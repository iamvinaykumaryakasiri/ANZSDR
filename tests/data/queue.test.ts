import { describe, expect, it, vi } from 'vitest';
import {
  InMemoryEnrichmentQueue,
  createEnrichmentQueue,
  jobIdOf,
  type EnrichmentJob
} from '../../src/data/enrichment-queue.js';

vi.mock('../../src/data/queue-bullmq.js', () => ({
  BullMqEnrichmentQueue: {
    connect: vi.fn(async (options: { redisUrl: string }) => ({ kind: 'bullmq', redisUrl: options.redisUrl }))
  }
}));

const job = (stage: 'email' | 'phone', apolloId: string): EnrichmentJob => ({ stage, apolloId, contactId: `c-${apolloId}` });

describe('the in-memory enrichment queue', () => {
  it('names a job by stage and person', () => {
    expect(jobIdOf(job('email', 'a1'))).toBe('email-a1');
    // BullMQ rejects a colon in a custom id.
    expect(jobIdOf(job('phone', 'x:y'))).toBe('phone-x_y');
  });

  it('queues the same stage for the same person once', async () => {
    const q = new InMemoryEnrichmentQueue();
    expect(await q.enqueue(job('email', 'a1'))).toEqual({ queued: true });
    expect(await q.enqueue(job('email', 'a1'))).toEqual({ queued: false, reason: 'duplicate' });
    // A different stage for the same person is different work.
    expect(await q.enqueue(job('phone', 'a1'))).toEqual({ queued: true });
    expect((await q.stats()).waiting).toBe(2);
  });

  it('processes in order and counts what it did', async () => {
    const q = new InMemoryEnrichmentQueue();
    const seen: string[] = [];
    await q.start(async (j) => {
      seen.push(jobIdOf(j));
    });
    await q.enqueue(job('email', 'a'));
    await q.enqueue(job('email', 'b'));
    await q.enqueue(job('phone', 'a'));
    expect(await q.drain()).toEqual({ processed: 3, failed: [] });
    expect(seen).toEqual(['email-a', 'email-b', 'phone-a']);
    expect(await q.stats()).toEqual({ waiting: 0, active: 0, completed: 3, failed: 0 });
    // A finished job is not queued again.
    expect((await q.enqueue(job('email', 'a'))).queued).toBe(false);
  });

  it('retries with growing backoff and then succeeds', async () => {
    const slept: number[] = [];
    const q = new InMemoryEnrichmentQueue({ maxAttempts: 3, backoffMs: 100, sleep: async (ms) => void slept.push(ms) });
    let calls = 0;
    await q.start(async () => {
      calls += 1;
      if (calls < 3) throw new Error('Apollo hiccup');
    });
    await q.enqueue(job('email', 'a'));
    expect(await q.drain()).toEqual({ processed: 1, failed: [] });
    expect(calls).toBe(3);
    expect(slept).toEqual([100, 200]);
  });

  it('reports a job that fails every time, and lets it be queued again', async () => {
    const q = new InMemoryEnrichmentQueue({ maxAttempts: 2, backoffMs: 1, sleep: async () => {} });
    await q.start(async () => {
      throw new Error('nope');
    });
    await q.enqueue(job('phone', 'a'));
    const report = await q.drain();
    expect(report.processed).toBe(0);
    expect(report.failed).toEqual([{ jobId: 'phone-a', error: 'nope', attempts: 2 }]);
    expect((await q.stats()).failed).toBe(1);
    expect(await q.enqueue(job('phone', 'a'))).toEqual({ queued: true });
  });

  it('does not drain without a handler, which would silently do nothing', async () => {
    await expect(new InMemoryEnrichmentQueue().drain()).rejects.toThrow(/start\(\)/);
  });

  it('forgets its handler when closed', async () => {
    const q = new InMemoryEnrichmentQueue();
    await q.start(async () => {});
    await q.close();
    await expect(q.drain()).rejects.toThrow();
  });
});

describe('choosing a queue', () => {
  it('is in memory unless REDIS_URL is set', async () => {
    expect((await createEnrichmentQueue({})).kind).toBe('memory');
    expect((await createEnrichmentQueue({ REDIS_URL: '   ' })).kind).toBe('memory');
  });

  it('is BullMQ, connected to that URL, when it is', async () => {
    const queue = (await createEnrichmentQueue({ REDIS_URL: 'redis://cache.internal:6379' })) as unknown as { kind: string; redisUrl: string };
    expect(queue).toEqual({ kind: 'bullmq', redisUrl: 'redis://cache.internal:6379' });
  });
});
