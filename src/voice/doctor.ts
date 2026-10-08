/**
 * The preflight: what stands between this checkout and a first test call.
 *
 * Read-only by construction. This module has no way to place a call: it is given
 * a narrow object that can read an assistant and a phone number back from the
 * provider and nothing else, and it asks the compliance gate's pure function
 * what it *would* say rather than asking the gate (which writes an audit record
 * of every question). Running it any number of times changes nothing.
 *
 * The output is a list of things that are missing, each with what to do about
 * it, and the gate's actual answer for each test contact - because "the gate
 * would refuse this and here is why" is the most useful sentence in the whole
 * set-up, and the codes the gate returns are exactly the things that need
 * fixing.
 */

import { DateTime } from 'luxon';
import type { AgentIdentity } from '../agents/caller/identity.js';
import { identityGaps } from '../agents/caller/identity.js';
import type { Blackboard } from '../blackboard/client.js';
import type { HolidayCalendar } from '../compliance/holidays.js';
import { evaluateDialRequest } from '../compliance/gate.js';
import { marketForDial } from '../compliance/phone.js';
import type { CompliancePolicy } from '../compliance/policy.js';
import type { ComplianceGate } from '../compliance/service.js';
import type { DenyCode, DialRequest, Jurisdiction, Market } from '../compliance/types.js';
import type { ClaimIndex } from '../knowledge/claims.js';
import { assertAssistantInvariants, AssistantInvariantError } from './vapi.js';
import type { VoiceConfig } from './voice-config.js';

export type CheckStatus = 'ok' | 'blocker' | 'warn' | 'info';

export interface Check {
  area: string;
  status: CheckStatus;
  summary: string;
  /** What to do about it. */
  fix?: string;
}

export interface GateLine {
  code: DenyCode;
  detail: string;
  /** A blocker needs a change somewhere; "waiting" clears with time or with an approval. */
  kind: 'blocker' | 'waiting';
  fix: string;
}

export interface GatePreview {
  contactId: string;
  name: string;
  /** Masked: the report may end up in a terminal log. */
  number: string;
  market: Market;
  allowed: boolean;
  /** Everything the gate says right now. */
  now: GateLine[];
  /** What would remain if today's plan were approved. */
  afterApproval: GateLine[];
}

export interface DoctorReport {
  checks: Check[];
  gate: GatePreview[];
  /** No blockers. Not a promise that a dial is allowed right now: the clock and the plan decide that. */
  ready: boolean;
}

/** The only calls the preflight may make to the provider, and they are reads. */
export interface ProviderReader {
  getAssistant(id: string): Promise<Record<string, unknown>>;
  getPhoneNumber(id: string): Promise<Record<string, unknown>>;
}

export interface DoctorInput {
  env: Record<string, string | undefined>;
  policy: CompliancePolicy;
  calendar: HolidayCalendar;
  identity: AgentIdentity;
  voice: VoiceConfig;
  claims: ClaimIndex;
  db: Blackboard | null;
  gate: ComplianceGate | null;
  now: Date;
  /** Narrow a preview to one contact. */
  contactId?: string;
  /** Reads from the provider and Twilio. Absent means offline. */
  online?: { provider?: ProviderReader; fetch?: typeof fetch };
}

