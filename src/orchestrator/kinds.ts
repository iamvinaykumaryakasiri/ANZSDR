/**
 * The two task kinds Phase 2 wires end to end: find the people, then research
 * them. Prospector's output becomes contacts on the blackboard and one research
 * task per contact; Scout's output becomes a dossier.
 */

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Agent } from '../agents/contract.js';
import type { ProspectorInput, ProspectorOutput } from '../agents/prospector/contract.js';
import type { ScoutInput, ScoutOutput } from '../agents/scout/contract.js';
import { encode, dossierAccountSchema, dossierPersonSchema, hookSchema, sourcedFactSchema } from '../blackboard/schemas.js';
import type { TaskSpec } from '../blackboard/repositories.js';
import type { TaskKind } from './registry.js';

export const PROSPECT_ACCOUNT = 'prospect-account';
export const RESEARCH_CONTACT = 'research-contact';

export function prospectAccountKind(agent: Agent<ProspectorInput, ProspectorOutput>): TaskKind<ProspectorInput, ProspectorOutput> {
  return {
    kind: PROSPECT_ACCOUNT,
    agent,
    async apply(output, { db, task, now }) {
      const specs: TaskSpec[] = [];
      for (const prospect of output.prospects) {
        // Deduplicate against everything already held: we never re-acquire a
        // person we have, and we never re-buy data for them.
        const existing = await db.contact.findFirst({ where: { apolloId: prospect.externalId } });
        const contactId = existing?.id ?? randomUUID();

        if (existing === null) {
          await db.contact.create({
            data: {
              id: contactId,
              accountId: output.accountId,
              campaignId: task.campaignId as string,
              firstName: prospect.firstName,
              lastName: prospect.lastName,
              title: prospect.title,
              seniority: prospect.seniority,
              linkedinUrl: prospect.linkedinUrl ?? null,
              apolloId: prospect.externalId,
              icpScore: prospect.icpScore,
              status: 'scored'
            }
          });
        } else {
          await db.contact.update({
            where: { id: contactId },
            data: { icpScore: prospect.icpScore, title: prospect.title, updatedAt: now }
          });
        }

        specs.push({
          kind: RESEARCH_CONTACT,
          priority: prospect.icpScore >= 85 ? 1 : 2,
          ...(task.campaignId !== null ? { campaignId: task.campaignId } : {}),
          accountId: output.accountId,
          contactId,
          dependsOn: [task.id],
          payload: {
            contactId,
            contactName: `${prospect.firstName} ${prospect.lastName}`,
            title: prospect.title,
            accountId: output.accountId,
            accountName: (task.payload as ProspectorInput).accountName,
            domain: (task.payload as ProspectorInput).domain,
            ...(prospect.linkedinUrl !== undefined ? { linkedinUrl: prospect.linkedinUrl } : {})
          } satisfies ScoutInput
        });
      }
      return specs;
    }
  };
}

export function researchContactKind(agent: Agent<ScoutInput, ScoutOutput>): TaskKind<ScoutInput, ScoutOutput> {
  return {
    kind: RESEARCH_CONTACT,
    agent,
    async apply(output, { db, now }) {
      await db.dossier.create({
        data: {
          id: randomUUID(),
          contactId: output.contactId,
          hypothesis: output.hypothesis,
          confidence: output.confidence,
          person: encode(dossierPersonSchema, 'Dossier.person', output.person),
          account: encode(dossierAccountSchema, 'Dossier.account', output.account),
          hooks: encode(z.array(hookSchema), 'Dossier.hooks', output.hooks),
          landmines: encode(z.array(sourcedFactSchema), 'Dossier.landmines', output.landmines),
          unverified: encode(z.array(z.string()), 'Dossier.unverified', output.unverified),
          sources: encode(z.array(z.string().url()), 'Dossier.sources', output.sources),
          createdAt: now
        }
      });
      await db.contact.update({
        where: { id: output.contactId },
        data: { status: 'researched', updatedAt: now }
      });
      // Phase 3 queues enrichment here, and Phase 4 the dial request. Research
      // is the end of the chain until the compliance gate has something to rule on.
      return [];
    }
  };
}
