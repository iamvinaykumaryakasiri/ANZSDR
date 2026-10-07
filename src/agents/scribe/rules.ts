/**
 * The deterministic part of writing a call down.
 *
 * Scribe has a model for the one thing a model is good at here - summarising a
 * conversation - and everything else is rules. Which outcome a call had, which
 * email address is best, which preferred windows are real: those feed
 * suppression, a text to a stranger and an email to Vinay, so they are code.
 *
 * The single most important rule is in `resolveOutcome`: Lexi's own mark is not
 * the last word. A call where the prospect asked to be left alone cannot be
 * recorded as a meeting request because the model got enthusiastic, since the
 * next step for a meeting request is a text message.
 */

import { DateTime } from 'luxon';
import type { CallOutcome } from '../../blackboard/schemas.js';
import type { CallerToolName } from '../caller/tools.js';
import { validateToolCall } from '../caller/tools.js';
import type { EmailSource, PreferredWindow } from '../concierge/meeting-email.js';
import type { EscalationReason } from '../concierge/followup.js';

export interface JournalToolCall {
  name: string;
  value: unknown;
}

export interface RuleDefect {
  kind:
    | 'outcome-missing'
    | 'outcome-contradicted'
    | 'bad-tool-call'
    | 'window-in-the-past'
    | 'window-missing';
  detail: string;
}

export interface ValidCall {
  name: CallerToolName;
  value: unknown;
}

/**
 * Re-validate every tool call from the journal.
 *
 * The brain already validated them, and Scribe validates them again: it is a
 * boundary, the journal is persisted state that something else wrote, and rule
 * three is about what happens before anything is acted on rather than about who
 * checked first.
 */
export function validCalls(calls: JournalToolCall[]): { valid: ValidCall[]; defects: RuleDefect[] } {
  const valid: ValidCall[] = [];
  const defects: RuleDefect[] = [];
  for (const call of calls) {
    const checked = validateToolCall(call.name, call.value);
    if (checked.ok) valid.push({ name: checked.name, value: checked.value });
    else defects.push({ kind: 'bad-tool-call', detail: checked.error });
  }
  return { valid, defects };
}

function last<T>(items: T[]): T | undefined {
  return items[items.length - 1];
}

export interface ResolvedOutcome {
  outcome: CallOutcome | null;
  escalationReason?: EscalationReason;
  defects: RuleDefect[];
}

/**
 * What the call was, when the evidence disagrees with itself.
 *
 * An escalation wins over everything, because section 8 says to end politely,
 * suppress and alert immediately and nothing about a marked outcome changes
 * that. A suppress request beats a friendlier mark for the same reason: someone
 * who asked to be left alone is not "interested" because a model recorded it
 * that way. Where Lexi marked nothing at all the answer is null, not a guess -
 * every outcome has a follow-up, several are permanent, and a hung-up call is
 * not evidence of any of them.
 */
export function resolveOutcome(calls: ValidCall[]): ResolvedOutcome {
  const defects: RuleDefect[] = [];

  const escalation = last(calls.filter((c) => c.name === 'escalate'));
  if (escalation !== undefined) {
    const reason = (escalation.value as { reason: EscalationReason }).reason;
    const marked = last(calls.filter((c) => c.name === 'mark_outcome'));
    const markedOutcome = marked === undefined ? undefined : (marked.value as { outcome: CallOutcome }).outcome;
    if (markedOutcome !== undefined && markedOutcome !== 'escalated') {
      defects.push({
        kind: 'outcome-contradicted',
        detail: `marked ${markedOutcome} but the call was escalated (${reason}); recorded as escalated`
      });
    }
    return { outcome: 'escalated', escalationReason: reason, defects };
  }

  const marked = last(calls.filter((c) => c.name === 'mark_outcome'));
  const markedOutcome = marked === undefined ? null : (marked.value as { outcome: CallOutcome }).outcome;

  const suppress = last(calls.filter((c) => c.name === 'suppress_contact'));
  if (suppress !== undefined) {
    const reason = (suppress.value as { reason: string }).reason;
    // A wrong number is not a refusal and must not be recorded as one.
    const implied: CallOutcome =
      reason === 'wrong-person' || reason === 'deceased-or-left' ? 'wrong_person' : 'do_not_contact';

    // The strictest reading wins, and do_not_contact is the strictest: it is a
    // refusal where wrong_person is not. So a call marked do_not_contact stays
    // that way even if the suppression reason was only "wrong person" - losing
    // a refusal is the mistake that texts someone who asked us to stop.
    const outcome: CallOutcome = markedOutcome === 'do_not_contact' ? 'do_not_contact' : implied;

    if (markedOutcome !== null && markedOutcome !== outcome) {
      defects.push({
        kind: 'outcome-contradicted',
        detail: `marked ${markedOutcome} but suppress_contact was called (${reason}); recorded as ${outcome}`
      });
    }
    return { outcome, defects };
  }

  if (markedOutcome === null) {
    defects.push({
      kind: 'outcome-missing',
      detail:
        'the call ended without an outcome being marked, so none is recorded and nothing irreversible follows from it; it needs a look'
    });
    return { outcome: null, defects };
  }

  return { outcome: markedOutcome, defects };
}

