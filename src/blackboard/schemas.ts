/**
 * The blackboard's contract with itself.
 *
 * SQLite has no enums and no JSON type, so every constrained field is stored as
 * text and validated here on the way in and on the way out. That is deliberate:
 * it makes the brief's third rule - every agent output that touches the outside
 * world is schema-validated before it is acted on - a property of the store
 * rather than a habit of whoever wrote the last query.
 */

import { z } from 'zod';

export const marketSchema = z.enum(['AU', 'NZ']);
export type Market = z.infer<typeof marketSchema>;

export const campaignStatusSchema = z.enum(['draft', 'active', 'paused', 'finished']);

export const accountStatusSchema = z.enum([
  'new',
  'researching',
  'calling',
  'engaged',
  'closed',
  'suppressed'
]);

export const contactStatusSchema = z.enum([
  'discovered',
  'scored',
  'enriched',
  'researched',
  'queued',
  'contacted',
  'done'
]);

/** Section 5.2: three email states, and a confirmed-on-call address always wins. */
export const emailKindSchema = z.enum(['apollo_work', 'apollo_personal', 'confirmed_on_call']);
export type EmailKind = z.infer<typeof emailKindSchema>;

/** Highest quality first. Used to pick which address to actually use. */
export const EMAIL_PRECEDENCE: EmailKind[] = ['confirmed_on_call', 'apollo_work', 'apollo_personal'];

export const lineTypeSchema = z.enum(['fixed', 'mobile', 'non-geographic']);

export const confidenceSchema = z.enum(['high', 'medium', 'low']);

/** Section 5.5. */
export const callOutcomeSchema = z.enum([
  'meeting_requested',
  'callback_requested',
  'not_interested',
  'wrong_person',
  'gatekeeper_blocked',
  'voicemail',
  'no_answer',
  'invalid_number',
  'do_not_contact',
  'escalated'
]);
export type CallOutcome = z.infer<typeof callOutcomeSchema>;

export const taskStatusSchema = z.enum([
  'pending',
  'blocked',
  'running',
  'done',
  'failed',
  'escalated',
  'cancelled'
]);
export type TaskStatus = z.infer<typeof taskStatusSchema>;

export const agentRunStatusSchema = z.enum([
  'running',
  'succeeded',
  'failed',
  'escalated',
  'budget-exceeded'
]);

export const escalationLevelSchema = z.enum(['orchestrator', 'human']);
export const escalationStatusSchema = z.enum(['open', 'acknowledged', 'resolved']);

export const memoryScopeSchema = z.enum(['contact', 'account', 'playbook', 'failure']);
export type MemoryScope = z.infer<typeof memoryScopeSchema>;

export const playbookSlotSchema = z.enum([
  'hook',
  'value-statement',
  'objection',
  'transition',
  'preference-request'
]);
export const playbookStatusSchema = z.enum(['champion', 'challenger', 'retired']);

export const spendCategorySchema = z.enum(['llm', 'apollo', 'voice', 'sms', 'email']);
export type SpendCategory = z.infer<typeof spendCategorySchema>;

/* ------------------------------------------------------------------ */
/* JSON column shapes                                                  */
/* ------------------------------------------------------------------ */

export const icpSchema = z.object({
  titles: z.array(z.string()),
  seniorities: z.array(z.string()),
  industries: z.array(z.string()).default([]),
  employeeRange: z.tuple([z.number().int(), z.number().int()]).optional(),
  disqualifiers: z.array(z.string()).default([]),
  /** Minimum score a person must reach before we spend a credit enriching them. */
  minimumScore: z.number().int().min(0).max(100).default(60)
});
export type Icp = z.infer<typeof icpSchema>;

export const campaignGoalSchema = z.object({
  meetingsPerWeek: z.number().int().positive(),
  /** Hard ceiling. The Campaign Director stops when this is reached. */
  maxUsdPerWeek: z.number().nonnegative()
});

/** Every fact in a dossier carries the URL it came from. Unsourced facts are dropped. */
export const sourcedFactSchema = z.object({
  fact: z.string().min(1),
  sourceUrl: z.string().url()
});
export type SourcedFact = z.infer<typeof sourcedFactSchema>;

export const dossierPersonSchema = z.object({
  name: z.string(),
  title: z.string(),
  tenure: z.string().optional(),
  priorEmployers: z.array(z.string()).default([]),
  likelyRemit: z.string().optional(),
  signals: z.array(sourcedFactSchema).default([])
});

export const dossierAccountSchema = z.object({
  whatTheyDo: z.string(),
  size: z.string().optional(),
  techSignals: z.array(sourcedFactSchema).default([]),
  announcements: z.array(sourcedFactSchema).default([]),
  pressures: z.array(sourcedFactSchema).default([])
});

export const hookSchema = z.object({
  text: z.string().min(1),
  sourceUrl: z.string().url(),
  /** Which slot of the playbook this hook is a candidate for. */
  slot: playbookSlotSchema.default('hook')
});

export const sectionMarkSchema = z.object({
  section: z.enum(['disclosure', 'reason', 'hook', 'value-statement', 'ask', 'close']),
  atSecond: z.number().nonnegative()
});

export const defectSchema = z.object({
  kind: z.enum(['unsupported-claim', 'banned-topic', 'injection-attempt', 'disclosure-missing']),
  detail: z.string(),
  atSecond: z.number().nonnegative().optional()
});

/* ------------------------------------------------------------------ */
/* Reading and writing JSON columns                                    */
/* ------------------------------------------------------------------ */

export class BlackboardDecodeError extends Error {
  readonly field: string;

  constructor(field: string, cause: unknown) {
    super(`blackboard field "${field}" does not match its schema`, { cause });
    this.name = 'BlackboardDecodeError';
    this.field = field;
  }
}

/**
 * Parse a JSON text column through its schema. Anything malformed throws rather
 * than reaching an agent: a corrupt row is a stop, not a shrug.
 */
export function decode<T>(schema: z.ZodType<T>, field: string, raw: string): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new BlackboardDecodeError(field, cause);
  }
  const result = schema.safeParse(parsed);
  if (!result.success) throw new BlackboardDecodeError(field, result.error);
  return result.data;
}

/** Validate before writing, so a malformed value never lands in the store at all. */
export function encode<T>(schema: z.ZodType<T>, field: string, value: unknown): string {
  const result = schema.safeParse(value);
  if (!result.success) throw new BlackboardDecodeError(field, result.error);
  return JSON.stringify(result.data);
}
