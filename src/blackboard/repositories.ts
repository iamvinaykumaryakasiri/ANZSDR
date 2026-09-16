/**
 * Typed access to the blackboard.
 *
 * Every read that crosses a JSON or constrained-string column goes through a Zod
 * schema, so a corrupt row surfaces as a stop rather than as a plausible-looking
 * value in an agent's input.
 */

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AgentJournal, RunFinish, RunStart, TraceInput } from '../agents/journal.js';
import type { Blackboard } from './client.js';
import {
  decode,
  encode,
  escalationLevelSchema,
  spendCategorySchema,
  taskStatusSchema,
  type SpendCategory,
  type TaskStatus
} from './schemas.js';

const DAY_MS = 86_400_000;

export interface TaskSpec {
  kind: string;
  payload: unknown;
  priority?: number;
  campaignId?: string;
  accountId?: string;
  contactId?: string;
  dependsOn?: string[];
  runAfter?: Date;
}

export interface TaskRecord {
  id: string;
  kind: string;
  status: TaskStatus;
  priority: number;
  payload: unknown;
  result: unknown;
  dependsOn: string[];
  attempts: number;
  campaignId: string | null;
  accountId: string | null;
  contactId: string | null;
  lastError: string | null;
  runAfter: Date | null;
  createdAt: Date;
}

const dependsOnSchema = z.array(z.string());

function toTask(row: {
  id: string;
  kind: string;
  status: string;
  priority: number;
  payload: string;
  result: string | null;
  dependsOn: string;
  attempts: number;
  campaignId: string | null;
  accountId: string | null;
  contactId: string | null;
  lastError: string | null;
  runAfter: Date | null;
  createdAt: Date;
}): TaskRecord {
  return {
    id: row.id,
    kind: row.kind,
    status: taskStatusSchema.parse(row.status),
    priority: row.priority,
    payload: decode(z.unknown(), 'Task.payload', row.payload),
    result: row.result === null ? null : decode(z.unknown(), 'Task.result', row.result),
    dependsOn: decode(dependsOnSchema, 'Task.dependsOn', row.dependsOn),
    attempts: row.attempts,
    campaignId: row.campaignId,
    accountId: row.accountId,
    contactId: row.contactId,
    lastError: row.lastError,
    runAfter: row.runAfter,
    createdAt: row.createdAt
  };
}

export class TaskRepository {
  constructor(private readonly db: Blackboard) {}

  async create(spec: TaskSpec): Promise<TaskRecord> {
    const row = await this.db.task.create({
      data: {
        id: randomUUID(),
        kind: spec.kind,
        status: 'pending',
        priority: spec.priority ?? 3,
        payload: encode(z.unknown(), 'Task.payload', spec.payload),
        dependsOn: encode(dependsOnSchema, 'Task.dependsOn', spec.dependsOn ?? []),
        campaignId: spec.campaignId ?? null,
        accountId: spec.accountId ?? null,
        contactId: spec.contactId ?? null,
        runAfter: spec.runAfter ?? null
      }
    });
    return toTask(row);
  }

  async get(id: string): Promise<TaskRecord | null> {
    const row = await this.db.task.findUnique({ where: { id } });
    return row === null ? null : toTask(row);
  }

  async byStatus(status: TaskStatus): Promise<TaskRecord[]> {
    const rows = await this.db.task.findMany({
      where: { status },
      orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }]
    });
    return rows.map(toTask);
  }

  /**
   * The next task whose dependencies are all satisfied.
   *
   * A task waiting on something that failed, escalated or was cancelled is not
   * merely skipped - it is marked blocked, so the queue does not quietly fill
   * with work that can never run.
   */
  async nextRunnable(now: Date): Promise<TaskRecord | null> {
    const candidates = await this.db.task.findMany({
      where: { status: 'pending' },
      orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }]
    });

    for (const row of candidates) {
      const task = toTask(row);
      if (task.runAfter !== null && task.runAfter > now) continue;
      if (task.dependsOn.length === 0) return task;

      const deps = await this.db.task.findMany({
        where: { id: { in: task.dependsOn } },
        select: { id: true, status: true }
      });
      const dead = deps.filter((d) => ['failed', 'escalated', 'cancelled'].includes(d.status));
      if (dead.length > 0) {
        await this.db.task.update({
          where: { id: task.id },
          data: { status: 'blocked', lastError: `depends on ${dead.map((d) => d.id).join(', ')}` }
        });
        continue;
      }
      if (deps.length === task.dependsOn.length && deps.every((d) => d.status === 'done')) return task;
    }
    return null;
  }

  async markRunning(id: string, at: Date): Promise<void> {
    await this.db.task.update({
      where: { id },
      data: { status: 'running', startedAt: at, attempts: { increment: 1 } }
    });
  }

  async markDone(id: string, result: unknown, at: Date): Promise<void> {
    await this.db.task.update({
      where: { id },
      data: {
        status: 'done',
        result: encode(z.unknown(), 'Task.result', result),
        finishedAt: at,
        lastError: null
      }
    });
  }

  async markStopped(id: string, status: Extract<TaskStatus, 'failed' | 'escalated'>, error: string, at: Date): Promise<void> {
    await this.db.task.update({ where: { id }, data: { status, lastError: error, finishedAt: at } });
  }

  /** Put a claimed task back when the tick stops before it could run. */
  async release(id: string): Promise<void> {
    await this.db.task.update({
      where: { id },
      data: { status: 'pending', startedAt: null, attempts: { decrement: 1 } }
    });
  }
}

