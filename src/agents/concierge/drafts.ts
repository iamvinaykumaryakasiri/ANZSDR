/**
 * Drafts and alerts: everything the concierge writes for Vinay to read.
 *
 * Prospect-facing email never leaves from this system (section 12.2). It is
 * drafted here and delivered to Vinay, who sends it from his own mailbox, so
 * every draft is a message to him containing a message for them.
 *
 * The drafts are deliberately plain and deliberately claim-free. They go out
 * under his name, and the claim boundary in section 6 exists so that nothing
 * is said on his behalf that nobody has approved. A draft that quietly
 * asserted "we work with banks across New Zealand" would route around that
 * boundary through email, so none of them assert anything about Hexaware at
 * all: they thank, they offer, and they leave the door open.
 */

import type { OutboundMail } from './ports.js';
import type { EscalationReason } from './followup.js';
import type { EmailSource } from './meeting-email.js';
import { describeEmailSource } from './meeting-email.js';

export interface DraftPerson {
  name: string;
  firstName: string;
  title: string;
  company: string;
  email?: string;
  emailSource: EmailSource;
}

export interface DraftOperator {
  name: string;
  firstName: string;
  title: string;
  company: string;
  email: string;
}

/** What it is, for the subject and the heading. */
export type DraftKind = 'thank-you' | 'one-pager' | 'voicemail-follow-up';

export const DRAFT_TITLES: Record<DraftKind, string> = {
  'thank-you': 'Thank-you',
  'one-pager': 'One-pager follow-up',
  'voicemail-follow-up': 'Voicemail follow-up'
};

/** Short, and it asks for nothing. They said no; this just closes politely. */
export function thankYouText(person: DraftPerson, operator: DraftOperator): string {
  return `Hi ${person.firstName},

Thanks for taking the call from Lexi earlier, and for being straight with her. I won't follow up further.

If anything changes on your side, you're always welcome to get in touch.

Best,
${operator.firstName}`;
}

/**
 * The "interested, no time now" email. Two placeholders for his own windows,
 * because there is no calendar integration and the system cannot know when he
 * is free; and one for the one-pager, which is his to attach.
 */
export function onePagerText(person: DraftPerson, operator: DraftOperator): string {
  return `Hi ${person.firstName},

Thanks for taking Lexi's call earlier. I know the timing may not have suited, so here's a one-page overview to read when it does.

If a short call would be useful, I could do either of these:

  - [YOUR FIRST WINDOW]
  - [YOUR SECOND WINDOW]

Either way, no pressure at all.

Best,
${operator.firstName}

[ATTACH THE ONE-PAGER]`;
}

/** After a voicemail. Says the caller was an AI, and gives them a clean way out. */
export function voicemailFollowUpText(person: DraftPerson, operator: DraftOperator): string {
  return `Hi ${person.firstName},

I'm ${operator.name}, ${operator.title} at ${operator.company}. Lexi, our AI assistant, left you a short voicemail earlier and I wanted to follow it up myself.

I'd value twenty minutes to hear how you're thinking about it, if that would be useful on your side. If it isn't, just tell me and I'll make sure you're not contacted again.

Best,
${operator.firstName}`;
}

const TEXT: Record<DraftKind, (p: DraftPerson, o: DraftOperator) => string> = {
  'thank-you': thankYouText,
  'one-pager': onePagerText,
  'voicemail-follow-up': voicemailFollowUpText
};

/**
 * The draft, wrapped in an email to Vinay.
 *
 * Flush left between two rules, for the same reason as the meeting request:
 * copying an indented block into Outlook means stripping the indent off every
 * line before it can be sent.
 */
export function wrapDraft(kind: DraftKind, person: DraftPerson, operator: DraftOperator, why: string): OutboundMail {
  const to =
    person.email === undefined || person.emailSource === 'none'
      ? 'no address held'
      : `${person.email}   ${describeEmailSource(person.emailSource)}`;

  const body = [
    'A draft for you to send from your own Outlook. Nothing has been sent to them.',
    '',
    `Why:  ${why}`,
    `To:   ${person.name}, ${person.title}, ${person.company}`,
    `      ${to}`,
    '',
    '──── DRAFT — copy from the next line ────',
    '',
    TEXT[kind](person, operator),
    '',
    '──── end of draft ────',
    ''
  ].join('\n');

  return {
    to: operator.email,
    subject: `[DRAFT] ${DRAFT_TITLES[kind]} — ${person.name} — ${person.company}`,
    body,
    attachments: []
  };
}

const ESCALATION_LABEL: Record<EscalationReason, string> = {
  'legal-threat': 'a legal threat',
  'formal-complaint': 'a formal complaint',
  'media-analyst-or-regulator': 'a journalist, analyst or regulator',
  'asked-for-a-human': 'a request to speak to a human',
  hostility: 'hostility',
  'existing-client-or-partner': 'an existing Hexaware client or partner',
  'active-rfp-or-procurement': 'an active RFP or procurement process',
  'personal-or-distressing': 'something personal or distressing'
};

export interface EscalationAlertInput {
  person: Pick<DraftPerson, 'name' | 'title' | 'company'>;
  phone: string;
  reason: EscalationReason | undefined;
  saidAs: string | undefined;
  summary: string[];
  summarySource: 'model' | 'unavailable';
  /** What the system already did about it, in plain English. */
  done: string[];
  transcriptUrl?: string;
  operatorEmail: string;
}

/**
 * Section 8: "alert Vinay immediately". An alert is read in a hurry, so it
 * leads with what and why, then what is already handled, then what is left.
 */
export function escalationAlert(input: EscalationAlertInput): OutboundMail {
  const why = input.reason === undefined ? 'escalated, with no reason recorded' : ESCALATION_LABEL[input.reason];
  const lines: string[] = [];

  lines.push(`Lexi ended a call with ${input.person.name} (${input.person.title}, ${input.person.company}) and flagged it for you.`);
  lines.push('');
  lines.push('WHY');
  lines.push(`  ${why}`);
  if (input.saidAs !== undefined && input.saidAs.trim() !== '') lines.push(`  They said: "${input.saidAs}"`);

  lines.push('');
  lines.push('ALREADY HANDLED');
  if (input.done.length === 0) lines.push('  Nothing has been done automatically.');
  for (const item of input.done) lines.push(`  ${item}`);

  lines.push('');
  lines.push('LEFT TO YOU');
  lines.push('  Nothing further will be sent to them by this system.');
  lines.push(`  If it needs a human, their number is ${input.phone}.`);

  if (input.summary.length > 0 && input.summarySource === 'model') {
    lines.push('');
    lines.push('WHAT WAS SAID  (written by an AI from the transcript)');
    for (const line of input.summary.slice(0, 5)) lines.push(`  ${line}`);
  } else {
    lines.push('');
    lines.push('No summary was written. Read the transcript before you act.');
  }
  if (input.transcriptUrl !== undefined) {
    lines.push('');
    lines.push(`  transcript: ${input.transcriptUrl}`);
  }
  lines.push('');

  return {
    to: input.operatorEmail,
    subject: `[ESCALATION] ${input.person.name} — ${input.person.company} — ${why}`,
    body: lines.join('\n'),
    attachments: []
  };
}
