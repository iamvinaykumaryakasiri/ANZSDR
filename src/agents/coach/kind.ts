/**
 * Coach as a task the Campaign Director can dispatch.
 *
 * Not registered anywhere yet: the registry lives in src/orchestrator, which this
 * phase does not edit. Registering it is one line there:
 *
 *   registry.register(coachWeeklyKind(createCoach(...), makeCycleDeps))
 *
 * The Director schedules `coach-weekly` once a week; this is the part that says what
 * the result means. Following the rule that the orchestrator decides what follows
 * from a result, `apply` is where Coach's proposals meet the gate, and it queues
 * nothing further - a started challenger is picked up by assignment, not by a task.
 */

import type { Agent } from '../contract.js';
import type { TaskKind } from '../../orchestrator/registry.js';
import type { CoachInput, CoachOutput } from './contract.js';
import { registerProposals, type CycleDeps } from './cycle.js';

export const COACH_WEEKLY = 'coach-weekly';

export function coachWeeklyKind(
  agent: Agent<CoachInput, CoachOutput>,
  cycleDeps: () => CycleDeps | Promise<CycleDeps>
): TaskKind<CoachInput, CoachOutput> {
  return {
    kind: COACH_WEEKLY,
    agent,
    async apply(output) {
      await registerProposals(await cycleDeps(), output, { apply: true });
      return [];
    }
  };
}
