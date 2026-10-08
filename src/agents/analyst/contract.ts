/**
 * Analyst's contract (section 3.3): it owns visibility.
 *
 * The daily digest is the one output, and it is also the 07:00 Sydney briefing:
 * `headline` and `sections` have exactly the shape of the console's briefing view,
 * so the console can show them as they are.
 *
 * Analyst makes no model call. Every number in the digest is computed from the
 * blackboard and every sentence is assembled from those numbers; a model asked to
 * "summarise yesterday" would round, smooth and occasionally invent, and this is
 * the page Vinay uses to decide whether to trust the system. The contract still
 * declares a model field because the contract shape requires one, and says
 * plainly that it is not used.
 */

import { z } from 'zod';
import type { AgentContract, AgentTool } from '../contract.js';

export const analystInputSchema = z.object({
  /** The day the digest covers, yyyy-MM-dd on the operator's clock. Normally yesterday. */
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** When it is being written: "today's queue" and "waiting more than 24 hours" are relative to it. */
  generatedAt: z.string().datetime()
});
export type AnalystInput = z.infer<typeof analystInputSchema>;

const funnelStage = z.object({
  id: z.enum([
    'queued',
    'gate_passed',
    'dialled',
    'answered',
    'survived_opener',
    'real_conversation',
    'ask_made',
    'meeting_requested',
    'confirmed'
  ]),
  label: z.string(),
  count: z.number(),
  rate: z.number(),
  loss: z.number(),
  baselineRate: z.number()
});

const sectionStat = z.object({
  stage: z.enum(['disclosure', 'reason', 'hook', 'value', 'ask', 'close']),
  label: z.string(),
  reached: z.number(),
  endedHere: z.number(),
  hazard: z.number(),
  share: z.number(),
  lostHere: z.number()
});

const spendBlock = z.object({
  dayUsd: z.number(),
  lastSevenDaysUsd: z.number(),
  monthToDateUsd: z.number(),
  /** The sum of the active campaigns' weekly ceilings. Null if none is set. */
  weeklyCeilingUsd: z.number().nullable(),
  byCategory: z.record(z.number()),
  costPerMeetingSevenDaysUsd: z.number().nullable(),
  costPerMeetingMonthUsd: z.number().nullable()
});

const defectBlock = z.object({
  calls: z.number(),
  callsWithDefects: z.number(),
  total: z.number(),
  byKind: z.record(z.number()),
  unsupportedClaims: z.object({
    total: z.number(),
    openingLineFlags: z.number(),
    other: z.number(),
    examples: z.array(
      z.object({
        callId: z.string(),
        company: z.string(),
        quote: z.string(),
        atSecond: z.number().optional(),
        openingLine: z.boolean()
      })
    )
  }),
  /** Defects per call over the seven days before, for comparison. Null with no calls to compare. */
  priorSevenDays: z.object({ calls: z.number(), defectsPerCall: z.number().nullable(), claimDefectsNetPerCall: z.number().nullable() })
});

const playbookBlock = z.object({
  champions: z.array(z.object({ slot: z.string(), version: z.number() })),
  /** What changed in the last day, in plain English. */
  changes: z.array(z.string()),
  test: z
    .object({
      slot: z.string(),
      version: z.number(),
      championCompleted: z.number(),
      challengerCompleted: z.number(),
      minimum: z.number(),
      championRequestRate: z.number(),
      challengerRequestRate: z.number()
    })
    .nullable()
});

const needsYouBlock = z.object({
  openMeetingRequests: z.array(
    z.object({ ref: z.string(), name: z.string(), company: z.string(), status: z.string(), waitingHours: z.number() })
  ),
  waitingOver24h: z.number(),
  openEscalations: z.array(z.object({ reason: z.string(), waitingHours: z.number() }))
});

const queueBlock = z.object({
  plans: z.array(z.object({ campaign: z.string(), planDate: z.string(), status: z.string(), entries: z.number(), clearGate: z.number() })),
  killSwitch: z.object({ engaged: z.boolean(), reason: z.string().optional() })
});

export const digestSchema = z.object({
  day: z.string(),
  generatedAt: z.string(),
  /** `[DAILY DIGEST] Tue 6 Oct — 2 meeting requests, US$4.20`. */
  subject: z.string().min(1),
  /** The console briefing's shape: a headline and titled sections. */
  headline: z.string().min(1),
  sections: z.array(z.object({ title: z.string(), body: z.string() })).min(1),
  /** The same content as plain text, for the email. */
  text: z.string().min(1),
  figures: z.object({
    today: z.object({
      dialled: z.number(),
      connected: z.number(),
      conversations: z.number(),
      requests: z.number(),
      spendUsd: z.number(),
      costPerMeetingUsd: z.number().nullable()
    }),
    outcomes: z.record(z.number()),
    funnel: z.array(funnelStage),
    sectionHangups: z.object({ stages: z.array(sectionStat), attributed: z.number(), unattributed: z.number() }),
    objections: z.array(z.object({ label: z.string(), count: z.number() })),
    gatekeepers: z.array(z.object({ company: z.string(), blocks: z.number(), calls: z.number() })),
    wrongNumberRate: z.number(),
    gateRejections: z.array(z.object({ reason: z.string(), count: z.number() })),
    spend: spendBlock,
    defects: defectBlock,
    safety: z.object({
      callsToday: z.number(),
      escalationsToday: z.number(),
      claimDefectsToday: z.number(),
      claimDefectsRaw: z.number(),
      errorRate: z.number(),
      negativeSentimentRate: z.number(),
      defectRate: z.number()
    }),
    playbook: playbookBlock,
    needsYou: needsYouBlock,
    queue: queueBlock
  })
});
export type DailyDigest = z.infer<typeof digestSchema>;

export const ANALYST_BUDGET = {
  maxTurns: 1,
  maxTokens: 1000,
  maxWallClockMs: 60_000,
  // No model is called, so nothing is spent. A tool that started to cost money
  // would breach this at once and escalate rather than quietly spend.
  maxUsd: 0
} as const;

export function analystContract(tools: AgentTool[]): AgentContract<AnalystInput, DailyDigest> {
  return {
    name: 'analyst',
    role: 'src/agents/analyst/digest.ts',
    model: 'none (deterministic: no model is called)',
    input: analystInputSchema,
    output: digestSchema,
    tools,
    budget: { ...ANALYST_BUDGET },
    escalatesTo: 'orchestrator'
  };
}
