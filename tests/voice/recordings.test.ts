/**
 * Recordings: encrypted at rest, deleted on schedule, deleted at once on an
 * objection - and the purge picks the right ones and only those.
 */

import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Blackboard } from '../../src/blackboard/client.js';
import { CallStore, type RecordingMeta } from '../../src/voice/call-store.js';
import { ProviderRejectedError } from '../../src/voice/provider.js';
import {
  EncryptedFileRecordingStore,
  archiveRecording,
  formatPurgeReport,
  parseEncryptionKey,
  planPurge,
  runPurge,
  type PurgeCandidate,
  type RecordingStore
} from '../../src/voice/recordings.js';
import { fakeFetch, seedContact, world, type World } from './support.js';

const KEY = Buffer.alloc(32, 7);
const NOW = new Date('2026-10-13T02:00:00Z');
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000);

let dirs: string[] = [];
let worlds: World[] = [];
afterEach(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
  for (const w of worlds) await w.close();
  dirs = [];
  worlds = [];
});
const tmp = async () => {
  const d = await mkdtemp(join(tmpdir(), 'rec-'));
  dirs.push(d);
  return d;
};

describe('the encrypted store', () => {
  it('round-trips audio, and what is on disk is not the audio', async () => {
    const dir = await tmp();
    const store = new EncryptedFileRecordingStore(dir, KEY);
    const audio = Buffer.from('RIFF....this is pretend audio that someone said a name in....');

    const stored = await store.put('call-1', audio, 'wav');
    expect(stored).toMatchObject({ location: 'call-1.wav.enc', bytes: audio.length, encrypted: true });
    expect(stored.sha256).toMatch(/^[0-9a-f]{64}$/);

    const onDisk = await readFile(join(dir, stored.location));
    expect(onDisk.includes(Buffer.from('pretend audio'))).toBe(false);
    expect((await store.get(stored.location)).equals(audio)).toBe(true);
  });

  it('will not decrypt with another key', async () => {
    const dir = await tmp();
    const stored = await new EncryptedFileRecordingStore(dir, KEY).put('call-1', Buffer.from('audio'), 'mp3');
    await expect(new EncryptedFileRecordingStore(dir, Buffer.alloc(32, 9)).get(stored.location)).rejects.toThrow();
  });

  it('will not decrypt a file that has been moved under another call\'s name', async () => {
    const dir = await tmp();
    const store = new EncryptedFileRecordingStore(dir, KEY);
    const stored = await store.put('call-1', Buffer.from('audio'), 'mp3');
    await copyFile(join(dir, stored.location), join(dir, 'call-2.mp3.enc'));
    await expect(store.get('call-2.mp3.enc')).rejects.toThrow();
  });

  it('rejects tampering and anything that is not one of its files', async () => {
    const dir = await tmp();
    const store = new EncryptedFileRecordingStore(dir, KEY);
    const stored = await store.put('call-1', Buffer.from('audio that matters'), 'mp3');
    const bytes = await readFile(join(dir, stored.location));
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] as number) ^ 0xff;
    await writeFile(join(dir, stored.location), bytes);
    await expect(store.get(stored.location)).rejects.toThrow();

    await writeFile(join(dir, 'call-3.mp3.enc'), 'plain text');
    await expect(store.get('call-3.mp3.enc')).rejects.toThrow(/not an encrypted recording/);
    await expect(store.get('../../etc/passwd')).rejects.toThrow(/not a recording location/);
    await expect(store.put('../escape', Buffer.from('x'), 'mp3')).rejects.toThrow(/not a usable call id/);
  });

  it('deletes, and says whether there was anything to delete', async () => {
    const dir = await tmp();
    const store = new EncryptedFileRecordingStore(dir, KEY);
    const stored = await store.put('call-1', Buffer.from('audio'), 'mp3');
    expect(await store.delete(stored.location)).toBe(true);
    expect(await store.delete(stored.location)).toBe(false);
    expect(await readdir(dir)).toEqual([]);
  });

  it('insists on a 256-bit key', () => {
    expect(() => parseEncryptionKey('abc')).toThrow(/64 hex/);
    expect(() => parseEncryptionKey('zz'.repeat(32))).toThrow(/64 hex/);
    expect(parseEncryptionKey('ab'.repeat(32))).toHaveLength(32);
    expect(() => new EncryptedFileRecordingStore('/x', Buffer.alloc(16))).toThrow(/32 bytes/);
  });
});

