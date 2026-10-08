/**
 * Prospector's contract: it owns contact acquisition and nothing else.
 *
 * The contract was fixed in Phase 2. Phase 3 replaced the stub handler with the
 * real one (`prospector.ts`); the shape of what Prospector may receive, reach
 * and spend is unchanged, and what it returns has only been extended with
 * optional fields, so the Phase 2 stub's output is still valid.
 */

import { z } from 'zod';
import type { AgentContract, AgentTool } from '../contract.js';
import { icpSchema } from '../../blackboard/schemas.js';

export const prospectorInputSchema = z.object({
  campaignId: z.string().min(1),
  accountId: z.string().min(1),
  accountName: z.string().min(1),
  domain: z.string().min(1),
  icp: icpSchema,
  /** How many people to return at most. Keeps a bad ICP from draining credits. */
  limit: z.number().int().positive().max(25)
});
export type ProspectorInput = z.infer<typeof prospectorInputSchema>;

export const prospectSchema = z.object({
  externalId: z.string().min(1),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  title: z.string().min(1),
  seniority: z.string().min(1),
  linkedinUrl: z.string().url().optional(),
  /** 0-100 against the campaign ICP. Below the ICP's minimum, we do not enrich. */
  icpScore: z.number().int().min(0).max(100),
  scoreRationale: z.string().min(1),
  /**
   * Phase 3: stage-one enrichment. All optional, so the Phase 2 shape (and its
   * stub) is still a valid Prospector output. The address here is a convenience
   * for the trace; the blackboard is written from the enrichment ledger, not
   * from this field.
   */
  email: z.string().email().optional(),
  /** Apollo's own word for how sure it is the address works. */
  emailStatus: z.string().optional(),
  /** `apollo` if this run bought it, `ledger` if we already held it and nothing was spent. */
  enrichmentSource: z.enum(['apollo', 'ledger']).optional()
});
export type Prospect = z.infer<typeof prospectSchema>;

export const prospectorOutputSchema = z.object({
  accountId: z.string().min(1),
  prospects: z.array(prospectSchema),
  /** People found but not returned, and why. Feeds ICP tuning later. */
  rejected: z.array(z.object({ externalId: z.string(), reason: z.string() })).default([]),
  searchedAt: z.string().datetime(),
  /** Phase 3: what stage one cost. Absent from a run that bought nothing and from the stub. */
  enrichment: z
    .object({
      requested: z.number().int().nonnegative(),
      bought: z.number().int().nonnegative(),
      fromLedger: z.number().int().nonnegative(),
      deferred: z.number().int().nonnegative(),
      credits: z.number().nonnegative(),
      usd: z.number().nonnegative()
    })
    .optional()
});
export type ProspectorOutput = z.infer<typeof prospectorOutputSchema>;

export const PROSPECTOR_BUDGET = {
  maxTurns: 4,
  maxTokens: 30_000,
  maxWallClockMs: 60_000,
  // Apollo discovery plus a small margin. Phone enrichment is budgeted separately
  // because it costs roughly eight times what an email does.
  maxUsd: 0.5
} as const;

export function prospectorContract(tools: AgentTool[]): AgentContract<ProspectorInput, ProspectorOutput> {
  return {
    name: 'prospector',
    role: 'src/agents/prospector/role.md',
    model: 'claude-sonnet-4-6',
    input: prospectorInputSchema,
    output: prospectorOutputSchema,
    tools,
    budget: { ...PROSPECTOR_BUDGET },
    escalatesTo: 'orchestrator'
  };
}
