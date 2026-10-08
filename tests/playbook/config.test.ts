import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { coachWeeklyKind, COACH_WEEKLY } from '../../src/agents/coach/kind.js';
import { createCoach } from '../../src/agents/coach/agent.js';
import { loadCoachConfig, loadCoachConfigFromObject, MIN_CONVERSATIONS_FLOOR } from '../../src/playbook/config.js';
import { ROOT, coachConfig } from './support.js';

const raw = (): { promotion: Record<string, unknown> & { degradation: Record<string, unknown> }; [k: string]: unknown } =>
  parseYaml(readFileSync(resolve(ROOT, 'config/coach.yaml'), 'utf8')) as never;

describe('config/coach.yaml can only make promotion harder', () => {
  it('loads as shipped, at the brief\'s floors', () => {
    const c = loadCoachConfig(resolve(ROOT, 'config/coach.yaml'));
    expect(c.promotion.minConversationsPerArm).toBe(MIN_CONVERSATIONS_FLOOR);
    expect(c.promotion.hardFailKinds).toContain('disclosure-missing');
    expect(c.promotion.alpha).toBeLessThanOrEqual(0.1);
    expect(c.assignment.challengerShare).toBe(0.5);
  });

  const refuses: Array<[string, (c: ReturnType<typeof raw>) => void, RegExp]> = [
    ['fewer than 30 conversations per arm', (c) => (c.promotion.min_conversations_per_arm = 29), /29|greater than or equal to 30/],
    ['a ceiling below the floor', (c) => (c.promotion.max_conversations_per_arm = 20), /cannot be below/],
    ['an alpha that would promote on a coin flip', (c) => (c.promotion.alpha = 0.5), /less than or equal to 0.1/],
    ['a lift smaller than noise', (c) => (c.promotion.min_absolute_lift = 0.001), /greater than or equal to 0.02/],
    ['a lax completion tolerance', (c) => (c.promotion.degradation.max_completion_drop = 0.5), /less than or equal to 0.1/],
    ['a hard-fail list without the disclosure', (c) => (c.promotion.hard_fail_kinds = ['banned-topic']), /must include disclosure-missing/],
    ['a defect list that stops counting the disclosure', (c) => (c.promotion.defect_kinds_counted = ['banned-topic']), /defect_kinds_counted must include/],
    ['a watch shorter than the floor', (c) => ((c.monitoring as Record<string, unknown>).post_promotion_min_conversations = 5), /30/],
    ['an unknown defect kind', (c) => (c.promotion.hard_fail_kinds = ['disclosure-missing', 'made-up']), /Invalid enum/]
  ];
  it.each(refuses)('refuses %s', (_name, mutate, message) => {
    const c = raw();
    mutate(c);
    expect(() => loadCoachConfigFromObject(c)).toThrow(message);
  });

  it('accepts a stricter file', () => {
    const c = raw();
    c.promotion.min_conversations_per_arm = 60;
    c.promotion.alpha = 0.01;
    expect(loadCoachConfigFromObject(c).promotion).toMatchObject({ minConversationsPerArm: 60, alpha: 0.01 });
  });
});

describe('Coach as a Director task', () => {
  it('names the kind and applies a result by running it through the gate', async () => {
    const kind = coachWeeklyKind(createCoach({ model: { instanceId: 'p', propose: async () => ({ output: {} }) }, config: coachConfig(), tools: [] }), () => {
      throw new Error('reached cycle deps');
    });
    expect(kind.kind).toBe(COACH_WEEKLY);
    await expect(
      kind.apply(
        { weekEnding: '2026-10-05', slot: 'hook', focusReason: 'x', proposals: [], discarded: [], variantPerformance: [], failures: [], changeNote: 'x', noProposalReason: null },
        {} as never
      )
    ).rejects.toThrow('reached cycle deps');
  });
});
