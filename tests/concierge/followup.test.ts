/**
 * The follow-up matrix, SMS rules and voicemail script.
 *
 * The properties that matter are negative ones: nobody who asked us to stop is
 * texted, no text goes to a landline, nothing outbound goes to a prospect while
 * the kill switch is on. Those are asserted over every combination rather than
 * by example, because a rule that holds for the cases someone thought of is
 * exactly the rule that fails on the one nobody did.
 */

import { describe, expect, it } from 'vitest';
import {
  SMS_WINDOW_MS,
  buildSms,
  isGsm7,
  isOptOut,
  missingFromSms,
  senderCanReceiveReplies,
  smsEligibility,
  smsSegments,
  type LineType
} from '../../src/agents/concierge/sms.js';
import { buildVoicemail, missingFromVoicemail, speakNumber, VoicemailNotAvailableError } from '../../src/agents/concierge/voicemail.js';
import { escalationSuppression, planFollowUp, type FollowUpContext } from '../../src/agents/concierge/followup.js';
import { callOutcomeSchema } from '../../src/blackboard/schemas.js';
import { escalationReasonSchema } from '../../src/agents/caller/tools.js';
import { loadIdentityFromObject } from '../../src/agents/caller/identity.js';

const NOW = new Date('2026-10-07T03:00:00.000Z');
const FIVE_MIN_AGO = new Date(NOW.getTime() - 5 * 60_000);

const identity = loadIdentityFromObject({
  agent: { name: 'Lexi', gender: 'female', accent: 'au-neutral' },
  operator: { name: 'Vinay Kumar', title: 'Sales Director', company: 'Hexaware Technologies', team: 'the ANZ sales team' },
  callback: { number: '+61280001234' }
});

const smsIdentity = {
  agentName: 'Lexi',
  operatorName: 'Vinay Kumar',
  operatorFirstName: 'Vinay',
  company: 'Hexaware'
};

function ctx(over: Partial<FollowUpContext> = {}): FollowUpContext {
  return {
    outcome: 'meeting_requested',
    contactKind: 'prospect',
    conversationOccurred: true,
    lineType: 'mobile',
    endedAt: FIVE_MIN_AGO,
    now: NOW,
    hasEmail: true,
    windowsCaptured: 2,
    killSwitchActive: false,
    smsOptedOut: false,
    smsAlreadySent: false,
    smsSenderConfigured: true,
    alreadySuppressed: false,
    voicemailEmailAlreadyDrafted: false,
    ...over
  };
}

const kinds = (plan: ReturnType<typeof planFollowUp>): string[] => plan.actions.map((a) => a.kind);

/* ------------------------------------------------------------------ */

describe('who may be texted', () => {
  const base = {
    lineType: 'mobile' as LineType,
    conversationOccurred: true,
    endedAt: FIVE_MIN_AGO,
    now: NOW,
    optedOut: false,
    alreadySent: false,
    killSwitchActive: false,
    suppressed: false,
    senderConfigured: true
  };

  it('allows someone who has just spoken to us on a mobile', () => {
    expect(smsEligibility(base)).toEqual({ ok: true });
  });

  it('refuses a landline, which cannot receive one', () => {
    const v = smsEligibility({ ...base, lineType: 'fixed' });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.why).toContain('cannot receive SMS');
  });

  it('refuses a non-geographic number too', () => {
    expect(smsEligibility({ ...base, lineType: 'non-geographic' }).ok).toBe(false);
  });

  it('refuses when nobody actually spoke to us', () => {
    expect(smsEligibility({ ...base, conversationOccurred: false }).ok).toBe(false);
  });

  it('refuses once the thirty minutes are up, and not a moment before', () => {
    const edge = new Date(NOW.getTime() - SMS_WINDOW_MS);
    expect(smsEligibility({ ...base, endedAt: edge }).ok).toBe(true);
    expect(smsEligibility({ ...base, endedAt: new Date(edge.getTime() - 1) }).ok).toBe(false);
  });

  it('refuses someone who has already said STOP', () => {
    expect(smsEligibility({ ...base, optedOut: true }).ok).toBe(false);
  });

  it('refuses a suppressed contact, and says so before anything else', () => {
    const v = smsEligibility({ ...base, suppressed: true, optedOut: true, lineType: 'fixed' });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.why).toContain('suppressed');
  });

  it('refuses while the kill switch is on', () => {
    expect(smsEligibility({ ...base, killSwitchActive: true }).ok).toBe(false);
  });

  it('refuses a second confirmation for the same call', () => {
    expect(smsEligibility({ ...base, alreadySent: true }).ok).toBe(false);
  });

  it('refuses with no sender that a reply could reach', () => {
    const v = smsEligibility({ ...base, senderConfigured: false });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.why).toContain('opt-out reply');
  });
});

