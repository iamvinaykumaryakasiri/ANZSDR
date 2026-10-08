/**
 * What was Jarvis asked?
 *
 * Deterministic rules, no model. The split that matters is between asking and
 * telling. A question is read-only and is answered at once. An instruction
 * changes state, spends money or touches a prospect, so it is never run on the
 * strength of being parsed: it becomes a confirmation the operator has to
 * approve separately (section 14.3). And anything this file does not recognise is
 * `unknown`, which the caller refuses rather than guesses at.
 *
 * Imperatives are recognised only at the start of the sentence. "Why did we stop
 * calling Westpac" contains the words "stop calling" and is a question; "stop
 * calling Westpac" is not a command Jarvis has, and says so.
 */

import { DateTime } from 'luxon';

export type Period = 'today' | 'yesterday' | 'week' | 'month';

export type Command =
  | { kind: 'pause_campaign'; name: string }
  | { kind: 'resume_campaign'; name: string }
  /** An empty `who` means "this contact": the one on the call, or the last one rung. */
  | { kind: 'suppress_contact'; who: string }
  | { kind: 'requeue_contact'; who: string; weekday: number | null }
  | { kind: 'rollback_playbook' }
  | { kind: 'engage_kill'; reason: string }
  | { kind: 'release_kill' };

export type Intent =
  | { kind: 'cost_per_meeting'; period: Period }
  | { kind: 'early_hangups'; seconds: number; period: Period }
  | { kind: 'why_stopped'; subject: string }
  | { kind: 'best_hook'; market: 'AU' | 'NZ' | null }
  | { kind: 'closest_calls'; count: number }
  | { kind: 'needs_me' }
  | { kind: 'today' }
  | { kind: 'queue' }
  | { kind: 'kill_status' }
  | { kind: 'plan_status' }
  | { kind: 'objections' }
  | { kind: 'spend'; period: Period }
  | { kind: 'help' }
  | { kind: 'command'; command: Command }
  | { kind: 'forbidden'; why: string }
  | { kind: 'unknown' };

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, forty: 40, 'forty-five': 45, fifty: 50, sixty: 60
};

function numberFrom(token: string | undefined): number | null {
  if (token === undefined) return null;
  if (/^\d+$/.test(token)) return Number(token);
  return NUMBER_WORDS[token] ?? null;
}

const NUMBER_TOKEN = `(\\d+|${Object.keys(NUMBER_WORDS).join('|')})`;

export function normalise(query: string): string {
  return query
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^a-z0-9'$%:.\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const COURTESY = /^(?:(?:hey|hi|ok|okay)\s+)?(?:jarvis[,:]?\s+)?(?:(?:please|kindly)\s+)?(?:(?:can|could|would|will) you(?: please)?\s+)?(?:go ahead and\s+)?(?:i(?:'d| would) like you to\s+)?/;

export function stripCourtesy(q: string): string {
  return q.replace(COURTESY, '').replace(/\s+please$/, '').trim();
}

export function periodOf(q: string, fallback: Period): Period {
  if (/\btoday\b/.test(q)) return 'today';
  if (/\byesterday\b/.test(q)) return 'yesterday';
  if (/\b(week|7 days|seven days)\b/.test(q)) return 'week';
  if (/\bmonth\b/.test(q)) return 'month';
  return fallback;
}

export interface PeriodRange {
  period: Period;
  from: Date;
  to: Date;
  label: string;
}

export function rangeOf(period: Period, now: Date, zone: string): PeriodRange {
  const today = DateTime.fromJSDate(now, { zone }).startOf('day');
  switch (period) {
    case 'today':
      return { period, from: today.toJSDate(), to: now, label: 'today' };
    case 'yesterday':
      return { period, from: today.minus({ days: 1 }).toJSDate(), to: today.toJSDate(), label: 'yesterday' };
    case 'week':
      return { period, from: new Date(now.getTime() - 7 * 86_400_000), to: now, label: 'in the last seven days' };
    case 'month':
      return { period, from: today.startOf('month').toJSDate(), to: now, label: 'so far this month' };
  }
}

const WEEKDAYS: Record<string, number> = {
  monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6, sunday: 7,
  mon: 1, tue: 2, tues: 2, wed: 3, thu: 4, thur: 4, thurs: 4, fri: 5
};

