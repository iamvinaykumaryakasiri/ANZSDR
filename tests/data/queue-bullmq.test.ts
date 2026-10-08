/**
 * The BullMQ queue against a real Redis.
 *
 * Runs only where a `redis-server` binary exists (or REDIS_URL points at a
 * disposable one); elsewhere it is skipped rather than faked, because a mock of
 * Redis would test the mock. The in-memory queue is held to the same behaviour
 * in queue.test.ts.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BullMqEnrichmentQueue } from '../../src/data/queue-bullmq.js';
import type { EnrichmentJob } from '../../src/data/enrichment-queue.js';

const hasRedis = spawnSync('redis-server', ['--version']).status === 0;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => (typeof address === 'object' && address !== null ? resolve(address.port) : reject(new Error('no port'))));
    });
  });
}

describe.skipIf(!hasRedis)('the BullMQ enrichment queue, on a real Redis', () => {
  let redis: ChildProcess;
  let url = '';
  const opened: BullMqEnrichmentQueue[] = [];

  beforeAll(async () => {
    const port = await freePort();
    url = `redis://127.0.0.1:${port}`;
    redis = spawn('redis-server', ['--port', String(port), '--save', '', '--appendonly', 'no', '--bind', '127.0.0.1'], { stdio: 'ignore' });
    // Wait until it answers.
    const deadline = Date.now() + 8000;
    for (;;) {
      const ping = spawnSync('redis-cli', ['-p', String(port), 'ping']);
      if (ping.stdout?.toString().trim() === 'PONG') break;
      if (Date.now() > deadline) throw new Error('redis-server did not start');
      await new Promise((r) => setTimeout(r, 100));
    }
  });

  afterAll(async () => {
    for (const q of opened) await q.close();
    redis?.kill();
  });

  async function open(name: string, extra: Partial<Parameters<typeof BullMqEnrichmentQueue.connect>[0]> = {}) {
    const q = await BullMqEnrichmentQueue.connect({ redisUrl: url, queueName: name, backoffMs: 50, drainTimeoutMs: 15_000, ...extra });
    opened.push(q);
    return q;
  }

  const job = (stage: 'email' | 'phone', apolloId: string): EnrichmentJob => ({ stage, apolloId, contactId: `c-${apolloId}` });

  it('queues a job once, runs it, and will not queue it again', async () => {
    const q = await open('t-dedupe');
    const seen: string[] = [];
    await q.start(async (j) => {
      seen.push(`${j.stage}:${j.apolloId}`);
    });
    expect(await q.enqueue(job('email', 'a'))).toEqual({ queued: true });
    expect(await q.enqueue(job('email', 'a'))).toEqual({ queued: false, reason: 'duplicate' });
    const report = await q.drain();
    expect(seen).toEqual(['email:a']);
    expect(report.failed).toEqual([]);
    expect((await q.stats()).completed).toBe(1);
    // Still remembered after it finished.
    expect((await q.enqueue(job('email', 'a'))).queued).toBe(false);
  });

  it('retries a failed job with backoff and succeeds', async () => {
    const q = await open('t-retry', { maxAttempts: 3 });
    let calls = 0;
    await q.start(async () => {
      calls += 1;
      if (calls < 2) throw new Error('Apollo hiccup');
    });
    await q.enqueue(job('phone', 'b'));
    await q.drain();
    expect(calls).toBe(2);
    expect((await q.stats()).completed).toBe(1);
  });

  it('reports a job that exhausts its attempts', async () => {
    const q = await open('t-fail', { maxAttempts: 2, backoffMs: 20 });
    await q.start(async () => {
      throw new Error('always');
    });
    await q.enqueue(job('phone', 'c'));
    await q.drain();
    await new Promise((r) => setTimeout(r, 200));
    expect((await q.stats()).failed).toBe(1);
    expect((await q.drain()).failed.map((f) => f.jobId)).toEqual(['phone-c']);
  });
});

describe.skipIf(hasRedis)('the BullMQ enrichment queue', () => {
  it.skip('needs a redis-server binary to run', () => {});
});