describe('what the text says', () => {
  const meeting = buildSms(smsIdentity, { kind: 'meeting-requested', firstName: 'Priya' });
  const callback = buildSms(smsIdentity, { kind: 'callback-requested', firstName: 'Priya', whenLabel: 'on Thursday at 2pm' });

  it('says who it is, that it is an AI, who for, and how to stop', () => {
    expect(missingFromSms(meeting, smsIdentity)).toEqual([]);
    expect(missingFromSms(callback, smsIdentity)).toEqual([]);
  });

  it('promises only an email from Vinay, never a time', () => {
    expect(meeting).toContain('will email you today to confirm');
    expect(meeting).not.toMatch(/\d{1,2}(:\d\d)?\s?(am|pm)|booked|confirmed for/i);
  });

  it('is plain GSM-7, so it is not silently billed as UCS-2', () => {
    // An em dash or curly quote switches the whole message to 70 characters a
    // segment. Easy to introduce, invisible in a code review.
    expect(isGsm7(meeting)).toBe(true);
    expect(isGsm7(callback)).toBe(true);
    expect(isGsm7('a message — with an em dash')).toBe(false);
  });

  it('fits in two segments', () => {
    expect(smsSegments(meeting)).toBeLessThanOrEqual(2);
    expect(smsSegments(callback)).toBeLessThanOrEqual(2);
  });

  it('counts a non-GSM message by the dearer rate', () => {
    // An em dash, not an accented e: e-acute is in the GSM-7 alphabet, which
    // is exactly the kind of thing that makes this easy to get wrong by hand.
    expect(isGsm7('\u00e9')).toBe(true);
    expect(smsSegments('\u2014'.repeat(70))).toBe(1);
    expect(smsSegments('\u2014'.repeat(71))).toBe(2);
    expect(smsSegments('a'.repeat(160))).toBe(1);
    expect(smsSegments('a'.repeat(161))).toBe(2);
  });

  it('reports what a message is missing, rather than trusting its builder', () => {
    expect(missingFromSms('Hi Priya, thanks for your time.', smsIdentity)).toEqual([
      'the sender',
      'that the sender is an AI',
      'who it is on behalf of',
      'a way to opt out'
    ]);
  });

  it('puts the callback time in the callback message', () => {
    expect(callback).toContain('on Thursday at 2pm');
  });
});

describe('reading a reply', () => {
  for (const reply of ['STOP', 'stop', 'Stop.', 'UNSUBSCRIBE', 'cancel', 'QUIT', 'stopall', 'opt out', 'opt-out']) {
    it(`treats "${reply}" as an opt-out`, () => expect(isOptOut(reply)).toBe(true));
  }

  for (const reply of [
    'please stop texting me',
    'Remove me from your list',
    'take my number off',
    "don't contact me again",
    'do not text me',
    'no more messages thanks',
    'leave me alone'
  ]) {
    it(`treats "${reply}" as an opt-out, because people do not write the keyword`, () => {
      expect(isOptOut(reply)).toBe(true);
    });
  }

  it('does not mistake an ordinary reply for one', () => {
    expect(isOptOut('Thanks, Thursday works')).toBe(false);
    expect(isOptOut('Great, speak soon')).toBe(false);
    expect(isOptOut('')).toBe(false);
    expect(isOptOut('   ')).toBe(false);
  });

  it('only counts a sender it can be replied to', () => {
    expect(senderCanReceiveReplies('+61412345678')).toBe(true);
    expect(senderCanReceiveReplies('HEXAWARE')).toBe(false);
    expect(senderCanReceiveReplies('')).toBe(false);
  });
});

