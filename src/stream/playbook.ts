/**
 * The playbook as the console shows it: champion, challenger, and how it got here.
 *
 * Coach owns the playbook table (section 11). This reads it and never writes;
 * the one write path in the console, rolling back, is a confirmed Jarvis action
 * (jarvis.ts) and goes through `rollBackPlaybook` below so that the flip is one
 * transaction and its shape is in one place.
 *
 * Two conventions this relies on, stated so Coach can match them:
 *
 *   - A version is named `<slot> v<n>`, for example "hook v3". A call's
 *     `playbookVersion` is that string, which is how a call is tied to the
 *     variant it ran.
 *   - A row's `evidence` JSON may carry `requestRate`, `conversations`,
 *     `minConversations` and `outcome` (promoted, rolled_back, rejected). When it
 *     does, those win; when it does not, the figures are counted from the calls.
 */

import { z } from 'zod';
import type { Blackboard } from '../blackboard/client.js';
import type { playbookSchema } from './contract.js';
import type { CallFact } from './facts.js';
import { ratio, readJson, truncate } from './util.js';

type PlaybookView = z.infer<typeof playbookSchema>;

/** Section 11: no promotion decision before this many completed conversations. */
export const DEFAULT_MIN_CONVERSATIONS = 30;

const SLOT_LABELS: Record<string, string> = {
  hook: 'Hook',
  'value-statement': 'Value statement',
  objection: 'Objection handling',
  transition: 'Transition to the ask',
  'preference-request': 'Preference request'
};

const evidenceSchema = z
  .object({
    requestRate: z.number().optional(),
    conversations: z.number().optional(),
    minConversations: z.number().optional(),
    outcome: z.enum(['promoted', 'rolled_back', 'rejected']).optional()
  })
  .passthrough();

type Row = Awaited<ReturnType<Blackboard['playbook']['findMany']>>[number];

export function versionLabel(row: { slot: string; version: number }): string {
  return `${row.slot} v${row.version}`;
}

function summaryOf(row: Row): string {
  const label = SLOT_LABELS[row.slot] ?? row.slot;
  return `${label}: ${truncate(row.content, 220)}`;
}

function statsOf(row: Row, facts: CallFact[]): { requestRate: number; conversations: number; minConversations: number } {
  const evidence = readJson(row.evidence, evidenceSchema, {});
  const label = versionLabel(row);
  const mine = facts.filter((f) => f.variant === label && f.realConversation);
  const counted = { requestRate: ratio(mine.filter((f) => f.requested).length, mine.length), conversations: mine.length };
  return {
    requestRate: evidence.requestRate ?? counted.requestRate,
    conversations: evidence.conversations ?? counted.conversations,
    minConversations: evidence.minConversations ?? DEFAULT_MIN_CONVERSATIONS
  };
}

function historyOutcome(row: Row): PlaybookView['history'][number]['outcome'] {
  const evidence = readJson(row.evidence, evidenceSchema, {});
  if (row.status === 'challenger') return 'running';
  if (row.status === 'champion') return 'champion';
  // A retired version's fate is whatever Coach recorded; absent that, the safe
  // reading is that it did not win.
  return evidence.outcome ?? 'rejected';
}

export async function loadPlaybook(db: Blackboard, facts: CallFact[]): Promise<PlaybookView> {
  const rows = await db.playbook.findMany({ orderBy: [{ createdAt: 'desc' }, { version: 'desc' }] });
  const challenger = rows.find((r) => r.status === 'challenger') ?? null;
  const champions = rows.filter((r) => r.status === 'champion');

  // One slot is under test at a time, so the champion that matters is the one the
  // challenger is up against; with nothing under test, the newest champion.
  const champion =
    (challenger === null ? undefined : champions.find((r) => r.slot === challenger.slot)) ?? champions[0] ?? null;

  const answered = facts.filter((f) => f.realConversation);
  const baseline: PlaybookView['champion'] = {
    version: 'built-in script',
    summary: 'No playbook versions have been recorded yet, so Lexi is using the built-in script.',
    requestRate: ratio(answered.filter((f) => f.requested).length, answered.length),
    conversations: answered.length
  };

  return {
    champion:
      champion === null
        ? baseline
        : { version: versionLabel(champion), summary: summaryOf(champion), ...pick(statsOf(champion, facts)) },
    challenger:
      challenger === null
        ? null
        : { version: versionLabel(challenger), summary: summaryOf(challenger), ...statsOf(challenger, facts) },
    history: rows.slice(0, 12).map((r) => ({
      version: versionLabel(r),
      at: r.createdAt.toISOString(),
      note: r.rationale,
      outcome: historyOutcome(r)
    }))
  };
}

