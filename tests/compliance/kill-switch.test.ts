import { describe, expect, it } from 'vitest';
import { InMemoryAuditLog } from '../../src/compliance/audit.js';
import {
  evaluateAutoTrip,
  InMemoryKillSwitchStore,
  KillSwitch,
  type SafetySignals
} from '../../src/compliance/kill-switch.js';
import { policy } from '../support/fixtures.js';

const NOW = new Date('2026-03-11T02:30:00Z');

function quiet(over: Partial<SafetySignals> = {}): SafetySignals {
  return {
    callsToday: 0,
    escalationsToday: 0,
    claimDefectsToday: 0,
    errorRate: 0,
    negativeSentimentRate: 0,
    blackboardReachable: true,
    ...over
  };
}

describe('KillSwitch', () => {
  it('starts off and trips on command', async () => {
    const audit = new InMemoryAuditLog();
    const ks = new KillSwitch(new InMemoryKillSwitchStore(), audit);
    expect((await ks.state()).active).toBe(false);

    const tripped = await ks.trip('operator', 'Vinay pressed Stop All', NOW);
    expect(tripped.active).toBe(true);
    expect(tripped.trippedBy).toBe('operator');
    expect((await audit.read())[0]?.summary).toContain('TRIPPED');
  });

  it('keeps the first cause when tripped again', async () => {
    const audit = new InMemoryAuditLog();
    const ks = new KillSwitch(new InMemoryKillSwitchStore(), audit);
    await ks.trip('error-rate', 'first cause', NOW);
    const second = await ks.trip('operator', 'second cause', new Date(NOW.getTime() + 1000));
    expect(second.reason).toBe('first cause');
    expect(await audit.read()).toHaveLength(1);
  });

  it('only resets when a human does it, and says so in the log', async () => {
    const audit = new InMemoryAuditLog();
    const ks = new KillSwitch(new InMemoryKillSwitchStore(), audit);
    await ks.trip('operator', 'stop', NOW);
    const reset = await ks.reset('vinay', new Date(NOW.getTime() + 60_000));
    expect(reset.active).toBe(false);
    expect((await audit.read())[1]?.summary).toContain('reset');
  });
});

describe('evaluateAutoTrip', () => {
  const p = policy();

  it('does nothing on a quiet day', () => {
    expect(evaluateAutoTrip(quiet(), p)).toEqual({ trip: false });
  });

  it('trips when the blackboard goes dark, before anything else is considered', () => {
    const v = evaluateAutoTrip(quiet({ blackboardReachable: false, escalationsToday: 99 }), p);
    expect(v.source).toBe('blackboard-unreachable');
  });

  it('trips on the third escalation of the day', () => {
    expect(evaluateAutoTrip(quiet({ escalationsToday: 2 }), p).trip).toBe(false);
    expect(evaluateAutoTrip(quiet({ escalationsToday: 3 }), p).source).toBe('escalation-threshold');
  });

  it('trips on unsupported-claim defects', () => {
    expect(evaluateAutoTrip(quiet({ claimDefectsToday: 5 }), p).source).toBe('claim-defect-threshold');
  });

  it('ignores rate signals until there are enough calls to mean anything', () => {
    expect(evaluateAutoTrip(quiet({ callsToday: 9, errorRate: 1, negativeSentimentRate: 1 }), p).trip).toBe(false);
  });

  it('trips on error rate once the sample is big enough', () => {
    const v = evaluateAutoTrip(quiet({ callsToday: 20, errorRate: 0.25 }), p);
    expect(v.source).toBe('error-rate');
    expect(v.reason).toContain('25.0%');
  });

  it('trips on sentiment collapse', () => {
    const v = evaluateAutoTrip(quiet({ callsToday: 20, negativeSentimentRate: 0.5 }), p);
    expect(v.source).toBe('sentiment-collapse');
  });

  it('leaves a sample that is exactly at threshold alone', () => {
    expect(evaluateAutoTrip(quiet({ callsToday: 20, errorRate: 0.1, negativeSentimentRate: 0.4 }), p).trip).toBe(false);
  });
});
