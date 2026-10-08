/**
 * Recordings: kept encrypted, kept for as long as the policy says, then deleted.
 *
 * Section 7.4: announce recording in the opening, encrypt recordings, default
 * 90-day retention with an automatic purge job, honour deletion requests, and if
 * the prospect objects never continue covertly.
 *
 * Two copies can exist, and the purge deals with both.
 *
 *   - The provider's copy. Vapi records the call and holds the audio; the
 *     end-of-call report carries a URL to it. Deleting a call at Vapi deletes its
 *     artifacts.
 *   - Ours. After a call, if an encryption key is configured, the audio is
 *     downloaded and written to `data/recordings` encrypted with AES-256-GCM,
 *     bound to the call id so a file cannot be swapped between calls. This is
 *     the copy retention is measured on, and the one that can sit in an
 *     Australian bucket if "may recordings leave Australia" (section 15 item 7)
 *     is answered no.
 *
 * Retention is measured from the end of the call and is strict: a recording is
 * due when it is *older than* the retention period. A recording the prospect
 * objected to is due immediately, whatever its age.
 *
 * `planPurge` is a pure function and is where the rule lives. `runPurge` does
 * what the plan says, and does nothing at all in dry-run mode, which is the
 * default for the command line.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Blackboard } from '../blackboard/client.js';
import { CallStore, parseMetrics, type RecordingMeta } from './call-store.js';
import { ProviderRejectedError, type ProviderAdapter } from './provider.js';

const DAY_MS = 86_400_000;
const MAGIC = Buffer.from('ANZREC01');
const IV_BYTES = 12;
const TAG_BYTES = 16;
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/* ------------------------------------------------------------------ */
/* Encrypted storage                                                   */
/* ------------------------------------------------------------------ */

export interface StoredRecording {
  /** Relative to the store. Never a URL, never an absolute path. */
  location: string;
  bytes: number;
  /** Of the plaintext audio, so integrity can be checked after decryption. */
  sha256: string;
  encrypted: boolean;
}

/** The encrypted-at-rest hook: anything that can hold a recording can stand in here. */
export interface RecordingStore {
  put(callId: string, audio: Buffer, extension: string): Promise<StoredRecording>;
  get(location: string): Promise<Buffer>;
  /** True if something was deleted, false if there was nothing there. */
  delete(location: string): Promise<boolean>;
}

/** A 256-bit key as 64 hex characters (`openssl rand -hex 32`). Anything else is refused. */
export function parseEncryptionKey(hex: string): Buffer {
  if (!/^[0-9a-fA-F]{64}$/.test(hex.trim())) {
    throw new Error('RECORDING_ENCRYPTION_KEY must be 64 hex characters (32 bytes). Generate one with: openssl rand -hex 32');
  }
  return Buffer.from(hex.trim(), 'hex');
}

function cleanExtension(extension: string): string {
  const clean = extension.toLowerCase().replace(/[^a-z0-9]/g, '');
  return clean === '' ? 'bin' : clean.slice(0, 8);
}

function callIdOf(location: string): string {
  const match = /^([A-Za-z0-9_-]{1,64})\.[a-z0-9]{1,8}\.enc$/.exec(location);
  if (match === null) throw new Error(`"${location}" is not a recording location`);
  return match[1] as string;
}

export class EncryptedFileRecordingStore implements RecordingStore {
  constructor(
    private readonly dir: string,
    private readonly key: Buffer
  ) {
    if (key.length !== 32) throw new Error('the recording encryption key must be 32 bytes');
  }

  async put(callId: string, audio: Buffer, extension: string): Promise<StoredRecording> {
    if (!SAFE_ID.test(callId)) throw new Error('not a usable call id for a recording file name');
    const location = `${callId}.${cleanExtension(extension)}.enc`;

    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    // Bound to the call: a file copied under another call's name will not decrypt.
    cipher.setAAD(Buffer.from(callId));
    const body = Buffer.concat([cipher.update(audio), cipher.final()]);

    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await writeFile(join(this.dir, location), Buffer.concat([MAGIC, iv, cipher.getAuthTag(), body]), { mode: 0o600 });

    return { location, bytes: audio.length, sha256: createHash('sha256').update(audio).digest('hex'), encrypted: true };
  }

  async get(location: string): Promise<Buffer> {
    const callId = callIdOf(location);
    const file = await readFile(join(this.dir, location));
    if (file.length < MAGIC.length + IV_BYTES + TAG_BYTES || !file.subarray(0, MAGIC.length).equals(MAGIC)) {
      throw new Error(`${location} is not an encrypted recording`);
    }
    const iv = file.subarray(MAGIC.length, MAGIC.length + IV_BYTES);
    const tag = file.subarray(MAGIC.length + IV_BYTES, MAGIC.length + IV_BYTES + TAG_BYTES);
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAAD(Buffer.from(callId));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(file.subarray(MAGIC.length + IV_BYTES + TAG_BYTES)), decipher.final()]);
  }

  async delete(location: string): Promise<boolean> {
    callIdOf(location);
    try {
      await unlink(join(this.dir, location));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }
}