/** Remove the words around a name so what is left can be matched against records. */
const FILLER = new Set([
  'the', 'a', 'an', 'this', 'that', 'all', 'my', 'our', 'campaign', 'campaigns', 'contact', 'contacts', 'account', 'accounts',
  'for', 'on', 'to', 'in', 'of', 'from', 'at', 'please', 'again', 'next', 'back', 'up', 'out', 'and', 'it', 'them', 'him', 'her'
]);

export function subjectTokens(text: string): string[] {
  return normalise(text)
    .split(' ')
    .filter((t) => t !== '' && !FILLER.has(t) && !(t in WEEKDAYS));
}

const WHY_NOISE = new Set([
  'why', 'did', 'do', 'does', 'we', 'you', 'have', 'has', 'had', 'are', 'is', 'was', 'were', 'isn\'t', 'aren\'t', 'wasn\'t', 'weren\'t',
  'stop', 'stopped', 'stopping', 'calling', 'call', 'called', 'dialling', 'dialled', 'suppress', 'suppressed', 'not', 'no', 'longer',
  'anymore', 'any', 'more', 'blocked', 'held', 'skipped', 'dropped', 'removed', 'queue', 'queued', 'plan', 'today', 'still', 'yet',
  'there', 'been', 'being', 'be', 'get', 'got', 'going', 'doing', 'ringing', 'ring', 'rung', 'contacting', 'contact', 'chasing', 'about'
]);

