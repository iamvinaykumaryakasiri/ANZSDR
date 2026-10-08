/**
 * The daily digest, built from numbers.
 *
 * `buildDigest` is a pure function: figures in, a digest out. Every sentence is
 * assembled from a computed value, nothing is estimated, and where there is nothing
 * to say the digest says that rather than padding. It is written to be listened to
 * as well as read - the console has a button that reads the briefing aloud - so:
 * whole sentences, words rather than symbols, numbers a person can say.
 *
 * The digest is also where the audit's known behaviour is explained, because the
 * numbers cannot be read correctly without it: Guardian's post-call audit flags
 * the frozen opening's own mandated lines as unsupported claims. That was left as it
 * is by decision. The digest shows the audit's count as reported and the count
 * with those lines taken out, every day, with the reason.
 */

import { DateTime } from 'luxon';
import type { CallFact } from './facts.js';
import {
  buildFunnel,
  costPerMeeting,
  gatekeeperByAccount,
  leakiestSection,
  outcomeCounts,
  rankObjections,
  round,
  safetySignalsFromFacts,
  sectionHangups,
  summariseDefects,
  todayNumbers,
  worstStageAgainstBaseline,
  wrongNumberRate,
  type SpendSummary
} from './metrics.js';
import type { DailyDigest } from './contract.js';

type Plan = DailyDigest['figures']['queue']['plans'][number];

export interface DigestData {
  /** yyyy-MM-dd on the operator's clock. */
  day: string;
  zone: string;
  generatedAt: Date;
  /** Calls that started on `day`. */
  facts: CallFact[];
  /** Calls in the seven days before it. */
  baselineFacts: CallFact[];
  queue: { queued: number; gatePassed: number; baselineQueued: number; baselineGatePassed: number };
  gateRejections: Array<{ reason: string; count: number }>;
  spend: {
    day: SpendSummary;
    lastSevenDays: SpendSummary;
    monthToDate: SpendSummary;
    /** Meeting requests in the same windows, for cost per meeting. */
    requestsLastSevenDays: number;
    requestsMonthToDate: number;
    weeklyCeilingUsd: number | null;
  };
  /** The frozen opening's lines, so the audit's flags on them can be separated out. */
  openingTexts: string[];
  escalationsOnDay: number;
  playbook: DailyDigest['figures']['playbook'];
  needsYou: DailyDigest['figures']['needsYou'];
  plans: Plan[];
  killSwitch: { engaged: boolean; reason?: string };
}

export const OPENING_AUDIT_CALLOUT =
  "How to read the unsupported-claim numbers. Guardian's post-call audit looks for anything Lexi said that is not an approved claim, and it flags lines from her frozen opening - who she works for, and the generic reason for the call - because none of those is in the approved claims list either. That is known, and the decision was to leave the audit as it is. So the audit's own count rises on every call whatever Lexi says. Both figures are shown: the audit's count as reported, and the count with the opening's own lines taken out. The second is the one to read.";

/* ------------------------------------------------------------------ */
/* Words                                                               */
/* ------------------------------------------------------------------ */

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const pct = (x: number): string => `${Math.round(x * 100)}%`;
const usd = (x: number): string => `US$${x.toFixed(2)}`;
const per = (x: number | null): string => (x === null ? 'no calls to compare with' : x.toFixed(2));

function dayLabel(day: string, zone: string): string {
  return DateTime.fromISO(day, { zone }).toFormat('cccc d LLLL');
}

function shortDay(day: string, zone: string): string {
  return DateTime.fromISO(day, { zone }).toFormat('ccc d LLL');
}

