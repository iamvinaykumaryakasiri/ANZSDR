/**
 * Where a live call's briefing pack comes from.
 *
 * The voice server and the process that places a call are different processes
 * (`npm run voice:testcall` runs, places the call and exits; `npm run
 * voice:serve` is what the provider talks to). So the pack cannot be handed over
 * in memory. It is rebuilt from the blackboard when the first request for a call
 * arrives, and then held for the life of that call: claims approved or revoked
 * mid-call do not change what Lexi may say halfway through a sentence.
 *
 * What is rebuilt is exactly what `caller:smoke` assembles by hand: the contact,
 * the account, the latest dossier, the approved claims, the knowledge pack. A
 * contact with no dossier (every test contact, to begin with) gets the
 * low-confidence generic pack - no hooks, a generic reason for the call, and the
 * opening unchanged. A dossier that fails to decode is treated the same way.
 */

import { z } from 'zod';
import { assembleBriefing, renderBriefing, type BriefingDossier } from '../agents/caller/briefing.js';
import type { OpeningSegment } from '../agents/caller/opening.js';
import type { AgentIdentity } from '../agents/caller/identity.js';
import { decode, hookSchema, sourcedFactSchema, confidenceSchema } from '../blackboard/schemas.js';
import type { Blackboard } from '../blackboard/client.js';
import { marketForDial } from '../compliance/phone.js';
import type { Market } from '../compliance/types.js';
import type { ClaimIndex } from '../knowledge/claims.js';
import type { KnowledgePack } from '../knowledge/pack.js';

export interface CallContext {
  callId: string;
  contactId: string;
  market: Market;
  /** The rendered briefing: the system prompt for every turn of this call. */
  system: string;
  openingText: string;
  opening: OpeningSegment[];
  /** What Lexi may assert on this call, for the layer-two judge. */
  assertableClaims: string[];
  /** Why the pack looks the way it does. */
  notes: string[];
}

export interface BriefingSourceDeps {
  db: Blackboard;
  identity: AgentIdentity;
  /** Called once per call, so a claim approved since startup is seen by the next call. */
  claims: () => ClaimIndex;
  pack: () => KnowledgePack;
}

const NO_DOSSIER: BriefingDossier = {
  hypothesis: '',
  confidence: 'low',
  hooks: [],
  landmines: [],
  unverified: ['no dossier has been written for this contact']
};

async function dossierFor(db: Blackboard, contactId: string, notes: string[]): Promise<BriefingDossier> {
  const row = await db.dossier.findFirst({ where: { contactId }, orderBy: { createdAt: 'desc' } });
  if (row === null) {
    notes.push('no dossier for this contact, so the pack is the generic one');
    return NO_DOSSIER;
  }
  try {
    return {
      hypothesis: row.hypothesis,
      confidence: confidenceSchema.parse(row.confidence),
      hooks: decode(z.array(hookSchema), 'Dossier.hooks', row.hooks).map((h) => ({ text: h.text, sourceUrl: h.sourceUrl })),
      landmines: decode(z.array(sourcedFactSchema), 'Dossier.landmines', row.landmines).map((l) => l.fact),
      unverified: decode(z.array(z.string()), 'Dossier.unverified', row.unverified)
    };
  } catch (error) {
    // A corrupt row is a stop for the agents that write from it; here the safe
    // reading is the generic one, said out loud in the notes.
    notes.push(`the dossier could not be read (${(error as Error).message}), so the pack is the generic one`);
    return NO_DOSSIER;
  }
}

/** Build the context for one contact. Throws if the opening cannot be built (no agent name, say). */
export async function buildCallContext(deps: BriefingSourceDeps, callId: string, contactId: string): Promise<CallContext> {
  const contact = await deps.db.contact.findUniqueOrThrow({ where: { id: contactId }, include: { account: true } });
  const notes: string[] = [];

  const accountMarket: Market = contact.account.country === 'NZ' ? 'NZ' : 'AU';
  // The number decides the market, as it does for the gate.
  const market = contact.phoneE164 !== null ? marketForDial(contact.phoneE164, accountMarket) : accountMarket;

  const claims = deps.claims();
  const briefing = assembleBriefing({
    identity: deps.identity,
    prospect: {
      contactId: contact.id,
      name: `${contact.firstName} ${contact.lastName}`.trim(),
      firstName: contact.firstName,
      title: contact.title,
      accountName: contact.account.name,
      market
    },
    dossier: await dossierFor(deps.db, contactId, notes),
    claims,
    pack: deps.pack()
  });
  notes.push(...briefing.notes);

  return {
    callId,
    contactId,
    market,
    system: renderBriefing(briefing),
    openingText: briefing.openingText,
    opening: briefing.opening,
    assertableClaims: briefing.assertable.map((c) => c.text),
    notes
  };
}

/**
 * Contexts for live calls: built on first use, held until the call ends.
 */
export class CallContextProvider {
  private readonly cache = new Map<string, CallContext>();

  constructor(private readonly deps: BriefingSourceDeps) {}

  /**
   * Which of our calls is this, if it is one we placed and that is still live?
   * Takes our id or the provider's. A call that has ended, or that we never
   * placed, is not ours to brief.
   */
  async resolve(key: string): Promise<string | null> {
    if (this.cache.has(key)) return key;
    const row =
      (await this.deps.db.call.findUnique({ where: { id: key }, select: { id: true, endedAt: true } })) ??
      (await this.deps.db.call.findUnique({ where: { providerCallId: key }, select: { id: true, endedAt: true } }));
    if (row === null || row.endedAt !== null) return null;
    return row.id;
  }

  async get(callId: string): Promise<CallContext | null> {
    const held = this.cache.get(callId);
    if (held !== undefined) return held;

    const call = await this.deps.db.call.findUnique({ where: { id: callId }, select: { contactId: true } });
    if (call === null) return null;
    try {
      const context = await buildCallContext(this.deps, callId, call.contactId);
      this.cache.set(callId, context);
      return context;
    } catch {
      // No name, no briefing: the endpoint says so and closes. The doctor and the
      // test-call preflight catch this before a phone rings.
      return null;
    }
  }

  /** Synchronous, for the layer-two judge, which is always asked after `get`. */
  peek(callId: string): CallContext | undefined {
    return this.cache.get(callId);
  }

  forget(callId: string): void {
    this.cache.delete(callId);
  }
}
