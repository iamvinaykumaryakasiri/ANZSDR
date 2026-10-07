/**
 * The shipped model configuration has to load.
 *
 * A malformed config/models.yaml fails at the first real call, which is the
 * worst moment to find out. This finds out on every commit instead.
 */

import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadModelConfig, modelConfigSchema } from '../../src/voice/claude-model.js';
import { ROOT } from '../support/fixtures.js';

describe('config/models.yaml', () => {
  const config = loadModelConfig(resolve(ROOT, 'config/models.yaml'));

  it('loads, and names a model for every job that needs one', () => {
    expect(config.caller).toMatch(/^claude-/);
    expect(config.scribe).toMatch(/^claude-/);
    expect(config.guardian_check).toMatch(/^claude-/);
    expect(config.guardian_audit).toMatch(/^claude-/);
  });

  it('keeps a turn short, because a turn is one or two sentences', () => {
    expect(config.max_turn_tokens).toBeLessThanOrEqual(600);
  });

  it('gives the post-call audit a different model from the in-call brain', () => {
    // Section 4: "a stronger model for Guardian's audit pass". Auditing with the
    // same model that made the claim is asking it to mark its own homework.
    expect(config.guardian_audit).not.toBe(config.caller);
  });

  it('refuses a config that leaves a job without a model', () => {
    expect(() => modelConfigSchema.parse({ caller: 'x', max_turn_tokens: 10 })).toThrow();
  });
});
