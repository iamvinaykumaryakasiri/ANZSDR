/**
 * Scribe's rules. These decide what a call *was*, and what a call was decides
 * whether a stranger is texted and whether someone is suppressed for good, so
 * the cases that matter are the ones where the evidence disagrees with itself.
 */

import { describe, expect, it } from 'vitest';
import {
  bestEmail,
  checkWindows,
  contactStatusAfter,
  resolveOutcome,
  validCalls,
  type ValidCall
} from '../../src/agents/scribe/rules.js';
import { callOutcomeSchema } from '../../src/blackboard/schemas.js';

const mark = (outcome: string): ValidCall => ({ name: 'mark_outcome', value: { outcome, note: '' } });
const suppress = (reason: string): ValidCall => ({ name: 'suppress_contact', value: { reason, saidAs: 'x' } });
const escalate = (reason: string): ValidCall => ({
  name: 'escalate',
  value: { reason, saidAs: 'x', closedPolitely: true }
});

describe('re-validating the journal', () => {
  it('keeps a good call and turns a bad one into a defect', () => {
    const { valid, defects } = validCalls([
      { name: 'mark_outcome', value: { outcome: 'meeting_requested' } },
      { name: 'mark_outcome', value: { outcome: 'went_well' } },
      { name: 'book_meeting', value: {} }
    ]);
    expect(valid).toHaveLength(1);
    expect(defects.map((d) => d.kind)).toEqual(['bad-tool-call', 'bad-tool-call']);
  });
});

describe('what the call was', () => {
  it('takes the outcome Lexi marked when nothing contradicts it', () => {
    expect(resolveOutcome([mark('meeting_requested')]).outcome).toBe('meeting_requested');
  });

  it('takes the last mark, because a correction is the last thing said', () => {
    expect(resolveOutcome([mark('callback_requested'), mark('meeting_requested')]).outcome).toBe('meeting_requested');
  });

  it('records nothing when nothing was marked, rather than guessing', () => {
    // Every outcome has a follow-up and several are permanent. A hang-up is not
    // evidence of any of them.
    const r = resolveOutcome([]);
    expect(r.outcome).toBeNull();
    expect(r.defects[0]?.kind).toBe('outcome-missing');
  });

  it('lets an escalation win over a friendlier mark, and records the contradiction', () => {
    const r = resolveOutcome([mark('meeting_requested'), escalate('legal-threat')]);
    expect(r.outcome).toBe('escalated');
    expect(r.escalationReason).toBe('legal-threat');
    expect(r.defects[0]?.kind).toBe('outcome-contradicted');
  });

  it('does not call it a contradiction when the mark already says escalated', () => {
    const r = resolveOutcome([mark('escalated'), escalate('hostility')]);
    expect(r.outcome).toBe('escalated');
    expect(r.defects).toEqual([]);
  });

  it('escalates on the tool call alone when nothing was marked', () => {
    expect(resolveOutcome([escalate('asked-for-a-human')]).outcome).toBe('escalated');
  });

  it('lets a request to be left alone beat a mark of meeting_requested', () => {
    // The next step for a meeting request is a text message, so this is the
    // case the whole function exists for.
    const r = resolveOutcome([mark('meeting_requested'), suppress('asked-not-to-be-called')]);
    expect(r.outcome).toBe('do_not_contact');
    expect(r.defects[0]?.detail).toContain('recorded as do_not_contact');
  });

  it('is not a contradiction when the mark already agrees', () => {
    expect(resolveOutcome([mark('do_not_contact'), suppress('asked-not-to-be-called')]).defects).toEqual([]);
  });

  it('records a wrong number as a wrong number, not as a refusal', () => {
    expect(resolveOutcome([suppress('wrong-person')]).outcome).toBe('wrong_person');
    expect(resolveOutcome([suppress('deceased-or-left')]).outcome).toBe('wrong_person');
  });

  it('keeps do_not_contact when Lexi marked it but only gave "wrong person" as the reason', () => {
    // The strictest reading wins: a refusal must never be downgraded to a data
    // problem, because that is the mistake that texts someone who said stop.
    expect(resolveOutcome([mark('do_not_contact'), suppress('wrong-person')]).outcome).toBe('do_not_contact');
  });

  it('treats a complaint or an unspecified reason as a refusal', () => {
    expect(resolveOutcome([suppress('complaint')]).outcome).toBe('do_not_contact');
    expect(resolveOutcome([suppress('other')]).outcome).toBe('do_not_contact');
  });

  it('prefers the stricter outcome over a wrong_person mark with a refusal behind it', () => {
    expect(resolveOutcome([mark('wrong_person'), suppress('asked-not-to-be-called')]).outcome).toBe('do_not_contact');
  });

  it('lets escalation beat a suppression request too', () => {
    expect(resolveOutcome([suppress('wrong-person'), escalate('hostility')]).outcome).toBe('escalated');
  });
});

