/**
 * The reference that ties a reply to the request it answers.
 *
 * A reply from a phone is a word and a wall of quotation, and the quotation is
 * where this lives: it survives in the quoted original whatever the mail client
 * does to the subject line. The decision is read from what Vinay typed; the
 * request it applies to is found anywhere in the whole message.
 *
 * Deliberately not "the one open request". If he writes a fresh email instead
 * of replying, guessing which request he meant is a guess with REJECT attached,
 * and REJECT suppresses a person for good.
 */

const PATTERN = /\bMR-([0-9A-F]{8})\b/i;

/** `MR-` and the first eight hex digits of the request id. */
export function refFor(requestId: string): string {
  return `MR-${requestId.replace(/-/g, '').slice(0, 8).toUpperCase()}`;
}

/** The reference in a message, normalised, or null when there is none. */
export function findRef(text: string): string | null {
  const match = PATTERN.exec(text);
  return match === null ? null : `MR-${(match[1] as string).toUpperCase()}`;
}

/** What an id has to start with to carry this reference. */
export function idPrefixFor(ref: string): string {
  return ref.slice(3).toLowerCase();
}