export function parseIntent(raw: string): Intent {
  const q = stripCourtesy(normalise(raw));
  if (q === '') return { kind: 'unknown' };

  /* ---- things Jarvis will not do, said plainly ---- */

  if (/^(approve|reject|release|sign off)\b.*\b(plan|calls?|dialling)\b/.test(q) && !/\bkill switch\b/.test(q)) {
    return {
      kind: 'forbidden',
      why: "Approving or rejecting the day's plan is yours alone. Run npm run plan -- approve, or reject it with a reason."
    };
  }
  if (/^(unsuppress|un-suppress|reinstate|remove (the |their |his |her )?suppression|take .* off the (suppression|do not call) list)\b/.test(q)) {
    return { kind: 'forbidden', why: 'Suppression is permanent and has no removal path, so I cannot lift one.' };
  }
  if (/^(dial|call|ring|phone|text|sms|email|e-mail|send|message|write to|contact)\b/.test(q)) {
    return {
      kind: 'forbidden',
      why: 'I cannot place calls or send anything. Calls go through the dialler, and only after the compliance gate says yes.'
    };
  }
  if (/^(delete|erase|wipe|purge|drop|clear)\b/.test(q)) {
    return { kind: 'forbidden', why: 'I do not delete anything. The record of what was said and done is kept.' };
  }

  /* ---- instructions: changes that need a confirmation ---- */

  if (/^(stop all|halt|stop everything|stop (all )?dialling|kill (the )?(dialler|dialling|switch)|trip the kill switch|engage the kill switch|emergency stop)\b/.test(q) && !/\bcampaign\b/.test(q)) {
    return { kind: 'command', command: { kind: 'engage_kill', reason: 'stopped from Jarvis' } };
  }
  if (/^(resume|restart|restore|lift|release|re-?enable|un-?halt|turn on)\b.*\b(dialling|kill switch|halt)\b/.test(q) && !/\bcampaign\b/.test(q)) {
    return { kind: 'command', command: { kind: 'release_kill' } };
  }
  if (/^(resume|restart|unpause|reactivate|re-?enable|activate|unhold)\b.*\bcampaign\b/.test(q)) {
    return { kind: 'command', command: { kind: 'resume_campaign', name: q.replace(/^\S+\s*/, '') } };
  }
  if (/^(pause|hold|suspend|stop|deactivate)\b.*\bcampaign\b/.test(q)) {
    return { kind: 'command', command: { kind: 'pause_campaign', name: q.replace(/^\S+\s*/, '') } };
  }
  if (/^(roll ?back|revert|go back)\b/.test(q) || /^(restore|use)\b.*\b(previous|last|old|earlier) (script|playbook|version)\b/.test(q)) {
    return { kind: 'command', command: { kind: 'rollback_playbook' } };
  }
  if (/^(suppress|blacklist|never call|do not call|don'?t call)\b/.test(q)) {
    const who = q.replace(/^(suppress|blacklist|never call|do not call|don'?t call)\s*/, '');
    return { kind: 'command', command: { kind: 'suppress_contact', who: /^(this|that|the current|the last)?\s*(contact|person|one|prospect|guy|lady)?$/.test(who) ? '' : who } };
  }
  if (/^(re-?queue|queue|call again|put back)\b/.test(q)) {
    const day = Object.keys(WEEKDAYS).find((d) => new RegExp(`\\b${d}\\b`).test(q));
    const who = q.replace(/^(re-?queue|queue|call again|put back)\s*/, '').replace(/\bfor\s+\w+day\b|\bon\s+\w+day\b/g, '');
    return { kind: 'command', command: { kind: 'requeue_contact', who, weekday: day === undefined ? null : (WEEKDAYS[day] as number) } };
  }

  /* ---- questions ---- */

  if (/^why\b/.test(q)) {
    const subject = q
      .split(' ')
      .filter((t) => !WHY_NOISE.has(t))
      .join(' ')
      .trim();
    return subject === '' ? { kind: 'unknown' } : { kind: 'why_stopped', subject };
  }

  if (/\b(cost|spend|spent|costing)\b.*\b(per|each|a|every)\b.*\b(meeting|request|booking|lead)s?\b/.test(q) || /\bcost per (meeting|request)\b/.test(q)) {
    return { kind: 'cost_per_meeting', period: periodOf(q, 'month') };
  }

  if (/\b(died|die|dead|dropped|drop|hung up|hang up|hung|bailed|lost|ended|ending)\b/.test(q) && /\b(seconds?|secs?)\b/.test(q)) {
    const match = new RegExp(`\\b${NUMBER_TOKEN}\\s*(?:seconds?|secs?|s)\\b`).exec(q);
    const seconds = numberFrom(match?.[1]) ?? 10;
    return { kind: 'early_hangups', seconds: Math.min(Math.max(seconds, 1), 120), period: periodOf(q, 'week') };
  }

  if (/\b(hook|hooks|opener|openers|script|variant)\b/.test(q) && /\b(work|working|works|best|performing|perform|converting|land|landing|winning)\b/.test(q)) {
    const market = /\b(nz|new zealand|kiwi|auckland|wellington)\b/.test(q) ? 'NZ' : /\b(au|aus|australia|australian|aussie|sydney|melbourne)\b/.test(q) ? 'AU' : null;
    return { kind: 'best_hook', market };
  }

  if (/\b(closest|nearest|nearly|almost|best calls?|most promising)\b/.test(q) && /\b(call|calls|conversation|conversations)\b/.test(q)) {
    const match = new RegExp(`\\b${NUMBER_TOKEN}\\s+(?:of the |of my )?(?:calls?|conversations?)\\b`).exec(q);
    return { kind: 'closest_calls', count: Math.min(Math.max(numberFrom(match?.[1]) ?? 3, 1), 10) };
  }

  if (/\b(what|anything)\b.*\b(needs?|waiting (on|for)|for) (me|you|my attention)\b|\bneeds me\b|\bneed my attention\b|\bany(thing)? (waiting|pending)\b|\bpending (meeting )?requests?\b/.test(q)) {
    return { kind: 'needs_me' };
  }

  if (/\b(kill switch|halted|halt status|is dialling|are we dialling|dialling (stopped|on|off|status))\b/.test(q)) return { kind: 'kill_status' };
  if (/\b(plan)\b/.test(q) && /\b(approved|approval|today|status|pending|drawn)\b/.test(q)) return { kind: 'plan_status' };
  if (/\b(who'?s|whos|who is|what'?s|whats|what is)\b.*\b(next|up next|in the queue|queued|queue)\b|\b(the )?queue\b|\bnext call\b/.test(q)) return { kind: 'queue' };
  if (/\bobjections?\b/.test(q)) return { kind: 'objections' };
  if (/\b(how much|spend|spent|cost)\b/.test(q)) return { kind: 'spend', period: periodOf(q, 'week') };
  if (/\b(today|how (did|are) (we|things)|how many calls|numbers|progress|going)\b/.test(q)) return { kind: 'today' };
  if (/^(help|what can you do|what can i ask|commands?)\b/.test(q)) return { kind: 'help' };

  return { kind: 'unknown' };
}

export const HELP_TEXT =
  'I answer from the blackboard and show what I read. Ask, for example: what is my cost per meeting this month; ' +
  'show every call that died in the first ten seconds this week; why did we stop calling an organisation; ' +
  'which hook is working in New Zealand; read me the three calls that got closest; what needs me. ' +
  'I can also propose, for you to confirm: pause or resume a campaign, suppress a contact, requeue a contact for a weekday, ' +
  'roll back to the previous script, and halt or resume dialling. I never place a call or send anything.';