describe('the best address to write to', () => {
  const held = (address: string, kind: string, verified = false) => ({ address, kind, verified });

  it('prefers a confirmed-on-call address that was read back', () => {
    expect(bestEmail([held('a@x.com', 'apollo_work', true), held('b@x.com', 'confirmed_on_call', true)])).toEqual({
      address: 'b@x.com',
      source: 'confirmed_on_call'
    });
  });

  it('labels an address heard once for what it is, and mentions what else is on file', () => {
    const chosen = bestEmail([held('b@x.com', 'confirmed_on_call', false), held('a@x.com', 'apollo_work')]);
    expect(chosen).toEqual({ address: 'b@x.com', source: 'heard_once', alsoOnFile: 'a@x.com' });
  });

  it('falls back to a personal address as the alternative when there is no work one', () => {
    const chosen = bestEmail([held('b@x.com', 'confirmed_on_call', false), held('p@home.com', 'apollo_personal')]);
    expect(chosen?.alsoOnFile).toBe('p@home.com');
  });

  it('has nothing to mention when a heard-once address is the only one', () => {
    expect(bestEmail([held('b@x.com', 'confirmed_on_call', false)])).toEqual({ address: 'b@x.com', source: 'heard_once' });
  });

  it('uses the work address from the data provider when nothing was captured', () => {
    expect(bestEmail([held('a@x.com', 'apollo_work'), held('p@home.com', 'apollo_personal')])).toEqual({
      address: 'a@x.com',
      source: 'apollo_work'
    });
  });

  it('uses a personal address only when it is all there is', () => {
    expect(bestEmail([held('p@home.com', 'apollo_personal')])?.source).toBe('apollo_personal');
  });

  it('has nothing when nothing is held', () => {
    expect(bestEmail([])).toBeNull();
  });
});

describe('windows that could actually happen', () => {
  const ENDED = new Date('2026-10-07T03:00:00.000Z');
  const window = (startsAt: string) => ({ saidAs: 'a Tuesday', startsAt, endsAt: startsAt });

  it('keeps a window in the future', () => {
    const r = checkWindows([window('2026-10-13T09:00:00+13:00')], ENDED);
    expect(r.windows).toHaveLength(1);
    expect(r.defects).toEqual([]);
  });

  it('drops one the model normalised to last Tuesday, and says so', () => {
    const r = checkWindows([window('2026-09-29T09:00:00+13:00')], ENDED);
    expect(r.windows).toEqual([]);
    expect(r.defects[0]?.kind).toBe('window-in-the-past');
  });

  it('drops one that starts exactly when the call ended', () => {
    expect(checkWindows([window(ENDED.toISOString())], ENDED).windows).toEqual([]);
  });

  it('keeps the good one when only some are wrong', () => {
    const r = checkWindows([window('2026-09-29T09:00:00+13:00'), window('2026-10-13T09:00:00+13:00')], ENDED);
    expect(r.windows).toHaveLength(1);
    expect(r.defects).toHaveLength(1);
  });
});

describe('where the contact goes next', () => {
  it('closes everyone who said no, asked us to stop, escalated or was the wrong number', () => {
    for (const outcome of ['not_interested', 'do_not_contact', 'escalated', 'wrong_person', 'invalid_number'] as const) {
      expect(contactStatusAfter(outcome, 'queued')).toBe('done');
    }
  });

  it('leaves anyone we will try again exactly where they were', () => {
    for (const outcome of ['voicemail', 'no_answer', 'gatekeeper_blocked'] as const) {
      expect(contactStatusAfter(outcome, 'queued')).toBe('queued');
    }
  });

  it('keeps a meeting request out of the call plan and a callback in it', () => {
    expect(contactStatusAfter('meeting_requested', 'researched')).toBe('contacted');
    expect(contactStatusAfter('callback_requested', 'researched')).toBe('queued');
  });

  it('changes nothing when no outcome was recorded', () => {
    expect(contactStatusAfter(null, 'researched')).toBe('researched');
  });

  it('never walks a closed contact backwards, whatever the call says', () => {
    for (const outcome of callOutcomeSchema.options) {
      expect(contactStatusAfter(outcome, 'done')).toBe('done');
    }
  });
});