/* ------------------------------------------------------------------ */

describe('the voicemail drop', () => {
  const script = buildVoicemail({ identity, firstName: 'Priya', reason: 'about the data platform work at Kiwibank' });

  it('says who is calling, that it is an AI, who for, why, and that it is recorded', () => {
    expect(missingFromVoicemail(script, identity)).toEqual([]);
    expect(script).toContain("it's Lexi");
    expect(script).toContain("I'm an AI assistant");
    expect(script).toContain('Hexaware Technologies');
  });

  it('gives a number to ring back, spoken as digits', () => {
    expect(script).toContain('zero two, eight zero zero zero, one two three four');
  });

  it('does not promise an email that depends on Vinay sending it by hand', () => {
    expect(script).not.toMatch(/email/i);
  });

  it('stays short enough to be heard rather than deleted', () => {
    expect(script.split(/\s+/).length).toBeLessThan(110);
  });

  it('falls back to a generic reason when none is given', () => {
    expect(buildVoicemail({ identity, firstName: 'Priya' })).toContain('one question about your data');
  });

  it('is not left at all with no callback number, which is what the brief forbids', () => {
    const noNumber = loadIdentityFromObject({
      agent: { name: 'Lexi', gender: 'female', accent: 'au-neutral' },
      operator: { name: 'Vinay Kumar', title: 'Sales Director', company: 'Hexaware Technologies', team: 'x' },
      callback: { number: '' }
    });
    expect(() => buildVoicemail({ identity: noNumber, firstName: 'Priya' })).toThrow(VoicemailNotAvailableError);
    expect(() => buildVoicemail({ identity: noNumber, firstName: 'Priya' })).toThrow(/callback number/);
  });

  it('is not left at all with no agent name', () => {
    const noName = loadIdentityFromObject({
      agent: { name: '  ', gender: 'female', accent: 'au-neutral' },
      operator: { name: 'Vinay Kumar', title: 'Sales Director', company: 'Hexaware Technologies', team: 'x' },
      callback: { number: '+61280001234' }
    });
    expect(() => buildVoicemail({ identity: noName, firstName: 'Priya' })).toThrow(/no name/);
  });

  it('reports what a finished script is missing', () => {
    expect(missingFromVoicemail('Hi there, call us back.', identity)).toEqual([
      'who is calling',
      'that the caller is an AI',
      'on whose behalf',
      'why',
      'that it is recorded',
      'a number to ring back'
    ]);
  });
});

describe('speaking a number', () => {
  it('reads an Australian landline as digit words with pauses', () => {
    expect(speakNumber('+61280001234')).toBe('zero two, eight zero zero zero, one two three four');
  });

  it('reads an Australian mobile in its usual 4-3-3 shape', () => {
    expect(speakNumber('+61448455510')).toBe('zero four four eight, four five five, five one zero');
  });

  it('reads a New Zealand landline in its 2-3-4 shape', () => {
    expect(speakNumber('+6444960000')).toBe('zero four, four nine six, zero zero zero zero');
  });

  it('never says "eight thousand" for 8000', () => {
    expect(speakNumber('+61280001234')).not.toMatch(/thousand|hundred/);
  });

  it('falls back to plain digits for a shape it does not know', () => {
    expect(speakNumber('+1415555')).toBe('one four one five five five five');
  });
});

/* ------------------------------------------------------------------ */