/* ------------------------------------------------------------------ */
/* Archiving                                                           */
/* ------------------------------------------------------------------ */

export const MAX_RECORDING_BYTES = 100 * 1024 * 1024;

function extensionFor(contentType: string | null, url: URL): string {
  const type = (contentType ?? '').toLowerCase();
  if (type.includes('mpeg') || type.includes('mp3')) return 'mp3';
  if (type.includes('wav')) return 'wav';
  const fromPath = /\.([a-z0-9]{2,4})$/i.exec(url.pathname);
  return fromPath?.[1]?.toLowerCase() ?? 'bin';
}

export interface ArchiveDeps {
  store: RecordingStore;
  adapter: Pick<ProviderAdapter, 'artifactHeaders'>;
  fetch?: typeof fetch;
}

/** Download a recording from the provider and keep our own encrypted copy. */
export async function archiveRecording(deps: ArchiveDeps, callId: string, rawUrl: string): Promise<StoredRecording> {
  const url = new URL(rawUrl);
  if (url.protocol !== 'https:') throw new Error('refusing to download a recording over anything but https');

  const response = await (deps.fetch ?? fetch)(url, {
    headers: deps.adapter.artifactHeaders(url),
    signal: AbortSignal.timeout(60_000)
  });
  if (!response.ok) throw new Error(`the recording download returned ${response.status}`);

  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > MAX_RECORDING_BYTES) throw new Error(`the recording is ${declared} bytes, over the ${MAX_RECORDING_BYTES} limit`);
  const audio = Buffer.from(await response.arrayBuffer());
  if (audio.length === 0) throw new Error('the recording download was empty');
  if (audio.length > MAX_RECORDING_BYTES) throw new Error('the recording is larger than the limit');

  return deps.store.put(callId, audio, extensionFor(response.headers.get('content-type'), url));
}

/* ------------------------------------------------------------------ */
/* The purge                                                           */
/* ------------------------------------------------------------------ */

export type PurgeReason = 'retention' | 'objection';

export interface PurgeCandidate {
  callId: string;
  providerCallId: string | null;
  endedAt: Date | null;
  recordingUrl: string | null;
  recording: RecordingMeta;
}

export interface PurgeItem {
  callId: string;
  reason: PurgeReason;
  /** Whole days since the call ended. */
  ageDays: number;
  hasArchive: boolean;
  hasProviderCopy: boolean;
}

/**
 * Which recordings are due for deletion.
 *
 * Due means: the call is over, something is still held, and either the prospect
 * objected or the call ended more than `retentionDays` ago. A live call is never
 * due, whatever its flags say - its provider copy cannot be deleted while it is
 * being written.
 */
export function planPurge(candidates: PurgeCandidate[], now: Date, retentionDays: number): PurgeItem[] {
  if (!Number.isInteger(retentionDays) || retentionDays < 1) {
    // Zero or negative would delete everything, immediately, on a typo.
    throw new Error(`retention must be a whole number of days, at least 1 (got ${retentionDays})`);
  }

  const due: PurgeItem[] = [];
  for (const c of candidates) {
    if (c.endedAt === null) continue;

    const hasArchive = c.recording.archive !== undefined;
    const hasProviderCopy = c.recordingUrl !== null && c.recording.providerDeletedAt === undefined;
    if (!hasArchive && !hasProviderCopy) continue;

    const ageMs = now.getTime() - c.endedAt.getTime();
    const reason: PurgeReason | null = c.recording.deleteNow === true ? 'objection' : ageMs > retentionDays * DAY_MS ? 'retention' : null;
    if (reason === null) continue;

    due.push({ callId: c.callId, reason, ageDays: Math.floor(ageMs / DAY_MS), hasArchive, hasProviderCopy });
  }
  return due;
}

export interface PurgeDeps {
  db: Blackboard;
  /** Absent when no encryption key is configured: there is then no archive of ours to delete. */
  store?: RecordingStore | undefined;
  /** Absent when no provider key is configured: the provider's copy cannot be deleted from here. */
  adapter?: Pick<ProviderAdapter, 'deleteArtifacts'> | undefined;
  now: () => Date;
  retentionDays: number;
  /** Plan and report; change nothing. The command line defaults to this. */
  dryRun: boolean;
  /** Restrict to these calls (an objection is purged straight away, not at the next run). */
  only?: string[];
}

export interface PurgeResult {
  callId: string;
  status: 'deleted' | 'partial' | 'failed';
  detail: string;
}

