/**
 * Shared types for the compliance engine.
 *
 * Nothing in `src/compliance` is an agent. Every decision here is deterministic,
 * reproducible from its inputs, and covered by tests. An agent may ask this
 * engine for permission; it may not argue with the answer.
 */

export type Market = 'AU' | 'NZ';

/** Australian states and territories, as used by the data.gov.au holiday dataset. */
export const AU_JURISDICTIONS = [
  'au-act',
  'au-nsw',
  'au-nt',
  'au-qld',
  'au-sa',
  'au-tas',
  'au-vic',
  'au-wa'
] as const;
export type AuJurisdiction = (typeof AU_JURISDICTIONS)[number];

/**
 * New Zealand has no state system; the thing that varies regionally is the
 * anniversary day, so regions are modelled as anniversary provinces.
 */
export const NZ_JURISDICTIONS = [
  'nz-auckland',
  'nz-canterbury',
  'nz-chatham',
  'nz-hawkes-bay',
  'nz-marlborough',
  'nz-nelson',
  'nz-otago',
  'nz-south-canterbury',
  'nz-southland',
  'nz-taranaki',
  'nz-wellington',
  'nz-westland'
] as const;
export type NzJurisdiction = (typeof NZ_JURISDICTIONS)[number];

/** Holidays observed nationally in NZ; every NZ region inherits these. */
export const NZ_NATIONAL = 'nz-national';

export type Jurisdiction = AuJurisdiction | NzJurisdiction | typeof NZ_NATIONAL;

/** A place the recipient might plausibly be, with the clock that applies there. */
export interface Locality {
  jurisdiction: Jurisdiction;
  /** IANA timezone identifier, e.g. `Australia/Adelaide`. */
  timezone: string;
}

export type LineType = 'fixed' | 'mobile' | 'non-geographic';

/** How precisely we know where the recipient is. */
export type GeoConfidence =
  /** An explicit, trusted hint (enrichment or operator input) pinned it to one place. */
  | 'exact'
  /** The number's area code narrowed it to a handful of places. */
  | 'narrowed'
  /** Mobile or non-geographic: it could be anywhere in the market. */
  | 'unknown';

export interface ParsedNumber {
  /** Normalised E.164, e.g. `+61255501234`. */
  e164: string;
  market: Market;
  lineType: LineType;
  /** National significant number (no country code, no leading zero). */
  nsn: string;
  /** Area / service code where the numbering plan defines one. */
  areaCode: string | null;
}

export interface InvalidNumber {
  valid: false;
  reason: string;
  input: string;
}

export type PhoneParseResult = ({ valid: true } & ParsedNumber) | InvalidNumber;

/** A trusted assertion about where a contact actually is, from enrichment or the operator. */
export interface LocalityHint {
  jurisdiction?: Jurisdiction;
  timezone?: string;
}

export interface ResolvedLocality {
  /** Every place the recipient might be. Never empty. The gate must pass in all of them. */
  candidates: Locality[];
  confidence: GeoConfidence;
  /** Plain-English note for the audit log and the console. */
  basis: string;
}

/* ------------------------------------------------------------------ */
/* Dial requests and decisions                                        */
/* ------------------------------------------------------------------ */

export type DialRequestSource = 'orchestrator' | 'operator' | 'retry-queue';

export interface DialRequest {
  requestId: string;
  contactId: string;
  accountId: string;
  campaignId: string;
  /** Raw phone number as held on the contact record. */
  phone: string;
  /** Market the contact is recorded against. Must agree with the number. */
  market: Market;
  /** Email domain, for domain-level suppression (a whole company asking to be left alone). */
  emailDomain?: string;
  localityHint?: LocalityHint;
  source: DialRequestSource;
  /** The instant the dial would happen. */
  at: Date;
}

export const DENY_CODES = [
  'KILL_SWITCH_ACTIVE',
  'INVALID_NUMBER',
  'MARKET_MISMATCH',
  'CALLER_ID_NOT_CONFIGURED',
  'MOBILE_DIALLING_DISABLED',
  'DNC_WASH_MISSING',
  'DNC_WASH_STALE',
  'DNC_REGISTERED',
  'SUPPRESSED',
  'OUTSIDE_STATUTORY_WINDOW',
  'OUTSIDE_POLICY_WINDOW',
  'PUBLIC_HOLIDAY',
  'HOLIDAY_CALENDAR_COVERAGE_GAP',
  'HOLIDAY_CALENDAR_UNVERIFIED',
  'ATTEMPT_CAP_REACHED',
  'ATTEMPT_WINDOW_CLOSED',
  'MIN_INTERVAL_NOT_ELAPSED',
  'ACCOUNT_WEEKLY_CAP',
  'DAILY_DIAL_CAP',
  'CONCURRENCY_LIMIT',
  'NUMBER_ALREADY_DIALLED_TODAY',
  'DAY_PLAN_NOT_APPROVED'
] as const;
export type DenyCode = (typeof DENY_CODES)[number];

