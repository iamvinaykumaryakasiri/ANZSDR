/**
 * The hard boundary.
 *
 * Section 6 gives the agent exactly one permission model: it may assert an
 * approved claim, and nothing else. These tests are mostly about the "nothing
 * else" half, because that is the half that fails quietly if it fails.
 */

import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClaimIndex } from '../../src/knowledge/claims.js';
import { claimSchema } from '../../src/knowledge/types.js';
import { ROOT } from '../support/fixtures.js';

const NOW = new Date('2026-09-17T00:00:00.000Z');

function claim(over: Record<string, unknown> = {}): unknown {
  return {
    id: 'c1',
    text: 'Hexaware is headquartered in Navi Mumbai.',
    kind: 'fact',
    status: 'draft',
    markets: ['AU', 'NZ'],
    sources: [{ kind: 'url', ref: 'https://example.com/a', quote: 'Navi Mumbai', retrievedAt: '2026-09-17' }],
    conflictsWith: [],
    ...over
  };
}

function index(...claims: unknown[]): ClaimIndex {
  return ClaimIndex.fromObject({ version: 1, claims });
}

describe('what the agent may say', () => {
  it('offers only approved claims', () => {
    const i = index(
      claim({ id: 'yes', status: 'approved' }),
      claim({ id: 'drafted', status: 'draft' }),
      claim({ id: 'binned', status: 'rejected' }),
      claim({ id: 'lost', status: 'orphaned' })
    );
    expect(i.assertable().map((c) => c.id)).toEqual(['yes']);
  });

  it('says nothing at all when nothing has been approved', () => {
    const i = index(claim({ status: 'draft' }), claim({ id: 'c2', status: 'draft' }));
    expect(i.assertable()).toEqual([]);
  });

  it('narrows to the market being called', () => {
    const i = index(
      claim({ id: 'both', status: 'approved', markets: ['AU', 'NZ'] }),
      claim({ id: 'nz-only', status: 'approved', markets: ['NZ'] })
    );
    expect(i.assertable('AU').map((c) => c.id)).toEqual(['both']);
    expect(i.assertable('NZ').map((c) => c.id)).toEqual(['both', 'nz-only']);
  });

  it('names a client only where the pack says it may', () => {
    const i = index(
      claim({ id: 'named', kind: 'reference', status: 'approved', nameable: true }),
      claim({ id: 'anon', kind: 'reference', status: 'approved', nameable: false }),
      claim({ id: 'unsaid', kind: 'reference', status: 'draft', nameable: true })
    );
    expect(i.nameableReferences().map((c) => c.id)).toEqual(['named']);
  });
});

describe('a claim cannot exist without a source', () => {
  it('refuses an empty source list', () => {
    expect(() => claimSchema.parse(claim({ sources: [] }))).toThrow();
  });

  it('refuses a source with no quote', () => {
    const bad = claim({
      sources: [{ kind: 'url', ref: 'https://example.com', quote: '', retrievedAt: '2026-09-17' }]
    });
    expect(() => claimSchema.parse(bad)).toThrow();
  });

  it('refuses a malformed retrieval date', () => {
    const bad = claim({
      sources: [{ kind: 'url', ref: 'https://example.com', quote: 'x', retrievedAt: 'last tuesday' }]
    });
    expect(() => claimSchema.parse(bad)).toThrow();
  });
});

describe('contradictions', () => {
  it('surfaces a declared conflict rather than picking a side', () => {
    const i = index(
      claim({ id: 'a', text: '34,506 employees', conflictsWith: ['b'] }),
      claim({ id: 'b', text: '33,000+ employees' })
    );
    const conflicts = i.conflicts();
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.live).toBe(false);
  });

  it('flags the dangerous case, where both sides are approved', () => {
    const i = index(
      claim({ id: 'a', status: 'approved', conflictsWith: ['b'] }),
      claim({ id: 'b', status: 'approved' })
    );
    expect(i.conflicts()[0]?.live).toBe(true);
  });

  it('reports a mutually declared conflict once, not twice', () => {
    const i = index(
      claim({ id: 'a', conflictsWith: ['b'] }),
      claim({ id: 'b', conflictsWith: ['a'] })
    );
    expect(i.conflicts()).toHaveLength(1);
  });

  it('ignores a conflict pointing at a claim that does not exist', () => {
    const i = index(claim({ id: 'a', conflictsWith: ['ghost'] }));
    expect(i.conflicts()).toEqual([]);
  });
});

describe('approving and rejecting', () => {
  it('records who approved it and when', () => {
    const i = index(claim({ id: 'a' }));
    i.approve('a', 'Vinay Kumar', NOW);
    const c = i.find('a');
    expect(c?.status).toBe('approved');
    expect(c?.approvedBy).toBe('Vinay Kumar');
    expect(c?.approvedAt).toBe(NOW.toISOString());
    expect(i.assertable().map((x) => x.id)).toEqual(['a']);
  });

  it('takes a claim back out of the agent’s mouth when rejected', () => {
    const i = index(claim({ id: 'a', status: 'approved' }));
    i.reject('a', 'figure is out of date', NOW);
    expect(i.assertable()).toEqual([]);
    expect(i.find('a')?.rejectedReason).toBe('figure is out of date');
    expect(i.find('a')?.approvedBy).toBeUndefined();
  });

  it('refuses to approve a claim whose source has disappeared', () => {
    const i = index(claim({ id: 'a', status: 'orphaned' }));
    expect(() => i.approve('a', 'Vinay Kumar', NOW)).toThrow(/orphaned/);
    expect(i.assertable()).toEqual([]);
  });

  it('refuses an id it has never heard of', () => {
    const i = index(claim({ id: 'a' }));
    expect(() => i.approve('nope', 'Vinay Kumar', NOW)).toThrow(/no claim/);
  });
});

describe('the index itself', () => {
  it('refuses a duplicate id rather than letting one shadow the other', () => {
    expect(() => index(claim({ id: 'same' }), claim({ id: 'same', text: 'something else' }))).toThrow(
      /duplicate claim id/
    );
  });

  it('counts what is where', () => {
    const i = index(
      claim({ id: 'a', status: 'approved' }),
      claim({ id: 'b', status: 'draft' }),
      claim({ id: 'c', status: 'rejected' }),
      claim({ id: 'd', status: 'orphaned' })
    );
    expect(i.counts()).toEqual({ total: 4, approved: 1, draft: 1, rejected: 1, orphaned: 1 });
  });
});

describe('the shipped pack', () => {
  const shipped = ClaimIndex.load(resolve(ROOT, 'knowledge/approved-claims.json'));

  it('ships with nothing approved, so a drafted claim cannot reach a prospect', () => {
    expect(shipped.assertable()).toEqual([]);
    expect(shipped.counts().draft).toBeGreaterThan(0);
  });

  it('carries a source and a quote on every single claim', () => {
    for (const c of shipped.all()) {
      expect(c.sources.length).toBeGreaterThan(0);
      for (const s of c.sources) expect(s.quote.trim()).not.toBe('');
    }
  });

  it('has no client reference marked nameable, because none has been cleared', () => {
    expect(shipped.all().filter((c) => c.nameable === true)).toEqual([]);
  });

  it('declares the headcount figures as contradicting each other', () => {
    const conflicts = shipped.conflicts();
    expect(conflicts.length).toBeGreaterThan(0);
    expect(conflicts.every((c) => !c.live)).toBe(true);
  });
});
