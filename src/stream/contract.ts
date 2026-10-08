/**
 * The wire contract between the console backend (src/stream) and the console
 * frontend (web/). Both sides build against this file; neither may change it
 * without changing the other. The console holds no business logic (section
 * 14.6): everything it shows is computed here and sent as data.
 *
 * Routes (all under /api/console, all behind ADMIN_TOKEN as a Bearer token):
 *   GET  /api/console/snapshot            -> ConsoleSnapshot
 *   GET  /api/console/stream              -> SSE of ConsoleEvent (first event is a snapshot)
 *   POST /api/console/kill                -> { engage: boolean, reason?: string }  => KillSwitchView
 *   POST /api/console/meetings/:ref       -> { decision: 'CONFIRMED'|'RESCHEDULE'|'REJECT' } => MeetingRequestView
 *   GET  /api/console/calls               -> CallLogEntry[]
 *   GET  /api/console/calls/:id           -> CallDetail
 *   GET  /api/console/trace               -> TraceEntry[]
 *   POST /api/console/jarvis              -> { query: string } => JarvisAnswer
 *   POST /api/console/jarvis/confirm      -> { actionId: string } => JarvisAnswer
 */

import { z } from 'zod';

export const SCRIPT_STAGES = ['disclosure', 'reason', 'hook', 'value', 'ask', 'close'] as const;
export type ScriptStage = (typeof SCRIPT_STAGES)[number];

const iso = z.string();

export const killSwitchViewSchema = z.object({
  engaged: z.boolean(),
  reason: z.string().optional(),
  since: iso.optional()
});
export type KillSwitchView = z.infer<typeof killSwitchViewSchema>;

export const transcriptTurnSchema = z.object({
  speaker: z.enum(['lexi', 'prospect']),
  text: z.string(),
  atSecond: z.number()
});
export type TranscriptTurnView = z.infer<typeof transcriptTurnSchema>;

export const liveCallSchema = z.object({
  callId: z.string(),
  prospect: z.object({ name: z.string(), title: z.string(), company: z.string(), market: z.enum(['AU', 'NZ']) }),
  hypothesis: z.string(),
  startedAt: iso,
  elapsedSeconds: z.number(),
  stage: z.enum(SCRIPT_STAGES),
  confidence: z.enum(['high', 'medium', 'low']),
  variant: z.string(),
  transcript: z.array(transcriptTurnSchema)
});
export type LiveCallView = z.infer<typeof liveCallSchema>;

export const gateVerdictSchema = z.object({
  allowed: z.boolean(),
  /** Gate reason codes, e.g. DAY_PLAN_NOT_APPROVED. Empty when allowed. */
  reasons: z.array(z.string())
});

export const queueItemSchema = z.object({
  contactId: z.string(),
  name: z.string(),
  title: z.string(),
  company: z.string(),
  market: z.enum(['AU', 'NZ']),
  hypothesis: z.string(),
  earliestLawfulAt: iso.nullable(),
  gate: gateVerdictSchema
});
export type QueueItemView = z.infer<typeof queueItemSchema>;

export const windowSchema = z.object({
  startsAt: iso,
  endsAt: iso,
  /** The prospect's own words, e.g. "Tuesday or Wednesday morning". */
  said: z.string(),
  localLabel: z.string(),
  sydneyLabel: z.string()
});

export const meetingRequestSchema = z.object({
  ref: z.string(),
  status: z.enum(['pending', 'confirmed', 'rescheduled', 'rejected']),
  createdAt: iso,
  name: z.string(),
  title: z.string(),
  company: z.string(),
  email: z.string().nullable(),
  phone: z.string(),
  linkedinUrl: z.string().nullable(),
  windows: z.array(windowSchema),
  attendees: z.array(z.string()),
  hypothesis: z.string(),
  hookThatWorked: z.string().nullable(),
  summary: z.array(z.string()),
  objections: z.array(z.string()),
  draftReply: z.string(),
  callId: z.string()
});
export type MeetingRequestView = z.infer<typeof meetingRequestSchema>;

export const escalationSchema = z.object({
  id: z.string(),
  contact: z.string(),
  company: z.string(),
  reason: z.string(),
  at: iso
});

export const funnelStageSchema = z.object({
  id: z.enum([
    'queued',
    'gate_passed',
    'dialled',
    'answered',
    'survived_opener',
    'real_conversation',
    'ask_made',
    'meeting_requested',
    'confirmed'
  ]),
  label: z.string(),
  count: z.number(),
  /** Fraction of the previous stage that reached this one (0..1). */
  rate: z.number(),
  loss: z.number(),
  /** The same rate over the trailing seven days. */
  baselineRate: z.number()
});
export type FunnelStageView = z.infer<typeof funnelStageSchema>;

export const hangupCurveSchema = z.object({
  /** Density of call length: one bin per `binSeconds`. */
  binSeconds: z.number(),
  bins: z.array(z.object({ fromSecond: z.number(), count: z.number(), callIds: z.array(z.string()) })),
  sections: z.array(z.object({ id: z.enum(SCRIPT_STAGES), label: z.string(), fromSecond: z.number(), toSecond: z.number() }))
});
export type HangupCurveView = z.infer<typeof hangupCurveSchema>;