describe('archiving a recording from the provider', () => {
  const fake = new EncryptedFileRecordingStore('/unused', KEY);
  const adapter = { artifactHeaders: (url: URL) => (url.hostname.endsWith('.vapi.ai') ? { authorization: 'Bearer k' } : {}) };

  it('downloads it and stores it, sending credentials only to the provider', async () => {
    const dir = await tmp();
    const store = new EncryptedFileRecordingStore(dir, KEY);
    const fetchImpl = fakeFetch(() => ({ text: 'AUDIO-BYTES' }));
    const stored = await archiveRecording({ store, adapter, fetch: fetchImpl }, 'call-1', 'https://storage.vapi.ai/rec.mp3');
    expect(stored.location).toBe('call-1.mp3.enc');
    expect((await store.get(stored.location)).toString()).toBe('AUDIO-BYTES');
    expect(fetchImpl.calls[0]?.headers.authorization).toBe('Bearer k');

    const other = fakeFetch(() => ({ text: 'x' }));
    await archiveRecording({ store, adapter, fetch: other }, 'call-2', 'https://cdn.example.com/rec.mp3');
    expect(other.calls[0]?.headers.authorization).toBeUndefined();
  });

  it('refuses plain http, a failed download, and an empty file', async () => {
    await expect(archiveRecording({ store: fake, adapter, fetch: fakeFetch(() => ({ text: 'x' })) }, 'c', 'http://storage.vapi.ai/r.mp3')).rejects.toThrow(/https/);
    await expect(archiveRecording({ store: fake, adapter, fetch: fakeFetch(() => ({ status: 403 })) }, 'c', 'https://storage.vapi.ai/r.mp3')).rejects.toThrow(/403/);
    await expect(archiveRecording({ store: fake, adapter, fetch: fakeFetch(() => ({ text: '' })) }, 'c', 'https://storage.vapi.ai/r.mp3')).rejects.toThrow(/empty/);
  });
});

/* ------------------------------------------------------------------ */

const candidate = (over: Partial<PurgeCandidate> & { recording?: RecordingMeta }): PurgeCandidate => ({
  callId: 'c',
  providerCallId: 'p',
  endedAt: daysAgo(1),
  recordingUrl: 'https://storage.vapi.ai/r.mp3',
  recording: {},
  ...over
});

describe('which recordings are due', () => {
  it('only those that ended more than the retention period ago', () => {
    const due = planPurge(
      [
        candidate({ callId: 'fresh', endedAt: daysAgo(1) }),
        candidate({ callId: 'd89', endedAt: daysAgo(89) }),
        candidate({ callId: 'd90', endedAt: daysAgo(90) }),
        candidate({ callId: 'd90-and-a-bit', endedAt: new Date(daysAgo(90).getTime() - 1000) }),
        candidate({ callId: 'd91', endedAt: daysAgo(91) }),
        candidate({ callId: 'd400', endedAt: daysAgo(400) })
      ],
      NOW,
      90
    );
    // Strictly older than the period: exactly 90 days is not yet due.
    expect(due.map((d) => d.callId)).toEqual(['d90-and-a-bit', 'd91', 'd400']);
    expect(due.every((d) => d.reason === 'retention')).toBe(true);
  });

  it('honours a shorter or longer period', () => {
    const calls = [candidate({ callId: 'a', endedAt: daysAgo(10) })];
    expect(planPurge(calls, NOW, 7)).toHaveLength(1);
    expect(planPurge(calls, NOW, 30)).toHaveLength(0);
  });

  it('takes a recording the prospect objected to at once, whatever its age', () => {
    const due = planPurge([candidate({ callId: 'obj', endedAt: daysAgo(0.01), recording: { deleteNow: true } })], NOW, 90);
    expect(due).toEqual([expect.objectContaining({ callId: 'obj', reason: 'objection' })]);
  });

  it('never touches a call that is still live', () => {
    const due = planPurge([candidate({ callId: 'live', endedAt: null, recording: { deleteNow: true } })], NOW, 90);
    expect(due).toEqual([]);
  });

  it('skips what is already gone and what was never recorded', () => {
    const due = planPurge(
      [
        candidate({ callId: 'gone', endedAt: daysAgo(200), recordingUrl: null, recording: { deletedAt: 'x', providerDeletedAt: 'x' } }),
        candidate({ callId: 'never', endedAt: daysAgo(200), recordingUrl: null }),
        candidate({ callId: 'provider-done', endedAt: daysAgo(200), recording: { providerDeletedAt: 'x' } })
      ],
      NOW,
      90
    );
    expect(due).toEqual([]);
  });

  it('picks up an encrypted copy even when the provider\'s is already deleted', () => {
    const archive = { location: 'c.mp3.enc', bytes: 1, sha256: 'x', encrypted: true, archivedAt: 'x' };
    const due = planPurge([candidate({ callId: 'ours-only', endedAt: daysAgo(200), recordingUrl: null, recording: { archive } })], NOW, 90);
    expect(due[0]).toMatchObject({ hasArchive: true, hasProviderCopy: false });
  });

  it('refuses a retention period that would delete everything', () => {
    for (const bad of [0, -1, 0.5, Number.NaN]) expect(() => planPurge([], NOW, bad)).toThrow(/at least 1/);
  });
});

