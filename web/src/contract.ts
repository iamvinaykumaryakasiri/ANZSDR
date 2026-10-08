/**
 * Wire contract with the console backend. TYPES ONLY, hand-copied from
 * src/stream/contract.ts (the zod source of truth) so the web bundle carries no
 * zod and no import from outside web/. Keep the two in step: `npm run
 * contract:check` compares the field names and fails on drift.
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

export const SCRIPT_STAGES = ['disclosure', 'reason', 'hook', 'value', 'ask', 'close'] as const;
export type ScriptStage = (typeof SCRIPT_STAGES)[number];

type Iso = string;
export type Market = 'AU' | 'NZ';

export interface KillSwitchView {
  engaged: boolean;
  reason?: string;
  since?: Iso;
}

export interface TranscriptTurnView {
  speaker: 'lexi' | 'prospect';
  text: string;
  atSecond: number;
}

export interface LiveCallView {
  callId: string;
  prospect: { name: string; title: string; company: string; market: Market };
  hypothesis: string;
  startedAt: Iso;
  elapsedSeconds: number;
  stage: ScriptStage;
  confidence: 'high' | 'medium' | 'low';
  variant: string;
  transcript: TranscriptTurnView[];
}

export interface GateVerdict {
  allowed: boolean;
  /** Gate reason codes, e.g. DAY_PLAN_NOT_APPROVED. Empty when allowed. */
  reasons: string[];
}

export interface QueueItemView {
  contactId: string;
  name: string;
  title: string;
  company: string;
  market: Market;
  hypothesis: string;
  earliestLawfulAt: Iso | null;
  gate: GateVerdict;
}

export interface MeetingWindow {
  startsAt: Iso;
  endsAt: Iso;
  /** The prospect's own words, e.g. "Tuesday or Wednesday morning". */
  said: string;
  localLabel: string;
  sydneyLabel: string;
}

export type MeetingStatus = 'pending' | 'confirmed' | 'rescheduled' | 'rejected';
export type MeetingDecision = 'CONFIRMED' | 'RESCHEDULE' | 'REJECT';

export interface MeetingRequestView {
  ref: string;
  status: MeetingStatus;
  createdAt: Iso;
  name: string;
  title: string;
  company: string;
  email: string | null;
  phone: string;
  linkedinUrl: string | null;
  windows: MeetingWindow[];
  attendees: string[];
  hypothesis: string;
  hookThatWorked: string | null;
  summary: string[];
  objections: string[];
  draftReply: string;
  callId: string;
}

export interface EscalationView {
  id: string;
  contact: string;
  company: string;
  reason: string;
  at: Iso;
}

export type FunnelStageId =
  | 'queued'
  | 'gate_passed'
  | 'dialled'
  | 'answered'
  | 'survived_opener'
  | 'real_conversation'
  | 'ask_made'
  | 'meeting_requested'
  | 'confirmed';

export interface FunnelStageView {
  id: FunnelStageId;
  label: string;
  count: number;
  /** Fraction of the previous stage that reached this one (0..1). */
  rate: number;
  loss: number;
  /** The same rate over the trailing seven days. */
  baselineRate: number;
}

export interface HangupBin {
  fromSecond: number;
  count: number;
  callIds: string[];
}

export interface HangupSection {
  id: ScriptStage;
  label: string;
  fromSecond: number;
  toSecond: number;
}

export interface HangupCurveView {
  /** Density of call length: one bin per `binSeconds`. */
  binSeconds: number;
  bins: HangupBin[];
  sections: HangupSection[];
}

export interface TodayView {
  dialled: number;
  connected: number;
  conversations: number;
  requests: number;
  spendUsd: number;
  costPerMeetingUsd: number | null;
}

export type PlaybookOutcome = 'champion' | 'promoted' | 'rolled_back' | 'rejected' | 'running';

export interface PlaybookView {
  champion: { version: string; summary: string; requestRate: number; conversations: number };
  challenger: {
    version: string;
    summary: string;
    requestRate: number;
    conversations: number;
    minConversations: number;
  } | null;
  history: Array<{ version: string; at: Iso; note: string; outcome: PlaybookOutcome }>;
}

export type ProviderStatus = 'ok' | 'degraded' | 'down' | 'not_configured';

export interface HealthView {
  queueDepth: number;
  providers: Array<{ name: string; status: ProviderStatus; detail?: string }>;
  apolloCreditsRemaining: number | null;
  spendMonthUsd: number;
  spendCeilingUsd: number | null;
  gateRejections: Array<{ reason: string; count: number }>;
}

export interface BriefingView {
  generatedAt: Iso;
  headline: string;
  sections: Array<{ title: string; body: string }>;
}

export interface ConsoleSnapshot {
  generatedAt: Iso;
  /** 'demo' when the data is seeded sample data; the console must say so. */
  mode: 'demo' | 'live';
  killSwitch: KillSwitchView;
  live: LiveCallView | null;
  standingBy: { next: QueueItemView | null; nextDialAt: Iso | null; note: string };
  needsYou: { meetingRequests: MeetingRequestView[]; escalations: EscalationView[] };
  upNext: QueueItemView[];
  today: TodayView;
  funnel: FunnelStageView[];
  hangupCurve: HangupCurveView;
  objections: Array<{ label: string; count: number }>;
  gatekeeperByAccount: Array<{ company: string; blocks: number; calls: number }>;
  wrongNumberRate: number;
  playbook: PlaybookView;
  health: HealthView;
  briefing: BriefingView;
}

export type ConsoleEvent =
  | { type: 'snapshot'; snapshot: ConsoleSnapshot }
  | { type: 'call_started'; call: LiveCallView }
  | { type: 'transcript'; callId: string; turn: TranscriptTurnView }
  | { type: 'stage'; callId: string; stage: ScriptStage }
  | { type: 'call_ended'; callId: string; outcome: string }
  | { type: 'kill_switch'; killSwitch: KillSwitchView };

export interface CallLogEntry {
  id: string;
  startedAt: Iso;
  durationSeconds: number;
  name: string;
  company: string;
  market: Market;
  outcome: string;
  variant: string;
  defects: number;
  /** Optional segment keys (section 14.2: segment by industry and seniority). */
  industry?: string;
  seniority?: string;
}

export interface CallDetail extends CallLogEntry {
  transcript: TranscriptTurnView[];
  recordingUrl: string | null;
  dossierSummary: string;
  defectDetails: Array<{ kind: string; detail: string; atSecond?: number }>;
}

export interface TraceEntry {
  id: string;
  at: Iso;
  agent: string;
  /** Plain English: what the orchestrator decided and why. */
  decision: string;
  result: string;
  costUsd: number;
}

export interface JarvisAnswer {
  kind: 'answer' | 'needs_confirmation' | 'refused' | 'done';
  text: string;
  /** What the answer was read from, always shown. */
  sources: string[];
  /** For needs_confirmation: exactly what will happen. */
  action?: { actionId: string; description: string };
}

/** Kept for the segmenter's signature; both fields now live on CallLogEntry. */
export type CallLogSegments = Pick<CallLogEntry, 'industry' | 'seniority'>;
