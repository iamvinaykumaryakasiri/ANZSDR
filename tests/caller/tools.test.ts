/**
 * The six tools. A malformed call from the model must be a refusal it can read,
 * never a bad row on the blackboard - the third overriding rule at the one
 * point where a call touches the outside world.
 */

import { describe, expect, it } from 'vitest';
import { CALLER_TOOL_NAMES, inSydney, validateToolCall } from '../../src/agents/caller/tools.js';

describe('the tool set', () => {
  it('is exactly the six section 3.3 names', () => {
    expect([...CALLER_TOOL_NAMES].sort()).toEqual([
      'capture_email',
      'capture_preferred_times',
      'escalate',
      'log_objection',
      'mark_outcome',
      'suppress_contact'
    ]);
  });

  it('refuses a tool it has never heard of, and says what it does have', () => {
    const result = validateToolCall('book_meeting', { when: 'Tuesday' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('no tool called "book_meeting"');
      expect(result.error).toContain('capture_email');
    }
  });
});

describe('capture_email', () => {
  it('normalises and accepts a confirmed address', () => {
    const result = validateToolCall('capture_email', {
      email: '  Priya.Raman@Kiwibank.CO.NZ ',
      confidence: 'read-back-confirmed'
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect((result.value as { email: string }).email).toBe('priya.raman@kiwibank.co.nz');
  });

  it('refuses something that is not an address', () => {
    expect(validateToolCall('capture_email', { email: 'priya at kiwibank', confidence: 'heard-once' }).ok).toBe(false);
  });

  it('requires the model to say whether it read it back', () => {
    expect(validateToolCall('capture_email', { email: 'a@b.com' }).ok).toBe(false);
  });
});

describe('capture_preferred_times', () => {
  const slot = {
    saidAs: 'Tuesday or Wednesday morning',
    startsAt: '2026-09-22T09:00:00+12:00',
    endsAt: '2026-09-22T12:00:00+12:00'
  };

  it('keeps both the prospect’s words and the normalised range', () => {
    const result = validateToolCall('capture_preferred_times', {
      slots: [slot],
      timezone: 'Pacific/Auckland',
      attendees: ['our head of architecture']
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const value = result.value as { slots: Array<{ saidAs: string }> };
      expect(value.slots[0]?.saidAs).toBe('Tuesday or Wednesday morning');
    }
  });

  it('refuses a timezone that is not real', () => {
    const result = validateToolCall('capture_preferred_times', { slots: [slot], timezone: 'NZ Standard Time' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('unknown timezone');
  });

  it('refuses a window that ends before it starts', () => {
    const backwards = { ...slot, startsAt: slot.endsAt, endsAt: slot.startsAt };
    const result = validateToolCall('capture_preferred_times', { slots: [backwards], timezone: 'Pacific/Auckland' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('end after it starts');
  });

  it('refuses more than three windows, which is what section 10 asks for', () => {
    expect(
      validateToolCall('capture_preferred_times', { slots: [slot, slot, slot, slot], timezone: 'Pacific/Auckland' }).ok
    ).toBe(false);
  });

  it('shows a window in Sydney time as well as theirs', () => {
    // 09:00 Auckland is 07:00 Sydney in September.
    expect(inSydney('2026-09-22T09:00:00+12:00')).toContain('07:00');
  });
});

describe('escalate', () => {
  it('will not take a vague reason', () => {
    expect(validateToolCall('escalate', { reason: 'seemed cross', saidAs: 'x', closedPolitely: true }).ok).toBe(false);
  });

  it('takes the section 8 triggers', () => {
    for (const reason of ['legal-threat', 'media-analyst-or-regulator', 'asked-for-a-human', 'active-rfp-or-procurement']) {
      expect(validateToolCall('escalate', { reason, saidAs: 'they said so', closedPolitely: true }).ok).toBe(true);
    }
  });

  it('makes the model state whether it closed the call first', () => {
    expect(validateToolCall('escalate', { reason: 'hostility', saidAs: 'x' }).ok).toBe(false);
  });
});

describe('suppress_contact', () => {
  it('records what they actually said, not just a label', () => {
    expect(validateToolCall('suppress_contact', { reason: 'asked-not-to-be-called' }).ok).toBe(false);
    expect(
      validateToolCall('suppress_contact', { reason: 'asked-not-to-be-called', saidAs: 'take me off your list' }).ok
    ).toBe(true);
  });
});

describe('mark_outcome', () => {
  it('only takes a section 5.5 outcome', () => {
    expect(validateToolCall('mark_outcome', { outcome: 'went_well' }).ok).toBe(false);
    expect(validateToolCall('mark_outcome', { outcome: 'meeting_requested' }).ok).toBe(true);
  });
});

describe('what Lexi has no handle for', () => {
  it('cannot book, quote, send or look anything up', () => {
    for (const absent of ['book_meeting', 'quote_price', 'send_email', 'search_web', 'lookup_claim', 'unsuppress']) {
      expect(validateToolCall(absent, {}).ok, `${absent} must not exist`).toBe(false);
    }
  });
});