/** How to clear each thing the gate can say, and whether it is a setting or just the clock. */
const GATE_ADVICE: Record<DenyCode, { kind: 'blocker' | 'waiting'; fix: string }> = {
  KILL_SWITCH_ACTIVE: { kind: 'blocker', fix: 'npm run kill -- status, then npm run kill -- resume once you know why it was stopped' },
  INVALID_NUMBER: { kind: 'blocker', fix: 'correct the phone number on the contact (E.164, e.g. +61448455510)' },
  MARKET_MISMATCH: { kind: 'blocker', fix: 'the number and the contact disagree about the country; correct the contact' },
  CALLER_ID_NOT_CONFIGURED: {
    kind: 'blocker',
    fix: 'put your Twilio number in config/policy.yaml under caller_id (au_number for an AU call, nz_number for NZ)'
  },
  MOBILE_DIALLING_DISABLED: {
    kind: 'blocker',
    fix: 'set dnc.exempt_test_contacts: true in config/policy.yaml (your own mobile, test contacts only; allow_mobile_dialling stays false)'
  },
  DNC_WASH_MISSING: { kind: 'blocker', fix: 'a test contact skips the wash only when dnc.exempt_test_contacts is true' },
  DNC_WASH_STALE: { kind: 'blocker', fix: 'a test contact skips the wash only when dnc.exempt_test_contacts is true' },
  DNC_REGISTERED: { kind: 'blocker', fix: 'this number is on the Do Not Call register and will not be dialled' },
  SUPPRESSED: { kind: 'blocker', fix: 'this contact or number was suppressed (a STOP text, a refusal). Suppression is permanent' },
  OUTSIDE_STATUTORY_WINDOW: { kind: 'waiting', fix: 'the law does not allow a call to this number at this time; try within calling hours' },
  OUTSIDE_POLICY_WINDOW: { kind: 'waiting', fix: "outside your calling window (Tue-Thu 09:30-16:30 on the operator's clock); try within it" },
  PUBLIC_HOLIDAY: { kind: 'waiting', fix: 'a public holiday; try the next working day' },
  HOLIDAY_CALENDAR_COVERAGE_GAP: { kind: 'blocker', fix: 'the holiday calendar does not cover this date: npm run holidays:build' },
  HOLIDAY_CALENDAR_UNVERIFIED: {
    kind: 'blocker',
    fix: 'a human signs the calendar off: npm run holidays:verify -- --sign-off all:2026 --by "Your Name"'
  },
  ATTEMPT_CAP_REACHED: { kind: 'blocker', fix: 'three attempts have been made on this contact; use another test contact' },
  ATTEMPT_WINDOW_CLOSED: { kind: 'blocker', fix: 'the 21-day attempt window for this contact has closed; use another test contact' },
  MIN_INTERVAL_NOT_ELAPSED: { kind: 'waiting', fix: 'attempts must be five days apart; use another test contact or wait' },
  ACCOUNT_WEEKLY_CAP: { kind: 'waiting', fix: 'one contact per account per week until someone has spoken to us; use a test contact at another account' },
  DAILY_DIAL_CAP: { kind: 'waiting', fix: 'the daily dial cap is reached; try tomorrow' },
  CONCURRENCY_LIMIT: {
    kind: 'waiting',
    fix: 'a call is already live (or stuck). npm run voice:serve closes stuck calls; otherwise wait for it to end'
  },
  NUMBER_ALREADY_DIALLED_TODAY: {
    kind: 'waiting',
    fix: 'this number has been dialled today. Both test contacts share one number, so only one of them can be rung per day'
  },
  DAY_PLAN_NOT_APPROVED: { kind: 'waiting', fix: "draw up and approve today's plan: npm run plan -- draft, then npm run plan -- approve" },
  NOT_A_TEST_CONTACT: { kind: 'blocker', fix: 'only contacts with kind test can be dialled in phase 5; mark the contact as test in config/contacts.csv only if the number is yours' },
  CONTACT_NOT_ON_BLACKBOARD: { kind: 'blocker', fix: 'import contacts first: npm run accounts:import' }
};

function mask(number: string): string {
  return number.length <= 6 ? number : `${number.slice(0, 3)}${'•'.repeat(Math.max(0, number.length - 6))}${number.slice(-3)}`;
}

const set = (v: string | undefined): boolean => (v ?? '').trim() !== '';

function envCheck(env: DoctorInput['env'], name: string, what: string, fix: string, status: CheckStatus = 'blocker'): Check {
  return set(env[name])
    ? { area: 'environment', status: 'ok', summary: `${name} is set` }
    : { area: 'environment', status, summary: `${name} is not set: ${what}`, fix };
}

/* ------------------------------------------------------------------ */