export interface DenyReason {
  code: DenyCode;
  /** Plain English, written to be read in the console without decoding. */
  detail: string;
  /**
   * True when no amount of waiting will change the answer. Permanent denials
   * take the contact out of the queue for good.
   */
  permanent: boolean;
  /** Earliest instant this particular reason could clear, when that is knowable. */
  retryableAt?: Date;
}

export interface DecisionEvidence {
  policyVersion: string;
  number?: ParsedNumber;
  locality?: ResolvedLocality;
  /** Local wall-clock time in each candidate locality, for the audit trail. */
  localTimes: Array<{ jurisdiction: Jurisdiction; timezone: string; local: string }>;
  /** The operator's own clock, which the calling plan is written against. */
  operatorTime?: { timezone: string; local: string; weekday: string };
  attemptsUsed: number;
  attemptsRemaining: number;
  dialsToday: number;
  liveCalls: number;
}

export interface DialDecision {
  requestId: string;
  allowed: boolean;
  evaluatedAt: Date;
  reasons: DenyReason[];
  evidence: DecisionEvidence;
  /** Earliest instant the whole request could be allowed, when knowable. */
  retryableAt?: Date;
}

/* ------------------------------------------------------------------ */
/* State the gate reads                                               */
/* ------------------------------------------------------------------ */

export type SuppressionScope = 'contact' | 'number' | 'account' | 'domain';

export type SuppressionSource =
  | 'prospect-request'
  | 'complaint'
  | 'not-interested'
  | 'dnc-register'
  | 'operator'
  | 'escalation'
  | 'existing-relationship';

export interface SuppressionEntry {
  scope: SuppressionScope;
  /** Contact id, E.164 number, account id or email domain depending on scope. */
  key: string;
  source: SuppressionSource;
  reason: string;
  createdAt: Date;
  /** Suppression is permanent and cross-campaign. This is here to be asserted, not set. */
  permanent: true;
}

export type DncWashResult = 'clear' | 'registered';

export interface DncWashRecord {
  e164: string;
  result: DncWashResult;
  washedAt: Date;
  /** Which register was checked, for the audit trail. */
  register: string;
}

export interface AttemptRecord {
  contactId: string;
  accountId: string;
  e164: string;
  at: Date;
  /**
   * Whether this attempt produced a real conversation. The per-account weekly
   * cap lifts once a conversation has happened (section 7.5).
   */
  hadConversation: boolean;
}

export const PLAN_STATUSES = ['draft', 'pending_approval', 'approved', 'rejected', 'superseded'] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

/**
 * The operator's approval of one day's calling.
 *
 * Approval is of a specific list of people on a specific day. A contact who is
 * not on the approved plan is not approved, and a plan approved yesterday does
 * not authorise anything today.
 */
export interface DayPlanState {
  planId: string;
  /** Calendar date in the operational timezone, `yyyy-MM-dd`. */
  planDate: string;
  status: PlanStatus;
  approvedBy?: string;
  approvedAt?: Date;
  /** Whether this particular contact is on that plan. */
  includesContact: boolean;
  /** How many people the plan covers, for the denial message. */
  entryCount: number;
}

export type KillSwitchTripSource =
  | 'operator'
  | 'escalation-threshold'
  | 'error-rate'
  | 'claim-defect-threshold'
  | 'sentiment-collapse'
  | 'blackboard-unreachable';

export interface KillSwitchState {
  active: boolean;
  trippedAt?: Date;
  trippedBy?: KillSwitchTripSource;
  reason?: string;
}

/** Everything the pure gate needs. Loaded by the gate's adapter, never by the gate itself. */
export interface ComplianceSnapshot {
  killSwitch: KillSwitchState;
  /** The live plan for the operational day this request falls in, if there is one. */
  dayPlan: DayPlanState | null;
  /** All suppression entries matching this contact, number, account or domain. */
  suppressions: SuppressionEntry[];
  dncWash: DncWashRecord | null;
  /** Every attempt ever made against this contact, any campaign. */
  contactAttempts: AttemptRecord[];
  /** Attempts against this account within the last 7 days, any contact. */
  accountAttemptsThisWeek: AttemptRecord[];
  /** Whether any conversation has ever happened at this account. */
  accountHasConversed: boolean;
  /** Dials placed so far in the current operational day, all contacts. */
  dialsToday: number;
  /** Dials placed to this specific number within the recipient's current local day. */
  numberDialsToday: number;
  /** Calls currently in progress. */
  liveCalls: number;
}
