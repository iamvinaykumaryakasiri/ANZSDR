/**
 * The guardrail linter: the first and cheapest stage of the promotion gate.
 *
 * It reads a variant the way Guardian layer one reads a live turn, and then it
 * reads the variant for the things only a script - as opposed to a sentence in a
 * conversation - can get wrong. Everything here is deterministic. A false positive
 * costs one variant that has to be rephrased; a false negative is a sentence Lexi
 * may say to a stranger on Hexaware's behalf, so the patterns are blunt.
 *
 * Two texts are examined per field. The literal text (placeholders removed) is the
 * words Coach actually wrote, and is where tampering, pressure, figures and
 * instructions are looked for. The rendered text (placeholders filled with a
 * sample hook and the real claim text) is what Lexi would say, and is run through
 * Guardian's own ban rules, so a variant that would be cut mid-sentence on a live
 * call is rejected here instead.
 */

import { BAN_RULES } from '../agents/guardian/banned.js';
import { textFields, type PlaybookContent } from './schema.js';
import { parseTemplate, renderTemplate } from './template.js';

export type LintRule =
  | 'banned-content'
  | 'immutable-topic'
  | 'instruction-shaped'
  | 'pressure'
  | 'false-relationship'
  | 'commitment'
  | 'figure'
  | 'one-question'
  | 'rebuttal-after-no'
  | 'preference-ask'
  | 'defers-to-vinay';

export interface LintFinding {
  rule: LintRule;
  /** `template`, or `responses.has-a-partner`. */
  field: string;
  message: string;
  matched?: string;
}

export interface LintContext {
  /** Approved claim text for rendering. Without it a claim renders as a neutral stand-in. */
  claimText?: (id: string) => string | undefined;
}

/** What placeholders are filled with when the linter renders a variant. Neutral on purpose. */
export const LINT_SAMPLE = {
  firstName: 'Priya',
  company: 'Kiwibank',
  hook: 'is modernising its core banking platform'
} as const;

interface Pattern {
  rule: LintRule;
  pattern: RegExp;
  message: string;
}

/**
 * Things the opening and Guardian own. A variant has no business mentioning them:
 * not to contradict them, and not to restate them in softer words either.
 */
