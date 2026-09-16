import { describe, expect, it } from 'vitest';
import { InMemoryJournal } from '../../src/agents/journal.js';
import { runAgent } from '../../src/agents/runner.js';
import { createStubProspector, scoreAgainstIcp } from '../../src/agents/prospector/stub.js';
import { createStubScout, keepSourced } from '../../src/agents/scout/stub.js';
import { ANZ_ICP, PEOPLE_FIXTURES, RESEARCH_FIXTURES } from '../support/harness.js';

const opts = () => ({ taskId: 'task-1', journal: new InMemoryJournal() });

const prospectorInput = {
  campaignId: 'c1',
  accountId: 'a1',
  accountName: 'Example Bank',
  domain: 'examplebank.com.au',
  icp: ANZ_ICP,
  limit: 10
};

describe('ICP scoring', () => {
  it('rewards a title match more than a seniority match', () => {
    const titleOnly = scoreAgainstIcp(
      { externalId: '1', firstName: 'A', lastName: 'B', title: 'Head of Data Platforms', seniority: 'manager' },
      ANZ_ICP
    );
    const seniorityOnly = scoreAgainstIcp(
      { externalId: '2', firstName: 'A', lastName: 'B', title: 'Chief Marketing Officer', seniority: 'c_suite' },
      ANZ_ICP
    );
    expect(titleOnly.score).toBeGreaterThan(seniorityOnly.score);
    expect(titleOnly.rationale).toContain('head of data');
  });

  it('zeroes anyone the ICP disqualifies, however senior', () => {
    const result = scoreAgainstIcp(
      { externalId: '3', firstName: 'A', lastName: 'B', title: 'Head of Data Recruiter', seniority: 'c_suite' },
      ANZ_ICP
    );
    expect(result.score).toBe(0);
    expect(result.rationale).toContain('disqualified');
  });

  it('says so plainly when nothing matched', () => {
    const result = scoreAgainstIcp(
      { externalId: '4', firstName: 'A', lastName: 'B', title: 'Facilities Coordinator', seniority: 'individual' },
      ANZ_ICP
    );
    expect(result.rationale).toBe('nothing in the ICP matched');
  });
});

describe('Prospector stub', () => {
  it('returns only the people who clear the ICP threshold, and says why the others did not', async () => {
    const outcome = await runAgent(createStubProspector(PEOPLE_FIXTURES), prospectorInput, opts());
    expect(outcome.status).toBe('succeeded');
    if (outcome.status !== 'succeeded') return;

    expect(outcome.output.prospects.map((p) => p.externalId)).toEqual(['apollo-1', 'apollo-2']);
    expect(outcome.output.rejected).toHaveLength(1);
    expect(outcome.output.rejected[0]?.reason).toContain('disqualified');
    expect(outcome.spend.turns).toBe(1);
  });

  it('returns nobody rather than a low-quality list when the account is unknown', async () => {
    const outcome = await runAgent(
      createStubProspector(PEOPLE_FIXTURES),
      { ...prospectorInput, domain: 'nobody.example' },
      opts()
    );
    expect(outcome.status).toBe('succeeded');
    if (outcome.status !== 'succeeded') return;
    expect(outcome.output.prospects).toEqual([]);
  });
});

describe('sourcing discipline', () => {
  it('drops any fact that arrives without a URL', () => {
    const { kept, dropped } = keepSourced([
      { kind: 'tech-signal', fact: 'uses Databricks', sourceUrl: 'https://example.com/a' },
      { kind: 'pressure', fact: 'heard they are cutting costs' }
    ]);
    expect(kept).toHaveLength(1);
    expect(dropped).toEqual(['heard they are cutting costs']);
  });
});

describe('Scout stub', () => {
  const scoutInput = {
    contactId: 'contact-1',
    contactName: 'Priya Raman',
    title: 'Chief Data Officer',
    accountId: 'a1',
    accountName: 'Example Bank',
    domain: 'examplebank.com.au'
  };

  it('builds a sourced dossier and reports what it could not verify', async () => {
    const outcome = await runAgent(createStubScout(RESEARCH_FIXTURES), scoutInput, opts());
    expect(outcome.status).toBe('succeeded');
    if (outcome.status !== 'succeeded') return;

    const d = outcome.output;
    expect(d.confidence).toBe('high');
    expect(d.hooks.length).toBeGreaterThanOrEqual(1);
    // Every hook points at something real.
    for (const hook of d.hooks) expect(hook.sourceUrl).toMatch(/^https:\/\//);
    // The unsourced rumour never becomes a fact.
    expect(d.unverified).toContain('a rumour about cost pressure in technology');
    expect(JSON.stringify(d.account.pressures)).not.toContain('rumour');
    expect(d.landmines[0]?.fact).toContain('APRA');
  });

  it('falls back to low confidence and a generic opener when nothing is verifiable', async () => {
    const outcome = await runAgent(
      createStubScout({ 'examplebank.com.au': { whatTheyDo: '', findings: [] } }),
      scoutInput,
      opts()
    );
    expect(outcome.status).toBe('succeeded');
    if (outcome.status !== 'succeeded') return;
    expect(outcome.output.confidence).toBe('low');
    expect(outcome.output.hypothesis).toContain('No specific trigger found');
    expect(outcome.output.hooks).toHaveLength(1);
  });
});
