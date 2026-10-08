/**
 * Phase 3 configuration, read from `config/campaign.yaml`.
 *
 * The ICP itself (titles, seniorities, disqualifiers, minimum score) is already
 * on the blackboard and travels in the task payload. What lives here is what the
 * scoring and enrichment need beyond it: the weights, and what a credit costs.
 * The account desk's importer ignores keys it does not know, so adding these
 * sections to the file changes nothing for it.
 *
 * Every field has a default, and a file with neither section behaves exactly as
 * the Phase 2 scoring did.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { REPO_ROOT } from '../config/env.js';

export const scoringWeightsSchema = z.object({
  /** A title containing one of the ICP's phrases. */
  title: z.number().nonnegative().default(55),
  /** The person's seniority band is one the ICP targets. */
  seniority: z.number().nonnegative().default(35),
  /** A public professional profile to research. */
  profile: z.number().nonnegative().default(10)
});
export type ScoringWeights = z.infer<typeof scoringWeightsSchema>;

export const phase3ConfigSchema = z.object({
  scoring: z
    .object({
      weights: scoringWeightsSchema.default({}),
      /** People Search pages to read per account. Search is free; the rate limit is the only cost. */
      searchPages: z.number().int().min(1).max(5).default(2),
      searchPerPage: z.number().int().min(1).max(100).default(50)
    })
    .default({}),
  enrichment: z
    .object({
      emailCredits: z.number().nonnegative().default(1),
      phoneCredits: z.number().nonnegative().default(8),
      organizationCredits: z.number().nonnegative().default(1),
      /** A conservative price per credit. Used to hold spend to a ceiling, so over is safer than under. */
      usdPerCredit: z.number().positive().default(0.05),
      /** Convert enriched people to Apollo contacts so enriching them again is free. */
      saveContacts: z.boolean().default(true),
      phone: z
        .object({
          /** Off until DNC washing is arranged (section 7.2): a phone costs eight times an email. */
          enabled: z.boolean().default(false),
          /** The research gate: Scout's confidence must be at least this for a phone to be bought. */
          minimumConfidence: z.enum(['high', 'medium']).default('medium')
        })
        .default({})
    })
    .default({})
});
export type Phase3Config = z.infer<typeof phase3ConfigSchema>;

export function parsePhase3Config(yamlText: string): Phase3Config {
  const raw = (parseYaml(yamlText) ?? {}) as Record<string, unknown>;
  return phase3ConfigSchema.parse({ scoring: raw.scoring, enrichment: raw.enrichment });
}

export function loadPhase3Config(path: string = resolve(REPO_ROOT, 'config/campaign.yaml')): Phase3Config {
  return existsSync(path) ? parsePhase3Config(readFileSync(path, 'utf8')) : phase3ConfigSchema.parse({});
}
