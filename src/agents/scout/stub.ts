/**
 * A Scout that reads a fixture instead of the open web.
 *
 * The sourcing discipline is real: facts arrive with URLs, anything without one
 * is dropped before it reaches the dossier, and confidence falls to `low` when
 * too little survives. Only the retrieval is fake.
 */

import { z } from 'zod';
import { defineAgent, type Agent, type AgentTool } from '../contract.js';
import type { SourcedFact } from '../../blackboard/schemas.js';
import { scoutContract, type ScoutInput, type ScoutOutput } from './contract.js';

export const webSearchArgsSchema = z.object({
  query: z.string().min(1),
  domain: z.string().min(1)
});

export interface FixtureFinding {
  fact: string;
  /** Deliberately optional: real sources sometimes arrive without one, and those must be dropped. */
  sourceUrl?: string;
  kind: 'person-signal' | 'tech-signal' | 'announcement' | 'pressure' | 'landmine';
}

export interface AccountResearch {
  whatTheyDo: string;
  size?: string;
  findings: FixtureFinding[];
}

/** Keep only what we can point at. An unsourced fact is not a fact we may use. */
export function keepSourced(findings: FixtureFinding[]): {
  kept: Array<SourcedFact & { kind: FixtureFinding['kind'] }>;
  dropped: string[];
} {
  const kept: Array<SourcedFact & { kind: FixtureFinding['kind'] }> = [];
  const dropped: string[] = [];
  for (const f of findings) {
    if (f.sourceUrl === undefined) {
      dropped.push(f.fact);
      continue;
    }
    kept.push({ fact: f.fact, sourceUrl: f.sourceUrl, kind: f.kind });
  }
  return { kept, dropped };
}

export function webSearchTool(fixtures: Record<string, AccountResearch>): AgentTool {
  return {
    name: 'web-search',
    description: 'Search the public web for an organisation: site, newsroom, filings, job postings, profiles.',
    input: webSearchArgsSchema,
    usdPerCall: 0.01,
    handler: async (args) => {
      const parsed = webSearchArgsSchema.parse(args);
      return fixtures[parsed.domain] ?? { whatTheyDo: '', findings: [] };
    }
  };
}

export function createStubScout(fixtures: Record<string, AccountResearch>): Agent<ScoutInput, ScoutOutput> {
  return defineAgent(scoutContract([webSearchTool(fixtures)]), async (ctx) => {
    const { domain, accountName, contactName, title } = ctx.input;
    ctx.charge({ tokensIn: 4_000, tokensOut: 1_200, usd: 0.06 });

    const research = await ctx.call<AccountResearch>('web-search', {
      query: `${accountName} ${title} technology strategy`,
      domain
    });

    const { kept, dropped } = keepSourced(research.findings);
    if (dropped.length > 0) {
      ctx.note(`dropped ${dropped.length} unsourced fact(s): ${dropped.join('; ')}`);
    }

    const of = (kind: FixtureFinding['kind']): SourcedFact[] =>
      kept.filter((k) => k.kind === kind).map(({ fact, sourceUrl }) => ({ fact, sourceUrl }));

    const techSignals = of('tech-signal');
    const announcements = of('announcement');
    const hookSources = [...announcements, ...techSignals].slice(0, 3);

    // A dossier with nothing verifiable behind it opens generically rather than
    // guessing at a specific, so the confidence it reports has to be honest.
    const confidence = hookSources.length >= 2 ? 'high' : hookSources.length === 1 ? 'medium' : 'low';

    const hooks =
      hookSources.length > 0
        ? hookSources.map((s) => ({ text: s.fact, sourceUrl: s.sourceUrl, slot: 'hook' as const }))
        : [
            {
              text: `${accountName} is on our ANZ target list and ${contactName} owns the area we work in`,
              sourceUrl: `https://${domain}/`,
              slot: 'hook' as const
            }
          ];

    ctx.note(`built a ${confidence}-confidence dossier from ${kept.length} sourced fact(s)`);

    return {
      contactId: ctx.input.contactId,
      hypothesis:
        confidence === 'low'
          ? `No specific trigger found; ${contactName} is a plausible owner of the problem we solve at ${accountName}`
          : `${contactName} is likely under pressure on ${hookSources[0]?.fact ?? 'their technology estate'}`,
      confidence,
      person: {
        name: contactName,
        title,
        priorEmployers: [],
        signals: of('person-signal')
      },
      account: {
        whatTheyDo: research.whatTheyDo === '' ? `${accountName} (not described in any source we found)` : research.whatTheyDo,
        ...(research.size !== undefined ? { size: research.size } : {}),
        techSignals,
        announcements,
        pressures: of('pressure')
      },
      hooks,
      landmines: of('landmine'),
      unverified: dropped,
      sources: [...new Set([`https://${domain}/`, ...kept.map((k) => k.sourceUrl)])]
    };
  });
}
