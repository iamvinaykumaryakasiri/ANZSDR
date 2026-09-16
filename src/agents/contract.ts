/**
 * The sub-agent contract (brief section 3.1).
 *
 * A sub-agent is its contract plus a handler. The contract declares what it may
 * receive, what it must return, the only tools it can reach, and what it is
 * allowed to spend. Everything else about it - which model, which prompt - is
 * data, not code.
 *
 * Nothing calls a handler directly. `runAgent` in `runner.ts` is the only way in,
 * because the guarantees live in the runner, not in the goodwill of the handler.
 */

import type { z } from 'zod';

export interface AgentBudget {
  /** Model turns. One request/response exchange is one turn. */
  maxTurns: number;
  /** Input plus output tokens across the whole run. */
  maxTokens: number;
  maxWallClockMs: number;
  maxUsd: number;
}

export type EscalationTarget = 'orchestrator' | 'human';

/** A tool is the only way a sub-agent reaches anything outside its own input. */
export interface AgentTool<I = unknown, O = unknown> {
  name: string;
  description: string;
  // The third type parameter stays `unknown` so a schema with defaults or
  // coercions can accept raw input and still produce a fully-populated value.
  input: z.ZodType<I, z.ZodTypeDef, unknown>;
  handler: (args: I) => Promise<O>;
  /** What one invocation costs, if it costs anything. Charged against the budget. */
  usdPerCall?: number;
}

export interface AgentContract<I, O> {
  name: string;
  /** Path to the system prompt, relative to the repository root. */
  role: string;
  model: string;
  input: z.ZodType<I, z.ZodTypeDef, unknown>;
  output: z.ZodType<O, z.ZodTypeDef, unknown>;
  tools: AgentTool[];
  budget: AgentBudget;
  escalatesTo: EscalationTarget;
}

export interface Spend {
  turns: number;
  tokensIn: number;
  tokensOut: number;
  usd: number;
  wallClockMs: number;
}

export const ZERO_SPEND: Spend = { turns: 0, tokensIn: 0, tokensOut: 0, usd: 0, wallClockMs: 0 };

/** What a handler is given. Deliberately narrow: validated input, its own tools, its meter. */
export interface AgentContext<I> {
  input: I;
  /** Invoke one of the contract's tools by name. Anything else throws. */
  call<T = unknown>(tool: string, args: unknown): Promise<T>;
  /** Record a model turn and its tokens. Throws the moment the budget is breached. */
  charge(usage: { tokensIn?: number; tokensOut?: number; usd?: number }): void;
  /** One plain-English line for the trace. */
  note(summary: string, detail?: Record<string, unknown>): void;
  /** Aborts when the wall-clock budget runs out. */
  signal: AbortSignal;
}

export type AgentHandler<I, O> = (ctx: AgentContext<I>) => Promise<O>;

export interface Agent<I, O> {
  contract: AgentContract<I, O>;
  handler: AgentHandler<I, O>;
}

export function defineAgent<I, O>(contract: AgentContract<I, O>, handler: AgentHandler<I, O>): Agent<I, O> {
  return { contract, handler };
}