const IMMUTABLE_TOPICS: Pattern[] = [
  {
    rule: 'immutable-topic',
    pattern: /\b(?:ai|a\.i\.|artificial intelligence|bot|robot|chatbot|human|(?:real|actual|live) (?:person|agent))\b/i,
    message: 'talks about what Lexi is; the AI disclosure is fixed and is not Coach\'s to phrase'
  },
  {
    rule: 'immutable-topic',
    pattern: /\brecord(?:ing|ed|s)?\b/i,
    message: 'talks about the recording; the announcement is fixed and is not Coach\'s to phrase'
  },
  {
    rule: 'immutable-topic',
    pattern:
      /\b(?:opt[- ]?out|unsubscribe|do not call|don'?t call|stop (?:calling|ringing)|no more calls|take you off|remove (?:you|your))\b/i,
    message: 'talks about stopping or removal; termination on request is fixed and is not Coach\'s to phrase'
  },
  {
    rule: 'immutable-topic',
    pattern: /\b(?:disclos\w*|privacy act|consent|where (?:did|do) (?:i|we) get|your number came|data provider)\b/i,
    message: 'talks about disclosure or where the number came from; those answers are fixed'
  },
  {
    rule: 'immutable-topic',
    pattern:
      /\b(?:skip|omit|drop|leave out|don'?t (?:mention|say|state|tell)|do not (?:mention|say|state|tell)|never (?:mention|say|state)|avoid (?:mentioning|saying)|without (?:mentioning|saying)|no need to (?:mention|say|tell))\b/i,
    message: 'tells Lexi to leave something out; what must be said on a call is not Coach\'s to remove'
  }
];

const INSTRUCTION_SHAPED: Pattern[] = [
  {
    rule: 'instruction-shaped',
    pattern: /\b(?:ignore|disregard|override|forget)\b/i,
    message: 'reads as an instruction to the model, not as something to say to a person'
  },
  {
    rule: 'instruction-shaped',
    pattern: /\b(?:system prompt|your (?:instructions|brief|rules|prompt|guidelines)|previous instructions|new instructions)\b/i,
    message: 'refers to Lexi\'s instructions; a phrasing is words to say, not a change to the brief'
  },
  {
    rule: 'instruction-shaped',
    pattern: /\b(?:you (?:must|are to|shall|will now)|from now on)\b/i,
    message: 'addresses the model rather than the prospect'
  },
  {
    rule: 'instruction-shaped',
    pattern: /^\s*(?:system|assistant|user|human)\s*:|```|<\/?[a-z][^>]*>|\[\s*(?:inst|system)\s*\]/im,
    message: 'contains markup or a role marker that would read as prompt structure'
  }
];

const PRESSURE: Pattern[] = [
  {
    rule: 'pressure',
    pattern:
      /\b(?:limited (?:time|spots|availability)|act (?:now|fast|quickly)|last chance|before it'?s too late|running out of|won'?t last|only (?:a few|\w+) (?:spots|slots|places)|don'?t miss|time is running)\b/i,
    message: 'manufactures urgency'
  },
  {
    rule: 'pressure',
    pattern:
      /\b(?:you (?:owe|have to|need to|should)\b|surely you|don'?t you (?:want|think|care)|aren'?t you (?:worried|concerned)|everyone else|your competitors are|falling behind|you'?ll regret|you could lose)\b/i,
    message: 'guilts, argues or plays on fear'
  }
];

const FALSE_RELATIONSHIP: Pattern[] = [
  {
    rule: 'false-relationship',
    pattern:
      /\b(?:as (?:we|i) (?:discussed|mentioned|spoke)|we (?:spoke|talked|met|discussed)|following up|follow(?:ing)?[- ]up on|last time|you'?ll remember|as you know|i know you|we(?:'ve| have) (?:spoken|met|worked)|our (?:last|previous) (?:conversation|call|chat)|catching up|(?:he|vinay)(?: is)? (?:expecting|asked me to call)|expecting (?:my|our) call)\b/i,
    message: 'implies a relationship or prior contact that does not exist'
  }
];

const COMMITMENT: Pattern[] = [
  {
    rule: 'commitment',
    pattern:
      /\b(?:i'?ll|i will|i can|let me)\s+(?:book|hold|reserve|pencil|lock|schedule|diarise|put (?:you|that|it) (?:in|down))\b/i,
    message: 'promises something only Vinay can do'
  },
  {
    rule: 'commitment',
    pattern: /\b(?:you'?re all set|all set|sorted|see you (?:then|on|at)|it'?s (?:done|locked|set)|consider it done)\b/i,
    message: 'speaks as though the meeting is arranged; Lexi captures a preference and Vinay confirms'
  }
];

const REBUTTAL_AFTER_NO: Pattern[] = [
  {
    rule: 'rebuttal-after-no',
    pattern:
      /\b(?:before you go|just one (?:more |last |quick )?thing|hear me out|give me (?:a|one) (?:minute|second|moment)|surely|are you sure|you'?d be (?:mad|crazy|foolish)|at least (?:let me|listen|hear))\b/i,
    message: 'pushes back after a no; the first genuine no is accepted'
  }
];

const FIGURES: Pattern[] = [
  { rule: 'figure', pattern: /\d/, message: 'contains a digit; a figure is a factual claim and may only arrive through an approved claim' },
  { rule: 'figure', pattern: /[$€£%]/, message: 'contains a currency or percentage symbol' },
  {
    rule: 'figure',
    pattern:
      /\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion|dozens?|hundreds|thousands)\s+(?:\w+\s+)?(?:percent|per cent|clients?|customers?|banks?|years?|countries|people|employees|engineers|consultants|projects|offices|times)\b/i,
    message: 'states a quantity of clients, people, years or the like; a figure may only arrive through an approved claim'
  }
];

function matches(patterns: Pattern[], text: string, field: string): LintFinding[] {
  const out: LintFinding[] = [];
  for (const { rule, pattern, message } of patterns) {
    const hit = pattern.exec(text);
    if (hit !== null) out.push({ rule, field, message, matched: hit[0] });
  }
  return out;
}

/** Every Guardian ban rule the rendered text would trip, not just the first. */
function bannedContent(rendered: string, field: string): LintFinding[] {
  const seen = new Set<string>();
  const out: LintFinding[] = [];
  for (const rule of BAN_RULES) {
    if (rule.severity !== 'cut') continue;
    const hit = rule.pattern.exec(rendered);
    if (hit === null || seen.has(rule.why)) continue;
    seen.add(rule.why);
    out.push({
      rule: 'banned-content',
      field,
      message: `Guardian would cut this live (${rule.why})`,
      matched: hit[0]
    });
  }
  return out;
}

export function lintContent(content: PlaybookContent, context: LintContext = {}): LintFinding[] {
  const findings: LintFinding[] = [];
  const claimText = context.claimText ?? (() => undefined);

  for (const { field, text } of textFields(content)) {
    const { literal } = parseTemplate(text);
    // A claim that cannot be resolved renders as a stand-in. Whether it should
    // exist at all is the claim check's question, not the linter's.
    const rendered = renderTemplate(text, {
      ...LINT_SAMPLE,
      claimText: (id) => claimText(id) ?? '[approved claim]'
    }).text;

    findings.push(...bannedContent(rendered, field));
    findings.push(...matches(IMMUTABLE_TOPICS, literal, field));
    findings.push(...matches(INSTRUCTION_SHAPED, literal, field));
    findings.push(...matches(PRESSURE, literal, field));
    findings.push(...matches(FALSE_RELATIONSHIP, literal, field));
    findings.push(...matches(COMMITMENT, literal, field));
    findings.push(...matches(REBUTTAL_AFTER_NO, literal, field));
    findings.push(...matches(FIGURES, literal, field));

    // Section 8: one question at a time, then stop talking.
    if ((rendered.match(/\?/g) ?? []).length > 1) {
      findings.push({ rule: 'one-question', field, message: 'asks more than one question; one at a time, then stop talking' });
    }

    if (content.slot === 'preference-request') {
      if (!/\b(?:window|windows|suit|suits|works? for you|good for you|free|prefer|convenient|times?)\b/i.test(literal)) {
        findings.push({
          rule: 'preference-ask',
          field,
          message: 'does not ask for a preference; the ask is for windows that suit them, never a commitment'
        });
      }
      if (!/\bvinay\b/i.test(literal) || !/\b(?:email|confirm|confirmation|invite)\b/i.test(literal)) {
        findings.push({
          rule: 'defers-to-vinay',
          field,
          message: 'does not say Vinay will email to confirm; that line is the only commitment Lexi may make'
        });
      }
    }
  }

  return findings;
}
