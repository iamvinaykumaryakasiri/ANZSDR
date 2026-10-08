/**
 * Prospector's task kind with Phase 3's enrichment write-back.
 *
 * The orchestrator's `prospectAccountKind` already turns a validated output
 * into contacts and one research task each. This wraps it rather than replacing
 * it, so the task graph is untouched, and adds the one thing Phase 3 needs after
 * it: the emails Prospector bought are written onto the new contacts.
 *
 * They are written from the enrichment ledger, not from the agent's output. The
 * output says that an email was bought; the ledger is the record of what, and
 * the blackboard is written from the record.
 */

import type { Agent } from '../contract.js';
import type { EnrichmentService } from '../../data/enrichment.js';
import { prospectAccountKind } from '../../orchestrator/kinds.js';
import type { TaskKind } from '../../orchestrator/registry.js';
import type { ProspectorInput, ProspectorOutput } from './contract.js';

export function prospectAccountKindWithEnrichment(
  agent: Agent<ProspectorInput, ProspectorOutput>,
  enrichment: EnrichmentService
): TaskKind<ProspectorInput, ProspectorOutput> {
  const base = prospectAccountKind(agent);
  return {
    ...base,
    async apply(output, ctx) {
      const specs = await base.apply(output, ctx);
      for (const prospect of output.prospects) {
        if (prospect.enrichmentSource === undefined) continue;
        const contact = await ctx.db.contact.findUnique({ where: { apolloId: prospect.externalId } });
        if (contact === null) continue;
        await enrichment.applyEmailFromLedger(contact.id, prospect.externalId);
      }
      return specs;
    }
  };
}
