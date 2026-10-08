/**
 * Coach's contract (section 3.3, section 11): it owns improvement, weekly.
 *
 * What it may receive, return, reach and spend is fixed here. The output is the
 * thing to notice: a Coach proposal is a `PlaybookContent`, whose strict schema has
 * no field for the opening, the disclosures, the banned-topic list or the claim
 * boundary. A proposal that tries to carry any of them does not become an invalid
 * output - it is dropped before the output is built and listed under `discarded`
 * with the reason, so the attempt is on the record and nothing off-contract is ever
 * returned.
 *
 * Coach proposes. It does not promote, roll back or start a test: those are the
 * promotion gate's decisions, made by deterministic code in src/playbook, carried
 * out by the orchestrator. The most Coach can do to the live script is hand the
 * gate a candidate.
 */

import { z } from 'zod';
import { playbookSlotSchema } from '../../blackboard/schemas.js';
import { playbookContentSchema } from '../../playbook/schema.js';
import { FAILURE_KINDS } from '../../playbook/failure-memory.js';
import type { AgentContract, AgentTool } from '../contract.js';

export const coachInputSchema = z.object({
  /** The last day of the week being reviewed, yyyy-MM-dd on the operator's clock. */
  weekEnding: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** Operator override of which slot to work on. Without it, the evidence picks. */
  slot: playbookSlotSchema.optional(),
  maxProposals: z.number().int().min(1).max(5).default(3)
});
export type CoachInput = z.infer<typeof coachInputSchema>;

export const proposalSchema = z.object({
  content: playbookContentSchema,
  /** Why this wording should do better, in plain English. */
  rationale: z.string().min(10).max(500),
  /** What it is meant to fix, in a few words. */
  targetsProblem: z.string().min(5).max(300)
});
export type Proposal = z.infer<typeof proposalSchema>;

export const discardedSchema = z.object({
  /** Why it never reached the gate. */
  reason: z.string().min(1),
  /** The start of what was proposed, for the record. */
  excerpt: z.string()
});

const variantRowSchema = z.object({
  slot: playbookSlotSchema,
  version: z.number().int().nullable(),
  dimension: z.enum(['all', 'market', 'industry', 'seniority']),
  value: z.string(),
  eligible: z.number().int(),
  completed: z.number().int(),
  requests: z.number().int(),
  requestRate: z.number()
});

export const coachOutputSchema = z.object({
  weekEnding: z.string(),
  /** The slot this run worked on. Null when it chose not to propose. */
  slot: playbookSlotSchema.nullable(),
  focusReason: z.string().min(1),
  proposals: z.array(proposalSchema).max(5),
  discarded: z.array(discardedSchema),
  /** Hook (and every other slot's) performance by industry, seniority and market. */
  variantPerformance: z.array(variantRowSchema),
  /** Failures this week's numbers showed, for failure memory. */
  failures: z.array(
    z.object({
      kind: z.enum(FAILURE_KINDS),
      key: z.string().min(1),
      summary: z.string().min(1),
      slot: playbookSlotSchema.optional()
    })
  ),
  /** Plain English, for the digest. */
  changeNote: z.string().min(1),
  noProposalReason: z.string().nullable()
});
export type CoachOutput = z.infer<typeof coachOutputSchema>;

export const COACH_BUDGET = {
  maxTurns: 3,
  maxTokens: 60_000,
  maxWallClockMs: 180_000,
  maxUsd: 1.0
} as const;

export function coachContract(tools: AgentTool[], model: string): AgentContract<CoachInput, CoachOutput> {
  return {
    name: 'coach',
    role: 'src/agents/coach/role.md',
    // Coach's output goes to live calls (after the gate), so it gets the stronger
    // model, and it has no latency budget.
    model,
    input: coachInputSchema,
    output: coachOutputSchema,
    tools,
    budget: { ...COACH_BUDGET },
    escalatesTo: 'orchestrator'
  };
}