/* ------------------------------------------------------------------ */

async function callWithRecording(w: World, over: { endedDaysAgo: number | null; url?: string | null; meta?: RecordingMeta; provider?: string }) {
  const seeded = await seedContact(w.db);
  const calls = new CallStore(w.db, () => NOW);
  const call = await calls.create(seeded);
  await w.db.call.update({
    where: { id: call.id },
    data: {
      providerCallId: over.provider ?? `prov-${call.id.slice(0, 6)}`,
      endedAt: over.endedDaysAgo === null ? null : daysAgo(over.endedDaysAgo),
      recordingUrl: over.url === undefined ? 'https://storage.vapi.ai/r.mp3' : over.url
    }
  });
  if (over.meta !== undefined) await calls.patchMetrics(call.id, (m) => ({ ...m, recording: over.meta as RecordingMeta }));
  return call.id;
}

class SpyStore implements RecordingStore {
  readonly deleted: string[] = [];
  failWith: Error | null = null;
  async put(): Promise<never> {
    throw new Error('not used');
  }
  async get(): Promise<never> {
    throw new Error('not used');
  }
  async delete(location: string): Promise<boolean> {
    if (this.failWith !== null) throw this.failWith;
    this.deleted.push(location);
    return true;
  }
}

describe('running the purge', () => {
  async function setup() {
    const w = await world();
    worlds.push(w);
    const store = new SpyStore();
    const provider: string[] = [];
    const adapter = {
      failWith: null as Error | null,
      async deleteArtifacts(id: string) {
        if (this.failWith !== null) throw this.failWith;
        provider.push(id);
      }
    };
    return { w, store, provider, adapter };
  }
  const archive = { location: 'x.mp3.enc', bytes: 1, sha256: 'x', encrypted: true, archivedAt: 'x' };

  it('changes nothing in a dry run, and says what it would do', async () => {
    const { w, store, provider, adapter } = await setup();
    const old = await callWithRecording(w, { endedDaysAgo: 120, meta: { archive } });
    await callWithRecording(w, { endedDaysAgo: 5 });

    const report = await runPurge({ db: w.db, store, adapter, now: () => NOW, retentionDays: 90, dryRun: true });
    expect(report.due.map((d) => d.callId)).toEqual([old]);
    expect(report.results).toEqual([]);
    expect(store.deleted).toEqual([]);
    expect(provider).toEqual([]);
    expect((await w.db.call.findUnique({ where: { id: old } }))?.recordingUrl).not.toBeNull();
    expect(formatPurgeReport(report)).toContain('DRY RUN');
    expect(formatPurgeReport(report)).toContain('--apply');
  });

  it('applied, deletes both copies, forgets the URL, and records that it did', async () => {
    const { w, store, provider, adapter } = await setup();
    const old = await callWithRecording(w, { endedDaysAgo: 120, meta: { archive }, provider: 'prov-old' });
    const fresh = await callWithRecording(w, { endedDaysAgo: 5, provider: 'prov-fresh' });

    const report = await runPurge({ db: w.db, store, adapter, now: () => NOW, retentionDays: 90, dryRun: false });
    expect(report.results).toEqual([{ callId: old, status: 'deleted', detail: 'deleted (retention)' }]);
    expect(store.deleted).toEqual(['x.mp3.enc']);
    expect(provider).toEqual(['prov-old']);

    const calls = new CallStore(w.db, () => NOW);
    const row = await w.db.call.findUnique({ where: { id: old } });
    expect(row?.recordingUrl).toBeNull();
    const meta = (await calls.metrics(old)).recording;
    expect(meta?.archive).toBeUndefined();
    expect(meta?.deletedAt).toBe(NOW.toISOString());
    expect((await calls.events(old, 'recording')).at(-1)?.data).toMatchObject({ action: 'purged', reason: 'retention' });

    // The recent one is untouched.
    expect((await w.db.call.findUnique({ where: { id: fresh } }))?.recordingUrl).not.toBeNull();

    // And a second run finds nothing to do.
    const again = await runPurge({ db: w.db, store, adapter, now: () => NOW, retentionDays: 90, dryRun: false });
    expect(again.due).toEqual([]);
  });

  it('a recording the prospect objected to goes now, however recent', async () => {
    const { w, store, provider, adapter } = await setup();
    const id = await callWithRecording(w, { endedDaysAgo: 0.01, meta: { deleteNow: true }, provider: 'prov-obj' });
    const report = await runPurge({ db: w.db, store, adapter, now: () => NOW, retentionDays: 90, dryRun: false, only: [id] });
    expect(report.results[0]?.status).toBe('deleted');
    expect(provider).toEqual(['prov-obj']);
  });

  it('keeps what it could not delete flagged, so the next run finishes the job', async () => {
    const { w, store, provider, adapter } = await setup();
    const id = await callWithRecording(w, { endedDaysAgo: 120, meta: { archive }, provider: 'prov-x' });
    adapter.failWith = new Error('Vapi is down');

    const first = await runPurge({ db: w.db, store, adapter, now: () => NOW, retentionDays: 90, dryRun: false });
    expect(first.results[0]).toMatchObject({ status: 'partial' });
    expect(first.results[0]?.detail).toContain('Vapi is down');
    // Our copy is gone, the provider's is not, and the URL is kept as the reminder.
    expect(store.deleted).toEqual(['x.mp3.enc']);
    expect((await w.db.call.findUnique({ where: { id: id } }))?.recordingUrl).not.toBeNull();
    const meta = (await new CallStore(w.db).metrics(id)).recording;
    expect(meta?.archive).toBeUndefined();
    expect(meta?.deletedAt).toBeUndefined();

    adapter.failWith = null;
    const second = await runPurge({ db: w.db, store, adapter, now: () => NOW, retentionDays: 90, dryRun: false });
    expect(second.results[0]?.status).toBe('deleted');
    expect(provider).toEqual(['prov-x']);
    expect(store.deleted).toEqual(['x.mp3.enc']);
  });

  it('treats "already gone at the provider" as done', async () => {
    const { w, store, adapter } = await setup();
    await callWithRecording(w, { endedDaysAgo: 120 });
    adapter.failWith = new ProviderRejectedError('404 not found', 404);
    const report = await runPurge({ db: w.db, store, adapter, now: () => NOW, retentionDays: 90, dryRun: false });
    expect(report.results[0]?.status).toBe('deleted');
  });

  it('says so when it has no way to delete one of the copies', async () => {
    const { w } = await setup();
    await callWithRecording(w, { endedDaysAgo: 120, meta: { archive } });
    const report = await runPurge({ db: w.db, now: () => NOW, retentionDays: 90, dryRun: false });
    expect(report.results[0]?.status).toBe('failed');
    expect(report.results[0]?.detail).toContain('no encryption key');
    expect(report.results[0]?.detail).toContain('no provider key');
  });
});
