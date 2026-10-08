/**
 * The playbook store: versioned, diffable, reversible.
 *
 * One row per (slot, version) in the blackboard's `Playbook` table, and the rules
 * that keep that table honest:
 *
 *   - A version's content never changes. Status moves (challenger, champion,
 *     retired); the words do not. So "hook v3" means one thing for ever, and a
 *     call that ran it can always be read against what it said.
 *   - At most one champion per slot, and at most one challenger in the whole
 *     playbook: one slot is under test at a time (section 11 item 2).
 *   - A challenger starts only from a passing gate report. There is no way to put
 *     a variant into the store by handing it content.
 *   - A promotion, a withdrawal and a rollback each change every row they touch in
 *     one transaction, or none.
 *
 * The plain-English history ("what changed and why") lives alongside, as playbook
 * memory (section 3.5): one event row per change, written in the same transaction.
 *
 * The console reads this table (src/stream/playbook.ts) and relies on two of its
 * conventions, which are matched here: a version is named `<slot> v<n>` and that
 * name is what a call's `playbookVersion` holds; and a row's evidence may carry
 * `outcome` (promoted | rolled_back | rejected), `rolledBackAt` and `restoredAt`.
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Blackboard } from '../blackboard/client.js';
import { decode, encode, playbookStatusSchema } from '../blackboard/schemas.js';
import { BASELINE, BASELINE_NOTE } from './baseline.js';
import type { GateReport } from './gate.js';
import {
  PLAYBOOK_SLOTS,
  playbookContentSchema,
  versionName,
  parseVersionName,
  type PlaybookContent,
  type PlaybookSet,
  type PlaybookSlot,
  type SlotVersions
} from './schema.js';

type Db = Pick<Blackboard, 'playbook' | 'memory'>;

export class PlaybookError extends Error {}

export type PlaybookStatus = z.infer<typeof playbookStatusSchema>;

const evidenceSchema = z.record(z.unknown());
export type Evidence = Record<string, unknown>;

export interface VersionRecord {
  slot: PlaybookSlot;
  version: number;
  status: PlaybookStatus;
  content: PlaybookContent;
  /** Why this version exists, in plain English. The console shows it as the version's note. */
  rationale: string;
  evidence: Evidence;
  createdAt: Date;
}