function configChecks(input: DoctorInput): Check[] {
  const { env, policy, identity } = input;
  const checks: Check[] = [];

  checks.push(
    envCheck(env, 'ANTHROPIC_API_KEY', 'Lexi has no model to think with', 'put it in .env (or LEXI_ANTHROPIC_API_KEY in a cloud session). `npm run caller:smoke` tests it'),
    envCheck(env, 'VAPI_API_KEY', 'no way to talk to the voice provider', 'dashboard.vapi.ai, Organization settings, API keys: copy the private key into .env'),
    envCheck(env, 'VAPI_WEBHOOK_SECRET', 'the webhook would be open to anyone', 'openssl rand -hex 24, into .env'),
    envCheck(env, 'VOICE_SHARED_SECRET', 'the LLM endpoint would be open to anyone', 'openssl rand -hex 24, into .env'),
    envCheck(env, 'VAPI_ASSISTANT_ID', 'no assistant to call with', 'npm run voice:assistant creates it and prints the id; put that in .env')
  );

  // The public address the provider calls back on.
  const base = (env.PUBLIC_BASE_URL ?? '').trim();
  if (base === '') {
    checks.push({
      area: 'environment',
      status: 'blocker',
      summary: 'PUBLIC_BASE_URL is not set: the provider has nowhere to send turns and reports',
      fix: 'start a tunnel to the voice server (docs/VOICE-SETUP.md step 4) and put its https address in .env'
    });
  } else if (!/^https:\/\//i.test(base) || /localhost|127\.0\.0\.1|\[::1\]/i.test(base)) {
    checks.push({
      area: 'environment',
      status: 'blocker',
      summary: `PUBLIC_BASE_URL is ${base}, which the provider cannot reach (it must be a public https address)`,
      fix: 'use the tunnel or deployment address, starting https://'
    });
  } else {
    checks.push({ area: 'environment', status: 'ok', summary: `PUBLIC_BASE_URL is ${base}` });
  }

  checks.push(
    envCheck(env, 'TWILIO_ACCOUNT_SID', 'needed to verify the number and receive replies to texts', 'console.twilio.com, Account info', 'warn'),
    envCheck(env, 'TWILIO_AUTH_TOKEN', 'needed to verify inbound SMS signatures', 'console.twilio.com, Account info', 'warn')
  );

  // The two phone-number ids, per market. Only the market being tested is needed.
  const ids = (['AU', 'NZ'] as const).map((m) => ({ m, id: env[`VAPI_PHONE_NUMBER_ID_${m}`], callerId: m === 'AU' ? policy.caller_id.au_number : policy.caller_id.nz_number }));
  if (!ids.some((x) => set(x.id))) {
    checks.push({
      area: 'environment',
      status: 'blocker',
      summary: 'no VAPI_PHONE_NUMBER_ID_AU or VAPI_PHONE_NUMBER_ID_NZ is set',
      fix: "import your Twilio number into Vapi (Phone Numbers, Import) and put the id Vapi gives it in .env"
    });
  }
  for (const { m, id, callerId } of ids) {
    if (set(id) && !set(callerId)) {
      checks.push({
        area: 'caller ID',
        status: 'blocker',
        summary: `VAPI_PHONE_NUMBER_ID_${m} is set but caller_id.${m.toLowerCase()}_number is empty in config/policy.yaml, so the gate will refuse every ${m} dial`,
        fix: `put the number in config/policy.yaml: caller_id.${m.toLowerCase()}_number: "+61..."`
      });
    }
    if (set(callerId)) {
      const e164 = /^\+\d{8,15}$/.test(callerId.trim());
      checks.push(
        e164
          ? { area: 'caller ID', status: 'ok', summary: `${m} caller ID is ${callerId}${set(id) ? '' : ` (no VAPI_PHONE_NUMBER_ID_${m} yet)`}` }
          : { area: 'caller ID', status: 'blocker', summary: `${m} caller ID "${callerId}" is not in E.164 form`, fix: 'write it as +61... or +64...' }
      );
      const fromEnv = env[`TWILIO_NUMBER_${m}`];
      if (set(fromEnv) && fromEnv?.trim() !== callerId.trim()) {
        checks.push({
          area: 'caller ID',
          status: 'warn',
          summary: `TWILIO_NUMBER_${m} (${fromEnv}) differs from caller_id.${m.toLowerCase()}_number (${callerId})`,
          fix: 'they should be the same number'
        });
      }
    }
  }

  // Section 7.3, said plainly, because it is the one obligation that outlives the call.
  checks.push({
    area: 'caller ID',
    status: 'info',
    summary: `Section 7.3: a caller ID number must be real, never withheld, never spoofed, and must stay answerable for at least ${policy.caller_id.answerable_for_days} days after the last call made from it`,
    fix: 'do not release the Twilio number, change its voice forwarding, or let its balance lapse for 30 days after any call from it. Point it at somewhere a person answers'
  });
  for (const gap of identityGaps(identity)) {
    const callback = gap.includes('callback number');
    checks.push({
      area: 'identity',
      status: callback ? 'warn' : 'blocker',
      summary: gap,
      fix: callback
        ? 'set callback.number in config/agent.yaml: the number a prospect can ring back, normally the same as the caller ID'
        : 'set agent.name in config/agent.yaml'
    });
  }
  if (identity.agent.name.trim() !== '') {
    checks.push({ area: 'identity', status: 'ok', summary: `the agent introduces itself as ${identity.agent.name}; the opening is frozen in code` });
  }

  // Safety settings: say what they are.
  checks.push(
    policy.dialling.test_contacts_only
      ? { area: 'safety', status: 'ok', summary: 'dialling.test_contacts_only is true: only numbers you control can be dialled' }
      : {
          area: 'safety',
          status: 'warn',
          summary: 'dialling.test_contacts_only is FALSE: the gate no longer limits dialling to your own numbers',
          fix: 'phase 5 should run with this true. Set it false only deliberately, for the phase 9 pilot'
        },
    policy.dnc.exempt_test_contacts
      ? { area: 'safety', status: 'ok', summary: 'dnc.exempt_test_contacts is true: your own mobile can be rung (and only test contacts get this)' }
      : {
          area: 'safety',
          status: 'blocker',
          summary: 'dnc.exempt_test_contacts is false: mobiles cannot be dialled at all, and your phone is a mobile',
          fix: 'set dnc.exempt_test_contacts: true in config/policy.yaml. It applies only to contacts marked test while test_contacts_only is true'
        },
    policy.dnc.allow_mobile_dialling
      ? { area: 'safety', status: 'warn', summary: 'dnc.allow_mobile_dialling is true: mobiles are dialled without the test-contact fence', fix: 'only after DNCR washing is in place (section 7.2)' }
      : { area: 'safety', status: 'ok', summary: 'dnc.allow_mobile_dialling is false (as shipped)' },
    policy.approval.require_daily_plan
      ? { area: 'safety', status: 'ok', summary: 'approval.require_daily_plan is true: no dial without an approved plan for today' }
      : { area: 'safety', status: 'warn', summary: 'approval.require_daily_plan is FALSE: dials do not need an approved plan', fix: 'set it back to true' }
  );

  return checks;
}

