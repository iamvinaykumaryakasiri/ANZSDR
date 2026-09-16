/**
 * The opening is where the brief's second overriding rule lives: the agent never
 * claims to be human, not by omission, not under pressure, not if the prospect
 * insists.
 *
 * Omission is the one these tests are really about. A disclosure that a future
 * change could drop is not a guarantee, so what is asserted here is that there
 * is no way to build an opening without it.
 */

import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  COACH_MAY_NOT_EDIT,
  OpeningNotAvailableError,
  SEGMENT_ORDER,
  buildOpening,
  missingSegments,
  renderOpening
} from '../../src/agents/caller/opening.js';
import { identityGaps, loadIdentity, loadIdentityFromObject } from '../../src/agents/caller/identity.js';
import { ROOT } from '../support/fixtures.js';

const REASON = 'I called because Kiwibank has been hiring data platform engineers all year.';

function identity(over: Record<string, unknown> = {}) {
  return loadIdentityFromObject({
    agent: { name: 'Lexi', gender: 'female', accent: 'au-neutral' },
    operator: {
      name: 'Vinay Kumar',
      title: 'Sales Director',
      company: 'Hexaware Technologies',
      team: 'the ANZ sales team'
    },
    callback: { number: '+61280000000' },
    ...over
  });
}

describe('the opening', () => {
  it('runs in the order section 8 fixes', () => {
    const segments = buildOpening({ identity: identity(), reason: REASON });
    expect(segments.map((s) => s.id)).toEqual([
      'identity',
      'ai-disclosure',
      'affiliation',
      'reason',
      'recording',
      'permission'
    ]);
  });

  it('gives the agent name first', () => {
    const [first] = buildOpening({ identity: identity(), reason: REASON });
    expect(first?.text).toContain('Lexi');
  });

  it('discloses it is an AI, in the second breath and without hedging', () => {
    const segments = buildOpening({ identity: identity(), reason: REASON });
    const disclosure = segments[1];
    expect(disclosure?.id).toBe('ai-disclosure');
    expect(disclosure?.text).toMatch(/\bAI\b/);
    expect(disclosure?.text).toMatch(/not a person/i);
  });

  it('never softens the disclosure into something a listener could miss', () => {
    const said = renderOpening(buildOpening({ identity: identity(), reason: REASON })).toLowerCase();
    // Each of these is a way of technically disclosing while leaving the
    // prospect believing they are talking to a person.
    for (const evasion of ['virtual assistant', 'digital colleague', 'virtual colleague', 'digital assistant']) {
      expect(said).not.toContain(evasion);
    }
  });

  it('says who it works with and on whose behalf', () => {
    const segments = buildOpening({ identity: identity(), reason: REASON });
    const affiliation = segments.find((s) => s.id === 'affiliation');
    expect(affiliation?.text).toContain('Vinay Kumar');
    expect(affiliation?.text).toContain('Hexaware Technologies');
    expect(affiliation?.text).toContain('ANZ sales team');
  });

  it('announces the recording and asks for thirty seconds', () => {
    const said = renderOpening(buildOpening({ identity: identity(), reason: REASON }));
    expect(said).toMatch(/recorded/i);
    expect(said).toMatch(/thirty seconds/i);
  });

  it('keeps the AI disclosure when the prospect has refused recording', () => {
    const segments = buildOpening({ identity: identity(), reason: REASON, recording: false });
    expect(segments.map((s) => s.id)).toEqual([...SEGMENT_ORDER]);
    expect(segments.find((s) => s.id === 'ai-disclosure')?.text).toMatch(/\bAI\b/);
    expect(segments.find((s) => s.id === 'recording')?.text).toMatch(/stopped the recording/i);
  });
});

describe('when it cannot introduce itself', () => {
  it('refuses to open with no name rather than improvising one', () => {
    const blank = identity({ agent: { name: '', gender: 'female', accent: 'au-neutral' } });
    expect(() => buildOpening({ identity: blank, reason: REASON })).toThrow(OpeningNotAvailableError);
  });

  it('treats whitespace as no name', () => {
    const blank = identity({ agent: { name: '   ', gender: 'female', accent: 'au-neutral' } });
    expect(() => buildOpening({ identity: blank, reason: REASON })).toThrow(/no name/);
  });

  it('refuses without a reason for the call, which section 7.3 requires', () => {
    expect(() => buildOpening({ identity: identity(), reason: '  ' })).toThrow(OpeningNotAvailableError);
  });
});

describe('what Coach may rewrite', () => {
  it('is nothing in the opening', () => {
    expect([...COACH_MAY_NOT_EDIT]).toEqual([...SEGMENT_ORDER]);
  });

  it('hands back segments that cannot be edited in place', () => {
    const segments = buildOpening({ identity: identity(), reason: REASON });
    const disclosure = segments[1];
    expect(Object.isFrozen(disclosure)).toBe(true);
    expect(() => {
      (disclosure as { text: string }).text = 'Hi, I am a person.';
    }).toThrow();
    expect(segments[1]?.text).toMatch(/not a person/i);
  });

  it('keeps the order list frozen too, so nothing can be reordered away', () => {
    expect(Object.isFrozen(SEGMENT_ORDER)).toBe(true);
  });
});

describe('checking what was actually said', () => {
  it('reports a disclosure that never reached the prospect', () => {
    const segments = buildOpening({ identity: identity(), reason: REASON });
    // A turn cut mid-stream: composed, but not heard.
    const truncated = segments.slice(0, 1);
    expect(missingSegments(truncated)).toContain('ai-disclosure');
  });

  it('is happy with a complete opening', () => {
    expect(missingSegments(buildOpening({ identity: identity(), reason: REASON }))).toEqual([]);
  });
});

describe('the shipped identity', () => {
  const shipped = loadIdentity(resolve(ROOT, 'config/agent.yaml'));

  it('is Lexi, female, AU-neutral', () => {
    expect(shipped.agent.name).toBe('Lexi');
    expect(shipped.agent.gender).toBe('female');
    expect(shipped.agent.accent).toBe('au-neutral');
  });

  it('calls on Vinay Kumar’s behalf at Hexaware', () => {
    expect(shipped.operator.name).toBe('Vinay Kumar');
    expect(shipped.operator.company).toBe('Hexaware Technologies');
  });

  it('still has no callback number, and says so rather than hiding it', () => {
    expect(shipped.callback.number).toBe('');
    expect(identityGaps(shipped)).toHaveLength(1);
    expect(identityGaps(shipped)[0]).toMatch(/callback number/);
  });

  it('can open a call, now that it has a name', () => {
    const said = renderOpening(buildOpening({ identity: shipped, reason: REASON }));
    expect(said).toContain('Lexi');
    expect(said).toMatch(/I'm an AI assistant, not a person/);
  });
});
