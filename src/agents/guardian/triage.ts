/**
 * Which turns are worth a model's opinion.
 *
 * Layer one catches what patterns can catch. Layer two catches what they
 * cannot: a turn that trips no rule and is still wrong - a relationship
 * implied, urgency manufactured, a claim phrased around the boundary rather
 * than over it. That check costs a model call, and a model call on every turn
 * would double the latency of a conversation that has an 800ms budget.
 *
 * So this decides. It is deterministic, it is cheap, and it is deliberately
 * generous - a turn wrongly triaged up costs tens of milliseconds and a
 * fraction of a cent, a turn wrongly triaged down is unexamined.
 */

import { detectInjection } from './stream-filter.js';

export type RiskLevel = 'none' | 'check' | 'hold';

export interface TriageInput {
  /** What the prospect just said. */
  prospectSaid: string;
  /** What Lexi is about to say, once layer one has passed it. */
  draftReply: string;
}

export interface TriageResult {
  level: RiskLevel;
  /** Why, in plain English, for the trace. */
  reasons: string[];
}

/**
 * Subjects where a clean-looking sentence is most likely to be wrong. These do
 * not ban anything - layer one does that - they mark the neighbourhood.
 */
const NEAR_THE_LINE: Array<{ pattern: RegExp; why: string }> = [
  { pattern: /\b(?:cost|price|pricing|budget|spend|invest|rate|fee|licen[cs]e)\b/i, why: 'money came up' },
  { pattern: /\b(?:when|how (?:soon|quickly|long)|timeline|deadline|by when)\b/i, why: 'timing came up' },
  { pattern: /\b(?:guarantee|promise|commit|assure|certain|definitely|absolutely)\b/i, why: 'the reply sounds like a commitment' },
  { pattern: /\b(?:we (?:have|did|built|delivered|work with)|our client|another bank|someone else)\b/i, why: 'sounds like a reference claim' },
  { pattern: /\b\d+(?:[.,]\d+)?\s*(?:%|percent|per cent|x\b|times|years?|months?|weeks?|people|clients?|banks?)\b/i, why: 'a figure was stated' },
  { pattern: /\b(?:certified|accredited|partner(?:ship)?|iso|soc ?2|apra|aligned with)\b/i, why: 'a certification or partnership was implied' },
  { pattern: /\b(?:we know|we've spoken|as you know|like we discussed|following up on)\b/i, why: 'implies a relationship that may not exist' },
  { pattern: /\b(?:only|limited|before (?:the end|it closes)|running out|last chance|act now)\b/i, why: 'sounds like manufactured urgency' },
  // Any turn naming a day is next to the commitment line, whatever words
  // surround it. "Thursday then?" answered with "consider it done" trips no ban
  // and is still the agent booking a meeting it cannot book.
  {
    pattern: /\b(?:monday|tuesday|wednesday|thursday|friday|next week|this week|tomorrow|morning|afternoon)\b/i,
    why: 'a specific time was discussed'
  },
  {
    pattern: /\b(?:consider it done|leave it with me|done|sorted|all set|no problem at all, i'?ll)\b/i,
    why: 'the reply agrees to do something'
  }
];

/**
 * Subjects where getting it wrong is not recoverable on a later turn, so the
 * turn is held until the check comes back rather than spoken and corrected.
 */
const CANNOT_BE_TAKEN_BACK: Array<{ pattern: RegExp; why: string }> = [
  { pattern: /\b(?:human|person|real|bot|ai|artificial|machine|recording|recorded)\b/i, why: 'the agent’s own nature is in play' },
  { pattern: /\b(?:lawyer|legal|complain|complaint|regulator|ombudsman|privacy|journalist|reporter|press)\b/i, why: 'a legal or reputational trigger is in play' },
  { pattern: /\b(?:remove me|take me off|stop calling|do not call|don'?t call|never call)\b/i, why: 'the prospect may be opting out' }
];

export function triageTurn(input: TriageInput): TriageResult {
  const reasons: string[] = [];
  const both = `${input.prospectSaid}\n${input.draftReply}`;

  for (const { pattern, why } of CANNOT_BE_TAKEN_BACK) {
    if (pattern.test(both)) reasons.push(why);
  }
  if (reasons.length > 0) return { level: 'hold', reasons };

  // An injection attempt is not itself unrecoverable, but the turn that follows
  // one is the likeliest place for the brief to quietly slip.
  if (detectInjection(input.prospectSaid).length > 0) {
    reasons.push('the prospect tried to redirect the agent on the previous turn');
  }

  for (const { pattern, why } of NEAR_THE_LINE) {
    if (pattern.test(both)) reasons.push(why);
  }

  return { level: reasons.length > 0 ? 'check' : 'none', reasons };
}
