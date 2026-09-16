/**
 * A Prospector that reaches a fixture instead of Apollo.
 *
 * It exists to prove the orchestration loop end to end without spending a credit
 * or needing a public hostname. The scoring and the shape of what it returns are
 * real; only the source of the people is not.
 */

import { z } from 'zod';
import { defineAgent, type Agent, type AgentTool } from '../contract.js';
import {
  prospectorContract,
  type Prospect,
  type ProspectorInput,
  type ProspectorOutput
} from './contract.js';

export const peopleSearchArgsSchema = z.object({
  domain: z.string().min(1),
  titles: z.array(z.string()),
  seniorities: z.array(z.string()),
  limit: z.number().int().positive()
});

export interface FixturePerson {
  externalId: string;
  firstName: string;
  lastName: string;
  title: string;
  seniority: string;
  linkedinUrl?: string;
}

/**
 * Score a person against the campaign ICP. A title keyword is worth more than a
 * seniority band because a "Head of Data" at the wrong level is still closer to
 * the point than a VP of something unrelated.
 */
export function scoreAgainstIcp(
  person: FixturePerson,
  icp: ProspectorInput['icp']
): { score: number; rationale: string } {
  const title = person.title.toLowerCase();
  const reasons: string[] = [];
  let score = 0;

  const titleHit = icp.titles.find((t) => title.includes(t.toLowerCase()));
  if (titleHit !== undefined) {
    score += 55;
    reasons.push(`title matches "${titleHit}"`);
  }
  if (icp.seniorities.some((s) => s.toLowerCase() === person.seniority.toLowerCase())) {
    score += 35;
    reasons.push(`${person.seniority} is a target seniority`);
  }
  if (person.linkedinUrl !== undefined) {
    score += 10;
    reasons.push('has a public LinkedIn profile to research');
  }
  const disqualifier = icp.disqualifiers.find((d) => title.includes(d.toLowerCase()));
  if (disqualifier !== undefined) {
    score = 0;
    reasons.length = 0;
    reasons.push(`disqualified by "${disqualifier}"`);
  }

  return {
    score: Math.min(100, score),
    rationale: reasons.length > 0 ? reasons.join('; ') : 'nothing in the ICP matched'
  };
}

export function peopleSearchTool(fixtures: Record<string, FixturePerson[]>): AgentTool {
  return {
    name: 'people-search',
    description: 'Find people at an organisation by title and seniority. Discovery only: no emails, no phone numbers.',
    input: peopleSearchArgsSchema,
    // Apollo charges nothing for discovery; enrichment is what costs credits.
    usdPerCall: 0,
    handler: async (args) => {
      const parsed = peopleSearchArgsSchema.parse(args);
      return (fixtures[parsed.domain] ?? []).slice(0, parsed.limit);
    }
  };
}

export function createStubProspector(fixtures: Record<string, FixturePerson[]>): Agent<ProspectorInput, ProspectorOutput> {
  return defineAgent(prospectorContract([peopleSearchTool(fixtures)]), async (ctx) => {
    const { icp, domain, limit } = ctx.input;
    ctx.charge({ tokensIn: 900, tokensOut: 400, usd: 0.004 });

    const people = await ctx.call<FixturePerson[]>('people-search', {
      domain,
      titles: icp.titles,
      seniorities: icp.seniorities,
      limit
    });
    ctx.note(`searched ${domain} and found ${people.length} people`);

    const prospects: Prospect[] = [];
    const rejected: Array<{ externalId: string; reason: string }> = [];

    for (const person of people) {
      const { score, rationale } = scoreAgainstIcp(person, icp);
      if (score < icp.minimumScore) {
        rejected.push({ externalId: person.externalId, reason: `scored ${score}: ${rationale}` });
        continue;
      }
      prospects.push({
        externalId: person.externalId,
        firstName: person.firstName,
        lastName: person.lastName,
        title: person.title,
        seniority: person.seniority,
        ...(person.linkedinUrl !== undefined ? { linkedinUrl: person.linkedinUrl } : {}),
        icpScore: score,
        scoreRationale: rationale
      });
    }

    ctx.note(`${prospects.length} passed the ICP threshold of ${icp.minimumScore}, ${rejected.length} did not`);

    return {
      accountId: ctx.input.accountId,
      prospects,
      rejected,
      searchedAt: new Date().toISOString()
    };
  });
}
