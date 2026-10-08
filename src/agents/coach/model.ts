/**
 * The seam between Coach and a model, and the prompt that goes through it.
 *
 * Coach asks a model for one thing: wording. Which slot to work on was decided
 * from the data before this prompt is written, what the wording may contain is
 * restated here from the rules the promotion gate will apply, and the answer is
 * validated against the strict slot schema before anything is done with it. The
 * restated rules are a courtesy to the model, saving it proposals the gate would
 * refuse; they are not what enforces anything.
 */

import type { AgentUsage } from './usage.js';
import type { FailureEntry } from '../../playbook/failure-memory.js';
import { REWRITABLE_OBJECTIONS, type PlaybookContent, type PlaybookSlot } from '../../playbook/schema.js';
import type { WeeklyOutcomes } from './outcomes.js';

export interface CoachModel {
  /** Distinguishes this instance from the compliance reviewer's. Never the same value. */
  instanceId: string;
  propose(prompt: string): Promise<{ output: unknown; usage?: AgentUsage }>;
}

const SHAPE: Record<PlaybookSlot, string> = {
  hook: '{"slot":"hook","template":"<one or two sentences; must contain {{hook}}>"}',
  'value-statement':
    '{"slot":"value-statement","template":"<one or two sentences; must contain at least one {{claim:<id>}} from the approved claims below>"}',
  transition: '{"slot":"transition","template":"<one sentence that moves from what was just said towards the ask>"}',
  'preference-request':
    '{"slot":"preference-request","template":"<asks for two or three windows that suit them and their best email, and says Vinay will email to confirm>"}',
  objection: `{"slot":"objection","responses":{${REWRITABLE_OBJECTIONS.map((k) => `"${k}":"<optional>"`).join(',')}}}`
};

export interface ProposerPromptInput {
  slot: PlaybookSlot;
  focusReason: string;
  maxProposals: number;
  champion: PlaybookContent | null;
  outcomes: WeeklyOutcomes;
  failures: FailureEntry[];
  claims: Array<{ id: string; text: string }>;
}

export function proposerPrompt(input: ProposerPromptInput): string {
  const claims =
    input.claims.length === 0
      ? '  (none are approved, so no wording may state any fact about Hexaware)'
      : input.claims.map((c) => `  {{claim:${c.id}}}  =  "${c.text}"`).join('\n');

  const failures =
    input.failures.length === 0
      ? '  (none recorded)'
      : input.failures
          .slice(0, 12)
          .map((f) => `  - ${f.summary}${f.text !== null ? ` (wording: "${f.text.slice(0, 160)}")` : ''}`)
          .join('\n');

  const champion =
    input.champion === null
      ? '  (there is no champion for this slot yet)'
      : JSON.stringify(input.champion, null, 2)
          .split('\n')
          .map((l) => `  ${l}`)
          .join('\n');

  const c = input.outcomes.conversations;

  return `You are Coach for an AI sales assistant named Lexi, who cold-calls business prospects in Australia and New Zealand on behalf of Vinay Kumar at Hexaware. Each week you propose better wording for ONE part of her call. A deterministic gate, a separate compliance reviewer and a set of adversarial test calls will examine whatever you write before it is ever spoken, so write for the people on the phone, not for the gate.

THIS WEEK'S SLOT: ${input.slot}
WHY THIS SLOT: ${input.focusReason}

WHAT HAPPENED: ${c.eligible} conversations got past the fixed opening; ${c.completed} reached a recorded outcome; ${c.requests} produced a meeting request (${(c.requestRate * 100).toFixed(1)}%).

THE CURRENT WORDING FOR THIS SLOT:
${champion}

WHAT HAS ALREADY FAILED (do not propose these again, or the same idea in other words):
${failures}

APPROVED CLAIMS. Facts can enter your wording ONLY as a {{claim:<id>}} placeholder, which the system fills with the approved text verbatim:
${claims}

HOW TO WRITE
- Plain, warm, brief spoken Australian English. One idea. One question at most.
- Placeholders you may use: {{firstName}}, {{company}}, {{hook}} (hook slot only), {{claim:<id>}} (value statement and objection responses only).
- Do not write a figure, a client name, a capability, a certification or a comparison. If it is a fact it must be a claim placeholder; if no claim fits, write wording that asserts nothing.
- Do not mention what Lexi is, the recording, being removed from a list, or where the number came from. Those are fixed and not yours.
- Never argue with a no, manufacture urgency, guilt, or imply they have spoken before. Lexi cannot book anything: she asks for preferences and Vinay emails to confirm.
- You are changing wording only. Do not include an opening, disclosures, rules, instructions or any key other than the ones in the shape below.

SHAPE OF EACH PROPOSAL'S "content":
  ${SHAPE[input.slot]}

Propose between one and ${input.maxProposals} different variants. Reply with JSON only, no prose:
{"proposals":[{"content":<as above>,"rationale":"why this should do better, in one or two plain sentences","targetsProblem":"what it fixes, in a few words"}]}`;
}
