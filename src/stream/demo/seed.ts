/**
 * Seeding the demo database.
 *
 * Writes a clearly-labelled sample world into a SEPARATE SQLite file, so the
 * console can be seen working with realistic traffic before any real call exists.
 * It refuses to run against a database that already holds anything: a seed that
 * could land in the real blackboard would put invented people in the list of
 * people the system calls, which is the one mistake this module cannot afford.
 *
 * The data is invented, but the machinery that judges it is real. The queue's
 * verdicts come from the actual compliance gate, the plan from the actual planner,
 * and the audit rows from the gate being asked. Only the calls, the people and the
 * money are made up.
 */

import { randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import { buildOpening, renderOpening, type OpeningSegment } from '../../agents/caller/opening.js';
import type { AgentIdentity } from '../../agents/caller/identity.js';
import type { Blackboard } from '../../blackboard/client.js';
import type { CallPlanRepository } from '../../blackboard/call-plans.js';
import type { HolidayCalendar } from '../../compliance/holidays.js';
import { marketForDial, parsePhoneNumber } from '../../compliance/phone.js';
import type { CompliancePolicy } from '../../compliance/policy.js';
import type { ComplianceGate } from '../../compliance/service.js';
import type { DialRequest, Jurisdiction, Market } from '../../compliance/types.js';
import { DailyCallPlanner } from '../../orchestrator/planner.js';
import {
  ACCOUNTS,
  bodyScript,
  FIRST_NAMES,
  HOOKS,
  HYPOTHESES,
  OBJECTIONS,
  PLACES,
  prng,
  SURNAMES,
  TITLES,
  WORKED_ACCOUNT_KEYS,
  type AccountSpec,
  type LiveProspect,
  type PlaceSpec
} from './data.js';

export const DEMO_CAMPAIGN_ID = 'demo-campaign';
export const DEMO_CAMPAIGN_NAME = 'Demo: ANZ banking pilot';

export interface SeedOptions {
  now: Date;
  /** The instant the queue's verdicts are evaluated at; see clock.ts. */
  gateAt: Date;
  policy: CompliancePolicy;
  calendar: HolidayCalendar;
  gate: ComplianceGate;
  plans: CallPlanRepository;
  identity: AgentIdentity;
}

export interface SeedSummary {
  calls: number;
  contacts: number;
  accounts: number;
  pendingMeetingRequests: number;
  queue: number;
  planDate: string;
}

type Kind =
  | 'meeting_pending_perth'
  | 'meeting_pending_brisbane'
  | 'meeting_pending_auckland'
  | 'meeting_confirmed'
  | 'callback'
  | 'declined_late'
  | 'declined_mid'
  | 'early_declined'
  | 'early_unmarked'
  | 'gatekeeper'
  | 'ring_out'
  | 'voicemail'
  | 'wrong'
  | 'dead'
  | 'dnc'
  | 'escalated';

/** The last seven working days, newest first, one list of calls each. */
const PAST_DAYS: Kind[][] = [
  ['meeting_pending_perth', 'escalated', 'declined_late', 'ring_out', 'early_unmarked'],
  ['meeting_pending_brisbane', 'callback', 'declined_mid', 'gatekeeper', 'voicemail'],
  ['meeting_confirmed', 'declined_late', 'gatekeeper', 'early_declined', 'ring_out'],
  ['meeting_confirmed', 'wrong', 'declined_mid', 'voicemail', 'early_unmarked'],
  ['meeting_confirmed', 'callback', 'declined_late', 'gatekeeper', 'dead'],
  ['declined_mid', 'gatekeeper', 'ring_out', 'voicemail', 'wrong'],
  ['declined_late', 'early_declined', 'dnc', 'ring_out', 'early_unmarked']
];

const TODAY_KINDS: Kind[] = ['declined_late', 'ring_out', 'meeting_pending_auckland', 'early_declined', 'gatekeeper', 'callback', 'voicemail'];

interface CallPlan {
  id: string;
  kind: Kind;
  startedAt: Date;
  accountKey: string;
  placeKey: string;
  variant: string;
  /** A contact already created for an earlier attempt, to be called again. */
  contactKey?: string;
}

interface Shape {
  outcome: string | null;
  duration: [number, number];
  /** How far through the script the call got. */
  reach: 'none' | 'disclosure' | 'opener' | 'mid' | 'full';
}

const SHAPES: Record<Kind, Shape> = {
  meeting_pending_perth: { outcome: 'meeting_requested', duration: [84, 112], reach: 'full' },
  meeting_pending_brisbane: { outcome: 'meeting_requested', duration: [80, 108], reach: 'full' },
  meeting_pending_auckland: { outcome: 'meeting_requested', duration: [88, 118], reach: 'full' },
  meeting_confirmed: { outcome: 'meeting_requested', duration: [78, 116], reach: 'full' },
  callback: { outcome: 'callback_requested', duration: [62, 96], reach: 'full' },
  declined_late: { outcome: 'not_interested', duration: [50, 84], reach: 'full' },
  declined_mid: { outcome: 'not_interested', duration: [26, 44], reach: 'mid' },
  early_declined: { outcome: 'not_interested', duration: [9, 14], reach: 'opener' },
  early_unmarked: { outcome: null, duration: [3, 8], reach: 'disclosure' },
  gatekeeper: { outcome: 'gatekeeper_blocked', duration: [14, 38], reach: 'opener' },
  ring_out: { outcome: 'no_answer', duration: [19, 31], reach: 'none' },
  voicemail: { outcome: 'voicemail', duration: [24, 36], reach: 'none' },
  wrong: { outcome: 'wrong_person', duration: [12, 24], reach: 'opener' },
  dead: { outcome: 'invalid_number', duration: [3, 5], reach: 'none' },
  dnc: { outcome: 'do_not_contact', duration: [8, 15], reach: 'opener' },
  escalated: { outcome: 'escalated', duration: [20, 35], reach: 'opener' }
};

const WORKED_PLACE_CYCLE: Record<string, string[]> = Object.fromEntries(ACCOUNTS.map((a) => [a.key, a.places]));

function accountOf(key: string): AccountSpec {
  const found = ACCOUNTS.find((a) => a.key === key);
  if (found === undefined) throw new Error(`demo account ${key} is not defined`);
  return found;
}

function placeOf(key: string): PlaceSpec {
  const found = PLACES[key];
  if (found === undefined) throw new Error(`demo place ${key} is not defined`);
  return found;
}

function recentWeekdays(now: Date, zone: string, count: number): DateTime[] {
  const out: DateTime[] = [];
  let day = DateTime.fromJSDate(now, { zone }).startOf('day').minus({ days: 1 });
  while (out.length < count) {
    if (day.weekday <= 5) out.push(day);
    day = day.minus({ days: 1 });
  }
  return out;
}

/** The start of the next `isoWeekday` at least `minAhead` days from now, in `zone`. */
function futureDay(now: Date, zone: string, isoWeekday: number, minAhead = 2): DateTime {
  let day = DateTime.fromJSDate(now, { zone }).startOf('day').plus({ days: minAhead });
  while (day.weekday !== isoWeekday) day = day.plus({ days: 1 });
  return day;
}

const slug = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export async function seedDemo(db: Blackboard, options: SeedOptions): Promise<SeedSummary> {
  // Never into a database that already holds anything. A real blackboard has a
  // campaign in it; an empty file made for the demo does not.
  const [campaigns, contacts, calls] = await Promise.all([db.campaign.count(), db.contact.count(), db.call.count()]);
  if (campaigns + contacts + calls > 0) {
    throw new Error('refusing to seed the demo into a database that already has data in it');
  }

  const { now, policy } = options;
  const zone = policy.operational_timezone;
  const rand = prng(20261007);
  const between = (lo: number, hi: number): number => Math.round(lo + rand() * (hi - lo));
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)] as T;

  /* ---- the campaign and its accounts ---- */

  await db.campaign.create({
    data: {
      id: DEMO_CAMPAIGN_ID,
      name: DEMO_CAMPAIGN_NAME,
      market: 'NZ',
      status: 'active',
      icp: JSON.stringify({
        titles: TITLES.map((t) => t.title.toLowerCase()),
        seniorities: ['c_suite', 'vp', 'director'],
        industries: ['financial services'],
        disqualifiers: ['recruiter'],
        minimumScore: 60
      }),
      goal: JSON.stringify({ meetingsPerWeek: 3, maxUsdPerWeek: 25 }),
      createdAt: new Date(now.getTime() - 30 * 86_400_000)
    }
  });

  for (const [i, a] of ACCOUNTS.entries()) {
    await db.account.create({
      data: {
        id: `demo-acct-${a.key}`,
        campaignId: DEMO_CAMPAIGN_ID,
        name: a.name,
        domain: `${a.slug}.example`,
        country: a.country,
        industry: a.industry,
        priority: 1 + (i % 3),
        status: WORKED_ACCOUNT_KEYS.includes(a.key) ? 'calling' : 'new',
        notes: 'Demo account. Invented for the sample console; not a real organisation.'
      }
    });
  }

  /* ---- people ---- */

  let personIndex = 0;
  const used = new Set<string>();
  const nextPerson = (): { first: string; last: string } => {
    for (let guard = 0; guard < 500; guard++) {
      const first = FIRST_NAMES[personIndex % FIRST_NAMES.length] as string;
      const last = SURNAMES[(personIndex * 7 + Math.floor(personIndex / FIRST_NAMES.length)) % SURNAMES.length] as string;
      personIndex += 1;
      if (!used.has(`${first} ${last}`)) {
        used.add(`${first} ${last}`);
        return { first, last };
      }
    }
    throw new Error('ran out of demo names');
  };

  interface Made {
    id: string;
    first: string;
    last: string;
    title: string;
    accountKey: string;
    place: PlaceSpec;
    phone: string;
    email: string;
    market: Market;
  }
  const made = new Map<string, Made>();
  let phoneCounter = 0;

  async function makeContact(
    key: string,
    accountKey: string,
    placeKey: string,
    opts: { status?: string; icp?: number; mobile?: boolean; titleIndex?: number } = {}
  ): Promise<Made> {
    const account = accountOf(accountKey);
    const place = placeOf(placeKey);
    const { first, last } = nextPerson();
    const titleSpec = TITLES[(opts.titleIndex ?? personIndex) % TITLES.length] as (typeof TITLES)[number];
    phoneCounter += 1;
    const phone = opts.mobile
      ? place.country === 'AU'
        ? '+61491570156'
        : '+64215550142'
      : `${place.prefix}${String(100 + phoneCounter).padStart(3, '0')}`;

    const parsed = parsePhoneNumber(phone, place.country);
    if (!parsed.valid) throw new Error(`demo phone number ${phone} does not parse: ${parsed.reason}`);

    const id = `demo-contact-${key}`;
    const email = `${slug(first)}.${slug(last)}@${account.slug}.example`;
    await db.contact.create({
      data: {
        id,
        accountId: `demo-acct-${accountKey}`,
        campaignId: DEMO_CAMPAIGN_ID,
        firstName: first,
        lastName: last,
        title: titleSpec.title,
        seniority: titleSpec.seniority,
        linkedinUrl: `https://www.linkedin.com/in/demo-${slug(first)}-${slug(last)}`,
        phoneE164: parsed.e164,
        phoneLine: parsed.lineType,
        jurisdiction: place.jurisdiction,
        timezone: place.timezone,
        icpScore: opts.icp ?? between(62, 94),
        status: opts.status ?? 'contacted',
        kind: 'prospect',
        source: 'demo',
        lawfulBasis: 'Demo data: not a real person.'
      }
    });
    const record: Made = { id, first, last, title: titleSpec.title, accountKey, place, phone: parsed.e164, email, market: place.country };
    made.set(key, record);
    return record;
  }

  async function dossierFor(contact: Made, confidence: 'high' | 'medium' | 'low', hypothesis: string, hook: string): Promise<void> {
    await db.dossier.create({
      data: {
        id: `demo-dossier-${contact.id}`,
        contactId: contact.id,
        hypothesis,
        confidence,
        person: JSON.stringify({ name: `${contact.first} ${contact.last}`, title: contact.title, priorEmployers: [], signals: [] }),
        account: JSON.stringify({ whatTheyDo: 'A demo organisation invented for the sample console.', techSignals: [], announcements: [], pressures: [] }),
        hooks: confidence === 'low' ? '[]' : JSON.stringify([{ text: hook, sourceUrl: 'https://demo.example/news', slot: 'hook' }]),
        landmines: '[]',
        unverified: confidence === 'high' ? '[]' : JSON.stringify(['Demo: the hook has not been checked against a second source.']),
        sources: JSON.stringify(['https://demo.example/news'])
      }
    });
  }

  /* ---- calls ---- */

  const operatorDays = recentWeekdays(now, zone, PAST_DAYS.length);
  const plansToWrite: CallPlan[] = [];
  // The challenger started yesterday evening, so only today's calls have run it.
  const TODAY_ARMS = ['hook v3', 'hook v3', 'hook v4', 'hook v4', 'hook v4', 'hook v4', 'hook v3'];

  const cycle: Record<string, number> = {};
  const nextAccount = (kind: Kind): { accountKey: string; placeKey: string } => {
    if (kind === 'meeting_pending_perth') return { accountKey: 'epsilon', placeKey: 'perth' };
    if (kind === 'meeting_pending_brisbane') return { accountKey: 'eta', placeKey: 'brisbane' };
    if (kind === 'meeting_pending_auckland') return { accountKey: 'beta', placeKey: 'auckland' };
    // Confirmed meetings lean to New Zealand: it is the build-out, and it is
    // what makes "which hook works in NZ" an interesting question.
    const pool = kind === 'meeting_confirmed' ? ['beta', 'delta', 'zeta'] : WORKED_ACCOUNT_KEYS;
    cycle[kind] = (cycle[kind] ?? 0) + 1;
    cycle.all = (cycle.all ?? 0) + 1;
    const accountKey = pool[cycle.all % pool.length] as string;
    const places = WORKED_PLACE_CYCLE[accountKey] as string[];
    return { accountKey, placeKey: places[cycle[kind] % places.length] as string };
  };

  [...PAST_DAYS].reverse().forEach((kinds, offset) => {
    const day = operatorDays[PAST_DAYS.length - 1 - offset] as DateTime;
    kinds.forEach((kind, i) => {
      const startedAt = day.set({ hour: 10, minute: 0 }).plus({ minutes: i * 50 + between(0, 12) }).toJSDate();
      plansToWrite.push({ id: `demo-call-${String(plansToWrite.length + 1).padStart(3, '0')}`, kind, startedAt, variant: 'hook v3', ...nextAccount(kind) });
    });
  });

  const todayStart = DateTime.fromJSDate(now, { zone }).startOf('day');
  const spacing = Math.max(60_000, Math.min(14 * 60_000, (now.getTime() - todayStart.toMillis()) / (TODAY_KINDS.length + 2)));
  TODAY_KINDS.forEach((kind, i) => {
    const startedAt = new Date(now.getTime() - (TODAY_KINDS.length - i) * spacing);
    plansToWrite.push({ id: `demo-call-${String(plansToWrite.length + 1).padStart(3, '0')}`, kind, startedAt, variant: TODAY_ARMS[i] as string, ...nextAccount(kind) });
  });

  // Two contacts are rung twice, five working days apart, so attempt counts are real.
  const repeat = plansToWrite.filter((c) => c.kind === 'ring_out');
  const [firstRing, lastRing] = [repeat[0], repeat[repeat.length - 1]];
  if (firstRing !== undefined && lastRing !== undefined && firstRing !== lastRing) {
    lastRing.contactKey = firstRing.id;
    lastRing.accountKey = firstRing.accountKey;
    lastRing.placeKey = firstRing.placeKey;
  }

  const opening = (contactHook: string): { segments: OpeningSegment[]; full: string; lite: string } => {
    const segments = buildOpening({ identity: options.identity, reason: `I'm calling about ${contactHook}.` });
    return { segments, full: renderOpening(segments), lite: segments.slice(0, 2).map((s) => s.text).join(' ') };
  };

  const markStarts = { disclosure: 0, reason: 10, hook: 22, 'value-statement': 38, ask: 60, close: 82 } as const;

  const pendingWindows: Array<{ callId: string; windows: Array<{ saidAs: string; startsAt: string; endsAt: string }>; timezone: string; attendees: string[] }> = [];
  const meetingCalls: Array<{ callId: string; contactId: string; status: 'requested' | 'confirmed'; endedAt: Date }> = [];
  const suppressions: Array<{ scope: string; key: string; source: string; reason: string; at: Date }> = [];
  let escalationInfo: { contactId: string; callId: string; at: Date } | null = null;
  const spend: Array<{ category: string; usd: number; at: Date; note: string }> = [];
  const attemptRows: Array<{ contactId: string; accountId: string; e164: string; at: Date; hadConversation: boolean; callId: string }> = [];

  let objectionCursor = 0;
  for (const c of plansToWrite) {
    const shape = SHAPES[c.kind];
    const duration = between(shape.duration[0], shape.duration[1]);
    const endedAt = new Date(c.startedAt.getTime() + duration * 1000);

    const reused = c.contactKey === undefined ? undefined : made.get(c.contactKey);
    const person = reused ?? (await makeContact(c.id, c.accountKey, c.placeKey, { status: 'contacted' }));
    const account = accountOf(c.accountKey);

    const hook = person.market === 'NZ' ? (HOOKS[0] as string) : pick([HOOKS[1], HOOKS[3], HOOKS[2]] as string[]);
    const hypothesis = HYPOTHESES[personIndex % HYPOTHESES.length] as string;
    if (reused === undefined) await dossierFor(person, personIndex % 5 === 0 ? 'medium' : 'high', hypothesis, hook);

    const answered = !['ring_out', 'voicemail', 'dead'].includes(c.kind);
    const realConversation = answered && duration >= 45;
    const v4 = c.variant === 'hook v4';

    // Where each section began on this call. The challenger reaches the hook
    // sooner, which is the whole claim it is making.
    const scale = duration / 100;
    const marks: Array<{ section: string; atSecond: number }> = [];
    const base: Array<[string, number]> =
      shape.reach === 'full'
        ? [
            ['disclosure', 0],
            ['reason', Math.round(10 + between(-1, 2))],
            ['hook', Math.round((v4 ? 16 : 23) + between(-2, 3))],
            ['value-statement', Math.round(Math.max(30, 36 * Math.max(scale, 0.8)) + between(-2, 4))],
            ['ask', Math.round(Math.max(44, 0.62 * duration) + between(-2, 2))],
            ['close', Math.round(Math.max(60, 0.85 * duration))]
          ]
        : answered
          ? (Object.entries(markStarts) as Array<[string, number]>)
          : [];
    for (const [section, at] of base) if (at < duration - 1) marks.push({ section, atSecond: at });

    const defects: Array<{ kind: string; detail: string; atSecond?: number }> = [];
    if (c.kind === 'early_unmarked') {
      defects.push({ kind: 'outcome-missing', detail: 'the call ended without an outcome being marked, so none is recorded and nothing irreversible follows from it; it needs a look' });
    }
    if (c.id === 'demo-call-007' || c.id === 'demo-call-019') {
      defects.push({ kind: 'unsupported-claim', detail: 'Demo defect: Lexi described a result that is not in the approved claims, and the post-call audit logged it.', atSecond: Math.min(duration - 2, 41) });
    }

    await db.call.create({
      data: {
        id: c.id,
        contactId: person.id,
        accountId: `demo-acct-${c.accountKey}`,
        campaignId: DEMO_CAMPAIGN_ID,
        startedAt: c.startedAt,
        endedAt,
        durationSec: duration,
        outcome: shape.outcome,
        playbookVersion: c.variant,
        sentiment: shape.outcome === 'meeting_requested' ? 'positive' : shape.outcome === 'not_interested' ? 'negative' : 'neutral',
        recordingUrl: null,
        sectionMarks: JSON.stringify(marks),
        defects: JSON.stringify(defects)
      }
    });

    attemptRows.push({
      contactId: person.id,
      accountId: `demo-acct-${c.accountKey}`,
      e164: person.phone,
      at: c.startedAt,
      hadConversation: realConversation,
      callId: c.id
    });

    // What was said. Short calls are short because they ended, not because the
    // transcript was trimmed: a call cut off at five seconds never got past the
    // second sentence of the opening.
    const open = opening(hook);
    const prospect: LiveProspect = {
      name: `${person.first} ${person.last}`,
      firstName: person.first,
      title: person.title,
      company: account.name,
      market: person.market,
      hypothesis,
      confidence: 'high',
      variant: c.variant,
      hook,
      email: person.email,
      timezoneLabel: person.place.city,
      ends: c.kind === 'callback' ? 'callback_requested' : c.kind.startsWith('meeting') ? 'meeting_requested' : 'not_interested'
    };
    const turns: Array<{ speaker: 'lexi' | 'prospect'; text: string }> = [];
    switch (shape.reach) {
      case 'none':
        if (c.kind === 'voicemail') {
          turns.push({ speaker: 'lexi', text: "Hi, this is Lexi. I'm an AI assistant working with Vinay Kumar at Hexaware. I'm sorry I missed you; you can reach us on the number this call came from. Goodbye." });
        }
        break;
      case 'disclosure':
        turns.push({ speaker: 'lexi', text: open.lite });
        break;
      case 'opener':
        turns.push({ speaker: 'lexi', text: open.full });
        turns.push({
          speaker: 'prospect',
          text:
            c.kind === 'gatekeeper'
              ? "Who's calling? I can't put you through to him. Try emailing the general address."
              : c.kind === 'wrong'
                ? "You've got the wrong person. I left that role last year."
                : c.kind === 'dnc'
                  ? 'Please take me off your list.'
                  : c.kind === 'escalated'
                    ? "Who gave you this number? I'll be speaking to our legal team about this call."
                    : "Not interested, sorry."
        });
        turns.push({
          speaker: 'lexi',
          text:
            c.kind === 'gatekeeper'
              ? "Thanks. Could you tell me who the right person for technology decisions is, and the best way to reach them?"
              : c.kind === 'wrong'
                ? "Thank you for telling me. I'll update our records. Goodbye."
                : c.kind === 'dnc'
                  ? "Of course. I'll make sure you're not called again. Goodbye."
                  : c.kind === 'escalated'
                    ? "I understand. I'll end the call here and make sure Vinay knows. Goodbye."
                    : 'Understood. Thank you for your time. Goodbye.'
        });
        break;
      case 'mid':
        turns.push({ speaker: 'lexi', text: open.full });
        turns.push({ speaker: 'prospect', text: 'Go on, quickly.' });
        turns.push({ speaker: 'lexi', text: `I noticed ${hook}. I'd guess that is keeping your team busy.` });
        turns.push({ speaker: 'prospect', text: "Look, I'm not interested. Thanks." });
        break;
      case 'full':
        turns.push({ speaker: 'lexi', text: open.full });
        for (const line of bodyScript(prospect)) turns.push({ speaker: line.speaker, text: line.text });
        break;
    }
    const last = Math.max(1, turns.length - 1);
    for (const [i, turn] of turns.entries()) {
      const atSecond = i === 0 ? 0 : duration < 12 ? Math.min(duration - 1, i * 2) : Math.min(duration - 1, Math.round(11 + ((duration - 14) * i) / last));
      await db.callEvent.create({
        data: { callId: c.id, kind: 'turn', speaker: turn.speaker, text: turn.text, atSecond, data: '{}', createdAt: new Date(c.startedAt.getTime() + atSecond * 1000) }
      });
    }

    // Scribe's record, for any call that was picked up.
    const objections: Array<{ kind: string; saidAs: string; handledAs: string }> = [];
    if (['declined_late', 'declined_mid', 'callback', 'early_declined'].includes(c.kind) || (c.kind === 'meeting_confirmed' && rand() < 0.5)) {
      const o = OBJECTIONS[objectionCursor % OBJECTIONS.length] as (typeof OBJECTIONS)[number];
      objectionCursor += 1;
      objections.push(o);
    }
    let windows: Array<{ saidAs: string; startsAt: string; endsAt: string }> = [];
    let timezone: string | null = null;
    let attendees: string[] = [];
    const isMeeting = c.kind.startsWith('meeting');
    if (isMeeting) {
      timezone = person.place.timezone;
      const w = (iso: number, from: number, to: number, saidAs: string) => {
        const d = futureDay(now, timezone as string, iso, 2 + (windows.length === 0 ? 0 : 2));
        return { saidAs, startsAt: d.set({ hour: from }).toISO() as string, endsAt: d.set({ hour: to }).toISO() as string };
      };
      if (c.kind === 'meeting_pending_auckland') {
        windows = [w(2, 9, 12, 'Tuesday morning'), w(4, 15, 17, 'after 3pm Thursday')];
        attendees = ['her head of architecture'];
      } else if (c.kind === 'meeting_pending_perth') {
        windows = [w(3, 13, 17, 'Wednesday afternoon')];
      } else if (c.kind === 'meeting_pending_brisbane') {
        windows = [w(4, 10, 12, 'Thursday, ten to twelve'), w(5, 9, 11, 'or Friday morning')];
        attendees = ['their CTO'];
      } else {
        windows = [w(2, 10, 12, 'Tuesday morning')];
      }
      pendingWindows.push({ callId: c.id, windows, timezone, attendees });
    }

    if (answered) {
      const summary = isMeeting
        ? [
            `${person.first} is mid-way through a platform programme at ${account.name}.`,
            'They were open to twenty minutes with Vinay.',
            `Free ${windows[0]?.saidAs ?? 'next week'}, ${person.place.city} time.`,
            'They gave a work email and asked for an invite.'
          ]
        : realConversation
          ? [`${person.first} listened to the reason for the call and the hook.`, shape.outcome === 'callback_requested' ? 'They asked to be rung back later in the week.' : 'They declined the offer of twenty minutes, politely.']
          : [];
      await db.callRecord.create({
        data: {
          id: `${c.id}-record`,
          callId: c.id,
          summary: JSON.stringify(summary),
          summarySource: summary.length === 0 ? 'unavailable' : 'model',
          hook: realConversation && ['meeting', 'callback'].some((k) => c.kind.startsWith(k)) ? hook : '',
          objections: JSON.stringify(objections),
          sentiment: shape.outcome === 'meeting_requested' ? 'positive' : shape.outcome === 'not_interested' ? 'negative' : 'neutral',
          attentionLostAtSec: shape.outcome === 'not_interested' ? Math.max(3, duration - between(2, 6)) : null,
          windows: JSON.stringify(windows),
          timezone,
          attendees: JSON.stringify(attendees),
          followUp: JSON.stringify({ plan: { actions: c.kind === 'escalated' ? [{ kind: 'alert-operator', detail: 'escalated: legal-threat' }] : [], withheld: [] }, results: [] }),
          followedUpAt: endedAt
        }
      });
    }

    if (isMeeting) {
      await db.contactEmail.create({
        data: { id: `${person.id}-confirmed`, contactId: person.id, address: person.email, kind: 'confirmed_on_call', verified: true, verifiedAt: endedAt }
      });
      meetingCalls.push({ callId: c.id, contactId: person.id, status: c.kind === 'meeting_confirmed' ? 'confirmed' : 'requested', endedAt });
    }

    if (c.kind === 'escalated') escalationInfo = { contactId: person.id, callId: c.id, at: endedAt };
    if (['declined_late', 'declined_mid', 'early_declined'].includes(c.kind) && rand() < 0.7) {
      suppressions.push({ scope: 'contact', key: person.id, source: 'not-interested', reason: 'they declined: no further contact', at: endedAt });
      suppressions.push({ scope: 'number', key: person.phone, source: 'not-interested', reason: 'they declined: no further contact', at: endedAt });
    }
    if (c.kind === 'dnc') {
      suppressions.push({ scope: 'contact', key: person.id, source: 'prospect-request', reason: 'they asked not to be contacted again', at: endedAt });
      suppressions.push({ scope: 'number', key: person.phone, source: 'prospect-request', reason: 'they asked not to be contacted again', at: endedAt });
    }
    if (c.kind === 'escalated') {
      suppressions.push({ scope: 'contact', key: person.id, source: 'escalation', reason: 'escalated (legal-threat): suppressed', at: endedAt });
      suppressions.push({ scope: 'number', key: person.phone, source: 'escalation', reason: 'escalated (legal-threat): suppressed', at: endedAt });
    }
    if (['declined_late', 'declined_mid', 'early_declined', 'dnc', 'wrong', 'dead', 'escalated'].includes(c.kind)) {
      await db.contact.update({ where: { id: person.id }, data: { status: 'done' } });
    }

    // What it cost: model time for any conversation, voice minutes for any connected call, a text for a request.
    if (answered) {
      spend.push({ category: 'llm', usd: Math.round((0.03 + duration * 0.0006) * 1000) / 1000, at: endedAt, note: `demo: call ${c.id}` });
      spend.push({ category: 'voice', usd: Math.round(duration * 0.002 * 1000) / 1000, at: endedAt, note: `demo: call ${c.id}` });
    } else {
      spend.push({ category: 'voice', usd: Math.round(duration * 0.0012 * 1000) / 1000, at: endedAt, note: `demo: call ${c.id}` });
    }
    if (isMeeting) spend.push({ category: 'sms', usd: 0.06, at: endedAt, note: `demo: confirmation text for ${c.id}` });
  }

  for (const row of attemptRows) {
    await db.dialAttempt.create({ data: { id: randomUUID(), ...row } });
  }
  for (const s of suppressions) {
    await db.suppression.create({ data: { id: randomUUID(), scope: s.scope, key: s.key, source: s.source, reason: s.reason, createdAt: s.at } });
  }

  /* ---- meeting requests and the escalation ---- */

  let requestNumber = 0;
  for (const m of meetingCalls) {
    requestNumber += 1;
    // Hex-only ids, so the reference reads MR-DE00C0D1 and is matched like any other.
    const id = `de00c0d${requestNumber.toString(16)}-0000-4000-8000-00000000000${requestNumber.toString(16)}`;
    await db.meetingRequest.create({
      data: {
        id,
        callId: m.callId,
        contactId: m.contactId,
        status: m.status,
        createdAt: new Date(m.endedAt.getTime() + 90_000),
        emailSentAt: new Date(m.endedAt.getTime() + 100_000),
        decidedAt: m.status === 'confirmed' ? new Date(m.endedAt.getTime() + 3 * 3_600_000) : null,
        decidedVia: m.status === 'confirmed' ? 'email-reply' : null,
        decisionNote: ''
      }
    });
    if (m.status === 'confirmed') {
      await db.contact.update({ where: { id: m.contactId }, data: { status: 'done' } });
    }
  }

  const escalation = escalationInfo as { contactId: string; callId: string; at: Date } | null;
  if (escalation !== null) {
    await db.escalation.create({
      data: {
        id: 'demo-escalation-1',
        level: 'human',
        reason: 'legal-threat: "I\'ll be speaking to our legal team about this call." Suppressed; Vinay alerted',
        detail: JSON.stringify({ callId: escalation.callId }),
        status: 'open',
        contactId: escalation.contactId,
        createdAt: new Date(escalation.at.getTime() + 60_000)
      }
    });
  }

  /* ---- the queue: twelve people, each chosen to meet a different ruling ---- */

  const queueSpec: Array<{ key: string; account: string; place: string; icp: number; mobile?: boolean }> = [
    { key: 'q01', account: 'iota', place: 'sydney', icp: 95 },
    { key: 'q02', account: 'mu', place: 'wellington', icp: 92 },
    { key: 'q03', account: 'lambda', place: 'melbourne', icp: 90 },
    { key: 'q04', account: 'nu', place: 'christchurch', icp: 88 },
    { key: 'q05', account: 'iota', place: 'brisbane', icp: 86 },
    { key: 'q06', account: 'xi', place: 'perth', icp: 84 },
    { key: 'q07', account: 'iota', place: 'sydney', icp: 82, mobile: true },
    { key: 'q08', account: 'mu', place: 'wellington', icp: 80 },
    { key: 'q09', account: 'kappa', place: 'auckland', icp: 78 },
    { key: 'q10', account: 'kappa', place: 'wellington', icp: 76 },
    { key: 'q11', account: 'lambda', place: 'melbourne', icp: 74 },
    { key: 'q12', account: 'nu', place: 'christchurch', icp: 72 }
  ];
  for (const [i, q] of queueSpec.entries()) {
    const person = await makeContact(q.key, q.account, q.place, { status: 'researched', icp: q.icp, titleIndex: i, ...(q.mobile ? { mobile: true } : {}) });
    await dossierFor(person, i % 4 === 3 ? 'medium' : 'high', HYPOTHESES[i % HYPOTHESES.length] as string, HOOKS[i % HOOKS.length] as string);
  }

  const gateAt = options.gateAt;
  const daysBefore = (n: number): Date => new Date(gateAt.getTime() - n * 86_400_000);
  const attempt = async (key: string, at: Date, hadConversation = false): Promise<void> => {
    const p = made.get(key) as Made;
    await db.dialAttempt.create({ data: { id: randomUUID(), contactId: p.id, accountId: `demo-acct-${p.accountKey}`, e164: p.phone, at, hadConversation } });
  };
  // q08 has used all three attempts, five or more days apart, inside twenty-one days.
  for (const n of [16, 10, 5]) await attempt('q08', daysBefore(n));
  // q09 was rung two days ago, so q09 is too soon and q10, a colleague, is held by the weekly account cap.
  await attempt('q09', daysBefore(2));
  // q11 asked on an earlier campaign not to be called.
  const q11 = made.get('q11') as Made;
  await db.suppression.create({
    data: { id: randomUUID(), scope: 'contact', key: q11.id, source: 'prospect-request', reason: 'asked on an earlier campaign not to be called again', createdAt: daysBefore(40) }
  });

  /* ---- the day's plan, drawn up by the real planner and approved ---- */

  const planner = new DailyCallPlanner({ db, plans: options.plans, gate: options.gate, policy, calendar: options.calendar, now: () => gateAt });
  const draft = await planner.draft({ campaignId: DEMO_CAMPAIGN_ID });
  await planner.submit(draft.id);
  await options.plans.approve(draft.id, 'demo operator', gateAt, 'Demo plan: approved so the sample queue shows the gate saying yes as well as no.');

  // Past plans for the funnel's seven-day baseline: who was lined up each day, and what the gate had said.
  const blocked = ['q06', 'q07'].map((k) => made.get(k) as Made);
  for (const [dayIndex, day] of operatorDays.slice(0, 5).entries()) {
    const date = day.toFormat('yyyy-MM-dd');
    const planId = `demo-plan-${date}`;
    const dayCalls = plansToWrite.filter((c) => DateTime.fromJSDate(c.startedAt, { zone }).toFormat('yyyy-MM-dd') === date);
    await db.callPlan.create({
      data: { id: planId, campaignId: DEMO_CAMPAIGN_ID, planDate: date, status: 'approved', createdAt: new Date(day.toMillis() + 6 * 3_600_000), decidedAt: new Date(day.toMillis() + 7 * 3_600_000), decidedBy: 'demo operator' }
    });
    let position = 0;
    const seen = new Set<string>();
    for (const c of dayCalls) {
      const p = made.get(c.contactKey ?? c.id) as Made;
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      position += 1;
      await db.callPlanEntry.create({
        data: { id: `${planId}-${position}`, planId, contactId: p.id, accountId: `demo-acct-${p.accountKey}`, position, e164: p.phone, displayName: `${p.first} ${p.last}`, title: p.title, accountName: accountOf(p.accountKey).name, hypothesis: '', gateAllowed: true, gateReasons: '[]' }
      });
    }
    for (const p of blocked.slice(0, 1 + (dayIndex % 2))) {
      position += 1;
      await db.callPlanEntry.create({
        data: {
          id: `${planId}-${position}`,
          planId,
          contactId: p.id,
          accountId: `demo-acct-${p.accountKey}`,
          position,
          e164: p.phone,
          displayName: `${p.first} ${p.last}`,
          title: p.title,
          accountName: accountOf(p.accountKey).name,
          hypothesis: '',
          gateAllowed: false,
          gateReasons: JSON.stringify([{ code: p.id === made.get('q07')?.id ? 'MOBILE_DIALLING_DISABLED' : 'OUTSIDE_STATUTORY_WINDOW', detail: 'demo', permanent: false }])
        }
      });
    }
  }

  // The gate has been asked about every planned person, at the evaluation instant and now, so
  // "what the gate refused, and why" has real entries behind it.
  const planned = (await options.plans.get(draft.id))?.entries ?? [];
  for (const entry of planned) {
    const contact = await db.contact.findUniqueOrThrow({ where: { id: entry.contactId }, include: { account: true } });
    for (const at of [gateAt, now]) {
      const market = marketForDial(entry.e164, contact.account.country === 'NZ' ? 'NZ' : 'AU');
      const request: DialRequest = {
        requestId: `demo-${entry.contactId}-${at.getTime()}`,
        contactId: entry.contactId,
        accountId: entry.accountId,
        campaignId: DEMO_CAMPAIGN_ID,
        phone: entry.e164,
        market,
        source: 'orchestrator',
        at,
        ...(contact.jurisdiction !== null
          ? { localityHint: { jurisdiction: contact.jurisdiction as Jurisdiction, ...(contact.timezone !== null ? { timezone: contact.timezone } : {}) } }
          : {})
      };
      await options.gate.request(request);
    }
  }

  /* ---- playbook ---- */

  const createdAt = (daysAgo: number): Date => new Date(now.getTime() - daysAgo * 86_400_000);
  const playbook: Array<{ slot: string; version: number; status: string; template: string; rationale: string; evidence: Record<string, unknown>; at: Date }> = [
    { slot: 'hook', version: 1, status: 'retired', template: 'I noticed {{hook}}. I would guess that is keeping the team busy.', rationale: 'The first script: names the reason for the call straight away.', evidence: { outcome: 'promoted', requestRate: 0.18, conversations: 41 }, at: createdAt(40) },
    { slot: 'hook', version: 2, status: 'retired', template: 'You have been hiring for {{hook}}, which usually means a change is coming.', rationale: 'Led with the hiring signal. It lost people inside fifteen seconds, so it was rolled back after 34 conversations.', evidence: { outcome: 'rolled_back', requestRate: 0.09, conversations: 34 }, at: createdAt(21) },
    { slot: 'hook', version: 3, status: 'champion', template: 'I noticed {{hook}}, and wondered whether that is where your attention is right now.', rationale: 'Back to the plain observation, with a question that lets them say yes or no. Promoted after clearing the gate.', evidence: { outcome: 'promoted' }, at: createdAt(9) },
    { slot: 'hook', version: 4, status: 'challenger', template: 'Before I take your time: {{hook}} caught my eye. Is that on your plate?', rationale: "Opens on the prospect's own public signal and asks one question straight away. Under test against hook v3.", evidence: { minConversations: 30 }, at: createdAt(0.75) }
  ];
  for (const row of playbook) {
    await db.playbook.create({
      data: {
        id: `pb-${row.slot}-v${row.version}`,
        slot: row.slot,
        version: row.version,
        status: row.status,
        content: JSON.stringify({ slot: row.slot, template: row.template }),
        rationale: row.rationale,
        evidence: JSON.stringify(row.evidence),
        createdAt: row.at
      }
    });
  }

  /* ---- money ---- */

  for (let d = 0; d < 9; d++) {
    const at = new Date(now.getTime() - d * 86_400_000 - 3 * 3_600_000);
    spend.push({ category: 'apollo', usd: 0.4, at, note: 'demo: contact enrichment' });
    spend.push({ category: 'llm', usd: 0.55 + (d % 3) * 0.1, at, note: 'demo: research and dossiers' });
  }
  for (const s of spend) {
    await db.spendRecord.create({ data: { id: randomUUID(), at: s.at, category: s.category, usd: s.usd, note: s.note } });
  }

  /* ---- the agent trace ---- */

  const trace: Array<{ actor: string; kind: string; summary: string; usd?: number; hoursAgo: number }> = [
    { actor: 'campaign-director', kind: 'decided', summary: 'Standing by: no research or prospecting is due, and the day plan is approved, so the dialler has what it needs.', hoursAgo: 0.2 },
    { actor: 'campaign-director', kind: 'decided', summary: `Drew up today's call plan: ${planned.length} people, and asked the compliance gate about each of them before showing it to you.`, hoursAgo: 1.1 },
    { actor: 'compliance-gate', kind: 'decided', summary: 'Held one person on the plan: they are on the suppression list from an earlier campaign.', hoursAgo: 1.1 },
    { actor: 'compliance-gate', kind: 'decided', summary: 'Held one person on the plan: the attempt limit has been reached, so no further calls are allowed.', hoursAgo: 1.1 },
    { actor: 'scout', kind: 'validated', summary: 'Researched 3 contacts at Demo Mutual Lambda. Every fact carries a source link; two unsourced rumours were dropped.', usd: 0.31, hoursAgo: 5 },
    { actor: 'prospector', kind: 'validated', summary: 'Searched Demo Health Nu for the target titles and kept 2 of 5 people; the others did not match the ICP.', usd: 0.4, hoursAgo: 6 },
    { actor: 'campaign-director', kind: 'decided', summary: 'Queued research for 4 new contacts, oldest first, within this week\'s budget.', hoursAgo: 7 },
    { actor: 'campaign-director', kind: 'escalated', summary: 'Escalated a call to you: the prospect made a legal threat. They were suppressed and you were alerted.', hoursAgo: 22 },
    { actor: 'scribe', kind: 'validated', summary: 'Wrote up yesterday\'s calls. One had no outcome marked, so nothing irreversible was done for it and it is flagged for a look.', usd: 0.18, hoursAgo: 23 },
    { actor: 'coach', kind: 'decided', summary: 'Started a challenger for the hook slot: hook v4 against hook v3. It needs 30 conversations before any promotion decision.', usd: 0.62, hoursAgo: 18 },
    { actor: 'campaign-director', kind: 'decided', summary: 'Held a research task: it could cost up to $0.50 and only $0.31 of this week\'s budget remained.', hoursAgo: 52 }
  ];
  for (const t of trace) {
    await db.traceEvent.create({
      data: { id: randomUUID(), at: new Date(now.getTime() - t.hoursAgo * 3_600_000), actor: t.actor, kind: t.kind, summary: t.summary, detail: '{}', usd: t.usd ?? 0 }
    });
  }

  return {
    calls: plansToWrite.length,
    contacts: made.size,
    accounts: ACCOUNTS.length,
    pendingMeetingRequests: meetingCalls.filter((m) => m.status === 'requested').length,
    queue: planned.length,
    planDate: draft.planDate
  };
}
