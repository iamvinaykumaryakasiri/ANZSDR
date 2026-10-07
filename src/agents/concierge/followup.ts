/**
 * The follow-up matrix (brief section 12.3), as a function.
 *
 * Given how a call ended, what happens next? Deterministic on purpose. This
 * decides who is texted, who is permanently suppressed and what is left alone,
 * and section 0's first rule is that anything like that is code rather than a
 * model's judgement.
 *
 * It plans; it does not do. Nothing here sends, dials or writes. The Director
 * and Concierge act on a plan, and a retry in it is a *request* - the
 * compliance gate still rules on the dial when the time comes.
 *
 * Every action it declines to take is recorded with the reason, because "why
 * didn't we text her?" is a question someone will ask and the answer should not
 * need reconstructing.
 */

import type { CallOutcome } from '../../blackboard/schemas.js';
import type { SuppressionSource } from '../../compliance/types.js';
import type { z } from 'zod';
import type { escalationReasonSchema } from '../caller/tools.js';
import { smsEligibility, type LineType } from './sms.js';

export type EscalationReason = z.infer<typeof escalationReasonSchema>;
export type SuppressionTarget = 'contact' | 'number' | 'account';

export type ActionKind =
  | 'meeting-request-email'
  | 'draft-reply'
  | 'sms-confirmation'
  | 'linkedin-queue'
  | 'schedule-retry'
  | 'draft-one-pager-email'
  | 'draft-thank-you'
  | 'draft-voicemail-followup'
  | 'retire-contact'
  | 'log-routing'
  | 'alert-operator';

export type PlannedAction =
  | { kind: ActionKind; detail: string; at?: Date }
  | { kind: 'suppress'; detail: string; targets: SuppressionTarget[]; source: SuppressionSource };

export interface WithheldAction {
  kind: ActionKind | 'suppress';
  why: string;
}

export interface FollowUpPlan {
  actions: PlannedAction[];
  withheld: WithheldAction[];
}

export interface FollowUpContext {
  outcome: CallOutcome;
  /** `test` is a number Vinay controls. Rehearsal must not burn it for good. */
  contactKind: 'test' | 'prospect';
  conversationOccurred: boolean;
  lineType: LineType;
  endedAt: Date;
  now: Date;
  /** An address we could send a drafted email to. */
  hasEmail: boolean;
  windowsCaptured: number;
  /** For a callback: when they said to ring. Absent means "interested, no time now". */
  callbackAt?: Date;
  callbackLabel?: string;
  escalationReason?: EscalationReason;
  killSwitchActive: boolean;
  smsOptedOut: boolean;
  smsAlreadySent: boolean;
  smsSenderConfigured: boolean;
  /** A suppression entry already covers this contact or number. */
  alreadySuppressed: boolean;
  voicemailEmailAlreadyDrafted: boolean;
}

/**
 * What an escalation suppresses, and under which source.
 *
 * Section 8 says "end politely, suppress, alert Vinay immediately" without
 * saying what to suppress. Two of the reasons are about the organisation rather
 * than the person - an existing client or partner, an active procurement - and
 * ringing a different person there next week is the same mistake, so those
 * suppress the whole account. Everything else is about the individual.
 */
export function escalationSuppression(reason: EscalationReason): {
  targets: SuppressionTarget[];
  source: SuppressionSource;
} {
  switch (reason) {
    case 'existing-client-or-partner':
      return { targets: ['contact', 'account'], source: 'existing-relationship' };
    case 'active-rfp-or-procurement':
      return { targets: ['contact', 'account'], source: 'escalation' };
    case 'formal-complaint':
      return { targets: ['contact', 'number'], source: 'complaint' };
    case 'legal-threat':
    case 'media-analyst-or-regulator':
    case 'asked-for-a-human':
    case 'hostility':
    case 'personal-or-distressing':
      return { targets: ['contact', 'number'], source: 'escalation' };
  }
}

/**
 * Suppress the person and, for a real prospect, the number as well.
 *
 * A test contact is suppressed as a contact only. Suppression is permanent and
 * has no removal path, so rehearsing "not interested" from Vinay's own phone
 * would otherwise burn that number for every future test. The contact record
 * is spent; he can add another. The cost is that a real prospect wrongly marked
 * `test` would be suppressed less thoroughly, which the gate's own handling of
 * `test` already treats as the dangerous mistake to make.
 */
export function narrowForTestContact(kind: 'test' | 'prospect', wanted: SuppressionTarget[]): SuppressionTarget[] {
  if (kind === 'test') return wanted.filter((t) => t === 'contact');
  return wanted;
}

function personTargets(ctx: FollowUpContext, wanted: SuppressionTarget[]): SuppressionTarget[] {
  return narrowForTestContact(ctx.contactKind, wanted);
}

