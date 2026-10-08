/**
 * The enrichment queue (section 3.3 and the project stack: BullMQ + Redis).
 *
 * Two stages, one queue. Email goes first for everyone who passes ICP scoring;
 * phone follows only for those who also pass the research gate, and arrives
 * minutes later by webhook. The interface is small so the rest of the system
 * does not care which implementation it has:
 *
 *   - in memory, the default and what every test uses;
 *   - BullMQ on Redis, constructed only when REDIS_URL is set (`./queue-bullmq`).
 *
 * Both dedupe on the job id. That is a convenience, not the guarantee: what
 * keeps a credit from being spent twice is the enrichment ledger, which is
 * checked again when the job actually runs.
 */

export type EnrichmentStage = 'email' | 'phone';

export interface EnrichmentJob {
  stage: EnrichmentStage;
  apolloId: string;
  contactId: string;
}

/** BullMQ forbids ':' in a custom job id, so the separator is a dash and any colon in the id is replaced. */
export function jobIdOf(job: Pick<EnrichmentJob, 'stage' | 'apolloId'>): string {
  return `${job.stage}-${job.apolloId.replace(/:/g, '_')}`;
}

export type JobHandler = (job: EnrichmentJob) => Promise<void>;

export interface EnqueueResult {
  queued: boolean;
  reason?: 'duplicate';
}

export interface QueueStats {
  waiting: number;
  active: number;
  completed: number;
  failed: number;
}

export interface DrainReport {
  processed: number;
  failed: Array<{ jobId: string; error: string; attempts: number }>;
}

export interface EnrichmentQueue {
  readonly kind: 'memory' | 'bullmq';
  enqueue(job: EnrichmentJob): Promise<EnqueueResult>;
  /** Attach the handler. In memory it is just remembered; on BullMQ it starts a worker. */
  start(handler: JobHandler): Promise<void>;
  /** Work until nothing is waiting, then report. */
  drain(): Promise<DrainReport>;
  stats(): Promise<QueueStats>;
  close(): Promise<void>;
}

export interface MemoryQueueOptions {
  maxAttempts?: number;
  backoffMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

type JobState = 'waiting' | 'active' | 'completed' | 'failed';

interface Entry {
  job: EnrichmentJob;
  state: JobState;
  attempts: number;
  error?: string;
}

export class InMemoryEnrichmentQueue implements EnrichmentQueue {
  readonly kind = 'memory' as const;

  private readonly entries = new Map<string, Entry>();
  private handler: JobHandler | undefined;
  private readonly maxAttempts: number;
  private readonly backoffMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: MemoryQueueOptions = {}) {
    this.maxAttempts = options.maxAttempts ?? 3;
    this.backoffMs = options.backoffMs ?? 1000;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async enqueue(job: EnrichmentJob): Promise<EnqueueResult> {
    const id = jobIdOf(job);
    const existing = this.entries.get(id);
    // A job that failed for good may be tried again; anything else is already in hand.
    if (existing !== undefined && existing.state !== 'failed') return { queued: false, reason: 'duplicate' };
    this.entries.set(id, { job, state: 'waiting', attempts: 0 });
    return { queued: true };
  }

  async start(handler: JobHandler): Promise<void> {
    this.handler = handler;
  }

  async drain(): Promise<DrainReport> {
    if (this.handler === undefined) throw new Error('the queue has no handler: call start() first');
    const report: DrainReport = { processed: 0, failed: [] };

    for (;;) {
      const next = [...this.entries.entries()].find(([, e]) => e.state === 'waiting');
      if (next === undefined) break;
      const [id, entry] = next;
      entry.state = 'active';

      for (;;) {
        entry.attempts += 1;
        try {
          await this.handler(entry.job);
          entry.state = 'completed';
          report.processed += 1;
          break;
        } catch (error) {
          entry.error = error instanceof Error ? error.message : String(error);
          if (entry.attempts >= this.maxAttempts) {
            entry.state = 'failed';
            report.failed.push({ jobId: id, error: entry.error, attempts: entry.attempts });
            break;
          }
          await this.sleep(this.backoffMs * 2 ** (entry.attempts - 1));
        }
      }
    }
    return report;
  }

  async stats(): Promise<QueueStats> {
    const count = (s: JobState): number => [...this.entries.values()].filter((e) => e.state === s).length;
    return { waiting: count('waiting'), active: count('active'), completed: count('completed'), failed: count('failed') };
  }

  async close(): Promise<void> {
    this.handler = undefined;
  }
}

/**
 * The queue this process should use: BullMQ when REDIS_URL is set, otherwise in
 * memory. BullMQ is imported on demand, so a process that never sets REDIS_URL
 * never loads it and never opens a connection.
 */
export async function createEnrichmentQueue(
  env: NodeJS.ProcessEnv = process.env,
  memory: MemoryQueueOptions = {}
): Promise<EnrichmentQueue> {
  const url = (env.REDIS_URL ?? '').trim();
  if (url === '') return new InMemoryEnrichmentQueue(memory);
  const { BullMqEnrichmentQueue } = await import('./queue-bullmq.js');
  return BullMqEnrichmentQueue.connect({ redisUrl: url });
}
