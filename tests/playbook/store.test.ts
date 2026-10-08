import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestBlackboard, type Blackboard } from '../../src/blackboard/client.js';
import { diffContent, diffWords, renderDiff } from '../../src/playbook/diff.js';
import { FailureMemory, contentText, similarity, variantKey } from '../../src/playbook/failure-memory.js';
import { preflightVariant } from '../../src/playbook/gate.js';
import type { PlaybookContent } from '../../src/playbook/schema.js';
import { PlaybookError, PlaybookStore, readAssignment } from '../../src/playbook/store.js';
import { addCall, claimIndex, GOOD_HOOK, passed, reviewer, simulator, world } from './support.js';

let db: Blackboard;
let clock: Date;
let store: PlaybookStore;

const HOOK_V2: PlaybookContent = { slot: 'hook', template: 'I was looking at {{company}} and noticed this: {{hook}}.' };
const HOOK_V3: PlaybookContent = { slot: 'hook', template: 'Something caught my eye about {{company}}: {{hook}}.' };

beforeEach(async () => {
  db = await createTestBlackboard();
  clock = new Date('2026-10-01T00:00:00.000Z');
  store = new PlaybookStore(db, () => {
    clock = new Date(clock.getTime() + 1000);
    return clock;
  });
});
afterEach(async () => {
  await db.$disconnect();
});

describe('the baseline', () => {
  it('seeds version 1 of every slot that can honestly have one, once', async () => {
    expect((await store.ensureBaseline()).sort()).toEqual(['hook', 'objection', 'preference-request', 'transition']);
    expect(await store.ensureBaseline()).toEqual([]);
    const snap = await store.snapshot();
    expect(snap.championVersions).toEqual({ hook: 1, transition: 1, 'preference-request': 1, objection: 1 });
    expect(snap.champions['value-statement']).toBeUndefined();
    expect(snap.challenger).toBeNull();
  });
});

describe('challengers', () => {
  beforeEach(async () => {
    await store.ensureBaseline();
  });

  it('start only from a passing gate report', async () => {
    const rejected = await preflightVariant({ ...HOOK_V2, opening: [] }, {
      claims: claimIndex(), markets: ['AU', 'NZ'], reviewer: reviewer(), proposerInstanceId: 'p', simulator: simulator(), champions: {}
    });
    await expect(store.startChallenger(rejected, { rationale: 'x' })).rejects.toThrow(/passed the promotion gate/);
    expect(await store.liveChallenger()).toBeNull();
  });

  it('are one at a time, versioned per slot, with their words never changing', async () => {
    const started = await store.startChallenger(await passed(HOOK_V2), { rationale: 'Trying a plainer hook.' });
    expect(started).toMatchObject({ slot: 'hook', version: 2, status: 'challenger' });
    expect(started.evidence.gate).toBeDefined();

    await expect(store.startChallenger(await passed(HOOK_V3), { rationale: 'And another.' })).rejects.toThrow(/already running/);

    await store.retireChallenger('hook', 2, { kind: 'withdrawn', note: 'no good' });
    const third = await store.startChallenger(await passed(HOOK_V3), { rationale: 'Another go.' });
    expect(third.version).toBe(3);
    expect((await store.get('hook', 2))?.content).toEqual(HOOK_V2);
    expect((await store.get('hook', 1))?.status).toBe('champion');
  });

  it('promote atomically, retiring the champion they replace', async () => {
    await store.startChallenger(await passed(HOOK_V2), { rationale: 'Plainer.' });
    const { promoted, replaced } = await store.promote('hook', 2, { note: 'hook v2 won', evidence: { requestRate: 0.2 } });
    expect(promoted.status).toBe('champion');
    expect(promoted.evidence).toMatchObject({ outcome: 'promoted', previousVersion: 1, requestRate: 0.2 });
    expect(replaced?.version).toBe(1);

    const versions = await store.versions('hook');
    expect(versions.map((v) => v.status)).toEqual(['retired', 'champion']);
    expect(versions.filter((v) => v.status === 'champion')).toHaveLength(1);
    await expect(store.promote('hook', 2, { note: 'again' })).rejects.toThrow(PlaybookError);
  });

  it('can be the first version of a slot that had none', async () => {
    const value: PlaybookContent = { slot: 'value-statement', template: '{{claim:company.ownership}} Worth a short chat?' };
    await store.startChallenger(await passed(value), { rationale: 'First value statement.' });
    const { replaced } = await store.promote('value-statement', 1, { note: 'first' });
    expect(replaced).toBeNull();
  });

  it('retiring one that is not running is an error', async () => {
    await expect(store.retireChallenger('hook', 1, { kind: 'retired', note: 'x' })).rejects.toThrow(/not a running challenger/);
    await expect(store.mergeEvidence('hook', 99, {})).rejects.toThrow(/does not exist/);
  });
});

