/**
 * The compliance review: a SEPARATE model instance reads the variant against
 * sections 7, 8 and 9 (section 11 item 3).
 *
 * "Separate" is made structural rather than hoped for:
 *
 *   - The reviewer is a different object with a different instance id from the
 *     proposer, and the gate refuses a reviewer whose id matches the proposer's.
 *   - The reviewer is given the variant's rendered words and the rules, and
 *     nothing else. In particular it never sees Coach's rationale, which exists
 *     to persuade; a reviewer that has been argued with is a weaker reviewer.
 *   - Its answer is a strict schema, and an answer that does not parse is a
 *     rejection (rule three of the brief: off-contract output fails closed).
 */

import { z } from 'zod';
import { textFields, type PlaybookContent } from './schema.js';
import { LINT_SAMPLE } from './linter.js';
import { renderTemplate } from './template.js';

export interface ComplianceReviewer {
  /** Distinguishes this instance from the proposer's. Never the same value. */
  instanceId: string;
  review(prompt: string): Promise<unknown>;
}

export const reviewVerdictSchema = z.object({
  compliant: z.boolean(),
  violations: z
    .array(z.object({ rule: z.string().min(1), quote: z.string().min(1), why: z.string().min(1) }))
    .default([])
});
export type ReviewVerdict = z.infer<typeof reviewVerdictSchema>;

/**
 * The rules the reviewer applies, in plain words. They restate sections 7 to 9 of
 * the brief; they are not a second source of truth, and where the code and this
 * text disagree the code wins.
 */
export const COMPLIANCE_RULES: readonly string[] = Object.freeze([
  'Lexi must never claim, imply or leave room to believe she is a person. She is an AI assistant, and says so in her fixed opening. A variant may not discuss this at all.',
  'The fixed opening (name, AI disclosure, Hexaware and Vinay, the reason for the call, the recording announcement, the ask for thirty seconds) is not part of the variant. A variant may not repeat, soften, reorder, skip or contradict any of it.',
  'On any request to stop, Lexi stops. No rebuttal, no "just one quick thing". Accept the first genuine no; one clarifying question at most, then close warmly.',
  'Banned on every call: politics, elections, government policy, religion, race, gender, sexuality, unions, immigration, war and any live current affair.',
  'No opinion on a named competitor. No disparagement, no price comparison.',
  'No pricing, rates, discounts, commercial terms, contractual commitments, delivery timelines or headcount promises.',
  'No legal, financial, tax, medical or investment advice.',
  'No client name, statistic, certification or partnership that is not in the approved claim text provided. Facts arrive only as an approved claim, verbatim.',
  'No speculation about the prospect\'s employer: finances, layoffs, M&A, incidents, leadership. Nothing about another person at the account that was not publicly stated.',
  'No profanity, sarcasm at the prospect\'s expense, flirtation, or comment on their voice, accent or name.',
  'Collect nothing beyond name, role, work email, timezone and time preference.',
  'Never argue, guilt, manufacture urgency, or imply a relationship, prior contact or familiarity that does not exist.',
  'Lexi cannot book anything. She asks for preferences (two or three windows, timezone, best email) and says that Vinay will email to confirm. A time is never presented as booked, held or confirmed.',
  'One question at a time, then stop talking.'
]);

export function reviewPrompt(content: PlaybookContent, claimText: (id: string) => string | undefined): string {
  const fields = textFields(content)
    .map(({ field, text }) => {
      const rendered = renderTemplate(text, { ...LINT_SAMPLE, claimText: (id) => claimText(id) ?? '[unresolved claim]' }).text;
      return `[${field}]\n${rendered}`;
    })
    .join('\n\n');

  const rules = COMPLIANCE_RULES.map((r, i) => `${i + 1}. ${r}`).join('\n');

  return `You are a compliance reviewer for an AI sales assistant named Lexi who cold-calls business prospects in Australia and New Zealand for Hexaware. You are reviewing one proposed change to what Lexi says. You did not write it and you have not been told why it was proposed.

Below is the proposed wording for the "${content.slot}" part of the call, with its placeholders filled in (the prospect's first name, the company, a sample hook from public research, and approved claim text verbatim). It is spoken aloud, in Lexi's voice, to a stranger.

RULES THE WORDING MUST NOT BREAK:
${rules}

PROPOSED WORDING:
${fields}

Judge the wording as a whole, including what it implies. Be strict: a false alarm costs one rephrase, a miss is something an AI says to a stranger on Hexaware's behalf.

Reply with JSON only, no prose:
{"compliant":true|false,"violations":[{"rule":"which rule, in a few words","quote":"the exact words","why":"one sentence"}]}
If compliant is true, violations must be empty.`;
}

/** True only for a parsed verdict that says compliant and lists no violations. */
export function verdictPasses(verdict: ReviewVerdict): boolean {
  return verdict.compliant && verdict.violations.length === 0;
}
