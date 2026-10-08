import { describe, expect, it } from 'vitest';
import type { CallerModel } from '../../src/agents/caller/brain.js';
import type { CheckModel } from '../../src/agents/guardian/check.js';
import { formatLatencyReport, stats, summariseLatency } from '../../src/voice/latency.js';
import { probeLatency } from '../../src/voice/latency-probe.js';

describe('latency statistics', () => {
  it('uses nearest-rank percentiles', () => {
    const s = stats([100, 200, 300, 400, 500, 600, 700, 800, 900, 1000]);
    expect(s).toEqual({ n: 10, p50: 500, p95: 1000, max: 1000, mean: 550 });
  });

  it('is null for no data, and ignores junk', () => {
    expect(stats([])).toBeNull();
    expect(stats([Number.NaN, -5])).toBeNull();
    expect(stats([300])).toEqual({ n: 1, p50: 300, p95: 300, max: 300, mean: 300 });
  });
});

describe('summarising a call', () => {
  const turn = (firstTokenMs: number, extra = {}) => ({ firstTokenMs, totalMs: firstTokenMs + 400, held: false, interrupted: false, ...extra });

  it('judges on the provider\'s perceived figure when it gave one', () => {
    const s = summariseLatency([turn(300), turn(350)], [700, 900], 800);
    expect(s.basis).toBe('perceived');
    expect(s.perceived?.p95).toBe(900);
    expect(s.withinTarget).toBe(false);
    expect(s.turns.map((t) => t.perceivedMs)).toEqual([700, 900]);
    expect(s.perceivedSamplesMs).toEqual([700, 900]);
  });

  it('falls back to first-token, and says that is what it judged on', () => {
    const s = summariseLatency([turn(300), turn(450)], [], 800);
    expect(s.basis).toBe('first-token');
    expect(s.perceived).toBeNull();
    expect(s.withinTarget).toBe(true);
  });

  it('does not pair the provider\'s turns with ours when the counts disagree', () => {
    const s = summariseLatency([turn(300), turn(350), turn(400)], [700, 900], 800);
    expect(s.turns.map((t) => t.perceivedMs)).toEqual([null, null, null]);
    expect(s.perceived?.n).toBe(2);
  });

  it('leaves interrupted turns out of first-token: nobody waited for them', () => {
    const s = summariseLatency([turn(300), turn(5000, { interrupted: true })], [], 800);
    expect(s.firstToken?.n).toBe(1);
    expect(s.withinTarget).toBe(true);
  });

  it('has no verdict without data', () => {
    expect(summariseLatency([], [], 800)).toMatchObject({ basis: 'none', withinTarget: null });
  });
});

describe('the text report', () => {
  it('says plainly when there is nothing', () => {
    expect(formatLatencyReport([], 800)).toContain('No calls with latency data yet');
  });

  it('shows each call and flags slow turns', () => {
    const summary = summariseLatency(
      [
        { firstTokenMs: 300, totalMs: 900, held: false, interrupted: false },
        { firstTokenMs: 1400, totalMs: 1700, held: true, interrupted: false }
      ],
      [],
      800
    );
    const text = formatLatencyReport([{ callId: 'abcdef12-0000', startedAt: new Date('2026-10-13T02:00:00Z'), summary }], 800);
    expect(text).toContain('abcdef12');
    expect(text).toContain('OVER TARGET');
    expect(text).toContain('turn 2 took 1400ms to first words (held for Guardian layer two)');
    expect(text).toContain('No perceived figures');
  });
});

describe('the probe', () => {
  it('drives the real endpoint and times each turn, including a held one', async () => {
    let now = 0;
    const caller: CallerModel = {
      async *stream() {
        now += 120;
        yield 'Thanks for that. ';
        now += 30;
        yield 'Tell me a bit more.';
      },
      toolCalls: () => []
    };
    const check: CheckModel = { judge: async () => ({ verdict: 'safe' }) };

    const turns = await probeLatency({
      caller,
      check,
      system: 'briefing',
      opening: 'Hi, my name is Lexi.',
      lines: ['Go ahead.', 'Are you a real person?'],
      clock: () => now
    });

    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatchObject({ prospectSaid: 'Go ahead.', held: false });
    expect(turns[0]?.reply).toContain('Thanks for that.');
    // The sentence is released when it completes, which is after the first chunk.
    expect(turns[0]?.firstTokenMs).toBe(120);
    expect(turns[0]?.totalMs).toBe(150);
    expect(turns[1]?.held).toBe(true);
  });
});