describe('rollback', () => {
  beforeEach(async () => {
    await store.ensureBaseline();
    await store.startChallenger(await passed(HOOK_V2), { rationale: 'v2' });
    await store.promote('hook', 2, { note: 'v2 won' });
  });

  it('puts the previous champion back, and keeps both histories', async () => {
    const plan = await store.planRollback('hook');
    expect([plan.current.version, plan.target.version]).toEqual([2, 1]);

    const { from, to } = await store.rollback('hook', { note: 'rolled back' });
    expect([from.version, to.version]).toEqual([2, 1]);
    const versions = await store.versions('hook');
    expect(versions.map((v) => v.status)).toEqual(['champion', 'retired']);
    expect(versions[1]?.evidence).toMatchObject({ outcome: 'rolled_back' });
    expect(versions[0]?.evidence.restoredAt).toBeDefined();
    expect(versions[0]?.evidence.outcome).toBeUndefined();

    // v2 was rolled back, so it is not "the previous script": a second rollback has nowhere to go.
    await expect(store.rollback('hook', { note: 'again' })).rejects.toThrow(/nothing to return to/);
    // And the console-compatible rule lets it be named explicitly only if it ever won; this one was rolled back.
    await expect(store.rollback('hook', { note: 'x', toVersion: 2 })).rejects.toThrow(/no champion|never became|not a retired/);
  });

  it('retires a challenger that was being tested against the champion it rolls back', async () => {
    await store.startChallenger(await passed(HOOK_V3), { rationale: 'v3' });
    await store.rollback('hook', { note: 'rolled back' });
    expect(await store.liveChallenger()).toBeNull();
    expect((await store.get('hook', 3))?.evidence).toMatchObject({ outcome: 'rejected' });
  });

  it('refuses to restore a version that never won, or a slot with no champion', async () => {
    await store.startChallenger(await passed(HOOK_V3), { rationale: 'v3' });
    await store.retireChallenger('hook', 3, { kind: 'withdrawn', note: 'lost' });
    await expect(store.rollback('hook', { note: 'x', toVersion: 3 })).rejects.toThrow(/never became the champion/);
    await expect(store.rollback('value-statement', { note: 'x' })).rejects.toThrow(/no champion/);
    await expect(store.rollback('hook', { note: 'x', toVersion: 9 })).rejects.toThrow(/not a retired version/);
  });

  it('can name the version to return to', async () => {
    await store.startChallenger(await passed(HOOK_V3), { rationale: 'v3' });
    await store.promote('hook', 3, { note: 'v3 won' });
    const { to } = await store.rollback('hook', { note: 'back to the start', toVersion: 1 });
    expect(to.version).toBe(1);
  });
});

describe('history', () => {
  it('is a plain-English record of every change, in order, including rejections', async () => {
    await store.ensureBaseline();
    await store.startChallenger(await passed(HOOK_V2), { rationale: 'Plainer hook.' });
    await store.recordRejection('hook', 'A hook variant was rejected: it pushed.', { failedAt: 'linter' });
    await store.promote('hook', 2, { note: 'hook v2 was promoted.' });
    await store.rollback('hook', { note: 'hook v2 was rolled back.' });

    const events = await store.history('hook');
    expect(events.map((e) => e.kind)).toEqual(['seeded', 'challenger-started', 'proposal-rejected', 'promoted', 'rolled-back']);
    expect(events.map((e) => e.note)).toContain('Plainer hook.');
    expect(events[3]).toMatchObject({ version: 2, fromVersion: 1 });
    expect(events[4]).toMatchObject({ version: 1, fromVersion: 2 });
    expect((await store.history()).length).toBeGreaterThan(events.length);
  });
});

