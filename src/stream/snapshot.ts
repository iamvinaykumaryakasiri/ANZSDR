/**
 * The console's whole picture of the room, built from the blackboard.
 *
 * One function, one answer: `buildSnapshot` reads the real stores and services
 * and returns exactly the `ConsoleSnapshot` in contract.ts, validated before it
 * leaves. The console does arithmetic on none of it.
 *
 * `SnapshotService` sits on top for the routes: it coalesces concurrent builds
 * (an SSE tick and an HTTP GET landing together cost one build, not two) and
 * publishes every fresh snapshot to the bus.
 */

import { DateTime } from 'luxon';
import {
  consoleSnapshotSchema,
  type ConsoleSnapshot,
  type KillSwitchView,
  type LiveCallView
} from './contract.js';
import { buildBriefing } from './briefing.js';
import type { ConsoleDeps } from './deps.js';
import { loadEscalations } from './escalations.js';
import {
  ANALYSIS_DAYS,
  buildFunnel,
  buildHangupCurve,
  gatekeeperByAccount,
  loadCallFacts,
  rankObjections,
  wrongNumberRate
} from './facts.js';
import { describeReasons } from './gate-text.js';
import { gateRejections, monthlyCeiling, providerStatuses } from './health.js';
import { openMeetingViews } from './meeting-views.js';
import { loadPlaybook, recentPlaybookChanges } from './playbook.js';
import { loadQueue } from './queue.js';
import { dayBounds, DAY_MS, monthStart, usd } from './util.js';

export async function killSwitchView(deps: ConsoleDeps): Promise<KillSwitchView> {
  const state = await deps.killSwitch.state();
  return {
    engaged: state.active,
    ...(state.reason !== undefined ? { reason: state.reason } : {}),
    ...(state.trippedAt !== undefined ? { since: state.trippedAt.toISOString() } : {})
  };
}

async function spendSince(deps: ConsoleDeps, since: Date): Promise<number> {
  const result = await deps.db.spendRecord.aggregate({ _sum: { usd: true }, where: { at: { gte: since } } });
  return usd(result._sum.usd ?? 0);
}