describe('the follow-up matrix, row by row', () => {
  it('meeting requested: email Vinay, draft the reply, text them, queue LinkedIn', () => {
    const plan = planFollowUp(ctx());
    expect(kinds(plan)).toEqual(['meeting-request-email', 'draft-reply', 'sms-confirmation', 'linkedin-queue']);
  });

  it('meeting requested on a landline: everything but the text, and says why', () => {
    const plan = planFollowUp(ctx({ lineType: 'fixed' }));
    expect(kinds(plan)).not.toContain('sms-confirmation');
    expect(plan.withheld.find((w) => w.kind === 'sms-confirmation')?.why).toContain('cannot receive SMS');
  });

  it('callback with a time: schedule the retry for that time and confirm by text', () => {
    const at = new Date('2026-10-09T03:00:00.000Z');
    const plan = planFollowUp(ctx({ outcome: 'callback_requested', callbackAt: at }));
    const retry = plan.actions.find((a) => a.kind === 'schedule-retry');
    expect(retry && 'at' in retry ? retry.at : undefined).toEqual(at);
    expect(kinds(plan)).toContain('sms-confirmation');
  });

  it('callback with no time: draft the one-pager email and schedule nothing', () => {
    const plan = planFollowUp(ctx({ outcome: 'callback_requested' }));
    expect(kinds(plan)).toEqual(['draft-one-pager-email']);
    expect(plan.withheld.map((w) => w.kind)).toContain('schedule-retry');
  });

  it('callback with no time and no email: nothing to draft, and says so', () => {
    const plan = planFollowUp(ctx({ outcome: 'callback_requested', hasEmail: false }));
    expect(plan.actions).toEqual([]);
    expect(plan.withheld.find((w) => w.kind === 'draft-one-pager-email')?.why).toContain('no email');
  });

  it('not interested: suppress for good, draft a thank-you, no text', () => {
    const plan = planFollowUp(ctx({ outcome: 'not_interested' }));
    const suppress = plan.actions.find((a) => a.kind === 'suppress');
    expect(suppress && 'targets' in suppress ? suppress.targets : []).toEqual(['contact', 'number']);
    expect(kinds(plan)).toContain('draft-thank-you');
    expect(kinds(plan)).not.toContain('sms-confirmation');
  });

  it('not interested with no email: suppressed, and no draft to make', () => {
    const plan = planFollowUp(ctx({ outcome: 'not_interested', hasEmail: false }));
    expect(kinds(plan)).toEqual(['suppress']);
  });

  it('do not contact: suppress and send nothing at all, not even a thank-you', () => {
    const plan = planFollowUp(ctx({ outcome: 'do_not_contact' }));
    expect(kinds(plan)).toEqual(['suppress']);
    expect(plan.withheld.map((w) => w.kind)).toEqual(expect.arrayContaining(['draft-thank-you', 'sms-confirmation']));
  });

  it('voicemail: one drafted email and a retry, no text', () => {
    const plan = planFollowUp(ctx({ outcome: 'voicemail', conversationOccurred: false }));
    expect(kinds(plan)).toEqual(['draft-voicemail-followup', 'schedule-retry']);
  });

  it('voicemail: never a second drafted email, however many attempts', () => {
    const plan = planFollowUp(ctx({ outcome: 'voicemail', conversationOccurred: false, voicemailEmailAlreadyDrafted: true }));
    expect(kinds(plan)).not.toContain('draft-voicemail-followup');
  });

  it('voicemail with no email held: retry only', () => {
    const plan = planFollowUp(ctx({ outcome: 'voicemail', conversationOccurred: false, hasEmail: false }));
    expect(kinds(plan)).toEqual(['schedule-retry']);
  });

  it('no answer: retry, and no message of any kind', () => {
    expect(kinds(planFollowUp(ctx({ outcome: 'no_answer', conversationOccurred: false })))).toEqual(['schedule-retry']);
  });

  it('gatekeeper: log the routing learned and retry the corrected contact', () => {
    expect(kinds(planFollowUp(ctx({ outcome: 'gatekeeper_blocked', conversationOccurred: false })))).toEqual([
      'log-routing',
      'schedule-retry'
    ]);
  });

  it('wrong person: retire the contact without suppressing anyone permanently', () => {
    const plan = planFollowUp(ctx({ outcome: 'wrong_person' }));
    expect(kinds(plan)).toEqual(['log-routing', 'retire-contact']);
    expect(plan.withheld.find((w) => w.kind === 'suppress')?.why).toContain('not a refusal');
  });

  it('invalid number: retire it, and suppress nothing', () => {
    const plan = planFollowUp(ctx({ outcome: 'invalid_number', conversationOccurred: false }));
    expect(kinds(plan)).toEqual(['retire-contact']);
  });

  it('an already-suppressed contact is not suppressed twice', () => {
    const plan = planFollowUp(ctx({ outcome: 'do_not_contact', alreadySuppressed: true }));
    expect(kinds(plan)).toEqual([]);
    expect(plan.withheld.find((w) => w.kind === 'suppress')?.why).toContain('already suppressed');
  });
});