export function planFollowUp(ctx: FollowUpContext): FollowUpPlan {
  const actions: PlannedAction[] = [];
  const withheld: WithheldAction[] = [];

  const act = (kind: ActionKind, detail: string, at?: Date): void => {
    actions.push(at === undefined ? { kind, detail } : { kind, detail, at });
  };
  const hold = (kind: ActionKind | 'suppress', why: string): void => {
    withheld.push({ kind, why });
  };
  const suppress = (detail: string, wanted: SuppressionTarget[], source: SuppressionSource): void => {
    if (ctx.alreadySuppressed) {
      hold('suppress', 'already suppressed; adding a second entry would only duplicate it');
      return;
    }
    actions.push({ kind: 'suppress', detail, targets: personTargets(ctx, wanted), source });
  };

  const sms = (purpose: string): void => {
    const verdict = smsEligibility({
      lineType: ctx.lineType,
      conversationOccurred: ctx.conversationOccurred,
      endedAt: ctx.endedAt,
      now: ctx.now,
      optedOut: ctx.smsOptedOut,
      alreadySent: ctx.smsAlreadySent,
      killSwitchActive: ctx.killSwitchActive,
      suppressed: ctx.alreadySuppressed,
      senderConfigured: ctx.smsSenderConfigured
    });
    if (verdict.ok) act('sms-confirmation', purpose);
    else hold('sms-confirmation', verdict.why);
  };

  switch (ctx.outcome) {
    case 'meeting_requested':
      act('meeting-request-email', 'send Vinay the request, with the .ics and a draft reply');
      act('draft-reply', 'a ready-to-send reply for Vinay to send from his own Outlook');
      sms('confirm a follow-up email is coming');
      act('linkedin-queue', 'queue a connect request for Vinay to send by hand; never automated');
      break;

    case 'callback_requested':
      if (ctx.callbackAt !== undefined) {
        act('schedule-retry', 'ring back at the time they gave; the compliance gate rules on the dial', ctx.callbackAt);
        sms('confirm when we will ring back');
      } else {
        // The brief's "interested, no time now". The outcome list in section 5.5
        // has no value for it, so it is read as a callback with no stated time.
        if (ctx.hasEmail) {
          act('draft-one-pager-email', 'a short email with a one-pager and two windows, prepared for Vinay');
        } else {
          hold('draft-one-pager-email', 'no email address is held for them, so there is nothing to draft to');
        }
        hold('schedule-retry', 'they gave no time to ring back, so none is scheduled');
        hold('sms-confirmation', 'there is nothing specific to confirm');
      }
      break;

    case 'not_interested':
      suppress('they declined: no further contact', ['contact', 'number'], 'not-interested');
      if (ctx.hasEmail) {
        act('draft-thank-you', 'a brief thank-you for Vinay to send or bin; it asks for nothing');
      } else {
        hold('draft-thank-you', 'no email address is held for them');
      }
      hold('sms-confirmation', 'they declined, and a decline is not followed by a text');
      break;

    case 'do_not_contact':
      suppress('they asked not to be contacted again', ['contact', 'number'], 'prospect-request');
      // Nothing at all goes to someone who asked us to stop. Not a courtesy
      // email, not a thank-you: those are further contact.
      hold('draft-thank-you', 'they asked us to stop, so nothing further is drafted or sent');
      hold('sms-confirmation', 'they asked us to stop');
      break;

    case 'escalated': {
      const reason = ctx.escalationReason;
      act('alert-operator', reason === undefined ? 'escalated, reason not recorded' : `escalated: ${reason}`);
      if (reason === undefined) {
        // An escalation with no reason cannot be matched to a suppression rule,
        // so it takes the narrowest permanent one rather than none.
        suppress('escalated with no reason recorded', ['contact', 'number'], 'escalation');
      } else {
        const rule = escalationSuppression(reason);
        suppress(`escalated (${reason}): suppressed`, rule.targets, rule.source);
      }
      hold('sms-confirmation', 'an escalated call is not followed by a text');
      break;
    }

    case 'voicemail':
      // The drop itself happened on the already-gated call. What follows is at
      // most one drafted email, once, however many attempts it takes.
      if (ctx.voicemailEmailAlreadyDrafted) {
        hold('draft-voicemail-followup', 'one voicemail email has already been drafted for this person');
      } else if (!ctx.hasEmail) {
        hold('draft-voicemail-followup', 'no email address is held for them');
      } else {
        act('draft-voicemail-followup', 'one short email for Vinay to send, once');
      }
      act('schedule-retry', 'try again per the cadence; the gate rules on the dial');
      hold('sms-confirmation', 'nobody spoke to us, and SMS is only for people who have just spoken to us');
      break;

    case 'no_answer':
      act('schedule-retry', 'try again per the cadence; the gate rules on the dial');
      hold('sms-confirmation', 'no answer means no message');
      break;

    case 'gatekeeper_blocked':
      act('log-routing', 'record who the gatekeeper pointed to, and the best route');
      act('schedule-retry', 'try the corrected contact; the gate rules on the dial');
      hold('sms-confirmation', 'nobody we were calling for spoke to us');
      break;

    case 'wrong_person':
      act('log-routing', 'record who the right person is, if they said');
      act('retire-contact', 'stop calling this contact; a wrong number is a data problem, not a refusal');
      hold('suppress', 'a wrong number is not a refusal, so nothing is suppressed permanently');
      hold('sms-confirmation', 'we reached the wrong person');
      break;

    case 'invalid_number':
      act('retire-contact', 'the number does not connect; stop spending attempts on it');
      hold('suppress', 'a dead number is not a refusal, so nothing is suppressed permanently');
      hold('sms-confirmation', 'the number did not connect');
      break;

    default: {
      // Adding an outcome to section 5.5 must fail here, at compile time, rather
      // than fall through to doing nothing in production.
      const unreachable: never = ctx.outcome;
      throw new Error(`no follow-up is defined for outcome "${String(unreachable)}"`);
    }
  }

  return { actions, withheld };
}
