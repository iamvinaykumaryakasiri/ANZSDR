import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { icpSchema } from '../../src/blackboard/schemas.js';
import { parse as parseYaml } from 'yaml';
import { readFileSync } from 'node:fs';
import { loadPhase3Config, parsePhase3Config } from '../../src/data/config.js';
import { containsPhrase, DEFAULT_WEIGHTS, inferSeniority, rankCandidates, scorePerson } from '../../src/data/icp.js';
import { ROOT } from '../support/fixtures.js';
import { ANZ_ICP } from '../support/harness.js';

describe('matching a title phrase', () => {
  it('matches whole words, so "cto" is not found inside "director"', () => {
    expect(containsPhrase('Marketing Director', 'cto')).toBe(false);
    expect(containsPhrase('CTO', 'cto')).toBe(true);
    expect(containsPhrase('Deputy CTO, Retail', 'cto')).toBe(true);
    expect(containsPhrase('Associate Director', 'cio')).toBe(false);
  });

  it('still finds a phrase inside a longer title, which is what the title list relies on', () => {
    expect(containsPhrase('Group Head of Data & Analytics', 'head of data')).toBe(true);
    expect(containsPhrase('General Manager, Technology and Operations', 'general manager technology')).toBe(true);
    expect(containsPhrase('Head of Data Platforms', 'head of data')).toBe(true);
    expect(containsPhrase('Heads of Data', 'head of data')).toBe(false);
    expect(containsPhrase('Engineering Managers', 'engineering manager')).toBe(true);
  });

  it('does not let "intern" disqualify "International"', () => {
    expect(containsPhrase('Head of International Data', 'intern')).toBe(false);
    expect(containsPhrase('Data Intern', 'intern')).toBe(true);
  });

  it('ignores an empty phrase', () => {
    expect(containsPhrase('Anything', '  ')).toBe(false);
  });
});

describe('reading seniority off a title', () => {
  it.each([
    ['Chief Data Officer', 'c_suite'],
    ['CIO', 'c_suite'],
    ['VP Engineering', 'vp'],
    ['Vice President, Technology', 'vp'],
    ['Head of Data Platforms', 'head'],
    ['General Manager Technology', 'head'],
    ['Director of Engineering', 'director'],
    ['Engineering Manager', 'manager'],
    ['Principal Architect', 'senior'],
    ['Data Intern', 'intern']
  ])('%s is %s', (title, band) => {
    expect(inferSeniority(title)).toBe(band);
  });

  it('says nothing rather than guessing', () => {
    expect(inferSeniority('Facilities Coordinator')).toBeUndefined();
  });
});

