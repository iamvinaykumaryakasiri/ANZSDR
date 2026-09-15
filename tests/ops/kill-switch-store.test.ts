import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileKillSwitchStore } from '../../src/ops/kill-switch-store.js';

describe('FileKillSwitchStore', () => {
  it('reports dialling permitted before anything has ever been written', async () => {
    const store = new FileKillSwitchStore(join(mkdtempSync(join(tmpdir(), 'ks-')), 'kill-switch.json'));
    expect(await store.read()).toEqual({ active: false });
  });

  it('round-trips a trip and a reset across processes', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'ks-')), 'nested', 'kill-switch.json');
    const writer = new FileKillSwitchStore(path);
    const at = new Date('2026-03-11T02:30:00Z');
    await writer.write({ active: true, trippedAt: at, trippedBy: 'error-rate', reason: 'too many failures' });

    // A separate instance, as the CLI and the dialler would be.
    const reader = new FileKillSwitchStore(path);
    const state = await reader.read();
    expect(state.active).toBe(true);
    expect(state.trippedAt?.toISOString()).toBe(at.toISOString());
    expect(state.trippedBy).toBe('error-rate');
    expect(state.reason).toBe('too many failures');

    await writer.write({ active: false });
    expect(await reader.read()).toEqual({ active: false });
  });
});