/** One email address with its provenance, as held on the blackboard. */
export interface HeldEmail {
  address: string;
  kind: string;
  verified: boolean;
}

export interface ChosenEmail {
  address: string;
  source: EmailSource;
  /** A second address on file, shown only when the first is not safe to trust. */
  alsoOnFile?: string;
}

/**
 * The best address to write to, and an honest label for it.
 *
 * Section 5.2: a confirmed-on-call address always wins. One heard once and
 * never read back is still that kind and still wins, but it is labelled for
 * what it is, and when something else is on file that is mentioned too - a
 * mistranscribed address means a meeting request about a bank going to a
 * stranger.
 */
export function bestEmail(held: HeldEmail[]): ChosenEmail | null {
  const byKind = (kind: string): HeldEmail | undefined => held.find((e) => e.kind === kind);
  const confirmed = byKind('confirmed_on_call');
  const work = byKind('apollo_work');
  const personal = byKind('apollo_personal');

  const others = (...skip: Array<HeldEmail | undefined>): string | undefined =>
    [work, personal].find((e) => e !== undefined && !skip.includes(e))?.address;

  if (confirmed !== undefined) {
    if (confirmed.verified) return { address: confirmed.address, source: 'confirmed_on_call' };
    const alt = others();
    return {
      address: confirmed.address,
      source: 'heard_once',
      ...(alt !== undefined ? { alsoOnFile: alt } : {})
    };
  }
  if (work !== undefined) return { address: work.address, source: 'apollo_work' };
  if (personal !== undefined) return { address: personal.address, source: 'apollo_personal' };
  return null;
}

export interface CheckedWindows {
  windows: PreferredWindow[];
  defects: RuleDefect[];
}

/**
 * Keep only windows that could actually happen.
 *
 * The model normalises "Tuesday morning" into a concrete range, and the classic
 * way to get that wrong is to land on last Tuesday. A window that starts before
 * the call ended is not a preference, it is a mistake, and putting it at the
 * top of Vinay's email is how a meeting gets proposed for the past.
 */
export function checkWindows(windows: PreferredWindow[], callEndedAt: Date): CheckedWindows {
  const kept: PreferredWindow[] = [];
  const defects: RuleDefect[] = [];

  for (const window of windows) {
    const starts = DateTime.fromISO(window.startsAt, { setZone: true });
    if (starts.toMillis() <= callEndedAt.getTime()) {
      defects.push({
        kind: 'window-in-the-past',
        detail: `"${window.saidAs}" was normalised to ${window.startsAt}, which is before the call ended; dropped`
      });
      continue;
    }
    kept.push(window);
  }
  return { windows: kept, defects };
}

/** What a finished call does to the contact's place in the pipeline. */
export function contactStatusAfter(outcome: CallOutcome | null, current: string): string {
  // Never walk anything backwards. A contact Vinay has already closed stays
  // closed however many times Scribe runs over the call that closed it.
  if (current === 'done') return current;

  switch (outcome) {
    case 'meeting_requested':
      return 'contacted';
    case 'callback_requested':
      return 'queued';
    case 'not_interested':
    case 'do_not_contact':
    case 'escalated':
    case 'wrong_person':
    case 'invalid_number':
      return 'done';
    case 'voicemail':
    case 'no_answer':
    case 'gatekeeper_blocked':
    case null:
      return current;
  }
}
