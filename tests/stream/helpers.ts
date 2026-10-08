/**
 * A small world for the console backend's tests: a throwaway blackboard, the real
 * gate, the real kill switch (in memory), and helpers to put calls, people and
 * meeting requests into it with exactly the durations and outcomes a test needs.
 *
 * The clock is fixed at noon on a Wednesday in Sydney, inside every calling window,
 * so a verdict that comes back "held" is held for a reason the test put there.
 */

import { randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import { CallPlanRepository } from '../../src/blackboard/call-plans.js';
import { createTestBlackboard, type Blackboard } from '../../src/blackboard/client.js';
import {
  PrismaAttemptStore,
  PrismaAuditLog,
  PrismaCallStateStore,
  PrismaContactStore,
  PrismaDncStore,
  PrismaSuppressionStore
} from '../../src/blackboard/compliance-stores.js';
import { MeetingRequestRepository } from '../../src/blackboard/meetings.js';
import { InMemoryAuditLog } from '../../src/compliance/audit.js';
import { InMemoryKillSwitchStore, KillSwitch } from '../../src/compliance/kill-switch.js';
import { ComplianceGate } from '../../src/compliance/service.js';
import { ConsoleBus } from '../../src/stream/bus.js';
import type { ConsoleDeps } from '../../src/stream/deps.js';
import { NO_LIVE_CALL, type LiveCallSource } from '../../src/stream/live-source.js';
import { calendar, policy, type PolicyOverrides } from '../support/fixtures.js';

/** Wednesday 7 October 2026, 12:00 in Sydney (AEDT), 14:00 in Auckland. */
export const NOW = new Date('2026-10-07T01:00:00.000Z');

export const SYDNEY = 'Australia/Sydney';

/** A time on the Sydney clock, `daysAgo` days before the fixed day. */
export function at(daysAgo: number, hour: number, minute = 0): Date {
  return DateTime.fromJSDate(NOW, { zone: SYDNEY }).startOf('day').minus({ days: daysAgo }).set({ hour, minute }).toJSDate();
}

export interface World {
  db: Blackboard;
  deps: ConsoleDeps;
  bus: ConsoleBus;
  killStore: InMemoryKillSwitchStore;
  killSwitch: KillSwitch;
  plans: CallPlanRepository;
  campaignId: string;
  accountId: string;
  close(): Promise<void>;
}

export interface WorldOptions {
  policy?: PolicyOverrides;
  mode?: 'demo' | 'live';
  live?: LiveCallSource;
  now?: () => Date;
  env?: Record<string, string | undefined>;
}

const open: World[] = [];

export async function closeWorlds(): Promise<void> {
  for (const w of open.splice(0)) await w.close();
}

export async function world(options: WorldOptions = {}): Promise<World> {
  const db = await createTestBlackboard();
  const compliancePolicy = policy(options.policy);
  const plans = new CallPlanRepository(db);
  const killStore = new InMemoryKillSwitchStore();
  const killSwitch = new KillSwitch(killStore, new InMemoryAuditLog());
  const audit = new PrismaAuditLog(db);
  const suppressions = new PrismaSuppressionStore(db);
  const cal = calendar();
  const bus = new ConsoleBus();

  const gate = new ComplianceGate({
    policy: compliancePolicy,
    calendar: cal,
    killSwitch,
    suppression: suppressions,
    dnc: new PrismaDncStore(db),
    attempts: new PrismaAttemptStore(db),
    calls: new PrismaCallStateStore(db),
    dayPlans: plans,
    contacts: new PrismaContactStore(db),
    audit
  });

  const campaignId = randomUUID();
  const accountId = randomUUID();
  await db.campaign.create({
    data: {
      id: campaignId,
      name: 'NZ banking pilot',
      market: 'NZ',
      status: 'active',
      icp: JSON.stringify({ titles: [], seniorities: [], industries: [], disqualifiers: [] }),
      goal: JSON.stringify({ meetingsPerWeek: 3, maxUsdPerWeek: 25 })
    }
  });
  await db.account.create({
    data: { id: accountId, campaignId, name: 'Kiwibank', domain: 'kiwibank.example', country: 'NZ', industry: 'financial services', priority: 1, status: 'calling' }
  });

  const deps: ConsoleDeps = {
    mode: options.mode ?? 'live',
    db,
    policy: compliancePolicy,
    calendar: cal,
    gate,
    killSwitch,
    plans,
    meetings: new MeetingRequestRepository(db),
    suppressions,
    audit,
    operator: { name: 'Vinay Kumar', firstName: 'Vinay', title: 'Sales Director', company: 'Hexaware Technologies', email: 'vinay@example.com' },
    bus,
    live: options.live ?? NO_LIVE_CALL,
    now: options.now ?? (() => NOW),
    gateAt: (now) => now,
    env: options.env ?? {}
  };

  const w: World = { db, deps, bus, killStore, killSwitch, plans, campaignId, accountId, close: async () => void (await db.$disconnect()) };
  open.push(w);
  return w;
}

export interface ContactOptions {
  first?: string;
  last?: string;
  title?: string;
  phone?: string | null;
  status?: string;
  kind?: 'test' | 'prospect';
  accountId?: string;
  seniority?: string;
}

export async function addContact(w: World, o: ContactOptions = {}): Promise<string> {
  const id = randomUUID();
  await w.db.contact.create({
    data: {
      id,
      accountId: o.accountId ?? w.accountId,
      campaignId: w.campaignId,
      firstName: o.first ?? 'Priya',
      lastName: o.last ?? 'Raman',
      title: o.title ?? 'Head of Data',
      seniority: o.seniority ?? 'director',
      status: o.status ?? 'contacted',
      kind: o.kind ?? 'prospect',
      phoneE164: o.phone === undefined ? '+6494960000' : o.phone,
      phoneLine: 'fixed',
      jurisdiction: 'nz-auckland',
      timezone: 'Pacific/Auckland'
    }
  });
  return id;
}

export interface CallOptions {
  contactId?: string;
  startedAt: Date;
  duration: number;
  outcome: string | null;
  variant?: string;
  marks?: Array<[string, number]>;
  hook?: string;
  objections?: Array<{ kind?: string; saidAs: string; handledAs?: string }>;
  summary?: string[];
  defects?: unknown[];
  windows?: Array<{ saidAs: string; startsAt: string; endsAt: string }>;
  timezone?: string;
  attendees?: string[];
  record?: boolean;
  /** Leave the call open (no end time), as a call on air is. */
  open?: boolean;
  transcript?: Array<{ speaker: 'lexi' | 'prospect'; text: string; atSecond: number }>;
  accountId?: string;
}

export async function addCall(w: World, o: CallOptions): Promise<{ callId: string; contactId: string }> {
  const contactId = o.contactId ?? (await addContact(w, { first: `C${Math.random().toString(36).slice(2, 7)}`, last: 'Tester', ...(o.accountId !== undefined ? { accountId: o.accountId } : {}) }));
  const contact = await w.db.contact.findUniqueOrThrow({ where: { id: contactId } });
  const callId = randomUUID();
  await w.db.call.create({
    data: {
      id: callId,
      contactId,
      accountId: contact.accountId,
      campaignId: w.campaignId,
      startedAt: o.startedAt,
      endedAt: o.open === true ? null : new Date(o.startedAt.getTime() + o.duration * 1000),
      durationSec: o.open === true ? null : o.duration,
      outcome: o.outcome,
      playbookVersion: o.variant ?? 'hook v3',
      sectionMarks: JSON.stringify((o.marks ?? []).map(([section, atSecond]) => ({ section, atSecond }))),
      defects: JSON.stringify(o.defects ?? [])
    }
  });
  if (o.record !== false && (o.hook !== undefined || o.objections !== undefined || o.summary !== undefined || o.windows !== undefined)) {
    await w.db.callRecord.create({
      data: {
        id: `${callId}-record`,
        callId,
        summary: JSON.stringify(o.summary ?? []),
        summarySource: (o.summary ?? []).length === 0 ? 'unavailable' : 'model',
        hook: o.hook ?? '',
        objections: JSON.stringify(o.objections ?? []),
        windows: JSON.stringify(o.windows ?? []),
        timezone: o.timezone ?? null,
        attendees: JSON.stringify(o.attendees ?? [])
      }
    });
  }
  for (const turn of o.transcript ?? []) {
    await w.db.callEvent.create({ data: { callId, kind: 'turn', speaker: turn.speaker, text: turn.text, atSecond: turn.atSecond } });
  }
  return { callId, contactId };
}

export async function addMeetingRequest(
  w: World,
  callId: string,
  contactId: string,
  status: 'requested' | 'confirmed' | 'reschedule' | 'rejected' = 'requested',
  id: string = randomUUID()
): Promise<string> {
  await w.db.meetingRequest.create({ data: { id, callId, contactId, status, createdAt: new Date(NOW.getTime() - 3_600_000), emailSentAt: new Date(NOW.getTime() - 3_500_000) } });
  return id;
}

export function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}