export interface PurgeReport {
  dryRun: boolean;
  retentionDays: number;
  considered: number;
  due: PurgeItem[];
  results: PurgeResult[];
}

export async function runPurge(deps: PurgeDeps): Promise<PurgeReport> {
  const now = deps.now();
  const calls = new CallStore(deps.db, deps.now);

  const rows = await deps.db.call.findMany({
    where: {
      endedAt: { not: null },
      ...(deps.only !== undefined ? { id: { in: deps.only } } : {}),
      OR: [{ recordingUrl: { not: null } }, { providerMetrics: { contains: '"archive"' } }]
    },
    select: { id: true, providerCallId: true, endedAt: true, recordingUrl: true, providerMetrics: true }
  });

  const candidates: PurgeCandidate[] = rows.map((row) => ({
    callId: row.id,
    providerCallId: row.providerCallId,
    endedAt: row.endedAt,
    recordingUrl: row.recordingUrl,
    recording: parseMetrics(row.providerMetrics).recording ?? {}
  }));

  const due = planPurge(candidates, now, deps.retentionDays);
  const report: PurgeReport = { dryRun: deps.dryRun, retentionDays: deps.retentionDays, considered: candidates.length, due, results: [] };
  if (deps.dryRun) return report;

  for (const item of due) {
    const candidate = candidates.find((c) => c.callId === item.callId) as PurgeCandidate;
    const problems: string[] = [];
    let archiveGone = !item.hasArchive;
    let providerGone = !item.hasProviderCopy;

    if (item.hasArchive) {
      const archive = candidate.recording.archive as NonNullable<RecordingMeta['archive']>;
      if (deps.store === undefined) {
        problems.push('our encrypted copy exists but no encryption key is configured, so it could not be deleted');
      } else {
        try {
          await deps.store.delete(archive.location);
          archiveGone = true;
        } catch (error) {
          problems.push(`could not delete our copy: ${(error as Error).message}`);
        }
      }
    }

    if (item.hasProviderCopy) {
      if (deps.adapter === undefined || candidate.providerCallId === null) {
        problems.push("the provider's copy could not be deleted from here (no provider key configured)");
      } else {
        try {
          await deps.adapter.deleteArtifacts(candidate.providerCallId);
          providerGone = true;
        } catch (error) {
          // Already gone at the provider is the outcome we wanted.
          if (error instanceof ProviderRejectedError && error.status === 404) providerGone = true;
          else problems.push(`could not delete the provider's copy: ${(error as Error).message}`);
        }
      }
    }

    // Record exactly what is now true, so the next run finishes the job rather
    // than repeating it or, worse, believing it is done.
    const at = now.toISOString();
    await calls.patchMetrics(item.callId, (m) => {
      const recording: RecordingMeta = { ...(m.recording ?? {}) };
      if (archiveGone && recording.archive !== undefined) delete recording.archive;
      if (providerGone) recording.providerDeletedAt = at;
      if (archiveGone && providerGone) recording.deletedAt = at;
      return { ...m, recording };
    });
    if (providerGone) await deps.db.call.update({ where: { id: item.callId }, data: { recordingUrl: null } });
    await calls.append(item.callId, {
      kind: 'recording',
      data: { action: archiveGone && providerGone ? 'purged' : 'purge-incomplete', reason: item.reason, problems }
    });

    report.results.push(
      archiveGone && providerGone
        ? { callId: item.callId, status: 'deleted', detail: `deleted (${item.reason})` }
        : {
            callId: item.callId,
            status: archiveGone || providerGone ? 'partial' : 'failed',
            detail: problems.join('; ')
          }
    );
  }
  return report;
}

export function formatPurgeReport(report: PurgeReport): string {
  const lines: string[] = [];
  lines.push(
    `${report.dryRun ? 'DRY RUN: nothing was deleted. ' : ''}Recordings held on ${report.considered} call(s); retention is ${report.retentionDays} days.`
  );
  if (report.due.length === 0) {
    lines.push('Nothing is due for deletion.');
  } else {
    lines.push(`${report.due.length} due for deletion:`);
    for (const item of report.due) {
      const where = [item.hasArchive ? 'our encrypted copy' : '', item.hasProviderCopy ? "the provider's copy" : ''].filter(Boolean).join(' and ');
      lines.push(
        `  ${item.callId.slice(0, 8)}  ${item.reason === 'objection' ? 'the prospect objected to recording' : `ended ${item.ageDays} days ago`}  (${where})`
      );
    }
  }
  for (const r of report.results) lines.push(`  ${r.callId.slice(0, 8)}  ${r.status}: ${r.detail}`);
  if (report.dryRun && report.due.length > 0) lines.push('Run again with --apply to delete them.');
  return lines.join('\n');
}
