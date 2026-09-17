/**
 * Reading Vinay's one-word reply.
 *
 * Section 12.1: he replies CONFIRMED, RESCHEDULE or REJECT. In practice a
 * reply from a phone is a word, a signature, and a wall of quoted original -
 * and the quoted original contains all three words, because the email he is
 * replying to lists them as instructions.
 *
 * So the quoted body is stripped before anything is read, and only what he
 * actually typed is considered. Getting this wrong means reading the word
 * "REJECT" out of the instructions in his own email and suppressing a prospect
 * who had just agreed to a meeting.
 *
 * Deliberately not a model. A model here would be a model with write access to
 * suppression, and section 0's first rule is about exactly that instinct.
 */

export type ReplyDecision = 'confirmed' | 'reschedule' | 'rejected' | 'unclear';

export interface ParsedReply {
  decision: ReplyDecision;
  /** For RESCHEDULE, whatever he typed after the word. */
  note: string;
  /** What the parser actually read, for the audit trail. */
  consideredText: string;
}

/**
 * Where the quoted original begins.
 *
 * Covers the shapes that actually arrive: Outlook's divider, Gmail's
 * attribution line, the plain `>` convention, and the mobile clients that use
 * a bare "Sent from" as the first thing after the typed text.
 */
const QUOTE_MARKERS: RegExp[] = [
  /^-{3,}\s*Original Message\s*-{3,}/im,
  /^_{5,}\s*$/m,
  /^From:\s.+$/im,
  /^On .+ wrote:\s*$/im,
  /^\s*>/m,
  /^Sent from my /im,
  /^Get Outlook for /im
];

export function stripQuoted(body: string): string {
  let cut = body.length;
  for (const marker of QUOTE_MARKERS) {
    const match = marker.exec(body);
    if (match !== null && match.index < cut) cut = match.index;
  }
  return body.slice(0, cut).trim();
}

const WORDS: Array<{ decision: Exclude<ReplyDecision, 'unclear'>; pattern: RegExp }> = [
  { decision: 'confirmed', pattern: /\bconfirm(?:ed|s)?\b/i },
  { decision: 'reschedule', pattern: /\bre-?schedul(?:e|ed|ing)\b/i },
  { decision: 'rejected', pattern: /\breject(?:ed)?\b|\bdecline(?:d)?\b/i }
];

export function parseReply(body: string): ParsedReply {
  const considered = stripQuoted(body);

  const found = WORDS.filter(({ pattern }) => pattern.test(considered));

  // Two decisions in one reply is not a decision. Better to nudge him again
  // than to guess which half he meant.
  if (found.length !== 1) {
    return { decision: 'unclear', note: '', consideredText: considered };
  }

  const decision = (found[0] as (typeof WORDS)[number]).decision;
  const note =
    decision === 'reschedule'
      ? considered
          .replace((found[0] as (typeof WORDS)[number]).pattern, '')
          .replace(/^[\s,:—-]+/, '')
          .trim()
      : '';

  return { decision, note, consideredText: considered };
}
