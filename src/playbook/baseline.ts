/**
 * The playbook on day one: version 1 of every slot that can honestly have one.
 *
 * Deliberately dull. These are phrasings that promise nothing, assert nothing and
 * pressure nobody - the floor that Coach's variants have to beat, not a script
 * anyone is proud of. Vinay's own words replace them on the first promotion he
 * approves, or earlier if he edits the baseline.
 *
 * The value statement has no baseline. A value statement is "one specific value
 * statement from approved claims" (section 8) and, today, no claim is approved,
 * so any sentence written here would be an assertion nothing supports. The slot
 * stays unset until a claim is approved and a variant built on it passes the gate;
 * until then Lexi goes from the hook to the ask without a value statement, which
 * is the correct behaviour of an agent with nothing it may assert.
 */

import type { PlaybookContent, PlaybookSlot } from './schema.js';

export const BASELINE: Partial<Record<PlaybookSlot, PlaybookContent>> = {
  hook: {
    slot: 'hook',
    template: 'I was reading up on {{company}} and this stood out: {{hook}}.'
  },
  transition: {
    slot: 'transition',
    template: "That's really why I thought of you, {{firstName}}. I wondered whether a short conversation with Vinay might be useful."
  },
  'preference-request': {
    slot: 'preference-request',
    template:
      'Could you give me two or three windows that suit you, and the best email to reach you on? Vinay will email you today to confirm.'
  },
  objection: {
    slot: 'objection',
    responses: {
      'has-a-partner':
        "That's fair, and I'm not suggesting anything changes with them. Would a short conversation with Vinay still be of interest?",
      'no-budget': "Understood, and this isn't about budget today. Would you rather Vinay sent a short note instead?",
      'no-time-now': 'No problem at all. Would it be easier if Vinay emailed you a couple of times that might suit?',
      'send-email': "Of course. What's the best email address for you?",
      'not-the-right-person': 'Thanks for telling me. Who would be the right person, and is there a good way to reach them?',
      other: 'Fair enough. Would a short email from Vinay be more useful than a call?'
    }
  }
};

export const BASELINE_NOTE =
  'The starting point: plain phrasings that assert nothing. The value statement is unset because no claim is approved yet.';
