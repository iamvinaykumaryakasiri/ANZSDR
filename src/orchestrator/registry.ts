/**
 * What each kind of task means: which sub-agent does it, and what happens to the
 * result.
 *
 * Follow-on work is decided here, by the orchestrator, and never by the agent
 * that produced the output. A sub-agent returns a result; it does not get to
 * decide what the system does next. That is what keeps the task graph
 * inspectable and keeps one agent from quietly driving another.
 */

import type { Agent } from '../agents/contract.js';
import type { Blackboard } from '../blackboard/client.js';
import type { TaskRecord, TaskSpec } from '../blackboard/repositories.js';

export interface TaskEffectContext {
  db: Blackboard;
  task: TaskRecord;
  now: Date;
}

export interface TaskKind<I = unknown, O = unknown> {
  kind: string;
  agent: Agent<I, O>;
  /**
   * Write the result to the blackboard and say what should happen next.
   * Returns the tasks to queue; the orchestrator creates them.
   */
  apply(output: O, ctx: TaskEffectContext): Promise<TaskSpec[]>;
}

export class TaskRegistry {
  private readonly kinds = new Map<string, TaskKind<never, never>>();

  register<I, O>(kind: TaskKind<I, O>): this {
    this.kinds.set(kind.kind, kind as unknown as TaskKind<never, never>);
    return this;
  }

  get(kind: string): TaskKind<never, never> | undefined {
    return this.kinds.get(kind);
  }

  known(): string[] {
    return [...this.kinds.keys()].sort();
  }
}
