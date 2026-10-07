/**
 * The voicemail drop.
 *
 * Section 12.3: "pre-recorded, identifies as AI, gives the callback number".
 *
 * This is not a second call. A voicemail is what the *same* already-gated dial
 * says when the line turns out to be an answering machine, so the compliance
 * gate has already ruled on it and nothing here dials anything. What it does
 * carry is the in-call obligations of section 7.3, and those do not relax
 * because nobody is listening yet: who is calling, on whose behalf, why, and a
 * real number back. A message missing any of them is not left.
 *
 * Refusing is the design. An agent that cannot name itself or give a number
 * back should hang up quietly, not leave something that breaks the rules a
 * person will hear later.
 */

import type { AgentIdentity } from '../caller/identity.js';

export class VoicemailNotAvailableError extends Error {}

const DIGIT_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];

/**
 * A number as it should be spoken.
 *
 * Text-to-speech reads "02 8000 1234" with an eight thousand in the middle of
 * it. Digit words, grouped with commas for the pauses, are read the way a
 * person would say them.
 */
export function speakNumber(e164: string): string {
  const digits = e164.replace(/\D/g, '');
  let national: string;

  if (digits.startsWith('61')) national = `0${digits.slice(2)}`;
  else if (digits.startsWith('64')) national = `0${digits.slice(2)}`;
  else national = digits;

  const groups: string[] = [];
  if (national.startsWith('04') && national.length === 10) {
    // Australian mobile: 04xx xxx xxx
    groups.push(national.slice(0, 4), national.slice(4, 7), national.slice(7));
  } else if (national.length === 10) {
    // Australian landline: 0x xxxx xxxx
    groups.push(national.slice(0, 2), national.slice(2, 6), national.slice(6));
  } else if (national.length === 9) {
    // New Zealand landline: 0x xxx xxxx
    groups.push(national.slice(0, 2), national.slice(2, 5), national.slice(5));
  } else {
    groups.push(national);
  }

  return groups
    .map((group) =>
      group
        .split('')
        .map((d) => DIGIT_WORDS[Number(d)] ?? d)
        .join(' ')
    )
    .join(', ');
}

export interface VoicemailOptions {
  identity: AgentIdentity;
  firstName: string;
  /** One short clause, from the dossier hypothesis. Optional: generic is allowed. */
  reason?: string;
}

/**
 * The script, or a refusal.
 *
 * Around twenty-five seconds spoken. Long voicemails are deleted unheard, and
 * the one thing that must survive is the number.
 */
export function buildVoicemail(options: VoicemailOptions): string {
  const { identity } = options;
  const name = identity.agent.name.trim();
  const number = identity.callback.number.trim();

  if (name === '') {
    throw new VoicemailNotAvailableError(
      'the agent has no name configured, so it cannot say who is calling (brief section 15 item 1)'
    );
  }
  if (number === '') {
    throw new VoicemailNotAvailableError(
      'no callback number is configured; a voicemail without a number to ring back is not left (brief sections 7.3 and 15 item 3)'
    );
  }

  const { operator } = identity;
  const reason = options.reason?.trim();
  const why = reason !== undefined && reason !== '' ? reason : 'to ask you one question about your data and engineering work';

  return [
    `Hi ${options.firstName}, it's ${name}. I'm an AI assistant working with ${operator.name}, ${operator.title} at ${operator.company}.`,
    `I was calling ${why}.`,
    `This message is being recorded.`,
    // No promise of an email. Section 12.2 has Vinay send prospect email from his
    // own mailbox, by hand, so a voicemail that says one is coming is promising
    // something that depends on a person and may never happen.
    `If it's useful, you can reach us on ${speakNumber(number)}.`,
    `And if you'd rather we didn't call again, just say so on that number and we won't. Thanks, ${options.firstName}.`
  ].join(' ');
}

/**
 * What a voicemail must contain, checked on the finished text rather than
 * trusted from the builder. Section 7.3 and section 0 rule 2.
 */
export function missingFromVoicemail(text: string, identity: AgentIdentity): string[] {
  const missing: string[] = [];
  if (!text.includes(identity.agent.name)) missing.push('who is calling');
  if (!/\bAI assistant\b/.test(text)) missing.push('that the caller is an AI');
  if (!text.includes(identity.operator.company)) missing.push('on whose behalf');
  if (!/I was calling/.test(text)) missing.push('why');
  if (!/recorded/.test(text)) missing.push('that it is recorded');
  if (!/\b(?:zero|one|two|three|four|five|six|seven|eight|nine)\b/.test(text)) missing.push('a number to ring back');
  return missing;
}
