/**
 * The two enrichment stages (section 5.2), and the research gate between them.
 *
 *   Stage one, email: for everyone who passes ICP scoring. About a credit each.
 *   Stage two, phone: only for those who also pass the research gate, because a
 *   phone costs around eight credits and arrives minutes later by webhook.
 *
 * The research gate is Scout's dossier. A contact we could say nothing specific
 * about is not worth eight credits, and with a `low` dossier Lexi would open
 * generically anyway.
 *
 * Nothing here decides whether a call may happen. A number stored on a contact
 * is a number the compliance gate will rule on; it is not permission.
 */

import { createHash } from 'node:crypto';
import type { Blackboard } from '../blackboard/client.js';
import { marketSchema, type Market } from '../blackboard/schemas.js';
import type { EnrichedPerson, PhoneNumberRecord } from './apollo-types.js';
import type {
  ApolloCosts,
  EnrichOutcome,
  EnrichRequest,
  PhoneRequestOutcome
} from './apollo-client.js';
import type { Phase3Config } from './config.js';
import { applyEmailStage, applyPhoneStage } from './contact-enrichment.js';
import { accountSuppression } from './dedupe.js';
import { ApolloStatusVerifier, type EmailVerifier } from './email.js';
import type { EnrichmentLedger } from './enrichment-ledger.js';
import type { EnrichmentJob, EnrichmentQueue } from './enrichment-queue.js';

/** The part of the Apollo client the enrichment service uses. The real client satisfies it. */
export interface ApolloPort {
  readonly costs: ApolloCosts;
  usdFor(credits: number): number;
  enrichEmails(requests: EnrichRequest[]): Promise<Map<string, EnrichOutcome>>;
  requestPhones(requests: EnrichRequest[], options: { webhookUrl: string }): Promise<Map<string, PhoneRequestOutcome>>;
  createContact(person: EnrichedPerson): Promise<string | undefined>;
}

export interface EnrichmentServiceDeps {
  db: Blackboard;
  ledger: EnrichmentLedger;
  /** Absent when there is no Apollo key. Planning and webhook delivery still work. */
  apollo?: ApolloPort | undefined;
  verifier?: EmailVerifier;
  config: Phase3Config['enrichment'];
  /** The https URL Apollo delivers phone numbers to, secret included. Absent means no phone stage. */
  webhookUrl?: string | undefined;
  queue?: EnrichmentQueue | undefined;
  now?: () => Date;
}

export interface EmailStagePlan {
  requested: number;
  /** Already bought: answered from the ledger for nothing. */
  fromLedger: number;
  toBuy: number;
  credits: number;
  usd: number;
}

export interface BudgetedEmailResult {
  outcomes: Map<string, EnrichOutcome>;
  /** Not bought because the run's spend ceiling would have been passed. They will be next time. */
  deferred: EnrichRequest[];
  /** What this call actually cost. Ledger hits are free. */
  credits: number;
  usd: number;
  /** Apollo contacts created, so enriching these people again is free. */
  savedContacts: number;
  notes: string[];
}

export interface PhoneGateDecision {
  eligible: boolean;
  reason: string;
}

export type DeliveryResult =
  | { status: 'applied'; contactId: string | undefined; chosen: string | undefined; rejected: string[] }
  | { status: 'duplicate' }
  | { status: 'unrequested' };

const CONFIDENCE_RANK: Record<string, number> = { low: 0, medium: 1, high: 2 };

/** A stable identity for one delivery, so Apollo's retry of it is recognised as the same thing. */
export function deliveryKey(apolloId: string, numbers: PhoneNumberRecord[]): string {
  const canonical = JSON.stringify([apolloId, numbers.map((n) => `${n.number}|${n.kind}`).sort()]);
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}

export class EnrichmentService {
  private readonly verifier: EmailVerifier;
  private readonly now: () => Date;

  constructor(private readonly deps: EnrichmentServiceDeps) {
    this.verifier = deps.verifier ?? new ApolloStatusVerifier(deps.now);
    this.now = deps.now ?? (() => new Date());
  }

  get phoneConfigured(): boolean {
    return this.deps.config.phone.enabled && this.deps.webhookUrl !== undefined && this.deps.apollo !== undefined;
  }

  /* ---------------------------------------------------------------- */
  /* Stage one                                                         */
  /* ---------------------------------------------------------------- */

  /** What stage one would cost, without spending anything. */
  async planEmailStage(requests: EnrichRequest[]): Promise<EmailStagePlan> {
    const seen = new Set<string>();
    let fromLedger = 0;
    let toBuy = 0;
    for (const r of requests) {
      if (seen.has(r.apolloId)) continue;
      seen.add(r.apolloId);
      if ((await this.deps.ledger.getEmail(r.apolloId)) !== null) fromLedger += 1;
      else toBuy += 1;
    }
    const credits = toBuy * this.deps.config.emailCredits;
    return {
      requested: seen.size,
      fromLedger,
      toBuy,
      credits,
      usd: Number((credits * this.deps.config.usdPerCredit).toFixed(6))
    };
  }