describe('what an escalation suppresses', () => {
  it('suppresses the whole account for an existing client or partner', () => {
    expect(escalationSuppression('existing-client-or-partner')).toEqual({
      targets: ['contact', 'account'],
      source: 'existing-relationship'
    });
  });

  it('suppresses the whole account for an active procurement', () => {
    expect(escalationSuppression('active-rfp-or-procurement').targets).toContain('account');
  });

  it('files a formal complaint as a complaint', () => {
    expect(escalationSuppression('formal-complaint').source).toBe('complaint');
  });

  it('suppresses only the person for everything else', () => {
    for (const reason of ['legal-threat', 'media-analyst-or-regulator', 'asked-for-a-human', 'hostility', 'personal-or-distressing'] as const) {
      expect(escalationSuppression(reason).targets).toEqual(['contact', 'number']);
    }
  });

  it('alerts Vinay on every escalation', () => {
    for (const reason of escalationReasonSchema.options) {
      const plan = planFollowUp(ctx({ outcome: 'escalated', escalationReason: reason }));
      expect(kinds(plan)).toContain('alert-operator');
    }
  });

  it('still suppresses when the reason was not recorded, taking the narrowest rule', () => {
    const plan = planFollowUp(ctx({ outcome: 'escalated' }));
    const suppress = plan.actions.find((a) => a.kind === 'suppress');
    expect(suppress && 'targets' in suppress ? suppress.targets : []).toEqual(['contact', 'number']);
    expect(plan.actions[0]?.detail).toContain('reason not recorded');
  });

  it('suppresses an account on an existing-client escalation, end to end', () => {
    const plan = planFollowUp(ctx({ outcome: 'escalated', escalationReason: 'existing-client-or-partner' }));
    const suppress = plan.actions.find((a) => a.kind === 'suppress');
    expect(suppress && 'targets' in suppress ? suppress.targets : []).toContain('account');
  });
});

describe('rehearsal must not burn the operator’s own phone', () => {
  it('suppresses a test contact as a contact only, never the number', () => {
    // Suppression is permanent with no removal path. Rehearsing "not
    // interested" from Vinay's phone would otherwise end every future test.
    const plan = planFollowUp(ctx({ outcome: 'not_interested', contactKind: 'test' }));
    const suppress = plan.actions.find((a) => a.kind === 'suppress');
    expect(suppress && 'targets' in suppress ? suppress.targets : []).toEqual(['contact']);
  });

  it('still suppresses a test contact on a do-not-contact, just not the number', () => {
    const plan = planFollowUp(ctx({ outcome: 'do_not_contact', contactKind: 'test' }));
    const suppress = plan.actions.find((a) => a.kind === 'suppress');
    expect(suppress && 'targets' in suppress ? suppress.targets : []).toEqual(['contact']);
  });

  it('never narrows the suppression of a real prospect', () => {
    const plan = planFollowUp(ctx({ outcome: 'do_not_contact', contactKind: 'prospect' }));
    const suppress = plan.actions.find((a) => a.kind === 'suppress');
    expect(suppress && 'targets' in suppress ? suppress.targets : []).toEqual(['contact', 'number']);
  });
});