function dataChecks(input: DoctorInput): Check[] {
  const { env, policy, voice, claims } = input;
  const checks: Check[] = [];

  const counts = claims.counts();
  checks.push(
    counts.approved === 0
      ? {
          area: 'knowledge',
          status: 'info',
          summary: `0 of ${counts.total} claims are approved, so Lexi can assert nothing about Hexaware and will defer anything it is asked. That is the shipped default and fine for a first test call`,
          fix: 'npm run knowledge:status, then approve claims you are happy for her to say'
        }
      : { area: 'knowledge', status: 'ok', summary: `${counts.approved} claim(s) approved` }
  );

  if (set(env.RECORDING_ENCRYPTION_KEY)) {
    try {
      if (!/^[0-9a-fA-F]{64}$/.test((env.RECORDING_ENCRYPTION_KEY ?? '').trim())) throw new Error('not 64 hex characters');
      checks.push({ area: 'recordings', status: 'ok', summary: `RECORDING_ENCRYPTION_KEY is set: recordings are archived encrypted here, kept ${policy.recording.retention_days} days` });
    } catch (error) {
      checks.push({
        area: 'recordings',
        status: 'blocker',
        summary: `RECORDING_ENCRYPTION_KEY is not usable (${(error as Error).message})`,
        fix: 'openssl rand -hex 32'
      });
    }
  } else {
    checks.push({
      area: 'recordings',
      status: 'warn',
      summary: `RECORDING_ENCRYPTION_KEY is not set: no encrypted copy of recordings is kept here; only the provider's copy exists (purged after ${policy.recording.retention_days} days)`,
      fix: 'openssl rand -hex 32, into .env. Back the key up: without it an archived recording cannot be read'
    });
  }
  checks.push({
    area: 'recordings',
    status: 'info',
    summary: 'Whether recordings may leave Australia (section 15 item 7) is not decided. Vapi stores its copy in its own cloud, outside Australia',
    fix: 'for test calls to your own phone this is fine. Decide before any real prospect is recorded'
  });

  checks.push({
    area: 'voice',
    status: 'info',
    summary: `voice ${voice.voice.provider}/${voice.voice.voice_id}, transcriber ${voice.transcriber.provider} ${voice.transcriber.model} (${voice.transcriber.language}), latency target ${voice.latency.target_ms}ms`,
    fix: 'audition voices in the Vapi dashboard and set config/voice.yaml; if npm run voice:assistant is refused, its message names the field'
  });
  return checks;
}

