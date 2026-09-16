/**
 * Per-run budget enforcement.
 *
 * The meter is checked on every charge and again before the run is allowed to
 * return, so a handler cannot spend its way past the ceiling and then hand back
 * a result as though nothing happened. Breaching throws, and a throw becomes an
 * escalation - never a quietly truncated answer.
 */

import type { AgentBudget, Spend } from './contract.js';
import { BudgetExceeded } from './errors.js';

export type Clock = () => number;

export class BudgetMeter {
  private turns = 0;
  private tokensIn = 0;
  private tokensOut = 0;
  private usd = 0;
  private readonly startedAt: number;

  constructor(
    private readonly budget: AgentBudget,
    private readonly now: Clock = Date.now
  ) {
    this.startedAt = now();
  }

  get spend(): Spend {
    return {
      turns: this.turns,
      tokensIn: this.tokensIn,
      tokensOut: this.tokensOut,
      usd: Number(this.usd.toFixed(6)),
      wallClockMs: this.now() - this.startedAt
    };
  }

  get elapsedMs(): number {
    return this.now() - this.startedAt;
  }

  /** Remaining wall clock, floored at zero. Drives the run's abort timer. */
  get remainingMs(): number {
    return Math.max(0, this.budget.maxWallClockMs - this.elapsedMs);
  }

  chargeTurn(usage: { tokensIn?: number; tokensOut?: number; usd?: number } = {}): void {
    this.turns += 1;
    this.tokensIn += usage.tokensIn ?? 0;
    this.tokensOut += usage.tokensOut ?? 0;
    this.usd += usage.usd ?? 0;
    this.assertWithinBudget();
  }

  chargeUsd(usd: number): void {
    this.usd += usd;
    this.assertWithinBudget();
  }

  /** Throws if anything is over. Called on every charge and once before returning. */
  assertWithinBudget(): void {
    if (this.turns > this.budget.maxTurns) {
      throw new BudgetExceeded('maxTurns', `used ${this.turns} turns, budget is ${this.budget.maxTurns}`, {
        spend: this.spend
      });
    }
    const tokens = this.tokensIn + this.tokensOut;
    if (tokens > this.budget.maxTokens) {
      throw new BudgetExceeded('maxTokens', `used ${tokens} tokens, budget is ${this.budget.maxTokens}`, {
        spend: this.spend
      });
    }
    if (this.usd > this.budget.maxUsd) {
      throw new BudgetExceeded('maxUsd', `spent $${this.usd.toFixed(4)}, budget is $${this.budget.maxUsd.toFixed(4)}`, {
        spend: this.spend
      });
    }
    if (this.elapsedMs > this.budget.maxWallClockMs) {
      throw new BudgetExceeded(
        'maxWallClockMs',
        `ran for ${this.elapsedMs}ms, budget is ${this.budget.maxWallClockMs}ms`,
        { spend: this.spend }
      );
    }
  }
}
