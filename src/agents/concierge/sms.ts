/**
 * SMS to a prospect: when it may be sent, what it says, and how a reply is read.
 *
 * Section 12.3 sets the rule in one line: "SMS goes via Twilio, only to people
 * who have just spoken to us, always identifying the sender and including an
 * opt-out." Everything here is that sentence made mechanical.
 *
 * None of this is a model's decision. A text to a stranger's phone is a thing
 * that cannot be recalled, so whether one goes is decided by a function of
 * facts, with the reason recorded when it does not.
 *
 * "Just spoken to us" is a number: thirty minutes. A confirmation that arrives
 * the next morning is no longer a confirmation, it is an unsolicited message,
 * and an outage that delays one past the window drops it rather than sending
 * it late. Failing closed here means a missed courtesy, not a complaint.
 */

export const SMS_WINDOW_MS = 30 * 60_000;

export type LineType = 'mobile' | 'fixed' | 'non-geographic';

export interface SmsEligibilityInput {
  lineType: LineType;
  /** A real two-way conversation, not a ring-out or a voicemail. */
  conversationOccurred: boolean;
  endedAt: Date;
  now: Date;
  /** They have already replied STOP, on any earlier message. */
  optedOut: boolean;
  /** One confirmation per call, however many times the pipeline re-runs. */
  alreadySent: boolean;
  killSwitchActive: boolean;
  /** Suppressed contacts and numbers are never messaged, whatever else is true. */
  suppressed: boolean;
  /** A sender number that can receive a reply. See `senderCanReceiveReplies`. */
  senderConfigured: boolean;
}

export type SmsEligibility = { ok: true } | { ok: false; why: string };

/**
 * The order is deliberate: the reasons a person would care about come first, so
 * the trace says "they opted out" rather than "no sender configured" when both
 * are true.
 */
export function smsEligibility(input: SmsEligibilityInput): SmsEligibility {
  if (input.suppressed) return { ok: false, why: 'the contact or number is suppressed' };
  if (input.optedOut) return { ok: false, why: 'they have already opted out of SMS' };
  if (input.killSwitchActive) return { ok: false, why: 'the kill switch is active, so nothing goes to a prospect' };
  if (!input.conversationOccurred) {
    return { ok: false, why: 'no conversation took place, and SMS is only for people who have just spoken to us' };
  }
  if (input.lineType !== 'mobile') {
    return { ok: false, why: `${input.lineType} lines cannot receive SMS` };
  }
  if (input.now.getTime() - input.endedAt.getTime() > SMS_WINDOW_MS) {
    return { ok: false, why: 'more than thirty minutes have passed, so they have no longer "just" spoken to us' };
  }
  if (input.alreadySent) return { ok: false, why: 'a confirmation has already been sent for this call' };
  if (!input.senderConfigured) {
    return { ok: false, why: 'no SMS-capable sender number is configured, so an opt-out reply could not reach us' };
  }
  return { ok: true };
}

/**
 * GSM-7 is the SMS default alphabet. One character outside it - an em dash, a
 * curly apostrophe, an accented letter - switches the whole message to UCS-2,
 * which holds 70 characters a segment instead of 160 and quietly triples the
 * cost of a message that looked short.
 */
const GSM7 =
  /^[A-Za-z0-9 \r\n@£$¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ!"#¤%&'()*+,\-./:;<=>?¡ÄÖÑÜ§¿äöñüà^{}\\[~\]|€]*$/;

export function isGsm7(text: string): boolean {
  return GSM7.test(text);
}

/** Segments billed: 160 for a single, 153 each once concatenated. UCS-2 is 70 and 67. */
export function smsSegments(text: string): number {
  const gsm = isGsm7(text);
  const single = gsm ? 160 : 70;
  const multi = gsm ? 153 : 67;
  return text.length <= single ? 1 : Math.ceil(text.length / multi);
}

export interface SmsIdentity {
  agentName: string;
  operatorName: string;
  operatorFirstName: string;
  company: string;
}

export type SmsPurpose =
  | { kind: 'meeting-requested'; firstName: string }
  | { kind: 'callback-requested'; firstName: string; whenLabel: string };

/**
 * The message. Plain ASCII on purpose (see `isGsm7`).
 *
 * It does three jobs the brief names: it says who is sending, it says the
 * sender is an AI (rule two applies in writing as much as in speech), and it
 * gives a way out. It promises exactly what Lexi promised on the call and no
 * more - an email from Vinay today - and never a time.
 */
export function buildSms(identity: SmsIdentity, purpose: SmsPurpose): string {
  const who = `it's ${identity.agentName}, the AI assistant working with ${identity.operatorName} at ${identity.company}`;
  const optOut = 'Reply STOP to opt out.';

  if (purpose.kind === 'meeting-requested') {
    return `Hi ${purpose.firstName}, ${who}. Thanks for your time just now. ${identity.operatorFirstName} will email you today to confirm. ${optOut}`;
  }
  return `Hi ${purpose.firstName}, ${who}. Thanks for your time. I'll try you again ${purpose.whenLabel}. ${optOut}`;
}

/** Wording a message must contain before it may go. Checked at send time, not trusted. */
export function missingFromSms(text: string, identity: SmsIdentity): string[] {
  const missing: string[] = [];
  if (!text.includes(identity.agentName)) missing.push('the sender');
  if (!/\bAI\b/.test(text)) missing.push('that the sender is an AI');
  if (!text.includes(identity.company)) missing.push('who it is on behalf of');
  if (!/\bSTOP\b/.test(text)) missing.push('a way to opt out');
  return missing;
}

/**
 * Reading a reply.
 *
 * Section 7.2: honour every opt-out regardless. The two ways to be wrong are
 * not equal. Missing an opt-out is a compliance breach and a person we keep
 * texting after they said stop; over-reading one costs a willing prospect that
 * Vinay can pick up by hand. So this leans generous.
 *
 * Twilio treats only an exact keyword as a STOP. That is the floor, not the
 * policy - people write "please stop texting me", not "STOP".
 */
const OPT_OUT_PHRASES: RegExp[] = [
  /\b(?:stop|stopall|unsubscribe|optout|opt[\s-]?out|cancel|quit)\b/i,
  /\b(?:remove|take)\s+(?:me|my number)\b/i,
  /\bdo\s*n[o']?t\s+(?:contact|text|call|message|sms)\b/i,
  /\bno\s+more\s+(?:texts?|messages?|calls?)\b/i,
  /\bleave\s+me\s+alone\b/i
];

export function isOptOut(body: string): boolean {
  const text = body.trim();
  if (text === '') return false;
  return OPT_OUT_PHRASES.some((pattern) => pattern.test(text));
}

/** What a sender number has to be able to do for "Reply STOP" to be true. */
export function senderCanReceiveReplies(senderId: string): boolean {
  // An alphanumeric sender ID ("HEXAWARE") cannot be replied to. Offering an
  // opt-out that cannot be exercised is worse than offering none, so a sender
  // without a number in it is treated as not configured.
  return /^\+\d{8,15}$/.test(senderId.trim());
}