describe('assignment', () => {
  beforeEach(async () => {
    await store.ensureBaseline();
    await store.startChallenger(await passed(HOOK_V2), { rationale: 'v2' });
  });

  it('is a function of the call, so a retried call cannot change arm', async () => {
    const snap = await store.snapshot();
    const first = store.assign('call-123', snap, 0.5);
    for (let i = 0; i < 5; i++) expect(store.assign('call-123', snap, 0.5)).toEqual(first);
  });

  it('splits near the configured share and labels the call the way the console reads it', async () => {
    const snap = await store.snapshot();
    const arms = Array.from({ length: 2000 }, (_, i) => store.assign(`call-${i}`, snap, 0.5));
    const challenger = arms.filter((a) => a.arm === 'challenger');
    expect(challenger.length).toBeGreaterThan(900);
    expect(challenger.length).toBeLessThan(1100);
    expect(challenger[0]).toMatchObject({ slot: 'hook', variant: 'hook v2' });
    expect(challenger[0]?.versions).toEqual({ hook: 2, transition: 1, 'preference-request': 1, objection: 1 });
    const champion = arms.find((a) => a.arm === 'champion');
    expect(champion).toMatchObject({ slot: 'hook', variant: 'hook v1' });
    expect(champion?.versions.hook).toBe(1);
  });

  it('gives everyone the champion when nothing is under test, labelled with the newest champion', async () => {
    await store.retireChallenger('hook', 2, { kind: 'retired', note: 'done' });
    const snap = await store.snapshot();
    const a = store.assign('call-1', snap, 1);
    expect(a).toMatchObject({ arm: 'champion', slot: null });
    expect(a.variant).toMatch(/ v1$/);
    const empty = new PlaybookStore(await createTestBlackboard()).assign('x', { champions: {}, championVersions: {}, newestChampion: null, challenger: null }, 0.5);
    expect(empty).toMatchObject({ arm: 'champion', variant: null, versions: {} });
  });

  it('resolves to the content the call ran with, and records it on the call', async () => {
    const snap = await store.snapshot();
    const w = await world(db);
    const callId = await addCall(db, w, { at: new Date('2026-10-02T00:00:00Z') });
    const asg = store.assign('forced-challenger', snap, 1);
    expect(store.resolve(asg, snap).hook).toEqual(HOOK_V2);
    expect(store.resolve({ ...asg, arm: 'champion' }, snap).hook).toEqual((await store.get('hook', 1))?.content);

    await store.recordAssignment(callId, asg);
    await store.recordAssignment(callId, asg);
    expect((await db.call.findUnique({ where: { id: callId } }))?.playbookVersion).toBe('hook v2');
    expect(await readAssignment(db, callId)).toEqual(asg);
    expect(await readAssignment(db, 'nope')).toBeNull();
    expect(await db.memory.count({ where: { scope: 'playbook', kind: 'assignment' } })).toBe(1);
  });
});

describe('diffs and failure memory', () => {
  it('diffs words, and shows a first version as all additions', () => {
    expect(renderDiff(diffContent(GOOD_HOOK, HOOK_V2))).toContain('[-');
    expect(diffWords('a b c', 'a x c')).toEqual([
      { type: 'same', text: 'a' },
      { type: 'del', text: 'b' },
      { type: 'add', text: 'x' },
      { type: 'same', text: 'c' }
    ]);
    expect(diffContent(null, HOOK_V2)[0]?.ops.every((o) => o.type === 'add')).toBe(true);
    const objection: PlaybookContent = { slot: 'objection', responses: { other: 'Fair enough, thanks for saying so.' } };
    expect(diffContent(objection, { slot: 'objection', responses: { 'no-budget': 'Understood, and thanks for that.' } }).map((d) => d.field).sort()).toEqual([
      'responses.no-budget',
      'responses.other'
    ]);
  });

  it('remembers failures, counts repeats, and recognises the same idea in other words', async () => {
    const memory = new FailureMemory(db, () => clock);
    await memory.record({ kind: 'variant-rejected', key: variantKey(HOOK_V2), slot: 'hook', summary: 'rejected at linter', text: contentText(HOOK_V2) });
    const again = await memory.record({ kind: 'variant-rejected', key: variantKey(HOOK_V2), slot: 'hook', summary: 'rejected again' });
    expect(again.count).toBe(2);
    expect(again.text).toBe(contentText(HOOK_V2));

    expect((await memory.priorFailureOf(HOOK_V2))?.kind).toBe('variant-rejected');
    expect(await memory.priorFailureOf(HOOK_V3)).toBeNull();
    const nearCopy: PlaybookContent = { slot: 'hook', template: 'I was looking at {{company}} and noticed this thing: {{hook}}.' };
    expect(await memory.priorFailureOf(nearCopy)).not.toBeNull();
    expect(await memory.priorFailureOf({ slot: 'transition', template: contentText(HOOK_V2) + ' ok ok' })).toBeNull();

    expect(await memory.recentVariantFailure('hook', new Date('2026-09-01'))).not.toBeNull();
    expect(await memory.recentVariantFailure('hook', new Date('2027-01-01'))).toBeNull();
    expect(await memory.recentVariantFailure('transition', new Date('2026-09-01'))).toBeNull();
    expect((await memory.list(['hook-died'])).length).toBe(0);
    expect(similarity('', '')).toBe(1);
  });
});
