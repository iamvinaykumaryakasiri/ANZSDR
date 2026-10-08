export function pct(value: number, digits = 0): string {
  if (!Number.isFinite(value)) return '-';
  return `${(value * 100).toFixed(digits)}%`;
}

export function usd(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '-';
  return `US$${value.toFixed(digits)}`;
}

export function int(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '-';
  return Math.round(value).toLocaleString('en-AU');
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function sentence(text: string): string {
  const t = text.trim().toLowerCase().replace(/[_-]+/g, ' ');
  return t.charAt(0).toUpperCase() + t.slice(1);
}

const GATE_REASONS: Record<string, string> = {
  ACCOUNT_WEEKLY_CAP: 'Already contacted someone at this account this week',
  ATTEMPT_CAP_REACHED: 'Three attempts used; no more, ever',
  ATTEMPT_WINDOW_CLOSED: 'The 21-day attempt window has closed',
  CALLER_ID_NOT_CONFIGURED: 'No caller ID number is set up yet',
  CONCURRENCY_LIMIT: 'Another call is already live',
  CONTACT_NOT_ON_BLACKBOARD: 'This person is not on the record',
  DAILY_DIAL_CAP: "Today's dial cap is reached",
  DAY_PLAN_NOT_APPROVED: "Today's plan isn't approved yet",
  DNC_REGISTERED: 'The number is on the Do Not Call register',
  DNC_WASH_MISSING: "The number hasn't been washed against the register",
  DNC_WASH_STALE: 'The register wash is more than 30 days old',
  HOLIDAY_CALENDAR_COVERAGE_GAP: "The holiday calendar doesn't cover this date",
  HOLIDAY_CALENDAR_UNVERIFIED: "The holiday calendar hasn't been signed off",
  INVALID_NUMBER: "The number isn't valid",
  KILL_SWITCH_ACTIVE: 'Dialling is halted',
  MARKET_MISMATCH: "The number's market doesn't match the request",
  MIN_INTERVAL_NOT_ELAPSED: 'Fewer than five days since the last attempt',
  MOBILE_DIALLING_DISABLED: 'Mobile numbers are switched off until register washing is in place',
  NOT_A_TEST_CONTACT: 'Test mode: only numbers Vinay controls can be dialled',
  NUMBER_ALREADY_DIALLED_TODAY: 'This number has already been dialled today',
  OUTSIDE_POLICY_WINDOW: "Outside Vinay's calling hours",
  OUTSIDE_STATUTORY_WINDOW: "Outside the legal calling hours where they are",
  PUBLIC_HOLIDAY: 'A public holiday where they are',
  SUPPRESSED: 'On the permanent suppression list'
};

export function gateReasonText(code: string): string {
  return GATE_REASONS[code] ?? sentence(code);
}

const OUTCOMES: Record<string, string> = {
  meeting_requested: 'Meeting requested',
  callback_requested: 'Callback requested',
  not_interested: 'Not interested',
  wrong_person: 'Wrong person',
  gatekeeper_blocked: 'Gatekeeper blocked',
  voicemail: 'Voicemail',
  no_answer: 'No answer',
  invalid_number: 'Invalid number',
  do_not_contact: 'Do not contact',
  escalated: 'Escalated'
};

export function outcomeText(outcome: string): string {
  return OUTCOMES[outcome] ?? sentence(outcome);
}

/** Outcomes that landed somewhere good enough to be shown in sand. */
export function isLandedOutcome(outcome: string): boolean {
  return outcome === 'meeting_requested' || outcome === 'callback_requested';
}

export const STAGE_LABELS: Record<string, string> = {
  disclosure: 'Disclosure',
  reason: 'Reason for call',
  hook: 'Hook',
  value: 'Value',
  ask: 'The ask',
  close: 'Close'
};

export function titleCase(text: string): string {
  return sentence(text);
}