function pick(s: { requestRate: number; conversations: number }): { requestRate: number; conversations: number } {
  return { requestRate: s.requestRate, conversations: s.conversations };
}

/** Plain-English lines for the briefing: what Coach did to the playbook in the last day. */
export async function recentPlaybookChanges(db: Blackboard, now: Date): Promise<string[]> {
  const since = new Date(now.getTime() - 24 * 3_600_000);
  const rows = await db.playbook.findMany({ orderBy: { createdAt: 'desc' }, take: 40 });
  const lines: string[] = [];
  for (const row of rows) {
    const label = versionLabel(row);
    const evidence = readJson(row.evidence, z.object({ rolledBackAt: z.string().optional(), restoredAt: z.string().optional() }).passthrough(), {});
    if (evidence.rolledBackAt !== undefined && new Date(evidence.rolledBackAt) >= since) {
      lines.push(`${label} was rolled back.`);
    } else if (evidence.restoredAt !== undefined && new Date(evidence.restoredAt) >= since) {
      lines.push(`${label} was restored as the champion.`);
    } else if (row.createdAt >= since) {
      lines.push(
        row.status === 'challenger'
          ? `A new challenger, ${label}, started testing against the champion.`
          : row.status === 'champion'
            ? `${label} became the champion.`
            : `${label} was proposed and is retired.`
      );
    }
  }
  return lines;
}

/* ------------------------------------------------------------------ */
/* Rolling back                                                        */
/* ------------------------------------------------------------------ */

export interface RollbackPlan {
  slot: string;
  current: { id: string; version: number };
  previous: { id: string; version: number };
  /** A challenger running against the current champion, left running by a rollback. */
  challengerVersion: number | null;
}

/**
 * What "roll back to the previous script" would do, or why it cannot.
 *
 * The slot is the one whose champion changed most recently and has an earlier
 * version to return to. The version returned to is the newest retired one that
 * was not rejected or already rolled back: a version that lost its test is not
 * "the previous script".
 */
export async function planRollback(db: Blackboard): Promise<{ ok: true; plan: RollbackPlan } | { ok: false; why: string }> {
  const rows = await db.playbook.findMany({ orderBy: [{ createdAt: 'desc' }, { version: 'desc' }] });
  const champions = rows.filter((r) => r.status === 'champion');
  if (champions.length === 0) return { ok: false, why: 'There is no champion playbook version recorded, so there is nothing to roll back from.' };

  for (const current of champions) {
    const previous = rows.find((r) => {
      if (r.slot !== current.slot || r.status !== 'retired' || r.version >= current.version) return false;
      const outcome = readJson(r.evidence, evidenceSchema, {}).outcome;
      return outcome !== 'rejected' && outcome !== 'rolled_back';
    });
    if (previous === undefined) continue;
    const challenger = rows.find((r) => r.slot === current.slot && r.status === 'challenger');
    return {
      ok: true,
      plan: {
        slot: current.slot,
        current: { id: current.id, version: current.version },
        previous: { id: previous.id, version: previous.version },
        challengerVersion: challenger?.version ?? null
      }
    };
  }
  return { ok: false, why: 'No slot has an earlier version that was ever the champion, so there is no previous script to return to.' };
}

/** Flip the two rows in one transaction, or change nothing. */
export async function rollBackPlaybook(db: Blackboard, plan: RollbackPlan, at: Date): Promise<void> {
  const current = await db.playbook.findUnique({ where: { id: plan.current.id } });
  const previous = await db.playbook.findUnique({ where: { id: plan.previous.id } });
  if (current === null || previous === null || current.status !== 'champion' || previous.status !== 'retired') {
    throw new Error('the playbook changed since this was proposed, so nothing was rolled back');
  }
  const merge = (raw: string, extra: Record<string, unknown>): string =>
    JSON.stringify({ ...readJson(raw, z.record(z.unknown()), {}), ...extra });

  await db.$transaction([
    db.playbook.update({
      where: { id: current.id },
      data: { status: 'retired', evidence: merge(current.evidence, { outcome: 'rolled_back', rolledBackAt: at.toISOString(), rolledBackBy: 'console' }) }
    }),
    db.playbook.update({
      where: { id: previous.id },
      data: { status: 'champion', evidence: merge(previous.evidence, { outcome: undefined, restoredAt: at.toISOString(), restoredBy: 'console' }) }
    })
  ]);
}
