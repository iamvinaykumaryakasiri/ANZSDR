/**
 * Analyst: gathers the day's figures through its read-only tools and builds the
 * digest. Then, separately, hands it to the operator-only mailer.
 */

import type { Agent, AgentTool } from '../contract.js';
import { defineAgent } from '../contract.js';
import { operatorOnly, type Mailer, type SentMail } from '../concierge/ports.js';
import { analystContract, type AnalystInput, type DailyDigest } from './contract.js';
import { buildDigest, type DigestData } from './digest.js';
import type { CallFact } from './facts.js';
import type { SpendSummary } from './metrics.js';

export interface AnalystDeps {
  /** From `analystTools`, or fixtures in a test. */
  tools: AgentTool[];
  zone?: string;
}

interface CallsRead {
  facts: CallFact[];
  baselineFacts: CallFact[];
}

interface QueueRead {
  queued: number;
  gatePassed: number;
  baselineQueued: number;
  baselineGatePassed: number;
  gateRejections: DigestData['gateRejections'];
  escalationsOnDay: number;
}

interface SpendRead {
  day: SpendSummary;
  lastSevenDays: SpendSummary;
  monthToDate: SpendSummary;
  requestsLastSevenDays: number;
  requestsMonthToDate: number;
  weeklyCeilingUsd: number | null;
}

export function createAnalyst(deps: AnalystDeps): Agent<AnalystInput, DailyDigest> {
  const zone = deps.zone ?? 'Australia/Sydney';

  return defineAgent(analystContract(deps.tools), async (ctx): Promise<DailyDigest> => {
    const { day, generatedAt } = ctx.input;

    const calls = await ctx.call<CallsRead>('read-calls', { day });
    const queue = await ctx.call<QueueRead>('read-queue', { day });
    const spend = await ctx.call<SpendRead>('read-spend', { day, generatedAt });
    const needsYou = await ctx.call<DigestData['needsYou']>('read-needs-you', { generatedAt });
    const playbook = await ctx.call<DigestData['playbook']>('read-playbook-state', { generatedAt });
    const queuePlans = await ctx.call<{ plans: DigestData['plans']; killSwitch: DigestData['killSwitch'] }>('read-plans', { generatedAt });
    const openingTexts = await ctx.call<string[]>('read-opening-lines', { contactIds: calls.facts.map((f) => f.contactId) });

    ctx.note(`read ${calls.facts.length} call(s) for ${day} and ${calls.baselineFacts.length} for the week before`);

    const digest = buildDigest({
      day,
      zone,
      generatedAt: new Date(generatedAt),
      facts: calls.facts,
      baselineFacts: calls.baselineFacts,
      queue: {
        queued: queue.queued,
        gatePassed: queue.gatePassed,
        baselineQueued: queue.baselineQueued,
        baselineGatePassed: queue.baselineGatePassed
      },
      gateRejections: queue.gateRejections,
      spend,
      openingTexts,
      escalationsOnDay: queue.escalationsOnDay,
      playbook,
      needsYou,
      plans: queuePlans.plans,
      killSwitch: queuePlans.killSwitch
    });

    ctx.note(digest.headline);
    return digest;
  });
}

/**
 * Send the digest to the operator, and only the operator.
 *
 * The mailer is wrapped in `operatorOnly` here rather than trusted to arrive that
 * way, so this function cannot be used to email anyone else however it is called -
 * the same property the Concierge's mailer has, for the same reason (section 12.2:
 * prospect email is drafted for Vinay to send, never sent by the system).
 */
export async function deliverDigest(mailer: Mailer, operatorEmail: string, digest: DailyDigest): Promise<SentMail> {
  return operatorOnly(mailer, [operatorEmail]).send({
    to: operatorEmail,
    subject: digest.subject,
    body: digest.text,
    attachments: []
  });
}