export const EVENT_KINDS = [
  'seeded',
  'challenger-started',
  'promoted',
  'withdrawn',
  'retired',
  'rolled-back',
  'proposal-rejected'
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export interface HistoryEvent {
  id: string;
  at: Date;
  slot: PlaybookSlot;
  kind: EventKind;
  version: number | null;
  fromVersion: number | null;
  /** The change note: plain English. */
  note: string;
  detail: Record<string, unknown>;
}

const eventBodySchema = z.object({
  version: z.number().int().nullable(),
  fromVersion: z.number().int().nullable(),
  detail: z.record(z.unknown())
});

export interface PlaybookSnapshot {
  champions: PlaybookSet;
  championVersions: SlotVersions;
  /** The champion row created most recently: what the console labels a call with no test running. */
  newestChampion: { slot: PlaybookSlot; version: number } | null;
  challenger: { slot: PlaybookSlot; version: number; content: PlaybookContent } | null;
}

export interface Assignment {
  arm: 'champion' | 'challenger';
  /** The slot under test, or null when nothing is. */
  slot: PlaybookSlot | null;
  /** Every slot's version for this call. A slot missing here has no variable content. */
  versions: SlotVersions;
  /** What goes in `Call.playbookVersion`, named the way the console reads it. */
  variant: string | null;
}

const assignmentBodySchema = z.object({
  arm: z.enum(['champion', 'challenger']),
  slot: z.string().nullable(),
  versions: z.record(z.number().int()),
  variant: z.string().nullable()
});

function slotMatches(slot: string): slot is PlaybookSlot {
  return (PLAYBOOK_SLOTS as readonly string[]).includes(slot);
}

type PlaybookRow = Awaited<ReturnType<Db['playbook']['findMany']>>[number];

function toRecord(row: PlaybookRow): VersionRecord {
  if (!slotMatches(row.slot)) throw new PlaybookError(`playbook row ${row.id} has an unknown slot "${row.slot}"`);
  const content = decode(playbookContentSchema, 'Playbook.content', row.content);
  if (content.slot !== row.slot) {
    // A row whose content is for a different slot than its label is corrupt, and
    // it is the kind of corruption that would put the wrong words on a call.
    throw new PlaybookError(`playbook row ${row.id} is labelled "${row.slot}" but holds "${content.slot}" content`);
  }
  return {
    slot: row.slot,
    version: row.version,
    status: playbookStatusSchema.parse(row.status),
    content,
    rationale: row.rationale,
    evidence: decode(evidenceSchema, 'Playbook.evidence', row.evidence),
    createdAt: row.createdAt
  };
}

const rowId = (slot: PlaybookSlot, version: number): string => `pb-${slot}-v${version}`;

/**
 * A rolled-back or rejected version is not "the previous script". Same rule the
 * console's own rollback uses, so the two cannot disagree about what to return to.
 */
function wasEverChampion(record: VersionRecord): boolean {
  const outcome = record.evidence.outcome;
  return record.status === 'retired' && outcome !== 'rejected' && outcome !== 'rolled_back';
}

export class PlaybookStore {
  constructor(
    private readonly db: Blackboard,
    private readonly now: () => Date = () => new Date()
  ) {}

  /* -------------------------------------------------------------- */
  /* Reading                                                        */
  /* -------------------------------------------------------------- */

  async versions(slot: PlaybookSlot): Promise<VersionRecord[]> {
    const rows = await this.db.playbook.findMany({ where: { slot }, orderBy: { version: 'asc' } });
    return rows.map(toRecord);
  }

  async get(slot: PlaybookSlot, version: number): Promise<VersionRecord | null> {
    const row = await this.db.playbook.findUnique({ where: { slot_version: { slot, version } } });
    return row === null ? null : toRecord(row);
  }

  async champion(slot: PlaybookSlot): Promise<VersionRecord | null> {
    const row = await this.db.playbook.findFirst({ where: { slot, status: 'champion' } });
    return row === null ? null : toRecord(row);
  }

  /** The one challenger running anywhere, or null. */
  async liveChallenger(): Promise<VersionRecord | null> {
    const row = await this.db.playbook.findFirst({ where: { status: 'challenger' } });
    return row === null ? null : toRecord(row);
  }

  async snapshot(): Promise<PlaybookSnapshot> {
    const rows = await this.db.playbook.findMany({
      where: { status: { in: ['champion', 'challenger'] } },
      orderBy: [{ createdAt: 'desc' }, { version: 'desc' }]
    });
    const champions: PlaybookSet = {};
    const championVersions: SlotVersions = {};
    let newestChampion: PlaybookSnapshot['newestChampion'] = null;
    let challenger: PlaybookSnapshot['challenger'] = null;

    for (const row of rows) {
      const record = toRecord(row);
      if (record.status === 'champion') {
        (champions as Record<string, PlaybookContent>)[record.slot] = record.content;
        championVersions[record.slot] = record.version;
        newestChampion ??= { slot: record.slot, version: record.version };
      } else {
        challenger = { slot: record.slot, version: record.version, content: record.content };
      }
    }
    return { champions, championVersions, newestChampion, challenger };
  }

  async history(slot?: PlaybookSlot, limit = 100): Promise<HistoryEvent[]> {
    const rows = await this.db.memory.findMany({
      where: { scope: 'playbook', kind: { in: [...EVENT_KINDS] }, ...(slot !== undefined ? { key: slot } : {}) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit
    });
    return rows
      .map((row) => {
        const body = decode(eventBodySchema, 'Memory.content', row.content);
        return {
          id: row.id,
          at: row.createdAt,
          slot: row.key as PlaybookSlot,
          kind: row.kind as EventKind,
          version: body.version,
          fromVersion: body.fromVersion,
          note: row.summary,
          detail: body.detail
        };
      })
      .reverse();
  }

  /* -------------------------------------------------------------- */
  /* Writing                                                        */
  /* -------------------------------------------------------------- */

  /**
   * Version 1 of every slot that has a baseline and no versions yet. Idempotent.
   * Returns the slots it seeded.
   */
  async ensureBaseline(): Promise<PlaybookSlot[]> {
    const seeded: PlaybookSlot[] = [];
    for (const slot of PLAYBOOK_SLOTS) {
      const content = BASELINE[slot];
      if (content === undefined) continue;
      await this.db.$transaction(async (tx) => {
        if ((await tx.playbook.count({ where: { slot } })) > 0) return;
        const at = this.now();
        await tx.playbook.create({
          data: {
            id: rowId(slot, 1),
            slot,
            version: 1,
            status: 'champion',
            content: encode(playbookContentSchema, 'Playbook.content', content),
            rationale: BASELINE_NOTE,
            evidence: JSON.stringify({ seededAt: at.toISOString() }),
            createdAt: at
          }
        });
        await this.writeEvent(tx, slot, 'seeded', 1, null, `${versionName(slot, 1)} seeded as the starting champion.`, {}, at);
        seeded.push(slot);
      });
    }
    return seeded;
  }

  /**
   * Start a challenger from a variant that passed the gate. The report is the only
   * way in: there is no overload that takes bare content.
   */
  async startChallenger(report: GateReport, meta: { rationale: string; evidence?: Evidence }): Promise<VersionRecord> {
    if (report.verdict !== 'pass' || report.content === null) {
      throw new PlaybookError('a challenger can only be started from a variant that passed the promotion gate');
    }
    const content = report.content;
    const slot = content.slot;

    return this.db.$transaction(async (tx) => {
      const live = await tx.playbook.findFirst({ where: { status: 'challenger' } });
      if (live !== null) {
        throw new PlaybookError(`${versionName(live.slot as PlaybookSlot, live.version)} is already running; one slot is tested at a time`);
      }
      const latest = await tx.playbook.aggregate({ where: { slot }, _max: { version: true } });
      const version = (latest._max.version ?? 0) + 1;
      const at = this.now();

      const row = await tx.playbook.create({
        data: {
          id: rowId(slot, version),
          slot,
          version,
          status: 'challenger',
          content: encode(playbookContentSchema, 'Playbook.content', content),
          rationale: meta.rationale,
          evidence: JSON.stringify({
            ...meta.evidence,
            startedAt: at.toISOString(),
            gate: report.stages.map((s) => ({ stage: s.stage, status: s.status }))
          }),
          createdAt: at
        }
      });
      await this.writeEvent(tx, slot, 'challenger-started', version, null, meta.rationale, meta.evidence ?? {}, at);
      return toRecord(row);
    });
  }

  /** Make a running challenger the champion, retiring the one it replaces. */
  async promote(
    slot: PlaybookSlot,
    version: number,
    meta: { note: string; evidence?: Evidence }
  ): Promise<{ promoted: VersionRecord; replaced: VersionRecord | null }> {
    return this.db.$transaction(async (tx) => {
      const challenger = await tx.playbook.findUnique({ where: { slot_version: { slot, version } } });
      if (challenger === null || challenger.status !== 'challenger') {
        throw new PlaybookError(`${versionName(slot, version)} is not a running challenger, so it cannot be promoted`);
      }
      const at = this.now();
      const current = await tx.playbook.findFirst({ where: { slot, status: 'champion' } });

      let replaced: VersionRecord | null = null;
      if (current !== null) {
        await tx.playbook.update({
          where: { id: current.id },
          data: {
            status: 'retired',
            // The console's own enum has no "former champion"; `promoted` is the
            // closest, and it is what keeps this version eligible to return to.
            evidence: this.merged(current.evidence, { outcome: 'promoted', retiredAt: at.toISOString(), replacedBy: version })
          }
        });
        replaced = toRecord({ ...current, status: 'retired', evidence: this.merged(current.evidence, { outcome: 'promoted' }) });
      }

      const updated = await tx.playbook.update({
        where: { id: challenger.id },
        data: {
          status: 'champion',
          evidence: this.merged(challenger.evidence, {
            ...meta.evidence,
            outcome: 'promoted',
            promotedAt: at.toISOString(),
            previousVersion: current?.version ?? null
          })
        }
      });
      await this.writeEvent(tx, slot, 'promoted', version, current?.version ?? null, meta.note, meta.evidence ?? {}, at);
      return { promoted: toRecord(updated), replaced };
    });
  }

  /**
   * Take a running challenger out of play without promoting it: `withdrawn` when
   * it regressed, `retired` when the test was inconclusive. Its calls return to
   * the champion at once, because assignment reads this table.
   */
  async retireChallenger(
    slot: PlaybookSlot,
    version: number,
    meta: { kind: 'withdrawn' | 'retired'; note: string; evidence?: Evidence }
  ): Promise<VersionRecord> {
    return this.db.$transaction(async (tx) => {
      const row = await tx.playbook.findUnique({ where: { slot_version: { slot, version } } });
      if (row === null || row.status !== 'challenger') {
        throw new PlaybookError(`${versionName(slot, version)} is not a running challenger`);
      }
      const at = this.now();
      const updated = await tx.playbook.update({
        where: { id: row.id },
        data: {
          status: 'retired',
          evidence: this.merged(row.evidence, { ...meta.evidence, outcome: 'rejected', [`${meta.kind}At`]: at.toISOString() })
        }
      });
      await this.writeEvent(tx, slot, meta.kind, version, null, meta.note, meta.evidence ?? {}, at);
      return toRecord(updated);
    });
  }

  /**
   * Put the previous champion back. With no `toVersion`, the newest earlier version
   * that was ever the champion; with one, that version, if it ever was. A
   * challenger running against the champion being rolled back is retired in the
   * same step: its test was against something that is no longer there.
   */
  async rollback(
    slot: PlaybookSlot,
    meta: { note: string; toVersion?: number; evidence?: Evidence }
  ): Promise<{ from: VersionRecord; to: VersionRecord }> {
    return this.db.$transaction(async (tx) => {
      const currentRow = await tx.playbook.findFirst({ where: { slot, status: 'champion' } });
      if (currentRow === null) throw new PlaybookError(`${slot} has no champion to roll back from`);
      const current = toRecord(currentRow);

      const earlier = (await tx.playbook.findMany({ where: { slot, status: 'retired' }, orderBy: { version: 'desc' } })).map(toRecord);
      const target =
        meta.toVersion !== undefined
          ? earlier.find((r) => r.version === meta.toVersion)
          : earlier.find((r) => r.version < current.version && wasEverChampion(r));

      if (target === undefined) {
        throw new PlaybookError(
          meta.toVersion !== undefined
            ? `${versionName(slot, meta.toVersion)} is not a retired version of ${slot}`
            : `${slot} has no earlier version that was ever the champion, so there is nothing to return to`
        );
      }
      if (!wasEverChampion(target)) {
        throw new PlaybookError(`${versionName(slot, target.version)} never became the champion (${String(target.evidence.outcome)}), so it is not a script to return to`);
      }

      const at = this.now();
      const challenger = await tx.playbook.findFirst({ where: { slot, status: 'challenger' } });
      if (challenger !== null) {
        await tx.playbook.update({
          where: { id: challenger.id },
          data: {
            status: 'retired',
            evidence: this.merged(challenger.evidence, {
              outcome: 'rejected',
              retiredAt: at.toISOString(),
              retiredBecause: 'the champion it was being tested against was rolled back'
            })
          }
        });
        await this.writeEvent(tx, slot, 'retired', challenger.version, null, `${versionName(slot, challenger.version)} was stopped because its champion was rolled back.`, {}, at);
      }

      await tx.playbook.update({
        where: { slot_version: { slot, version: current.version } },
        data: {
          status: 'retired',
          evidence: JSON.stringify({
            ...current.evidence,
            outcome: 'rolled_back',
            rolledBackAt: at.toISOString(),
            rolledBackBy: 'coach',
            ...meta.evidence
          })
        }
      });
      const restoredEvidence: Evidence = { ...target.evidence, restoredAt: at.toISOString(), restoredBy: 'coach' };
      delete restoredEvidence.outcome;
      const restored = await tx.playbook.update({
        where: { slot_version: { slot, version: target.version } },
        data: { status: 'champion', evidence: JSON.stringify(restoredEvidence) }
      });
      await this.writeEvent(tx, slot, 'rolled-back', target.version, current.version, meta.note, meta.evidence ?? {}, at);

      return { from: { ...current, status: 'retired' }, to: toRecord(restored) };
    });
  }

  /** A variant the gate refused, kept on the record with its reasons. Creates no version. */
  async recordRejection(slot: PlaybookSlot, note: string, detail: Record<string, unknown>): Promise<void> {
    await this.db.$transaction(async (tx) => {
      await this.writeEvent(tx, slot, 'proposal-rejected', null, null, note, detail, this.now());
    });
  }

  /** Add to a row's evidence. The only mutation a version's row allows besides its status. */
  async mergeEvidence(slot: PlaybookSlot, version: number, patch: Evidence): Promise<void> {
    await this.db.$transaction(async (tx) => {
      const row = await tx.playbook.findUnique({ where: { slot_version: { slot, version } } });
      if (row === null) throw new PlaybookError(`${versionName(slot, version)} does not exist`);
      await tx.playbook.update({ where: { id: row.id }, data: { evidence: this.merged(row.evidence, patch) } });
    });
  }

  /* -------------------------------------------------------------- */
  /* Assignment                                                     */
  /* -------------------------------------------------------------- */

  /**
   * Which arm a call gets, and which versions it runs with.
   *
   * A hash of the call's key, not a coin flip, so the same call always gets the
   * same arm however many times it is asked - a retried webhook cannot move a call
   * from one arm to the other.
   */
  assign(callKey: string, snapshot: PlaybookSnapshot, challengerShare: number): Assignment {
    const { challenger } = snapshot;
    const draw = createHash('sha256').update(callKey).digest().readUInt32BE(0) / 2 ** 32;
    const challenged = challenger !== null && draw < challengerShare;

    const versions: SlotVersions = { ...snapshot.championVersions };
    if (challenger !== null && challenged) versions[challenger.slot] = challenger.version;

    const testSlot = challenger?.slot ?? null;
    const tested = testSlot === null ? undefined : versions[testSlot];
    const headline =
      testSlot !== null && tested !== undefined
        ? { slot: testSlot, version: tested }
        : snapshot.newestChampion;

    return {
      arm: challenged ? 'challenger' : 'champion',
      slot: testSlot,
      versions,
      variant: headline === null ? null : versionName(headline.slot, headline.version)
    };
  }

  /** The content a call runs with: the champions, with the challenger swapped in where it was assigned. */
  resolve(assignment: Assignment, snapshot: PlaybookSnapshot): PlaybookSet {
    const set: PlaybookSet = { ...snapshot.champions };
    const { challenger } = snapshot;
    if (assignment.arm === 'challenger' && challenger !== null) {
      (set as Record<string, PlaybookContent>)[challenger.slot] = challenger.content;
    }
    return set;
  }

  /**
   * Write an assignment against a call: the console-readable name on the call, and
   * the full version set as playbook memory, so what the call ran with is never
   * reconstructed from a name alone. Idempotent per call.
   */
  async recordAssignment(callId: string, assignment: Assignment): Promise<void> {
    await this.db.call.update({ where: { id: callId }, data: { playbookVersion: assignment.variant } });
    const body = encode(assignmentBodySchema, 'Memory.content', assignment);
    const id = `pb-assign-${callId}`;
    await this.db.memory.upsert({
      where: { id },
      create: {
        id,
        scope: 'playbook',
        key: callId,
        kind: 'assignment',
        summary: `${assignment.arm} arm${assignment.variant === null ? '' : `: ${assignment.variant}`}`,
        content: body,
        createdAt: this.now()
      },
      update: { content: body }
    });
  }

  /* -------------------------------------------------------------- */
  /* Internals                                                      */
  /* -------------------------------------------------------------- */

  private merged(existing: string, patch: Evidence): string {
    return JSON.stringify({ ...decode(evidenceSchema, 'Playbook.evidence', existing), ...patch });
  }

  private async writeEvent(
    db: Db,
    slot: PlaybookSlot,
    kind: EventKind,
    version: number | null,
    fromVersion: number | null,
    note: string,
    detail: Record<string, unknown>,
    at: Date
  ): Promise<void> {
    const count = await db.memory.count({ where: { scope: 'playbook', key: slot, kind: { in: [...EVENT_KINDS] } } });
    await db.memory.create({
      data: {
        // Sequenced per slot. A collision is a primary-key error, which fails the
        // whole transaction: a lost event is worse than a refused change.
        id: `pb-evt-${slot}-${String(count + 1).padStart(6, '0')}`,
        scope: 'playbook',
        key: slot,
        kind,
        summary: note,
        content: encode(eventBodySchema, 'Memory.content', { version, fromVersion, detail }),
        createdAt: at
      }
    });
  }
}

/** The assignment recorded against a call, or null if it has none. */
export async function readAssignment(db: Pick<Blackboard, 'memory'>, callId: string): Promise<Assignment | null> {
  const row = await db.memory.findUnique({ where: { id: `pb-assign-${callId}` } });
  if (row === null) return null;
  const body = decode(assignmentBodySchema, 'Memory.content', row.content);
  const versions: SlotVersions = {};
  for (const [slot, version] of Object.entries(body.versions)) {
    if (slotMatches(slot)) versions[slot] = version;
  }
  return {
    arm: body.arm,
    slot: body.slot !== null && slotMatches(body.slot) ? body.slot : null,
    versions,
    variant: body.variant
  };
}

export { parseVersionName };