export interface EscalationInput {
  level: z.infer<typeof escalationLevelSchema>;
  reason: string;
  detail?: Record<string, unknown>;
  taskId?: string;
  contactId?: string;
}

export class EscalationRepository {
  constructor(private readonly db: Blackboard) {}

  async open(input: EscalationInput, at: Date): Promise<string> {
    const id = randomUUID();
    await this.db.escalation.create({
      data: {
        id,
        level: escalationLevelSchema.parse(input.level),
        reason: input.reason,
        detail: JSON.stringify(input.detail ?? {}),
        status: 'open',
        taskId: input.taskId ?? null,
        contactId: input.contactId ?? null,
        createdAt: at
      }
    });
    return id;
  }

  async openCount(since: Date): Promise<number> {
    return this.db.escalation.count({ where: { createdAt: { gte: since } } });
  }

  async list(status: 'open' | 'acknowledged' | 'resolved' = 'open') {
    return this.db.escalation.findMany({ where: { status }, orderBy: { createdAt: 'desc' } });
  }

  async resolve(id: string, at: Date): Promise<void> {
    await this.db.escalation.update({ where: { id }, data: { status: 'resolved', resolvedAt: at } });
  }
}

export class SpendLedger {
  constructor(private readonly db: Blackboard) {}

  async record(category: SpendCategory, usd: number, at: Date, taskId?: string, note = ''): Promise<void> {
    if (usd === 0) return;
    await this.db.spendRecord.create({
      data: {
        id: randomUUID(),
        at,
        category: spendCategorySchema.parse(category),
        usd,
        taskId: taskId ?? null,
        note
      }
    });
  }

  async totalSince(since: Date): Promise<number> {
    const result = await this.db.spendRecord.aggregate({ _sum: { usd: true }, where: { at: { gte: since } } });
    return result._sum.usd ?? 0;
  }

  async totalThisWeek(now: Date): Promise<number> {
    return this.totalSince(new Date(now.getTime() - 7 * DAY_MS));
  }
}

/** Writes agent runs and trace events where the console can read them. */
export class PrismaJournal implements AgentJournal {
  constructor(private readonly db: Blackboard) {}

  async startRun(start: RunStart): Promise<void> {
    await this.db.agentRun.create({
      data: {
        id: start.runId,
        taskId: start.taskId,
        agent: start.agent,
        status: 'running',
        input: JSON.stringify(start.input)
      }
    });
  }

  async finishRun(finish: RunFinish): Promise<void> {
    await this.db.agentRun.update({
      where: { id: finish.runId },
      data: {
        status: finish.status,
        output: finish.output === undefined ? null : JSON.stringify(finish.output),
        error: finish.error ?? null,
        turns: finish.spend.turns,
        tokensIn: finish.spend.tokensIn,
        tokensOut: finish.spend.tokensOut,
        usd: finish.spend.usd,
        wallClockMs: finish.spend.wallClockMs,
        validationFailures: finish.validationFailures,
        finishedAt: new Date()
      }
    });
  }

  async trace(event: TraceInput): Promise<void> {
    await this.db.traceEvent.create({
      data: {
        id: randomUUID(),
        taskId: event.taskId ?? null,
        agentRunId: event.agentRunId ?? null,
        actor: event.actor,
        kind: event.kind,
        summary: event.summary,
        detail: JSON.stringify(event.detail ?? {}),
        usd: event.usd ?? 0
      }
    });
  }
}

export interface TraceLine {
  at: Date;
  actor: string;
  kind: string;
  summary: string;
  usd: number;
}

export class TraceRepository {
  constructor(private readonly db: Blackboard) {}

  /** The story of one task, in order, in plain English. */
  async forTask(taskId: string): Promise<TraceLine[]> {
    const rows = await this.db.traceEvent.findMany({ where: { taskId }, orderBy: { at: 'asc' } });
    return rows.map((r) => ({ at: r.at, actor: r.actor, kind: r.kind, summary: r.summary, usd: r.usd }));
  }

  async recent(limit = 50): Promise<TraceLine[]> {
    const rows = await this.db.traceEvent.findMany({ orderBy: { at: 'desc' }, take: limit });
    return rows.map((r) => ({ at: r.at, actor: r.actor, kind: r.kind, summary: r.summary, usd: r.usd }));
  }
}
