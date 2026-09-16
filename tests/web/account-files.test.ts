/**
 * The committed account list.
 *
 * `config/campaign.yaml` and `config/accounts.csv` are the durable copy of who we
 * are calling and who is worth calling. A database lives on one machine; these
 * files survive a fresh clone. What is worth testing is that the shipped files
 * are valid, and that a round trip through the blackboard does not lose or
 * corrupt anything.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import {
  campaignGoalSchema,
  campaignStatusSchema,
  icpSchema,
  marketSchema
} from '../../src/blackboard/schemas.js';
import { parseAccountRows, toCsv, CSV_COLUMNS } from '../../src/web/accounts-api.js';
import { scoreAgainstIcp } from '../../src/agents/prospector/stub.js';
import { ROOT } from '../support/fixtures.js';

const campaignFileSchema = z.object({
  campaign: z.object({ name: z.string().min(1), market: marketSchema, status: campaignStatusSchema }),
  goal: campaignGoalSchema,
  icp: icpSchema
});

describe('the shipped campaign file', () => {
  const raw = parseYaml(readFileSync(resolve(ROOT, 'config/campaign.yaml'), 'utf8')) as unknown;

  it('matches the schemas the blackboard will validate it against', () => {
    expect(() => campaignFileSchema.parse(raw)).not.toThrow();
  });

  it('starts small, so a first run cannot spend much', () => {
    const file = campaignFileSchema.parse(raw);
    expect(file.goal.maxUsdPerWeek).toBeLessThanOrEqual(50);
    expect(file.goal.meetingsPerWeek).toBeLessThanOrEqual(5);
  });

  it('keeps a score floor, so a loose title list cannot start spending credits', () => {
    const file = campaignFileSchema.parse(raw);
    expect(file.icp.minimumScore).toBeGreaterThan(0);
    expect(file.icp.titles.length).toBeGreaterThan(0);
    // Titles are matched case-insensitively as substrings, so storing them
    // lower-case is what keeps the file and the matcher agreeing.
    for (const title of file.icp.titles) expect(title).toBe(title.toLowerCase());
    for (const word of file.icp.disqualifiers) expect(word).toBe(word.toLowerCase());
  });
});

describe('the shipped account list', () => {
  const text = readFileSync(resolve(ROOT, 'config/accounts.csv'), 'utf8');

  it('uses the column names the brief names', () => {
    expect(text.split('\n')[0]).toBe(CSV_COLUMNS.join(','));
  });

  it('parses into rows the importer will accept', () => {
    const rows = parseAccountRows(text);
    expect(rows.length).toBeGreaterThan(0);
    for (const { values } of rows) {
      expect(values.account_name).toBeTruthy();
      expect(values.domain).toMatch(/^[a-z0-9.-]+\.[a-z.]{2,}$/i);
      expect(['AU', 'NZ']).toContain(values.country);
    }
  });
});

describe('the shipped ICP, scored against realistic titles', () => {
  const icp = icpSchema.parse(
    (parseYaml(readFileSync(resolve(ROOT, 'config/campaign.yaml'), 'utf8')) as { icp: unknown }).icp
  );

  const person = (title: string, seniority: string, linkedin = true) => ({
    externalId: 'x',
    firstName: 'A',
    lastName: 'B',
    title,
    seniority,
    ...(linkedin ? { linkedinUrl: 'https://www.linkedin.com/in/example' } : {})
  });

  const clears = (title: string, seniority: string, linkedin = true): boolean =>
    scoreAgainstIcp(person(title, seniority, linkedin), icp).score >= icp.minimumScore;

  it('lets through the people this campaign is actually for', () => {
    expect(clears('Head of Data & Analytics', 'head')).toBe(true);
    expect(clears('GM Technology', 'vp')).toBe(true);
    expect(clears('Chief Information Officer', 'c_suite')).toBe(true);
    expect(clears('Head of Engineering', 'director')).toBe(true);
    expect(clears('Engineering Manager', 'manager')).toBe(true);
    expect(clears('Group Head of Digital', 'head')).toBe(true);
  });

  it('keeps out the people it is not for', () => {
    expect(clears('Graduate Software Engineer', 'entry')).toBe(false);
    expect(clears('Technical Recruiter', 'manager')).toBe(false);
    expect(clears('Head of Retail Banking', 'head')).toBe(false);
    expect(clears('Chief Financial Officer', 'c_suite')).toBe(false);
  });

  it('drops a disqualified title however senior the person is', () => {
    // "Head of Technology" would otherwise score full marks.
    expect(clears('Head of Technology, Graduate Programme', 'c_suite')).toBe(false);
  });

  /**
   * The trap this guards. Scoring is 55 for a title match, 35 for a seniority
   * match, 10 for a public profile. With a minimum of 60, a title match ALONE is
   * 55 and therefore fails. So every seniority band the title list implies has
   * to be listed, or good people are dropped before anyone sees them.
   */
  it('covers every seniority band its own titles imply', () => {
    const titleOnly = scoreAgainstIcp(person('Head of Data', 'not_a_band', false), icp);
    expect(titleOnly.score).toBeLessThan(icp.minimumScore);

    for (const band of ['c_suite', 'vp', 'head', 'director', 'manager']) {
      expect(icp.seniorities).toContain(band);
    }
  });
});

describe('round trip', () => {
  it('survives export and re-import unchanged, including awkward cells', () => {
    const original = [
      { account_name: 'Bank, The', domain: 'bankthe.com.au', country: 'AU', industry: 'banking', priority: 1, notes: 'said "not now" in March' },
      { account_name: 'Plain Bank', domain: 'plain.co.nz', country: 'NZ', industry: 'financial services', priority: 3, notes: '' }
    ];

    const rows = parseAccountRows(toCsv(original));
    expect(rows).toHaveLength(2);
    expect(rows[0]?.values).toMatchObject({
      account_name: 'Bank, The',
      domain: 'bankthe.com.au',
      notes: 'said "not now" in March'
    });
    expect(rows[1]?.values.notes).toBeUndefined();
    expect(rows[1]?.values.country).toBe('NZ');
  });
});
