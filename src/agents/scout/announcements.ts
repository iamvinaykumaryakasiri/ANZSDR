/**
 * ASX and NZX announcements (section 5.3: "ASX/NZX announcements where listed").
 *
 * For a listed account, the exchange's announcements page is the most reliable
 * public record of what the company says it is doing. Which accounts are listed,
 * and under what code, is operator data in `config/scout.yaml`: Scout does not
 * guess a ticker from a name, because a wrong guess reads another company's
 * announcements and attributes them to this one.
 *
 * The page goes through the policy fetcher like any other, so if the exchange's
 * robots.txt does not permit it, nothing is read and the dossier says so.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { REPO_ROOT } from '../../config/env.js';
import type { AnnouncementResult, AnnouncementSource, PageFetcher } from './sources.js';

export const scoutResearchConfigSchema = z.object({
  /** Keyed by the account's domain. */
  listings: z.record(z.object({ exchange: z.enum(['ASX', 'NZX']), code: z.string().min(2).max(6) })).default({}),
  /** `{code}` is replaced. Overridable because an exchange can move its pages. */
  announcementUrls: z
    .object({
      ASX: z.string().default('https://www.asx.com.au/markets/trade-our-cash-market/announcements.{code}'),
      NZX: z.string().default('https://www.nzx.com/companies/{code}/announcements')
    })
    .default({})
});
export type ScoutResearchConfig = z.infer<typeof scoutResearchConfigSchema>;

export function loadScoutResearchConfig(path: string = resolve(REPO_ROOT, 'config/scout.yaml')): ScoutResearchConfig {
  const raw = existsSync(path) ? ((parseYaml(readFileSync(path, 'utf8')) ?? {}) as unknown) : {};
  return scoutResearchConfigSchema.parse(raw);
}

export class ExchangeAnnouncements implements AnnouncementSource {
  constructor(
    private readonly fetcher: PageFetcher,
    private readonly config: ScoutResearchConfig
  ) {}

  async forCompany(input: { domain: string; accountName: string }): Promise<AnnouncementResult> {
    const listing = this.config.listings[input.domain.toLowerCase()];
    if (listing === undefined) return { docs: [], skipped: [] };

    const url = this.config.announcementUrls[listing.exchange].replace('{code}', encodeURIComponent(listing.code.toUpperCase()));
    const page = await this.fetcher.fetch(url);
    if (!page.ok) {
      return {
        docs: [],
        skipped: [`${listing.exchange} announcements for ${listing.code} were not read (${page.reason}${page.detail !== undefined ? `: ${page.detail}` : ''})`]
      };
    }
    return {
      docs: [
        {
          url: page.finalUrl,
          title: page.title === '' ? `${listing.exchange} announcements for ${listing.code}` : page.title,
          text: page.text,
          kind: 'announcement',
          retrievedAt: page.retrievedAt
        }
      ],
      skipped: []
    };
  }
}