describe('scoring a person against the ICP', () => {
  it('gives a title match more than a seniority match, and both together clear the bar', () => {
    const titleOnly = scorePerson({ title: 'Head of Data Platforms', seniority: 'entry' }, ANZ_ICP);
    const seniorityOnly = scorePerson({ title: 'Chief Marketing Officer', seniority: 'c_suite' }, ANZ_ICP);
    const both = scorePerson({ title: 'Chief Data Officer', seniority: 'c_suite' }, ANZ_ICP);
    expect(titleOnly.score).toBe(55);
    expect(seniorityOnly.score).toBe(35);
    expect(both.score).toBe(90);
    expect(titleOnly.score).toBeLessThan(ANZ_ICP.minimumScore);
    expect(both.score).toBeGreaterThanOrEqual(ANZ_ICP.minimumScore);
  });

  it('adds the profile weight for a public profile', () => {
    expect(scorePerson({ title: 'Chief Data Officer', seniority: 'c_suite', linkedinUrl: 'https://linkedin.com/in/x' }, ANZ_ICP).score).toBe(100);
  });

  it('zeroes anyone the ICP disqualifies, however senior', () => {
    const result = scorePerson({ title: 'Head of Data Recruiter', seniority: 'c_suite' }, ANZ_ICP);
    expect(result).toMatchObject({ score: 0, disqualified: true });
    expect(result.rationale).toContain('disqualified by "recruiter"');
  });

  it('reads seniority off the title when the search did not return one, and says so', () => {
    const result = scorePerson({ title: 'Chief Data Officer' }, ANZ_ICP);
    expect(result).toMatchObject({ seniority: 'c_suite', seniorityInferred: true, score: 90 });
    expect(result.rationale).toContain('read from the title');
  });

  it('does not score a Marketing Director as a CTO', () => {
    const icp = { ...ANZ_ICP, titles: ['cto'], seniorities: [] };
    expect(scorePerson({ title: 'Marketing Director' }, icp).score).toBe(0);
  });

  it('says plainly when nothing matched', () => {
    expect(scorePerson({ title: 'Facilities Coordinator', seniority: 'entry' }, ANZ_ICP).rationale).toBe('nothing in the ICP matched');
  });

  it('is driven by the weights, normalised to 0-100', () => {
    const weights = { title: 1, seniority: 1, profile: 0 };
    expect(scorePerson({ title: 'Chief Data Officer', seniority: 'c_suite' }, ANZ_ICP, weights).score).toBe(100);
    expect(scorePerson({ title: 'Chief Data Officer', seniority: 'entry' }, ANZ_ICP, weights).score).toBe(50);
    expect(() => scorePerson({ title: 'x' }, ANZ_ICP, { title: 0, seniority: 0, profile: 0 })).toThrow(/more than zero/);
  });

  it('normalises seniority spelling', () => {
    expect(scorePerson({ title: 'Chief Data Officer', seniority: 'C-Suite' }, ANZ_ICP).seniority).toBe('c_suite');
  });
});

describe('ranking', () => {
  it('orders by score, then seniority, then name, never by search order', () => {
    const ranked = rankCandidates([
      { id: 'a', score: 90, seniority: 'head', sortName: 'Zed' },
      { id: 'b', score: 90, seniority: 'c_suite', sortName: 'Yan' },
      { id: 'c', score: 100, seniority: 'manager', sortName: 'Xi' },
      { id: 'd', score: 90, seniority: 'head', sortName: 'Abe' }
    ]);
    expect(ranked.map((r) => r.id)).toEqual(['c', 'b', 'd', 'a']);
  });
});

describe('configuration', () => {
  it('has defaults that match the Phase 2 scoring', () => {
    expect(parsePhase3Config('')).toMatchObject({
      scoring: { weights: DEFAULT_WEIGHTS },
      enrichment: { emailCredits: 1, phoneCredits: 8, phone: { enabled: false } }
    });
  });

  it('loads the shipped campaign.yaml, and the account desk\'s own parser still accepts the same file', () => {
    const config = loadPhase3Config(resolve(ROOT, 'config/campaign.yaml'));
    expect(config.scoring.weights).toEqual({ title: 55, seniority: 35, profile: 10 });
    expect(config.enrichment.phone.enabled).toBe(false);
    const raw = parseYaml(readFileSync(resolve(ROOT, 'config/campaign.yaml'), 'utf8')) as { icp: unknown };
    expect(icpSchema.parse(raw.icp).minimumScore).toBe(60);
  });

  it('refuses a nonsense weight', () => {
    expect(() => parsePhase3Config('scoring:\n  weights:\n    title: -5\n')).toThrow();
  });

  it('puts the shipped title list through the scorer sensibly', () => {
    const raw = parseYaml(readFileSync(resolve(ROOT, 'config/campaign.yaml'), 'utf8')) as { icp: unknown };
    const icp = icpSchema.parse(raw.icp);
    expect(scorePerson({ title: 'Head of Data & Analytics' }, icp).score).toBeGreaterThanOrEqual(icp.minimumScore);
    expect(scorePerson({ title: 'General Manager, Technology' }, icp).score).toBeGreaterThanOrEqual(icp.minimumScore);
    expect(scorePerson({ title: 'Head of International Marketing' }, icp).score).toBeLessThan(icp.minimumScore);
    expect(scorePerson({ title: 'Technical Recruiter', seniority: 'manager' }, icp).score).toBe(0);
  });
});
