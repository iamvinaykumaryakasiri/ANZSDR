/**
 * Where a run's story is written.
 *
 * The runner records through this port rather than touching the database, so the
 * guarantees it provides can be tested without one, and so the console's agent
 * trace has a single well-defined source.
 */

import type { Spend } from './contract.js';

export interface RunStart {
  runId: string;
  taskId: string;
  agent: string;
  input: unknown;
}

export interface RunFinish {
  runId: string;
  status: 'succeeded' | 'failed' | 'escalated' | 'budget-exceeded';
  output?: unknown;
  error?: string;
  spend: Spend;
  validationFailures: number;
}

export interface TraceInput {
  taskId?: string;
  agentRunId?: string;
  actor: string;
  kind: string;
  /** One line, plain English, written to be read rather than parsed. */
  summary: string;
  detail?: Record<string, unknown>;
  usd?: number;
}

export interface AgentJournal {
  startRun(start: RunStart): Promise<void>;
  finishRun(finish: RunFinish): Promise<void>;
  trace(event: TraceInput): Promise<void>;
}

export interface JournalledTrace extends TraceInput {
  at: Date;
}

export class InMemoryJournal implements AgentJournal {
  readonly starts: RunStart[] = [];
  readonly finishes: RunFinish[] = [];
  readonly traces: JournalledTrace[] = [];

  async startRun(start: RunStart): Promise<void> {
    this.starts.push(start);
  }

  async finishRun(finish: RunFinish): Promise<void> {
    this.finishes.push(finish);
  }

  async trace(event: TraceInput): Promise<void> {
    this.traces.push({ ...event, at: new Date() });
  }
}
