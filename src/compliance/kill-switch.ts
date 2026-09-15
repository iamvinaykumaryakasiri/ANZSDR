/**
 * The kill switch (section 7.6).
 *
 * One command and one dashboard button stop all dialling. It is a plain flag with
 * a store behind it, checked by the gate on every single request, so nothing can
 * dial past it and nothing can talk it out of being tripped.
 */

import type { AuditLog } from './audit.js';
import { killSwitchRecord } from './audit.js';
import type { CompliancePolicy } from './policy.js';
import type { KillSwitchState, KillSwitchTripSource } from './types.js';

export interface KillSwitchStore {
  read(): Promise<KillSwitchState>;
  write(state: KillSwitchState): Promise<void>;
}

export class InMemoryKillSwitchStore implements KillSwitchStore {
  private state: KillSwitchState = { active: false };

  async read(): Promise<KillSwitchState> {
    return { ...this.state };
  }

  async write(state: KillSwitchState): Promise<void> {
    this.state = { ...state };
  }
}

export class KillSwitch {
  constructor(
    private readonly store: KillSwitchStore,
    private readonly audit: AuditLog
  ) {}

  async state(): Promise<KillSwitchState> {
    return this.store.read();
  }

  async trip(by: KillSwitchTripSource, reason: string, at: Date): Promise<KillSwitchState> {
    const current = await this.store.read();
    // Re-tripping keeps the original trip on the record: the first cause is the
    // one worth investigating.
    if (current.active) return current;
    const next: KillSwitchState = { active: true, trippedAt: at, trippedBy: by, reason };
    await this.store.write(next);
    await this.audit.append(killSwitchRecord(next, by, at));
    return next;
  }

  /** Only a human resets the kill switch. Nothing auto-resets. */
  async reset(actor: string, at: Date): Promise<KillSwitchState> {
    const next: KillSwitchState = { active: false };
    await this.store.write(next);
    await this.audit.append(killSwitchRecord(next, actor, at));
    return next;
  }
}

/** The signals the orchestrator feeds in on every tick. */
export interface SafetySignals {
  callsToday: number;
  escalationsToday: number;
  claimDefectsToday: number;
  /** Fraction of calls today that errored. */
  errorRate: number;
  /** Fraction of calls today that ended in negative sentiment. */
  negativeSentimentRate: number;
  /** False when the orchestrator has lost contact with the blackboard. */
  blackboardReachable: boolean;
}

export interface AutoTripVerdict {
  trip: boolean;
  source?: KillSwitchTripSource;
  reason?: string;
}

/**
 * Deterministic auto-trip evaluation. Rate-based conditions need a minimum
 * number of calls first, so one bad call in the morning does not stop the day.
 */
export function evaluateAutoTrip(signals: SafetySignals, policy: CompliancePolicy): AutoTripVerdict {
  const t = policy.kill_switch.auto_trip;

  if (!signals.blackboardReachable) {
    return {
      trip: true,
      source: 'blackboard-unreachable',
      reason: 'the orchestrator has lost contact with the blackboard; state cannot be trusted'
    };
  }
  if (signals.escalationsToday >= t.escalations_per_day) {
    return {
      trip: true,
      source: 'escalation-threshold',
      reason: `${signals.escalationsToday} escalations today (threshold ${t.escalations_per_day})`
    };
  }
  if (signals.claimDefectsToday >= t.claim_defects_per_day) {
    return {
      trip: true,
      source: 'claim-defect-threshold',
      reason: `${signals.claimDefectsToday} unsupported-claim defects today (threshold ${t.claim_defects_per_day})`
    };
  }
  if (signals.callsToday >= t.min_calls_before_rate_trips) {
    if (signals.errorRate > t.error_rate) {
      return {
        trip: true,
        source: 'error-rate',
        reason: `error rate ${(signals.errorRate * 100).toFixed(1)}% over ${signals.callsToday} calls (threshold ${(t.error_rate * 100).toFixed(1)}%)`
      };
    }
    if (signals.negativeSentimentRate > t.negative_sentiment_rate) {
      return {
        trip: true,
        source: 'sentiment-collapse',
        reason: `${(signals.negativeSentimentRate * 100).toFixed(1)}% of calls ended negatively over ${signals.callsToday} calls (threshold ${(t.negative_sentiment_rate * 100).toFixed(1)}%)`
      };
    }
  }
  return { trip: false };
}