/* ------------------------------------------------------------------ */

/** The gate lists every place a mobile might be; the first is enough to read. */
function brief(detail: string): string {
  return detail.length <= 220 ? detail : `${detail.slice(0, 200).trimEnd()}...`;
}

function toLines(reasons: Array<{ code: DenyCode; detail: string }>): GateLine[] {
  return reasons.map((r) => ({ code: r.code, detail: brief(r.detail), ...GATE_ADVICE[r.code] }));
}

async function previews(input: DoctorInput): Promise<{ checks: Check[]; gate: GatePreview[] }> {
  const checks: Check[] = [];
  const gate: GatePreview[] = [];
  const { db, gate: service, policy, calendar } = input;

  if (db === null || service === null) {
    checks.push({ area: 'blackboard', status: 'blocker', summary: 'the blackboard could not be opened', fix: 'npm run db:setup' });
    return { checks, gate };
  }

  let contacts;
  try {
    contacts = await db.contact.findMany({
      where: { kind: 'test', ...(input.contactId !== undefined ? { id: input.contactId } : {}) },
      include: { account: true },
      orderBy: { createdAt: 'asc' }
    });
  } catch (error) {
    checks.push({ area: 'blackboard', status: 'blocker', summary: `the blackboard could not be read (${(error as Error).message})`, fix: 'npm run db:setup' });
    return { checks, gate };
  }

  const usable = contacts.filter((c) => c.phoneE164 !== null && c.phoneE164.trim() !== '');
  if (usable.length === 0) {
    checks.push({
      area: 'test contacts',
      status: 'blocker',
      summary: input.contactId !== undefined ? `no test contact ${input.contactId} with a phone number` : 'no contact is marked as a test contact with a phone number',
      fix: 'add yourself to config/contacts.csv with kind test and your mobile number, then npm run accounts:import'
    });
    return { checks, gate };
  }
  checks.push({
    area: 'test contacts',
    status: 'ok',
    summary: `${usable.length} test contact(s): ${usable.map((c) => `${c.firstName} ${c.lastName} ${mask(c.phoneE164 as string)} (--contact ${c.id})`).join('; ')}`
  });
  const numbers = usable.map((c) => c.phoneE164);
  if (new Set(numbers).size < numbers.length) {
    checks.push({
      area: 'test contacts',
      status: 'info',
      summary: 'some test contacts share one number, and a number may be dialled once a day, so only one of them can be rung per day'
    });
  }

  for (const contact of usable) {
    const phone = contact.phoneE164 as string;
    const accountMarket: Market = contact.account.country === 'NZ' ? 'NZ' : 'AU';
    const market = marketForDial(phone, accountMarket);
    const request: DialRequest = {
      requestId: `doctor-${contact.id}`,
      contactId: contact.id,
      accountId: contact.accountId,
      campaignId: contact.campaignId,
      phone,
      market,
      emailDomain: contact.account.domain,
      source: 'operator',
      at: input.now,
      ...(contact.jurisdiction !== null
        ? { localityHint: { jurisdiction: contact.jurisdiction as Jurisdiction, ...(contact.timezone !== null ? { timezone: contact.timezone } : {}) } }
        : {})
    };
    const snapshot = await service.snapshot(request);
    const now = evaluateDialRequest(request, snapshot, policy, calendar);
    // The same question with the plan check off: what is left once you approve today's plan.
    const afterApproval = evaluateDialRequest(request, snapshot, { ...policy, approval: { require_daily_plan: false } }, calendar);

    gate.push({
      contactId: contact.id,
      name: `${contact.firstName} ${contact.lastName}`,
      number: mask(phone),
      market,
      allowed: now.allowed,
      now: toLines(now.reasons),
      afterApproval: toLines(afterApproval.reasons)
    });
  }
  return { checks, gate };
}

