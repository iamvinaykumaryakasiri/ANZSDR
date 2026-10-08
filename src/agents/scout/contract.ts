/**
 * Scout's contract: it owns research, and nothing it returns is allowed to be
 * unsourced.
 *
 * Every fact carries the URL it came from, enforced by the schema rather than by
 * the prompt. A hook without a source cannot be returned at all, which is the
 * point: on a cold call a wrong specific is worse than a right generic, and the
 * cheapest way to avoid asserting something we cannot stand behind is to make it
 * structurally impossible to hand over.
 */

import { z } from 'zod';
import type { AgentContract, AgentTool } from '../contract.js';
import {
  confidenceSchema,
  dossierAccountSchema,
  dossierPersonSchema,
  hookSchema,
  sourcedFactSchema
} from '../../blackboard/schemas.js';

export const scoutInputSchema = z.object({
  contactId: z.string().min(1),
  contactName: z.string().min(1),
  title: z.string().min(1),
  accountId: z.string().min(1),
  accountName: z.string().min(1),
  domain: z.string().min(1),
  linkedinUrl: z.string().url().optional()
});
export type ScoutInput = z.infer<typeof scoutInputSchema>;

export const scoutOutputSchema = z.object({
  contactId: z.string().min(1),
  /** The single most plausible reason this person takes a meeting. */
  hypothesis: z.string().min(10),
  confidence: confidenceSchema,
  person: dossierPersonSchema,
  account: dossierAccountSchema,
  /**
   * Up to three specific, verifiable openers, each tied to something real.
   *
   * Phase 3 relaxed the floor from one to none. A dossier with nothing
   * verifiable behind it has no hooks, and says so; the Phase 2 stub padded it
   * with a placeholder sourced to the company homepage, which is the one thing
   * section 5.3 forbids - a specific nobody has checked.
   */
  hooks: z.array(hookSchema).max(3),
  /** Layoffs, a breach, litigation, M&A: anything to keep away from. */
  landmines: z.array(sourcedFactSchema).default([]),
  /** Said plainly rather than left implied, so Caller knows what not to assert. */
  unverified: z.array(z.string()).default([]),
  /** The pages whose content supports something kept in this dossier. Empty if nothing was. */
  sources: z.array(z.string().url())
});
export type ScoutOutput = z.infer<typeof scoutOutputSchema>;

export const SCOUT_BUDGET = {
  maxTurns: 8,
  maxTokens: 120_000,
  maxWallClockMs: 180_000,
  maxUsd: 1.5
} as const;

export function scoutContract(tools: AgentTool[]): AgentContract<ScoutInput, ScoutOutput> {
  return {
    name: 'scout',
    role: 'src/agents/scout/role.md',
    // Research is where a stronger model earns its cost: it is the difference
    // between a hook that lands and one that is subtly wrong.
    model: 'claude-opus-5',
    input: scoutInputSchema,
    output: scoutOutputSchema,
    tools,
    budget: { ...SCOUT_BUDGET },
    escalatesTo: 'orchestrator'
  };
}
