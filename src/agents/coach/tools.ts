/**
 * The only things Coach can read.
 *
 * Section 3.1: a sub-agent's contract names the tools it can reach, and these are
 * Coach's. All four read. Nothing here writes to the playbook, starts a test or
 * touches a call - there is no handle for it, which is a stronger statement than
 * a prompt asking Coach not to.
 */

import { z } from 'zod';
import type { Blackboard } from '../../blackboard/client.js';
import type { ClaimIndex } from '../../knowledge/claims.js';
import type { FailureMemory } from '../../playbook/failure-memory.js';
import type { PlaybookStore } from '../../playbook/store.js';
import { loadCallFacts } from '../analyst/facts.js';
import { dayWindow, shiftDays } from '../analyst/metrics.js';
import type { AgentTool } from '../contract.js';
import { weeklyOutcomes } from './outcomes.js';

export interface CoachToolDeps {
  db: Blackboard;
  store: PlaybookStore;
  memory: FailureMemory;
  claims: ClaimIndex;
  /** The operator's clock, for what a "week ending" means. */
  zone?: string;
}

export const readOutcomesArgs = z.object({
  weekEnding: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  lookbackDays: z.number().int().min(1).max(120)
});

export function coachTools(deps: CoachToolDeps): AgentTool[] {
  return [
    {
      name: 'read-outcomes',
      description: 'The period\'s calls boiled down: where people were lost by script section, objections, variant performance by segment.',
      input: readOutcomesArgs,
      usdPerCall: 0,
      handler: async (args) => {
        const { weekEnding, lookbackDays } = readOutcomesArgs.parse(args);
        const last = dayWindow(weekEnding, deps.zone);
        const from = shiftDays(last, -(lookbackDays - 1)).from;
        const facts = await loadCallFacts(deps.db, { from, to: last.to });
        return weeklyOutcomes(facts, { from, to: last.to });
      }
    },
    {
      name: 'read-playbook',
      description: 'The current champion for each slot, and the challenger under test if there is one.',
      input: z.object({}),
      usdPerCall: 0,
      handler: async () => deps.store.snapshot()
    },
    {
      name: 'read-failure-memory',
      description: 'Hooks that died, objections handled badly and variants that did not survive.',
      input: z.object({}),
      usdPerCall: 0,
      handler: async () => deps.memory.list()
    },
    {
      name: 'read-approved-claims',
      description: 'Every claim that is approved, with the id a wording refers to it by. Nothing else may be asserted.',
      input: z.object({}),
      usdPerCall: 0,
      handler: async () => deps.claims.assertable().map((c) => ({ id: c.id, text: c.text, markets: c.markets }))
    }
  ];
}