/* ------------------------------------------------------------------ */

describe('invariants over every outcome and context', () => {
  const bools = [true, false] as const;
  const lines: LineType[] = ['mobile', 'fixed', 'non-geographic'];
  const outcomes = callOutcomeSchema.options;

  const everything: FollowUpContext[] = [];
  for (const outcome of outcomes)
    for (const lineType of lines)
      for (const conversationOccurred of bools)
        for (const smsOptedOut of bools)
          for (const killSwitchActive of bools)
            for (const hasEmail of bools)
              for (const contactKind of ['test', 'prospect'] as const)
                everything.push(
                  ctx({ outcome, lineType, conversationOccurred, smsOptedOut, killSwitchActive, hasEmail, contactKind })
                );

  it(`covers ${everything.length} combinations`, () => {
    expect(everything.length).toBe(outcomes.length * 3 * 2 * 2 * 2 * 2 * 2);
  });

  it('never texts anyone who is not a mobile, spoken to, not opted out, and not halted', () => {
    const breaches: string[] = [];
    for (const c of everything) {
      const plan = planFollowUp(c);
      if (!kinds(plan).includes('sms-confirmation')) continue;
      if (c.lineType !== 'mobile') breaches.push(`${c.outcome}: texted a ${c.lineType}`);
      if (!c.conversationOccurred) breaches.push(`${c.outcome}: texted without a conversation`);
      if (c.smsOptedOut) breaches.push(`${c.outcome}: texted someone who opted out`);
      if (c.killSwitchActive) breaches.push(`${c.outcome}: texted while halted`);
    }
    expect(breaches).toEqual([]);
  });

  it('only ever texts after a meeting or a timed callback', () => {
    const breaches: string[] = [];
    for (const c of everything) {
      const plan = planFollowUp(c);
      if (kinds(plan).includes('sms-confirmation') && c.outcome !== 'meeting_requested' && c.outcome !== 'callback_requested') {
        breaches.push(c.outcome);
      }
    }
    expect(breaches).toEqual([]);
  });

  it('always suppresses after a do-not-contact, and sends nothing further', () => {
    for (const c of everything.filter((x) => x.outcome === 'do_not_contact')) {
      const plan = planFollowUp(c);
      expect(kinds(plan)).toEqual(['suppress']);
    }
  });

  it('always alerts Vinay and suppresses after an escalation', () => {
    for (const c of everything.filter((x) => x.outcome === 'escalated')) {
      expect(kinds(planFollowUp(c))).toEqual(expect.arrayContaining(['alert-operator', 'suppress']));
    }
  });

  it('never plans anything to a prospect that is not either an SMS or a draft for Vinay', () => {
    // Prospect email leaves from Vinay's own mailbox (section 12.2), so the
    // only things this system can send a prospect directly are texts.
    const allowed = new Set([
      'meeting-request-email',
      'draft-reply',
      'sms-confirmation',
      'linkedin-queue',
      'schedule-retry',
      'draft-one-pager-email',
      'draft-thank-you',
      'draft-voicemail-followup',
      'suppress',
      'retire-contact',
      'log-routing',
      'alert-operator'
    ]);
    for (const c of everything) {
      for (const action of planFollowUp(c).actions) expect(allowed.has(action.kind)).toBe(true);
    }
  });

  it('throws on an outcome the matrix does not know rather than doing nothing', () => {
    expect(() => planFollowUp(ctx({ outcome: 'went_well' as never }))).toThrow(/no follow-up is defined/);
  });

  it('always explains itself: every plan is either actions or reasons', () => {
    for (const c of everything) {
      const plan = planFollowUp(c);
      expect(plan.actions.length + plan.withheld.length).toBeGreaterThan(0);
    }
  });
});
