/**
 * Scout's task kind with Phase 3's research gate.
 *
 * The orchestrator's `researchContactKind` stores the dossier and marks the
 * contact researched. This wraps it and adds the one thing that follows: asking
 * whether the dossier is good enough to spend on a phone number.
 *
 * What the gate said is written to the task's trace, so "why did we not buy her
 * number" has an answer on the same screen as the research that led to it. The
 * phone stage failing never fails the research: the dossier is already stored.
 */

import { randomUUID } from 'node:crypto';
import type { Agent } from '../contract.js';
import type { EnrichmentService } from '../../data/enrichment.js';
import { researchContactKind } from '../../orchestrator/kinds.js';
import type { TaskKind } from '../../orchestrator/registry.js';
import type { ScoutInput, ScoutOutput } from './contract.js';

export function researchContactKindWithPhoneGate(
  agent: Agent<ScoutInput, ScoutOutput>,
  enrichment: EnrichmentService
): TaskKind<ScoutInput, ScoutOutput> {
  const base = researchContactKind(agent);
  return {
    ...base,
    async apply(output, ctx) {
      const specs = await base.apply(output, ctx);

      let summary: string;
      try {
        const decision = await enrichment.onResearched(output.contactId);
        summary = `phone stage for ${output.person.name}: ${decision.reason}`;
      } catch (error) {
        summary = `phone stage for ${output.person.name} failed and was skipped: ${error instanceof Error ? error.message : String(error)}`;
      }
      await ctx.db.traceEvent.create({
        data: {
          id: randomUUID(),
          taskId: ctx.task.id,
          actor: 'enrichment',
          kind: 'decided',
          summary,
          detail: '{}'
        }
      });
      return specs;
    }
  };
}