  /**
   * Buy emails for as many of `requests` (best first) as `maxUsd` allows. Anyone
   * already in the ledger is free and always included.
   */
  async enrichEmailsWithinBudget(requests: EnrichRequest[], maxUsd: number): Promise<BudgetedEmailResult> {
    const apollo = this.requireApollo();
    const perPerson = this.deps.config.emailCredits * this.deps.config.usdPerCredit;
    let affordable = perPerson <= 0 ? Number.POSITIVE_INFINITY : Math.floor(maxUsd / perPerson + 1e-9);

    const chosen: EnrichRequest[] = [];
    const deferred: EnrichRequest[] = [];
    const notes: string[] = [];
    for (const r of requests) {
      if ((await this.deps.ledger.getEmail(r.apolloId)) !== null) {
        chosen.push(r);
      } else if (affordable > 0) {
        chosen.push(r);
        affordable -= 1;
      } else {
        deferred.push(r);
      }
    }
    if (deferred.length > 0) {
      notes.push(
        `${deferred.length} deferred: this run's spend ceiling of $${maxUsd.toFixed(2)} allows ${chosen.length} (they are bought on a later run)`
      );
    }

    const outcomes = chosen.length === 0 ? new Map<string, EnrichOutcome>() : await apollo.enrichEmails(chosen);

    let credits = 0;
    let savedContacts = 0;
    for (const outcome of outcomes.values()) {
      if (outcome.status === 'enriched' && outcome.source === 'apollo') credits += outcome.credits;
    }
    if (this.deps.config.saveContacts) {
      for (const outcome of outcomes.values()) {
        if (outcome.status !== 'enriched' || outcome.source !== 'apollo' || outcome.person.email === undefined) continue;
        try {
          if ((await apollo.createContact(outcome.person)) !== undefined) savedContacts += 1;
        } catch (error) {
          // Best effort: the purchase stands whether or not the save worked.
          notes.push(`could not save ${outcome.person.apolloId} as an Apollo contact: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    return { outcomes, deferred, credits, usd: apollo.usdFor(credits), savedContacts, notes };
  }

  /** Write one stage-one result onto an existing contact. */
  async applyEmailOutcome(contactId: string, person: EnrichedPerson): Promise<void> {
    await applyEmailStage(this.deps.db, contactId, person, this.verifier, this.now());
  }

  /**
   * Write onto a contact whatever the ledger holds for this Apollo id. The
   * blackboard is written from the record of what was bought, never from an
   * agent's description of it. Returns whether there was anything to write.
   */
  async applyEmailFromLedger(contactId: string, apolloId: string): Promise<boolean> {
    const purchase = await this.deps.ledger.getEmail(apolloId);
    if (purchase === null || !purchase.matched || purchase.person === undefined) return false;
    await this.applyEmailOutcome(contactId, purchase.person);
    return true;
  }

  /* ---------------------------------------------------------------- */
  /* The research gate, and stage two                                  */
  /* ---------------------------------------------------------------- */

  async phoneGate(contactId: string): Promise<PhoneGateDecision> {
    const { config } = this.deps;
    if (!config.phone.enabled) {
      return { eligible: false, reason: 'phone enrichment is off (enrichment.phone.enabled); mobile dialling waits on DNC washing' };
    }
    if (this.deps.webhookUrl === undefined) {
      return { eligible: false, reason: 'no webhook: set PUBLIC_BASE_URL (https) and APOLLO_WEBHOOK_SECRET' };
    }
    if (this.deps.apollo === undefined) return { eligible: false, reason: 'no Apollo key' };

    const contact = await this.deps.db.contact.findUnique({ where: { id: contactId }, include: { account: true } });
    if (contact === null) return { eligible: false, reason: 'no such contact' };
    if (contact.kind === 'test') return { eligible: false, reason: 'a test contact already has the operator\'s own number' };
    if (contact.apolloId === null) return { eligible: false, reason: 'no Apollo id, so nothing to reveal' };
    if (contact.phoneE164 !== null) return { eligible: false, reason: 'already has a number' };

    const hold = await accountSuppression(this.deps.db, { accountId: contact.accountId, domain: contact.account.domain });
    const contactHold = await this.deps.db.suppression.findFirst({ where: { scope: 'contact', key: contactId } });
    if (hold !== null || contactHold !== null) {
      return { eligible: false, reason: 'suppressed; no money is spent on someone we may not call' };
    }

    const dossier = await this.deps.db.dossier.findFirst({ where: { contactId }, orderBy: { createdAt: 'desc' } });
    if (dossier === null) return { eligible: false, reason: 'research gate: no dossier yet' };
    const have = CONFIDENCE_RANK[dossier.confidence] ?? 0;
    const need = CONFIDENCE_RANK[config.phone.minimumConfidence] ?? 1;
    if (have < need) {
      return {
        eligible: false,
        reason: `research gate: dossier confidence is ${dossier.confidence}, and a phone needs ${config.phone.minimumConfidence} or better`
      };
    }
    if ((await this.deps.ledger.getPhone(contact.apolloId)) !== null) {
      return { eligible: false, reason: 'a phone reveal was already requested for this person' };
    }
    return { eligible: true, reason: `research gate passed (${dossier.confidence} confidence)` };
  }

  /**
   * Called when a dossier has been stored. Queues stage two if the gate passes;
   * says why not if it does not.
   */
  async onResearched(contactId: string): Promise<PhoneGateDecision> {
    const decision = await this.phoneGate(contactId);
    if (!decision.eligible) return decision;
    const contact = await this.deps.db.contact.findUniqueOrThrow({ where: { id: contactId } });
    const job: EnrichmentJob = { stage: 'phone', apolloId: contact.apolloId as string, contactId };

    if (this.deps.queue === undefined) {
      await this.process(job);
      return { eligible: true, reason: `${decision.reason}; phone requested now` };
    }
    const queued = await this.deps.queue.enqueue(job);
    return {
      eligible: true,
      reason: `${decision.reason}; ${queued.queued ? 'phone reveal queued' : 'a phone reveal is already queued'}`
    };
  }

  /** Queue stage one for contacts that are held without an address. */
  async enqueueEmailBackfill(limit = 25): Promise<number> {
    const queue = this.deps.queue;
    if (queue === undefined) throw new Error('no queue to put the backfill on');
    const waiting = await this.deps.db.contact.findMany({
      where: { apolloId: { not: null }, emails: { none: {} }, kind: 'prospect', status: { in: ['discovered', 'scored'] } },
      orderBy: [{ icpScore: 'desc' }, { createdAt: 'asc' }],
      take: limit
    });
    let queued = 0;
    for (const c of waiting) {
      const result = await queue.enqueue({ stage: 'email', apolloId: c.apolloId as string, contactId: c.id });
      if (result.queued) queued += 1;
    }
    return queued;
  }

  /** The queue's handler. Both stages re-check their own conditions when they run. */
  async process(job: EnrichmentJob): Promise<void> {
    const apollo = this.requireApollo();
    const contact = await this.deps.db.contact.findUnique({ where: { id: job.contactId }, include: { account: true } });
    if (contact === null) return;

    const request: EnrichRequest = {
      apolloId: job.apolloId,
      firstName: contact.firstName,
      domain: contact.account.domain,
      ...(contact.lastName.includes('*') ? {} : { lastName: contact.lastName })
    };

    if (job.stage === 'email') {
      const result = await this.enrichEmailsWithinBudget([request], Number.POSITIVE_INFINITY);
      const outcome = result.outcomes.get(job.apolloId);
      if (outcome?.status === 'enriched') await this.applyEmailOutcome(job.contactId, outcome.person);
      return;
    }

    // The gate is asked again at the moment of spending, not trusted from when the job was queued.
    const decision = await this.phoneGate(job.contactId);
    if (!decision.eligible) return;
    const outcomes = await apollo.requestPhones([request], { webhookUrl: this.deps.webhookUrl as string });
    const outcome = outcomes.get(job.apolloId);
    if (outcome?.status === 'requested' && outcome.immediate.length > 0) {
      await this.applyPhoneDelivery(job.apolloId, outcome.immediate);
    }
  }

  /** Start consuming the queue. A no-op in memory until drain() is called. */
  async startWorker(): Promise<void> {
    if (this.deps.queue === undefined) throw new Error('no queue to consume');
    await this.deps.queue.start((job) => this.process(job));
  }

  /* ---------------------------------------------------------------- */
  /* Delivery                                                          */
  /* ---------------------------------------------------------------- */

  /**
   * Apply one delivery of numbers for one person. Idempotent: Apollo retries
   * webhooks, and the second arrival of the same delivery changes nothing.
   */
  async applyPhoneDelivery(apolloId: string, numbers: PhoneNumberRecord[]): Promise<DeliveryResult> {
    const key = deliveryKey(apolloId, numbers);
    const recorded = await this.deps.ledger.recordPhoneDelivery(apolloId, key, numbers, this.now());
    if (!recorded.applied) return { status: recorded.reason };

    const contact = await this.deps.db.contact.findUnique({ where: { apolloId }, include: { account: true } });
    if (contact === null) {
      return { status: 'applied', contactId: undefined, chosen: undefined, rejected: [] };
    }
    const purchase = await this.deps.ledger.getEmail(apolloId);
    const market: Market = marketSchema.safeParse(contact.account.country).success
      ? (contact.account.country as Market)
      : 'AU';
    const applied = await applyPhoneStage(
      this.deps.db,
      contact.id,
      recorded.request,
      {
        city: purchase?.person?.city,
        state: purchase?.person?.state,
        country: purchase?.person?.country
      },
      market,
      this.now()
    );
    return {
      status: 'applied',
      contactId: contact.id,
      chosen: applied.chosen?.e164,
      rejected: applied.rejected
    };
  }

  private requireApollo(): ApolloPort {
    if (this.deps.apollo === undefined) {
      throw new Error('no Apollo client: set APOLLO_API_KEY (docs/APOLLO-SETUP.md)');
    }
    return this.deps.apollo;
  }
}
