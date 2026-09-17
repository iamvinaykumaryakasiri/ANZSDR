/**
 * Caller's tool set. Section 3.3 names six and no more.
 *
 * These are the only way anything Lexi hears becomes a fact on the blackboard.
 * Each one validates on entry, so a malformed tool call from the model is a
 * rejected tool call rather than a bad row - the third overriding rule, applied
 * at the one point where a call touches the outside world.
 *
 * What is deliberately absent matters as much: there is no tool to book a time,
 * quote a price, look anything up, or send anything. Lexi cannot do those
 * things because there is no handle for them, not because it was asked not to.
 */

import { DateTime } from 'luxon';
import { z } from 'zod';
import { callOutcomeSchema } from '../../blackboard/schemas.js';

/* ------------------------------------------------------------------ */
/* capture_email                                                       */
/* ------------------------------------------------------------------ */

/**
 * Section 10. A confirmed-on-call address beats anything Apollo sold us, so
 * this is the highest-value tool on the call and the cheapest data we buy.
 */
export const captureEmailSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  /** Whether it was read back phonetically and confirmed. */
  confidence: z.enum(['read-back-confirmed', 'heard-once']),
  /** How the prospect said it, for the record when a transcription is doubtful. */
  spokenAs: z.string().optional()
});
export type CaptureEmailArgs = z.infer<typeof captureEmailSchema>;

/* ------------------------------------------------------------------ */
/* capture_preferred_times                                             */
/* ------------------------------------------------------------------ */

/**
 * A window in the prospect's own words, normalised. Both are kept: the operator
 * reads "Tuesday or Wednesday morning" and the system needs a range, and
 * throwing the phrasing away loses the only evidence that the range is right.
 */
export const preferredSlotSchema = z.object({
  saidAs: z.string().min(1),
  startsAt: z.string().datetime({ offset: true }),
  endsAt: z.string().datetime({ offset: true })
});

export const capturePreferredTimesSchema = z
  .object({
    slots: z.array(preferredSlotSchema).min(1).max(3),
    /** IANA zone. The prospect's, not the operator's. */
    timezone: z.string().min(1),
    /** Anyone else who should be on the call, in the prospect's words. */
    attendees: z.array(z.string()).default([])
  })
  .superRefine((value, ctx) => {
    if (!DateTime.local().setZone(value.timezone).isValid) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['timezone'], message: `unknown timezone "${value.timezone}"` });
    }
    value.slots.forEach((slot, i) => {
      if (DateTime.fromISO(slot.endsAt) <= DateTime.fromISO(slot.startsAt)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['slots', i], message: 'a window must end after it starts' });
      }
    });
  });
export type CapturePreferredTimesArgs = z.infer<typeof capturePreferredTimesSchema>;

/** Section 12.1 shows every window in their time and in Sydney time. */
export function inSydney(iso: string): string {
  return DateTime.fromISO(iso).setZone('Australia/Sydney').toFormat('ccc d LLL, HH:mm');
}

/* ------------------------------------------------------------------ */
/* log_objection                                                       */
/* ------------------------------------------------------------------ */

export const objectionKindSchema = z.enum([
  'has-a-partner',
  'no-budget',
  'no-time-now',
  'send-email',
  'not-the-right-person',
  'not-interested',
  'wants-pricing',
  'asked-where-number-came-from',
  'asked-if-human',
  'other'
]);

export const logObjectionSchema = z.object({
  kind: objectionKindSchema,
  /** What they actually said, so Coach learns from the wording not the label. */
  saidAs: z.string().min(1),
  handledAs: z.string().min(1)
});
export type LogObjectionArgs = z.infer<typeof logObjectionSchema>;

/* ------------------------------------------------------------------ */
/* mark_outcome                                                        */
/* ------------------------------------------------------------------ */

export const markOutcomeSchema = z.object({
  outcome: callOutcomeSchema,
  /** One line. Scribe writes the real summary afterwards from the transcript. */
  note: z.string().max(400).default('')
});
export type MarkOutcomeArgs = z.infer<typeof markOutcomeSchema>;

/* ------------------------------------------------------------------ */
/* suppress_contact                                                    */
/* ------------------------------------------------------------------ */

/**
 * Section 7.2: permanent and cross-campaign. There is no un-suppress tool and
 * there should not be - a person who asked not to be called again asked once.
 */
export const suppressContactSchema = z.object({
  reason: z.enum(['asked-not-to-be-called', 'complaint', 'wrong-person', 'deceased-or-left', 'other']),
  saidAs: z.string().min(1)
});
export type SuppressContactArgs = z.infer<typeof suppressContactSchema>;

/* ------------------------------------------------------------------ */
/* escalate                                                            */
/* ------------------------------------------------------------------ */

/** Section 8's hard-escalation list, as an enum so the reason cannot be vague. */
export const escalationReasonSchema = z.enum([
  'legal-threat',
  'formal-complaint',
  'media-analyst-or-regulator',
  'asked-for-a-human',
  'hostility',
  'existing-client-or-partner',
  'active-rfp-or-procurement',
  'personal-or-distressing'
]);

export const escalateSchema = z.object({
  reason: escalationReasonSchema,
  saidAs: z.string().min(1),
  /** True once Lexi has closed the call politely, which it must do first. */
  closedPolitely: z.boolean()
});
export type EscalateArgs = z.infer<typeof escalateSchema>;

/* ------------------------------------------------------------------ */
/* The set                                                             */
/* ------------------------------------------------------------------ */

export const CALLER_TOOL_SCHEMAS = {
  capture_email: captureEmailSchema,
  capture_preferred_times: capturePreferredTimesSchema,
  log_objection: logObjectionSchema,
  mark_outcome: markOutcomeSchema,
  suppress_contact: suppressContactSchema,
  escalate: escalateSchema
} as const;

export type CallerToolName = keyof typeof CALLER_TOOL_SCHEMAS;

export const CALLER_TOOL_NAMES = Object.freeze(Object.keys(CALLER_TOOL_SCHEMAS) as CallerToolName[]);

/** Every escalation reason also suppresses the contact, per section 8. */
export const ESCALATION_SUPPRESSES: readonly string[] = Object.freeze(escalationReasonSchema.options);

export interface ToolCallResult {
  ok: boolean;
  /** What Lexi is told back. Short: it is being read mid-conversation. */
  message: string;
  error?: string;
}

/**
 * Validate a tool call before anything acts on it.
 *
 * A model that hallucinates a tool name or sends a malformed argument gets a
 * refusal it can read and recover from, rather than a thrown error that drops
 * the call or, worse, a half-parsed value written to the blackboard.
 */
export function validateToolCall(
  name: string,
  args: unknown
): { ok: true; name: CallerToolName; value: unknown } | { ok: false; error: string } {
  if (!(name in CALLER_TOOL_SCHEMAS)) {
    return { ok: false, error: `there is no tool called "${name}"; you have: ${CALLER_TOOL_NAMES.join(', ')}` };
  }
  const tool = name as CallerToolName;
  const parsed = CALLER_TOOL_SCHEMAS[tool].safeParse(args);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first === undefined ? '' : `${first.path.join('.')}: `;
    return { ok: false, error: `${name} was not called correctly — ${where}${first?.message ?? 'invalid arguments'}` };
  }
  return { ok: true, name: tool, value: parsed.data };
}
