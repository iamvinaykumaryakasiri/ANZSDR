/**
 * What a playbook slot can hold - and, by omission, what it cannot.
 *
 * Section 11 lets Coach rewrite five things: hook phrasing, the value statement,
 * objection rebuttals, the transition to the ask, and the wording of the
 * preference request. It may never touch the identity disclosure, the AI
 * disclosure, the recording announcement, termination on request, the banned-topic
 * list or the approved-claims boundary.
 *
 * "May never touch" is enforced here by what the schema can express rather than
 * by a check that somebody could forget to run:
 *
 *   - Every content shape is `.strict()`. A variant carrying an `opening`, a
 *     `disclosure`, a list of banned topics or a claim definition does not parse;
 *     there is no field for it to land in.
 *   - The five slots are the only slots. There is no sixth that could hold
 *     "the part Coach shouldn't change".
 *   - Text is a template (see template.ts). A fact can enter only as a reference
 *     to an approved claim, resolved when the prompt is built.
 *   - The objection kinds that carry an obligation - being asked whether she is a
 *     person, being asked where the number came from, a request for a price, a
 *     plain "not interested" - are not rewritable kinds, so there is nowhere to
 *     put a rebuttal to them.
 *
 * What a schema cannot do is read meaning. A variant whose free text says "skip
 * the disclosure" parses perfectly well; that is the linter's, the reviewer's and
 * the adversarial simulation's job, and they run before anything is live.
 */

import { z } from 'zod';
import { playbookSlotSchema } from '../blackboard/schemas.js';
import { COACH_MAY_NOT_EDIT } from '../agents/caller/opening.js';
import { objectionKindSchema } from '../agents/caller/tools.js';
import { parseTemplate } from './template.js';

export type PlaybookSlot = z.infer<typeof playbookSlotSchema>;

/** The order slots appear in a call, and in a version label. */
export const PLAYBOOK_SLOTS = ['hook', 'value-statement', 'transition', 'preference-request', 'objection'] as const satisfies readonly PlaybookSlot[];

/* ------------------------------------------------------------------ */
/* Objections                                                          */
/* ------------------------------------------------------------------ */

/** Objections whose handling is phrasing. Coach may rewrite these. */
export const REWRITABLE_OBJECTIONS = [
  'has-a-partner',
  'no-budget',
  'no-time-now',
  'send-email',
  'not-the-right-person',
  'other'
] as const;
export type RewritableObjection = (typeof REWRITABLE_OBJECTIONS)[number];

/**
 * Objections whose handling is an obligation, with the reason each is out of
 * Coach's reach. Kept as data so the list is reviewable and the test that every
 * objection kind is accounted for for has something to read.
 */
export const FROZEN_OBJECTIONS = {
  'asked-if-human': 'the AI disclosure: Lexi tells them plainly that she is an AI, every time, however it is asked',
  'asked-where-number-came-from': 'section 7.3 requires an honest answer on request: a B2B data provider',
  'wants-pricing': 'commercial terms are a banned topic; the deflection is fixed in Guardian',
  'not-interested': 'termination on request: accept the first genuine no, one clarifying question at most, close warmly'
} as const;

/* ------------------------------------------------------------------ */
/* Template fields                                                     */
/* ------------------------------------------------------------------ */

interface TemplateRules {
  max: number;
  /** `{{hook}}` is required. Only the hook slot may use it. */
  hook?: 'required';
  /** `{{claim:id}}` is allowed, or required. */
  claims?: 'allowed' | 'required';
}

function templateText(rules: TemplateRules): z.ZodType<string, z.ZodTypeDef, string> {
  return z
    .string()
    .trim()
    .min(10, 'too short to be a sentence')
    .max(rules.max)
    .superRefine((value, ctx) => {
      const parsed = parseTemplate(value);
      for (const bad of parsed.invalid) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `unknown placeholder ${bad}; allowed: {{firstName}} {{company}} {{hook}} {{claim:<id>}}` });
      }
      const hooks = parsed.placeholders.filter((p) => p.kind === 'hook').length;
      const claims = parsed.placeholders.filter((p) => p.kind === 'claim').length;

      if (rules.hook === 'required' && hooks === 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'a hook phrasing must include {{hook}}: the specific thing it is about comes from the dossier, not from Coach' });
      }
      if (rules.hook !== 'required' && hooks > 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: '{{hook}} belongs to the hook slot only' });
      }
      if (rules.claims === undefined && claims > 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'this slot may not carry a claim; facts belong in the value statement and the objection responses' });
      }
      if (rules.claims === 'required' && claims === 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'a value statement must rest on at least one approved claim: {{claim:<id>}}' });
      }
    });
}

/* ------------------------------------------------------------------ */
/* The five slots                                                      */
/* ------------------------------------------------------------------ */

export const hookContentSchema = z
  .object({ slot: z.literal('hook'), template: templateText({ max: 300, hook: 'required' }) })
  .strict();

export const valueStatementContentSchema = z
  .object({ slot: z.literal('value-statement'), template: templateText({ max: 420, claims: 'required' }) })
  .strict();

export const transitionContentSchema = z
  .object({ slot: z.literal('transition'), template: templateText({ max: 240 }) })
  .strict();

export const preferenceRequestContentSchema = z
  .object({ slot: z.literal('preference-request'), template: templateText({ max: 320 }) })
  .strict();

const objectionText = templateText({ max: 280, claims: 'allowed' });

export const objectionResponsesSchema = z
  .object({
    'has-a-partner': objectionText.optional(),
    'no-budget': objectionText.optional(),
    'no-time-now': objectionText.optional(),
    'send-email': objectionText.optional(),
    'not-the-right-person': objectionText.optional(),
    other: objectionText.optional()
  })
  .strict()
  .refine((responses) => Object.values(responses).some((v) => v !== undefined), {
    message: 'an objection variant must rewrite at least one response'
  });