/* ------------------------------------------------------------------ */

async function callerIdHistory(input: DoctorInput): Promise<Check[]> {
  const { db, policy } = input;
  if (db === null) return [];
  try {
    const last = await db.dialAttempt.findFirst({ orderBy: { at: 'desc' } });
    if (last === null) {
      return [{ area: 'caller ID', status: 'info', summary: `no call has been placed yet, so the ${policy.caller_id.answerable_for_days}-day answerability clock has not started` }];
    }
    const until = DateTime.fromJSDate(last.at).plus({ days: policy.caller_id.answerable_for_days });
    return [
      {
        area: 'caller ID',
        status: 'info',
        summary: `the last call was placed ${DateTime.fromJSDate(last.at).toISODate()}; whichever caller ID it used must stay answerable until ${until.toISODate()}`
      }
    ];
  } catch {
    return [];
  }
}

async function onlineChecks(input: DoctorInput): Promise<Check[]> {
  const { env, policy, online } = input;
  if (online === undefined) {
    return [{ area: 'online', status: 'info', summary: 'offline run: the provider and Twilio were not contacted', fix: 'add --online to check the assistant, the phone numbers and the Twilio credentials (reads only)' }];
  }
  const checks: Check[] = [];
  const base = (env.PUBLIC_BASE_URL ?? '').trim();

  if (online.provider !== undefined) {
    const assistantId = (env.VAPI_ASSISTANT_ID ?? '').trim();
    if (assistantId !== '') {
      try {
        const assistant = await online.provider.getAssistant(assistantId);
        // The deployed assistant has to be the one this system would send: no
        // first message of its own, our endpoint as its model, recording on.
        assertAssistantInvariants(assistant, { publicBaseUrl: base });
        checks.push({ area: 'provider', status: 'ok', summary: `the assistant ${assistantId} is ours: no first message, our endpoint as its brain, recording on` });
      } catch (error) {
        const invariant = error instanceof AssistantInvariantError;
        checks.push({
          area: 'provider',
          status: 'blocker',
          summary: invariant ? `the deployed assistant has drifted: ${(error as Error).message}` : `the assistant could not be read: ${(error as Error).message}`,
          fix: invariant ? 'npm run voice:assistant puts it back' : 'check VAPI_API_KEY and VAPI_ASSISTANT_ID'
        });
      }
    }
    for (const m of ['AU', 'NZ'] as const) {
      const id = (env[`VAPI_PHONE_NUMBER_ID_${m}`] ?? '').trim();
      if (id === '') continue;
      const expected = (m === 'AU' ? policy.caller_id.au_number : policy.caller_id.nz_number).trim();
      try {
        const record = await online.provider.getPhoneNumber(id);
        const number = typeof record.number === 'string' ? record.number : '';
        checks.push(
          expected !== '' && number.replace(/\D/g, '') !== expected.replace(/\D/g, '')
            ? { area: 'provider', status: 'blocker', summary: `Vapi phone number ${id} is ${number || 'unreadable'}, but caller_id.${m.toLowerCase()}_number is ${expected}`, fix: 'the number presented must be the configured, contactable one; fix whichever is wrong' }
            : { area: 'provider', status: 'ok', summary: `Vapi phone number ${id} is ${number}` }
        );
      } catch (error) {
        checks.push({ area: 'provider', status: 'blocker', summary: `Vapi phone number ${id} could not be read: ${(error as Error).message}`, fix: 'check the id and VAPI_API_KEY' });
      }
    }
  }

  const sid = (env.TWILIO_ACCOUNT_SID ?? '').trim();
  const token = (env.TWILIO_AUTH_TOKEN ?? '').trim();
  if (sid !== '' && token !== '') {
    try {
      const response = await (online.fetch ?? fetch)(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}.json`, {
        headers: { authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}` },
        signal: AbortSignal.timeout(10_000)
      });
      checks.push(
        response.ok
          ? { area: 'twilio', status: 'ok', summary: 'the Twilio credentials work' }
          : { area: 'twilio', status: 'blocker', summary: `Twilio refused the credentials (${response.status})`, fix: 'check TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN' }
      );
    } catch (error) {
      checks.push({ area: 'twilio', status: 'warn', summary: `Twilio could not be reached: ${(error as Error).message}` });
    }
  }
  return checks;
}