export async function buildSnapshot(deps: ConsoleDeps): Promise<ConsoleSnapshot> {
  const now = deps.now();
  const zone = deps.policy.operational_timezone;
  const today = dayBounds(now, zone);
  const yesterday = dayBounds(now, zone, -1);
  const baselineFrom = dayBounds(now, zone, -7);

  const analysisFrom = new Date(today.start.getTime() - ANALYSIS_DAYS * DAY_MS);
  const [kill, live, facts, meetings, escalations, spendToday, spendWeek, spendMonth, ceiling, rejections] = await Promise.all([
    killSwitchView(deps),
    deps.live.current(now),
    loadCallFacts(deps.db, { from: analysisFrom, to: new Date(now.getTime() + 60_000) }, now),
    openMeetingViews(deps),
    loadEscalations(deps, now),
    spendSince(deps, today.start),
    spendSince(deps, new Date(now.getTime() - 7 * DAY_MS)),
    spendSince(deps, monthStart(now, zone)),
    monthlyCeiling(deps),
    gateRejections(deps, now)
  ]);

  const inDay = (from: Date, to: Date) => facts.filter((f) => f.startedAt >= from && f.startedAt < to);
  const todayFacts = inDay(today.start, today.end);
  const baselineFacts = inDay(baselineFrom.start, today.start);
  const yesterdayFacts = inDay(yesterday.start, yesterday.end);

  const queue = await loadQueue(deps, now, new Set(todayFacts.map((f) => f.contactId)));

  // The plan side of the baseline: for the seven days before today, how many
  // people the approved plans lined up and how many of those the gate had passed.
  const [baselineQueued, baselineGatePassed] = await Promise.all([
    deps.db.callPlanEntry.count({ where: { plan: { status: 'approved', planDate: { gte: baselineFrom.date, lt: today.date } } } }),
    deps.db.callPlanEntry.count({
      where: { gateAllowed: true, plan: { status: 'approved', planDate: { gte: baselineFrom.date, lt: today.date } } }
    })
  ]);

  const funnel = buildFunnel({
    today: todayFacts,
    baseline: baselineFacts,
    queued: todayFacts.length + queue.waiting,
    gatePassed: todayFacts.length + queue.allowed,
    baselineQueued,
    baselineGatePassed
  });

  const requestsToday = todayFacts.filter((f) => f.outcome === 'meeting_requested').length;
  const todayView = {
    dialled: todayFacts.length,
    connected: todayFacts.filter((f) => f.answered).length,
    conversations: todayFacts.filter((f) => f.realConversation).length,
    requests: requestsToday,
    spendUsd: spendToday,
    costPerMeetingUsd: requestsToday === 0 ? null : usd(spendToday / requestsToday)
  };

  const playbook = await loadPlaybook(deps.db, facts);
  const providers = deps.demo !== undefined ? deps.demo.providers : await providerStatuses(deps);
  const weeklyCeiling = ceiling === null ? null : usd((ceiling * 12) / 52);

  // Stand-by: who is next, when, and if nothing can dial, why in words.
  const head = queue.head;
  let nextDialAt: string | null = null;
  let note: string;
  if (kill.engaged) {
    note = `Dialling is halted${kill.reason !== undefined ? `: ${kill.reason}` : ''}. Nothing will be dialled until a person lifts the halt.`;
  } else if (head === null) {
    note = 'Nobody is queued. Prospecting and research carry on; nobody is dialled who is not on a plan.';
  } else if (head.allowed) {
    nextDialAt = now.toISOString();
    note = 'The compliance gate has cleared the next person. Waiting for the dialler to take the call.';
  } else {
    const reasons = head.item.gate.reasons;
    note = `Held: ${describeReasons(reasons)}.`;
    if (head.retryAt !== null) nextDialAt = head.retryAt.toISOString();
  }
  const simulated = kill.engaged ? null : (deps.live.nextDialAt?.(now) ?? null);
  if (simulated !== null) nextDialAt = simulated.toISOString();
  if (deps.demo !== undefined) note = `${note} ${deps.demo.note}`;

  const briefing = buildBriefing({
    now,
    zone,
    yesterday: { label: DateTime.fromISO(yesterday.date, { zone }).toFormat('cccc d LLLL'), facts: yesterdayFacts },
    meetings,
    escalations,
    queue,
    killSwitch: kill,
    playbookChanges: await recentPlaybookChanges(deps.db, now),
    spendThisWeekUsd: spendWeek,
    weeklyCeilingUsd: weeklyCeiling,
    mode: deps.mode
  });

  const snapshot: ConsoleSnapshot = {
    generatedAt: now.toISOString(),
    mode: deps.mode,
    killSwitch: kill,
    live: live as LiveCallView | null,
    standingBy: { next: head?.item ?? null, nextDialAt, note },
    needsYou: { meetingRequests: meetings, escalations },
    upNext: queue.items,
    today: todayView,
    funnel,
    hangupCurve: buildHangupCurve(facts),
    objections: rankObjections(facts),
    gatekeeperByAccount: gatekeeperByAccount(facts),
    wrongNumberRate: wrongNumberRate(facts),
    playbook,
    health: {
      queueDepth: queue.waiting,
      providers,
      apolloCreditsRemaining: deps.demo?.apolloCreditsRemaining ?? null,
      spendMonthUsd: spendMonth,
      spendCeilingUsd: ceiling,
      gateRejections: rejections
    },
    briefing
  };

  // Fail closed: a snapshot that does not match the contract is a bug here, and
  // is reported here, not discovered by a browser.
  return consoleSnapshotSchema.parse(snapshot);
}

export class SnapshotService {
  private inflight: Promise<ConsoleSnapshot> | null = null;
  private pending: Promise<ConsoleSnapshot> | null = null;
  private last: { at: number; snapshot: ConsoleSnapshot } | null = null;

  constructor(readonly deps: ConsoleDeps) {}

  private build(): Promise<ConsoleSnapshot> {
    const run: Promise<ConsoleSnapshot> = buildSnapshot(this.deps)
      .then((snapshot) => {
        this.last = { at: Date.now(), snapshot };
        return snapshot;
      })
      .finally(() => {
        if (this.inflight === run) this.inflight = null;
      });
    this.inflight = run;
    return run;
  }

  private async buildAndPublish(): Promise<ConsoleSnapshot> {
    const snapshot = await this.build();
    this.deps.bus.publish({ type: 'snapshot', snapshot });
    return snapshot;
  }

  /** A snapshot no older than `maxAgeMs`, building one if need be. */
  async get(maxAgeMs = 1500): Promise<ConsoleSnapshot> {
    if (this.last !== null && Date.now() - this.last.at <= maxAgeMs) return this.last.snapshot;
    return this.inflight ?? this.build();
  }

  /**
   * Rebuild now and tell every viewer. Called after anything that changes what
   * the room looks like. A build already in flight may have read the old state,
   * so a refresh waits for it and then reads again; refreshes asked for in the
   * meantime share that one second build.
   */
  refresh(): Promise<ConsoleSnapshot> {
    if (this.pending !== null) return this.pending;
    const waiting = this.inflight;
    if (waiting === null) return this.buildAndPublish();

    const run: Promise<ConsoleSnapshot> = waiting
      .catch(() => undefined)
      .then(() => {
        this.pending = null;
        return this.buildAndPublish();
      });
    this.pending = run;
    return run;
  }

  /** Forget the cache, so the next `get` reads fresh state. */
  invalidate(): void {
    this.last = null;
  }
}