export const objectionContentSchema = z
  .object({ slot: z.literal('objection'), responses: objectionResponsesSchema })
  .strict();

export const playbookContentSchema = z.discriminatedUnion('slot', [
  hookContentSchema,
  valueStatementContentSchema,
  transitionContentSchema,
  preferenceRequestContentSchema,
  objectionContentSchema
]);
export type PlaybookContent = z.infer<typeof playbookContentSchema>;

/** The shapes by slot, for validating content that is already known to belong to one. */
export const CONTENT_SCHEMAS = {
  hook: hookContentSchema,
  'value-statement': valueStatementContentSchema,
  transition: transitionContentSchema,
  'preference-request': preferenceRequestContentSchema,
  objection: objectionContentSchema
} as const satisfies Record<PlaybookSlot, z.ZodTypeAny>;

/** What a call runs with: one piece of content per slot, where there is one. */
export type PlaybookSet = Partial<{ [S in PlaybookSlot]: Extract<PlaybookContent, { slot: S }> }>;

/* ------------------------------------------------------------------ */
/* Reading the text out of a content                                   */
/* ------------------------------------------------------------------ */

export interface TextField {
  /** A path for messages: `template`, or `responses.has-a-partner`. */
  field: string;
  text: string;
}

export function textFields(content: PlaybookContent): TextField[] {
  if (content.slot === 'objection') {
    const out: TextField[] = [];
    for (const kind of REWRITABLE_OBJECTIONS) {
      const text = content.responses[kind];
      if (text !== undefined) out.push({ field: `responses.${kind}`, text });
    }
    return out;
  }
  return [{ field: 'template', text: content.template }];
}

/* ------------------------------------------------------------------ */
/* The immutable module                                                */
/* ------------------------------------------------------------------ */

/**
 * Things Coach may never touch that are not opening segments. The opening's own
 * segments come from `COACH_MAY_NOT_EDIT`, so adding one there extends this list
 * without anyone remembering to.
 */
const OTHER_IMMUTABLE = [
  'opening',
  'openingSegments',
  'segments',
  'disclosure',
  'aiDisclosure',
  'identityDisclosure',
  'recordingAnnouncement',
  'termination',
  'terminateOnRequest',
  'optOut',
  'suppression',
  'bannedTopics',
  'bannedTopicList',
  'banned',
  'deflection',
  'deflections',
  'claims',
  'approvedClaims',
  'claimIndex',
  'claimBoundary',
  'systemPrompt',
  'system',
  'prompt',
  'instructions'
] as const;

function normaliseKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(
  [...COACH_MAY_NOT_EDIT, ...OTHER_IMMUTABLE].map((k) => normaliseKey(k))
);

/**
 * Key paths in a raw, untrusted candidate that name part of the immutable module.
 *
 * This runs before the schema so a rejection can say what was attempted
 * ("tried to set `opening`") rather than only that the shape was wrong. It is
 * defence in depth: the strict schema would reject these too.
 */
export function findImmutableKeys(raw: unknown, path = '', depth = 0): string[] {
  if (depth > 6 || raw === null || typeof raw !== 'object') return [];
  if (Array.isArray(raw)) {
    return raw.flatMap((item, i) => findImmutableKeys(item, `${path}[${i}]`, depth + 1));
  }
  const found: string[] = [];
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const here = path === '' ? key : `${path}.${key}`;
    if (FORBIDDEN_KEYS.has(normaliseKey(key))) found.push(here);
    found.push(...findImmutableKeys(value, here, depth + 1));
  }
  return found;
}

/** Every field name any slot's schema can hold. Used to prove the module is not representable. */
export function schemaFieldNames(): string[] {
  const names = new Set<string>();
  const visit = (schema: z.ZodTypeAny): void => {
    if (schema instanceof z.ZodEffects) return visit(schema.innerType() as z.ZodTypeAny);
    if (schema instanceof z.ZodOptional) return visit(schema.unwrap() as z.ZodTypeAny);
    if (schema instanceof z.ZodObject) {
      for (const [key, child] of Object.entries(schema.shape as Record<string, z.ZodTypeAny>)) {
        names.add(key);
        visit(child);
      }
    }
  };
  for (const schema of Object.values(CONTENT_SCHEMAS)) visit(schema);
  return [...names];
}

/** Field names in the schema that collide with the immutable module. Must be empty. */
export function immutableFieldsInSchema(): string[] {
  return schemaFieldNames().filter((name) => FORBIDDEN_KEYS.has(normaliseKey(name)));
}

/* ------------------------------------------------------------------ */
/* Version names                                                       */
/* ------------------------------------------------------------------ */

export type SlotVersions = Partial<Record<PlaybookSlot, number>>;

/**
 * How a version is named everywhere a person or another module reads it:
 * `hook v3`. The console's playbook panel matches a call to the version it ran by
 * this exact string in `Call.playbookVersion`, so the format is shared, not
 * private to Coach. Every (slot, version) pair names exactly one immutable piece of
 * content.
 */
export function versionName(slot: PlaybookSlot, version: number): string {
  return `${slot} v${version}`;
}

export function parseVersionName(name: string | null | undefined): { slot: PlaybookSlot; version: number } | null {
  if (name === null || name === undefined) return null;
  const match = /^([a-z-]+) v(\d+)$/.exec(name);
  if (match === null) return null;
  const slot = PLAYBOOK_SLOTS.find((s) => s === match[1]);
  return slot === undefined ? null : { slot, version: Number(match[2]) };
}

export { objectionKindSchema };
