/**
 * The arithmetic and the plumbing that need no database: the funnel, the
 * hang-up curve, objection filing, the bus, the intent parser and the static
 * file server's refusals.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { ConsoleBus } from '../../src/stream/bus.js';
import type { ConsoleEvent } from '../../src/stream/contract.js';
import { buildFunnel, buildHangupCurve, classifyObjection, funnelCounts, type CallFact } from '../../src/stream/facts.js';
import { parseIntent } from '../../src/stream/jarvis-intents.js';
import { registerConsoleStatic } from '../../src/stream/static.js';

function fact(over: Partial<CallFact> & { durationSec: number }): CallFact {
  const base: CallFact = {
    id: `c${Math.random()}`, contactId: 'x', accountId: 'a', startedAt: new Date(), endedAt: new Date(), live: false, durationSec: 0,
    outcome: 'not_interested', variant: 'hook v3', market: 'NZ', industry: 'fs', seniority: 'director', company: 'Co', name: 'N', title: 'T',
    marks: [], defects: 0, objections: [], hook: '', meetingStatus: null, recordingUrl: null, attentionLostAtSec: null, summary: [],
    answered: true, survivedOpener: false, realConversation: false, askMade: false, requested: false, confirmed: false
  };
  const f = { ...base, ...over };
  return f;
}

describe('the funnel', () => {
  const calls = [
    fact({ durationSec: 8 }),
    fact({ durationSec: 20, survivedOpener: true }),
    fact({ durationSec: 60, survivedOpener: true, realConversation: true, askMade: true }),
    fact({ durationSec: 95, survivedOpener: true, realConversation: true, askMade: true, requested: true, outcome: 'meeting_requested' }),
    fact({ durationSec: 25, answered: false, outcome: 'no_answer' })
  ];

  it('is nested, so no step can exceed the one above it', () => {
    const counts = funnelCounts(calls, 0, 0);
    expect(counts).toEqual([5, 5, 5, 4, 3, 2, 2, 1, 0]);
    for (let i = 1; i < counts.length; i++) expect(counts[i]).toBeLessThanOrEqual(counts[i - 1] as number);
  });

  it('forces queue-side counts to agree with the calls that really happened', () => {
    // 3 queued and 1 passed the gate cannot be true of 5 dials.
    expect(funnelCounts(calls, 3, 1).slice(0, 3)).toEqual([5, 5, 5]);
    // But a longer queue is kept, and the gate count is capped at the queue.
    expect(funnelCounts(calls, 12, 99).slice(0, 3)).toEqual([12, 12, 5]);
  });

  it('reports count, rate, absolute loss and the seven-day baseline for each stage', () => {
    const funnel = buildFunnel({ today: calls, baseline: calls.slice(0, 4), queued: 8, gatePassed: 6, baselineQueued: 4, baselineGatePassed: 4 });
    expect(funnel.map((s) => s.id)).toEqual(['queued', 'gate_passed', 'dialled', 'answered', 'survived_opener', 'real_conversation', 'ask_made', 'meeting_requested', 'confirmed']);
    const byId = Object.fromEntries(funnel.map((s) => [s.id, s]));
    expect(byId.queued).toMatchObject({ count: 8, rate: 1, loss: 0, baselineRate: 1 });
    expect(byId.gate_passed).toMatchObject({ count: 6, rate: 0.75, loss: 2 });
    expect(byId.dialled).toMatchObject({ count: 5, loss: 1 });
    expect(byId.answered).toMatchObject({ count: 4, rate: 0.8, loss: 1, baselineRate: 1 });
    expect(byId.meeting_requested).toMatchObject({ count: 1, rate: 0.5, loss: 1, baselineRate: 0.5 });
  });

  it('shows a stage level with itself when the baseline has nothing behind it, not against a made-up zero', () => {
    const funnel = buildFunnel({ today: calls, baseline: [], queued: 5, gatePassed: 5, baselineQueued: 0, baselineGatePassed: 0 });
    for (const stage of funnel) expect(stage.baselineRate).toBe(stage.rate);
  });
});

describe('the seconds-to-hangup curve', () => {
  it('bins finished, answered calls and ties each bin to its calls', () => {
    const calls = [
      fact({ id: 'a', durationSec: 4 }),
      fact({ id: 'b', durationSec: 7 }),
      fact({ id: 'c', durationSec: 62, marks: [{ stage: 'ask', atSecond: 50 }] }),
      fact({ id: 'ring', durationSec: 25, answered: false, outcome: 'no_answer' }),
      fact({ id: 'live', durationSec: 12, live: true, endedAt: null })
    ];
    const curve = buildHangupCurve(calls);
    expect(curve.binSeconds).toBe(5);
    expect(curve.bins[0]).toMatchObject({ fromSecond: 0, count: 1, callIds: ['a'] });
    expect(curve.bins[1]).toMatchObject({ fromSecond: 5, count: 1, callIds: ['b'] });
    expect(curve.bins[12]).toMatchObject({ fromSecond: 60, count: 1, callIds: ['c'] });
    // A voicemail is not someone losing interest, and a call on air has not hung up yet.
    expect(curve.bins.flatMap((b) => b.callIds)).not.toContain('ring');
    expect(curve.bins.flatMap((b) => b.callIds)).not.toContain('live');
  });

  it('overlays the six script sections in order, contiguous, from where calls really reached them', () => {
    const marks = [{ stage: 'disclosure' as const, atSecond: 0 }, { stage: 'ask' as const, atSecond: 50 }];
    const curve = buildHangupCurve([fact({ durationSec: 70, marks }), fact({ durationSec: 80, marks })]);
    expect(curve.sections.map((s) => s.id)).toEqual(['disclosure', 'reason', 'hook', 'value', 'ask', 'close']);
    expect(curve.sections.find((s) => s.id === 'ask')?.fromSecond).toBe(50);
    for (let i = 1; i < curve.sections.length; i++) {
      expect(curve.sections[i]?.fromSecond).toBe(curve.sections[i - 1]?.toSecond);
    }
  });
});

describe('objections', () => {
  it.each([
    ['We already have a partner for that.', 'has-a-partner'],
    ['Can you just send me an email?', 'send-email'],
    ['What does it cost?', 'wants-pricing'],
    ['Wait, am I talking to a robot?', 'asked-if-human'],
    ['Where did you get my number?', 'asked-where-number-came-from'],
    ['That sits with someone else.', 'not-the-right-person'],
    ['We are right in the middle of a release.', 'no-time-now'],
    ['The weather is lovely.', 'other']
  ])('files "%s" as %s', (said, kind) => {
    expect(classifyObjection(said)).toBe(kind);
  });
});

describe('the bus', () => {
  const snapshotEvent = { type: 'kill_switch', killSwitch: { engaged: false } } as ConsoleEvent;

  it('drops an event that does not match the contract, and says so', () => {
    const bus = new ConsoleBus();
    const heard = vi.fn();
    bus.subscribe(heard);
    expect(bus.publish({ type: 'stage', callId: 'x', stage: 'nonsense' } as unknown as ConsoleEvent)).toBe(false);
    expect(heard).not.toHaveBeenCalled();
    expect(bus.rejectedCount).toBe(1);
    expect(bus.publish(snapshotEvent)).toBe(true);
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it('keeps going when one listener throws, and stops delivering after unsubscribe', () => {
    const bus = new ConsoleBus();
    const heard = vi.fn();
    bus.subscribe(() => {
      throw new Error('a closed socket');
    });
    const off = bus.subscribe(heard);
    bus.publish(snapshotEvent);
    expect(heard).toHaveBeenCalledTimes(1);
    off();
    bus.publish(snapshotEvent);
    expect(heard).toHaveBeenCalledTimes(1);
    expect(bus.subscriberCount).toBe(1);
  });
});

describe('what Jarvis recognises', () => {
  it.each([
    ["what's my cost per meeting this month?", 'cost_per_meeting'],
    ['show me every call that died in the first ten seconds this week', 'early_hangups'],
    ['why did we stop calling Westpac?', 'why_stopped'],
    ['which hook is working in New Zealand?', 'best_hook'],
    ['read me the three calls that got closest', 'closest_calls'],
    ['what needs me', 'needs_me'],
    ['is dialling halted?', 'kill_status']
  ])('reads "%s" as a question (%s)', (query, kind) => {
    expect(parseIntent(query).kind).toBe(kind);
  });

  it('reads the numbers in a question', () => {
    expect(parseIntent('show me every call that died in the first ten seconds this week')).toMatchObject({ seconds: 10, period: 'week' });
    expect(parseIntent('read me the three calls that got closest')).toMatchObject({ count: 3 });
    expect(parseIntent('which hook is working in New Zealand')).toMatchObject({ market: 'NZ' });
  });

  it.each([
    ['pause the ANZ banking campaign', 'pause_campaign'],
    ['suppress this contact', 'suppress_contact'],
    ['requeue Priya for Thursday', 'requeue_contact'],
    ['roll back to the previous script', 'rollback_playbook'],
    ['stop all dialling', 'engage_kill'],
    ['please resume dialling', 'release_kill']
  ])('reads "%s" as an instruction (%s), never as something to run', (query, kind) => {
    const intent = parseIntent(query);
    expect(intent.kind).toBe('command');
    if (intent.kind === 'command') expect(intent.command.kind).toBe(kind);
  });

  it('does not take "stop calling" inside a question for an instruction', () => {
    expect(parseIntent('why did we stop calling Westpac').kind).toBe('why_stopped');
    expect(parseIntent('stop calling Westpac').kind).toBe('unknown');
  });

  it('names what it will not do', () => {
    for (const q of ["approve today's plan", 'call Priya now', 'unsuppress Priya', 'email the prospects', 'delete the calls']) {
      expect(parseIntent(q).kind, q).toBe('forbidden');
    }
  });
});

describe('serving the built console', () => {
  function app() {
    const dir = mkdtempSync(join(tmpdir(), 'console-dist-'));
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'index.html'), '<html>console</html>');
    writeFileSync(join(dir, 'assets', 'app.js'), 'console.log(1)');
    writeFileSync(join(tmpdir(), 'secret-outside-dist.txt'), 'nope');
    const server = Fastify();
    expect(registerConsoleStatic(server, dir)).toBe(true);
    return server;
  }

  it('serves the app, its assets, and the app again for a route it owns', async () => {
    const server = app();
    expect((await server.inject({ url: '/console/' })).body).toContain('console');
    expect((await server.inject({ url: '/console/assets/app.js' })).headers['content-type']).toContain('javascript');
    expect((await server.inject({ url: '/assets/app.js' })).statusCode).toBe(200);
    expect((await server.inject({ url: '/console/meetings' })).body).toContain('console');
  });

  it('refuses a path that climbs out of the build, and a missing asset', async () => {
    const server = app();
    expect((await server.inject({ url: '/console/..%2fsecret-outside-dist.txt' })).statusCode).toBe(404);
    expect((await server.inject({ url: '/console/%2e%2e/%2e%2e/etc/passwd' })).statusCode).toBe(404);
    expect((await server.inject({ url: '/console/assets/missing.js' })).statusCode).toBe(404);
    expect((await server.inject({ url: '/assets/../index.html' })).statusCode).toBe(404);
  });

  it('mounts nothing when there is no build', () => {
    expect(registerConsoleStatic(Fastify(), join(tmpdir(), 'no-such-dist-dir'))).toBe(false);
  });
});