function list(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/* ------------------------------------------------------------------ */
/* Building                                                            */
/* ------------------------------------------------------------------ */

export function buildDigest(data: DigestData): DailyDigest {
  const { facts, zone } = data;
  const label = dayLabel(data.day, zone);

  const today = todayNumbers(facts, data.spend.day.totalUsd);
  const funnel = buildFunnel({
    today: facts,
    baseline: data.baselineFacts,
    queued: data.queue.queued,
    gatePassed: data.queue.gatePassed,
    baselineQueued: data.queue.baselineQueued,
    baselineGatePassed: data.queue.baselineGatePassed
  });
  const hangups = sectionHangups(facts);
  const objections = rankObjections(facts, 5);
  const gatekeepers = gatekeeperByAccount(facts, 3);
  const wrongNumbers = wrongNumberRate(facts);
  const outcomes = outcomeCounts(facts);

  const defectSummary = summariseDefects(facts, data.openingTexts);
  const baselineDefects = summariseDefects(data.baselineFacts, data.openingTexts);
  const defects = {
    ...defectSummary,
    priorSevenDays: {
      calls: data.baselineFacts.length,
      defectsPerCall: data.baselineFacts.length === 0 ? null : round(baselineDefects.total / data.baselineFacts.length, 2),
      claimDefectsNetPerCall:
        data.baselineFacts.length === 0 ? null : round(baselineDefects.unsupportedClaims.other / data.baselineFacts.length, 2)
    }
  };

  const window = { from: DateTime.fromISO(data.day, { zone }).toJSDate(), to: DateTime.fromISO(data.day, { zone }).plus({ days: 1 }).toJSDate() };
  const signals = safetySignalsFromFacts(facts, data.escalationsOnDay, window, data.openingTexts);

  const spend = {
    dayUsd: data.spend.day.totalUsd,
    lastSevenDaysUsd: data.spend.lastSevenDays.totalUsd,
    monthToDateUsd: data.spend.monthToDate.totalUsd,
    weeklyCeilingUsd: data.spend.weeklyCeilingUsd,
    byCategory: Object.fromEntries(Object.entries(data.spend.day.byCategory).map(([k, v]) => [k, v ?? 0])),
    costPerMeetingSevenDaysUsd: costPerMeeting(data.spend.lastSevenDays.totalUsd, data.spend.requestsLastSevenDays),
    costPerMeetingMonthUsd: costPerMeeting(data.spend.monthToDate.totalUsd, data.spend.requestsMonthToDate)
  };

  const sections: Array<{ title: string; body: string }> = [];

  /* ---- The day ---- */
  {
    const lines: string[] = [];
    if (facts.length === 0) {
      lines.push(`No calls were placed on ${label}.`);
    } else {
      lines.push(
        `On ${label} Lexi dialled ${plural(today.dialled, 'number')}. ${plural(today.connected, 'person', 'people')} picked up, ${plural(today.conversations, 'conversation')} ran past forty-five seconds, and ${plural(today.requests, 'meeting request')} came out of them.`
      );
      const confirmed = facts.filter((f) => f.confirmed).length;
      if (today.requests > 0) lines.push(`${confirmed} of those ${confirmed === 1 ? 'has' : 'have'} been confirmed by Vinay so far.`);
      const named = Object.entries(outcomes)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([k, n]) => `${n} ${k.replace(/_/g, ' ')}`);
      lines.push(`How the calls ended: ${list(named)}.`);
    }
    sections.push({ title: label, body: lines.join(' ') });
  }

  /* ---- Where they dropped ---- */
  {
    const lines: string[] = [];
    if (facts.length === 0) {
      lines.push('There is nothing to compare, because no calls were placed.');
    } else {
      const worst = worstStageAgainstBaseline(funnel);
      lines.push(
        worst === null
          ? 'No step of the funnel did noticeably worse than it has over the previous seven days.'
          : `Against the previous seven days, the biggest slip was at "${worst.stage.label}": ${pct(worst.stage.rate)} of the step before got through, against a usual ${pct(worst.stage.baselineRate)}.`
      );

      if (hangups.attributed === 0) {
        lines.push('Script timings were not recorded for these calls, so the hang-up curve cannot yet say which sentence lost people.');
      } else {
        const leak = leakiestSection(hangups);
        lines.push(
          leak === null
            ? 'No script section stands out as losing people.'
            : `The leakiest part of the script was the ${leak.label.toLowerCase()}: ${leak.endedHere} of the ${leak.reached} calls that reached it ended there (${pct(leak.hazard)}).`
        );
        if (hangups.unattributed > 0) lines.push(`${plural(hangups.unattributed, 'call')} had no section timings and are not counted in that.`);
      }

      lines.push(
        objections.length === 0
          ? 'No objections were logged.'
          : `Objections, most common first: ${list(objections.map((o) => `${o.label} (${o.count})`))}.`
      );
      if (gatekeepers.length > 0) {
        lines.push(`Gatekeepers blocked calls at ${list(gatekeepers.map((g) => `${g.company} (${g.blocks} of ${g.calls})`))}.`);
      }
      if (wrongNumbers > 0) {
        lines.push(`${pct(wrongNumbers)} of finished calls were wrong or dead numbers, which is a data problem rather than a script one.`);
      }
    }
    if (data.gateRejections.length > 0) {
      lines.push(
        `The compliance gate refused ${list(data.gateRejections.slice(0, 4).map((g) => `${g.reason} (${g.count})`))}.`
      );
    }
    sections.push({ title: 'Where people dropped', body: lines.join(' ') });
  }

  /* ---- Money ---- */
  {
    const lines: string[] = [`${usd(spend.dayUsd)} was spent on the day.`];
    const cats = Object.entries(spend.byCategory).filter(([, v]) => v > 0);
    if (cats.length > 0) lines.push(`That was ${list(cats.map(([k, v]) => `${k} ${usd(v)}`))}.`);
    lines.push(
      spend.weeklyCeilingUsd === null
        ? `${usd(spend.lastSevenDaysUsd)} in the last seven days, with no weekly ceiling set.`
        : `${usd(spend.lastSevenDaysUsd)} in the last seven days against a ceiling of ${usd(spend.weeklyCeilingUsd)}.`
    );
    lines.push(`${usd(spend.monthToDateUsd)} so far this month.`);
    lines.push(
      spend.costPerMeetingSevenDaysUsd === null
        ? 'There is no cost per meeting for the last seven days, because there are no meeting requests to divide by.'
        : `Cost per meeting request is ${usd(spend.costPerMeetingSevenDaysUsd)} over the last seven days${
            spend.costPerMeetingMonthUsd === null ? '' : ` and ${usd(spend.costPerMeetingMonthUsd)} this month`
          }.`
    );
    sections.push({ title: 'Money', body: lines.join(' ') });
  }

  /* ---- Defects ---- */
  {
    const u = defects.unsupportedClaims;
    const lines: string[] = [];
    if (facts.length === 0) {
      lines.push('No calls, so no defects to report.');
    } else {
      lines.push(
        defects.total === 0
          ? 'No defects were flagged on any call.'
          : `${plural(defects.total, 'defect')} flagged across ${plural(defects.callsWithDefects, 'call')}: ${list(
              Object.entries(defects.byKind)
                .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
                .map(([k, n]) => `${k.replace(/-/g, ' ')} ${n}`)
            )}.`
      );
      lines.push(
        `Unsupported claims as the audit reports them: ${u.total}. With the frozen opening's own lines taken out: ${u.other}.`
      );
      const real = u.examples.filter((e) => !e.openingLine);
      if (real.length > 0) {
        lines.push(`To read: ${real.map((e) => `"${e.quote}" (${e.company})`).join('; ')}.`);
      }
      lines.push(
        `That is ${per(round(defects.total / facts.length, 2))} defects per call, against ${per(defects.priorSevenDays.defectsPerCall)} over the previous seven days.`
      );
    }
    lines.push(OPENING_AUDIT_CALLOUT);
    sections.push({ title: 'Defects', body: lines.join(' ') });
  }

  /* ---- The script ---- */
  {
    const lines: string[] = [];
    lines.push(
      data.playbook.champions.length === 0
        ? 'No playbook versions have been recorded yet, so Lexi is using the built-in script.'
        : `Current champions: ${list(data.playbook.champions.map((c) => `${c.slot} v${c.version}`))}.`
    );
    if (data.playbook.changes.length > 0) lines.push(...data.playbook.changes);
    else lines.push('Nothing in the script changed in the last day.');
    const t = data.playbook.test;
    lines.push(
      t === null
        ? 'No test is running.'
        : `A test is running on the ${t.slot}: version ${t.version} against the champion. Meeting-request rate so far is ${pct(t.challengerRequestRate)} for the challenger and ${pct(t.championRequestRate)} for the champion, with ${t.challengerCompleted} and ${t.championCompleted} completed conversations of the ${t.minimum} each that a decision needs.`
    );
    sections.push({ title: 'The script', body: lines.join(' ') });
  }

  /* ---- Needs you ---- */
  {
    const n = data.needsYou;
    const lines: string[] = [];
    for (const m of n.openMeetingRequests) {
      lines.push(`${m.name} at ${m.company} (${m.ref}) has been waiting ${plural(Math.round(m.waitingHours), 'hour')} for a reply${m.status === 'reschedule' ? ', and was marked for rescheduling' : ''}.`);
    }
    if (n.waitingOver24h > 0) lines.push(`${plural(n.waitingOver24h, 'request')} ${n.waitingOver24h === 1 ? 'has' : 'have'} been waiting more than a day.`);
    for (const e of n.openEscalations) lines.push(`An open escalation: ${e.reason}, waiting ${plural(Math.round(e.waitingHours), 'hour')}.`);
    sections.push({ title: 'Needs you', body: lines.length === 0 ? 'Nothing is waiting on you.' : lines.join(' ') });
  }

  /* ---- Today's queue ---- */
  {
    const lines: string[] = [];
    if (data.plans.length === 0) lines.push('No plan has been drawn up for today, so nothing will be dialled.');
    for (const p of data.plans) {
      lines.push(
        p.status === 'approved'
          ? `The plan for ${p.campaign} is approved: ${plural(p.entries, 'person', 'people')} on it, ${p.clearGate} clearing the compliance gate.`
          : p.status === 'pending_approval'
            ? `The plan for ${p.campaign} is waiting for your approval, with ${plural(p.entries, 'person', 'people')} on it. Nothing will be dialled until you approve it.`
            : `The plan for ${p.campaign} is ${p.status.replace(/_/g, ' ')} with ${plural(p.entries, 'person', 'people')} on it, so nothing is released from it.`
      );
    }
    if (data.killSwitch.engaged) {
      lines.push(`Dialling is halted${data.killSwitch.reason !== undefined ? `: ${data.killSwitch.reason}` : ''}.`);
    }
    sections.push({ title: "Today's queue", body: lines.join(' ') });
  }

  const needCount = data.needsYou.openMeetingRequests.length + data.needsYou.openEscalations.length;
  const headline =
    `${facts.length === 0 ? `No calls on ${shortDay(data.day, zone)}` : `${plural(today.dialled, 'dial')}, ${plural(today.requests, 'meeting request')}, ${usd(spend.dayUsd)} spent`}. ` +
    (needCount === 0 ? 'Nothing needs you.' : `${plural(needCount, 'thing')} ${needCount === 1 ? 'needs' : 'need'} you.`) +
    (data.killSwitch.engaged ? ' Dialling is halted.' : '');

  const subject = `[DAILY DIGEST] ${shortDay(data.day, zone)} — ${plural(today.requests, 'meeting request')}, ${usd(spend.dayUsd)}`;

  const text = [headline, '', ...sections.flatMap((s) => [s.title, '-'.repeat(s.title.length), s.body, ''])].join('\n').trimEnd() + '\n';

  return {
    day: data.day,
    generatedAt: data.generatedAt.toISOString(),
    subject,
    headline,
    sections,
    text,
    figures: {
      today,
      outcomes,
      funnel,
      sectionHangups: hangups,
      objections: rankObjections(facts, 8),
      gatekeepers,
      wrongNumberRate: wrongNumbers,
      gateRejections: data.gateRejections,
      spend,
      defects,
      safety: {
        callsToday: signals.callsToday,
        escalationsToday: signals.escalationsToday,
        claimDefectsToday: signals.claimDefectsToday,
        claimDefectsRaw: signals.claimDefectsRaw,
        errorRate: signals.errorRate,
        negativeSentimentRate: signals.negativeSentimentRate,
        defectRate: signals.defectRate
      },
      playbook: data.playbook,
      needsYou: data.needsYou,
      queue: { plans: data.plans, killSwitch: data.killSwitch }
    }
  };
}
