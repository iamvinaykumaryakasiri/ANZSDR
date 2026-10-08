/**
 * The enrichment queue on BullMQ and Redis.
 *
 * Only constructed when REDIS_URL is set (see `createEnrichmentQueue`). It adds
 * what the in-memory queue cannot: jobs that survive a restart, retries with
 * backoff that outlive the process, and a rate limit shared by every worker.
 *
 * `jobId` is `stage:apolloId`, so the same person is never queued twice for the
 * same stage while the job is retained. Completed jobs are kept for a day, which
 * is what makes that true across a restart; after that the enrichment ledger is
 * what stops a repeat purchase.
 */

import { Queue, Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import {
  jobIdOf,
  type DrainReport,
  type EnqueueResult,
  type EnrichmentJob,
  type EnrichmentQueue,
  type JobHandler,
  type QueueStats
} from './enrichment-queue.js';

const DAY_SECONDS = 86_400;

export interface BullMqOptions {
  redisUrl: string;
  queueName?: string;
  maxAttempts?: number;
  backoffMs?: number;
  /** Apollo's per-minute limits are shared by every worker, so the limiter lives on the queue. */
  limiter?: { max: number; duration: number };
  /** How long drain() waits for the queue to empty before giving up. */
  drainTimeoutMs?: number;
  onError?: (error: Error) => void;
}

interface Resolved {
  queueName: string;
  maxAttempts: number;
  backoffMs: number;
  limiter: { max: number; duration: number };
  drainTimeoutMs: number;
  onError: ((error: Error) => void) | undefined;
}

export class BullMqEnrichmentQueue implements EnrichmentQueue {
  readonly kind = 'bullmq' as const;

  private worker: Worker<EnrichmentJob> | undefined;
  private readonly failures: DrainReport['failed'] = [];

  private constructor(
    private readonly queue: Queue<EnrichmentJob>,
    private readonly connections: Redis[],
    private readonly options: Resolved,
    private readonly redisUrl: string
  ) {}

  static async connect(options: BullMqOptions): Promise<BullMqEnrichmentQueue> {
    const resolved: Resolved = {
      queueName: options.queueName ?? 'anzsdr-enrichment',
      maxAttempts: options.maxAttempts ?? 3,
      backoffMs: options.backoffMs ?? 5000,
      limiter: options.limiter ?? { max: 30, duration: 60_000 },
      drainTimeoutMs: options.drainTimeoutMs ?? 300_000,
      onError: options.onError
    };
    // A connection that fails must be reported, not thrown from an event
    // emitter with nobody listening, which would take the process down.
    const connection = new Redis(options.redisUrl, { maxRetriesPerRequest: null });
    connection.on('error', (error: Error) => resolved.onError?.(error));
    const queue = new Queue<EnrichmentJob>(resolved.queueName, { connection });
    return new BullMqEnrichmentQueue(queue, [connection], resolved, options.redisUrl);
  }

  async enqueue(job: EnrichmentJob): Promise<EnqueueResult> {
    const jobId = jobIdOf(job);
    if ((await this.queue.getJob(jobId)) !== undefined) return { queued: false, reason: 'duplicate' };
    await this.queue.add(job.stage, job, {
      jobId,
      attempts: this.options.maxAttempts,
      backoff: { type: 'exponential', delay: this.options.backoffMs },
      removeOnComplete: { age: DAY_SECONDS },
      removeOnFail: { age: 7 * DAY_SECONDS }
    });
    return { queued: true };
  }

  async start(handler: JobHandler): Promise<void> {
    if (this.worker !== undefined) return;
    // A worker needs its own connection: it blocks on it.
    const connection = new Redis(this.redisUrl, { maxRetriesPerRequest: null });
    connection.on('error', (error: Error) => this.options.onError?.(error));
    this.connections.push(connection);

    this.worker = new Worker<EnrichmentJob>(
      this.options.queueName,
      async (job: Job<EnrichmentJob>) => handler(job.data),
      { connection, concurrency: 1, limiter: this.options.limiter }
    );
    this.worker.on('error', (error: Error) => this.options.onError?.(error));
    this.worker.on('failed', (job, error) => {
      if (job !== undefined && job.attemptsMade >= this.options.maxAttempts) {
        this.failures.push({ jobId: job.id ?? 'unknown', error: error.message, attempts: job.attemptsMade });
      }
    });
  }

  async drain(): Promise<DrainReport> {
    const deadline = Date.now() + this.options.drainTimeoutMs;
    for (;;) {
      const counts = await this.queue.getJobCounts('waiting', 'active', 'delayed', 'prioritized');
      const outstanding = Object.values(counts).reduce((a, b) => a + b, 0);
      if (outstanding === 0) break;
      if (Date.now() > deadline) throw new Error(`the enrichment queue still had ${outstanding} job(s) after ${this.options.drainTimeoutMs}ms`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const completed = await this.queue.getJobCounts('completed');
    return { processed: completed.completed ?? 0, failed: [...this.failures] };
  }

  async stats(): Promise<QueueStats> {
    const c = await this.queue.getJobCounts('waiting', 'active', 'completed', 'failed');
    return {
      waiting: c.waiting ?? 0,
      active: c.active ?? 0,
      completed: c.completed ?? 0,
      failed: c.failed ?? 0
    };
  }

  async close(): Promise<void> {
    await this.worker?.close();
    await this.queue.close();
    for (const c of this.connections) c.disconnect();
  }
}