export const todaySchema = z.object({
  dialled: z.number(),
  connected: z.number(),
  conversations: z.number(),
  requests: z.number(),
  spendUsd: z.number(),
  costPerMeetingUsd: z.number().nullable()
});

export const playbookSchema = z.object({
  champion: z.object({ version: z.string(), summary: z.string(), requestRate: z.number(), conversations: z.number() }),
  challenger: z
    .object({ version: z.string(), summary: z.string(), requestRate: z.number(), conversations: z.number(), minConversations: z.number() })
    .nullable(),
  history: z.array(z.object({ version: z.string(), at: iso, note: z.string(), outcome: z.enum(['champion', 'promoted', 'rolled_back', 'rejected', 'running']) }))
});

export const healthSchema = z.object({
  queueDepth: z.number(),
  providers: z.array(z.object({ name: z.string(), status: z.enum(['ok', 'degraded', 'down', 'not_configured']), detail: z.string().optional() })),
  apolloCreditsRemaining: z.number().nullable(),
  spendMonthUsd: z.number(),
  spendCeilingUsd: z.number().nullable(),
  gateRejections: z.array(z.object({ reason: z.string(), count: z.number() }))
});

export const briefingSchema = z.object({
  generatedAt: iso,
  headline: z.string(),
  sections: z.array(z.object({ title: z.string(), body: z.string() }))
});

export const consoleSnapshotSchema = z.object({
  generatedAt: iso,
  /** 'demo' when the data is seeded sample data; the console must say so. */
  mode: z.enum(['demo', 'live']),
  killSwitch: killSwitchViewSchema,
  live: liveCallSchema.nullable(),
  standingBy: z.object({ next: queueItemSchema.nullable(), nextDialAt: iso.nullable(), note: z.string() }),
  needsYou: z.object({ meetingRequests: z.array(meetingRequestSchema), escalations: z.array(escalationSchema) }),
  upNext: z.array(queueItemSchema),
  today: todaySchema,
  funnel: z.array(funnelStageSchema),
  hangupCurve: hangupCurveSchema,
  objections: z.array(z.object({ label: z.string(), count: z.number() })),
  gatekeeperByAccount: z.array(z.object({ company: z.string(), blocks: z.number(), calls: z.number() })),
  wrongNumberRate: z.number(),
  playbook: playbookSchema,
  health: healthSchema,
  briefing: briefingSchema
});
export type ConsoleSnapshot = z.infer<typeof consoleSnapshotSchema>;

export const consoleEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('snapshot'), snapshot: consoleSnapshotSchema }),
  z.object({ type: z.literal('call_started'), call: liveCallSchema }),
  z.object({ type: z.literal('transcript'), callId: z.string(), turn: transcriptTurnSchema }),
  z.object({ type: z.literal('stage'), callId: z.string(), stage: z.enum(SCRIPT_STAGES) }),
  z.object({ type: z.literal('call_ended'), callId: z.string(), outcome: z.string() }),
  z.object({ type: z.literal('kill_switch'), killSwitch: killSwitchViewSchema })
]);
export type ConsoleEvent = z.infer<typeof consoleEventSchema>;

export const callLogEntrySchema = z.object({
  id: z.string(),
  startedAt: iso,
  durationSeconds: z.number(),
  name: z.string(),
  company: z.string(),
  market: z.enum(['AU', 'NZ']),
  outcome: z.string(),
  variant: z.string(),
  defects: z.number(),
  /** Optional segment keys (section 14.2: segment by industry and seniority). */
  industry: z.string().optional(),
  seniority: z.string().optional()
});
export type CallLogEntry = z.infer<typeof callLogEntrySchema>;

export const callDetailSchema = callLogEntrySchema.extend({
  transcript: z.array(transcriptTurnSchema),
  recordingUrl: z.string().nullable(),
  dossierSummary: z.string(),
  defectDetails: z.array(z.object({ kind: z.string(), detail: z.string(), atSecond: z.number().optional() }))
});
export type CallDetail = z.infer<typeof callDetailSchema>;

export const traceEntrySchema = z.object({
  id: z.string(),
  at: iso,
  agent: z.string(),
  /** Plain English: what the orchestrator decided and why. */
  decision: z.string(),
  result: z.string(),
  costUsd: z.number()
});
export type TraceEntry = z.infer<typeof traceEntrySchema>;

export const jarvisAnswerSchema = z.object({
  kind: z.enum(['answer', 'needs_confirmation', 'refused', 'done']),
  text: z.string(),
  /** What the answer was read from, always shown. */
  sources: z.array(z.string()),
  /** For needs_confirmation: exactly what will happen. */
  action: z.object({ actionId: z.string(), description: z.string() }).optional()
});
export type JarvisAnswer = z.infer<typeof jarvisAnswerSchema>;