export async function runDoctor(input: DoctorInput): Promise<DoctorReport> {
  const checks: Check[] = [...configChecks(input), ...dataChecks(input)];

  const preview = await previews(input);
  checks.push(...preview.checks);
  checks.push(...(await callerIdHistory(input)));
  checks.push(...(await onlineChecks(input)));

  // A gate answer that is a setting rather than the clock is a blocker too, even
  // though the environment looks complete: that is the "why won't it dial" answer.
  for (const g of preview.gate) {
    for (const line of g.afterApproval.filter((l) => l.kind === 'blocker')) {
      checks.push({ area: 'gate', status: 'blocker', summary: `the gate would refuse ${g.name} (${g.number}): ${line.code}`, fix: line.fix });
    }
  }
  // De-duplicate identical gate blockers across contacts.
  const seen = new Set<string>();
  const unique = checks.filter((c) => {
    const key = `${c.area}|${c.status}|${c.summary.replace(/the gate would refuse .*? \(.*?\): /, '')}`;
    if (c.area !== 'gate') return true;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return { checks: unique, gate: preview.gate, ready: !unique.some((c) => c.status === 'blocker') };
}

const MARK: Record<CheckStatus, string> = { ok: '  ok     ', blocker: '  MISSING', warn: '  warn   ', info: '  note   ' };

export function formatDoctorReport(report: DoctorReport, at: Date): string {
  const lines: string[] = [];
  lines.push(`Voice preflight, ${at.toISOString()}. Read-only: no call is placed by this command.`);
  lines.push('');

  const order = ['environment', 'identity', 'caller ID', 'safety', 'test contacts', 'recordings', 'knowledge', 'voice', 'provider', 'twilio', 'blackboard', 'gate', 'online'];
  const areas = [...new Set(report.checks.map((c) => c.area))].sort((a, b) => order.indexOf(a) - order.indexOf(b));
  for (const area of areas) {
    lines.push(area);
    for (const c of report.checks.filter((x) => x.area === area)) {
      lines.push(`${MARK[c.status]} ${c.summary}`);
      if (c.fix !== undefined && c.status !== 'ok') lines.push(`           -> ${c.fix}`);
    }
    lines.push('');
  }

  lines.push('What the compliance gate says about each test contact right now');
  if (report.gate.length === 0) lines.push('  (no test contact to ask about)');
  for (const g of report.gate) {
    lines.push(`  ${g.name}  ${g.number}  ${g.market}  ->  ${g.allowed ? 'ALLOWED right now' : 'REFUSED right now'}`);
    for (const l of g.now) lines.push(`      ${l.kind === 'blocker' ? 'setting' : 'waiting'}  ${l.code}: ${l.detail}`);
    if (!g.allowed) {
      const remaining = g.afterApproval;
      lines.push(
        remaining.length === 0
          ? '      once today\'s plan is approved, nothing else would stop this dial'
          : `      even with today's plan approved, still refused: ${remaining.map((l) => l.code).join(', ')}`
      );
      const fixes = [...new Map(g.now.map((l) => [l.code, l.fix])).entries()];
      for (const [code, fix] of fixes) lines.push(`      ${code}: ${fix}`);
    }
  }
  lines.push('');

  const blockers = report.checks.filter((c) => c.status === 'blocker').length;
  lines.push(
    report.ready
      ? 'No missing settings. Whether a call can be placed this minute depends on the clock and the approved plan, which the gate answers above.'
      : `${blockers} thing(s) missing before a test call. Fix them in the order shown; run this again after each.`
  );
  return lines.join('\n');
}
