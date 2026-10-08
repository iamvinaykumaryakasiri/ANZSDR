/**
 * Demo mode: a sample world that is unmistakably sample, in a file of its own,
 * with no way to dial or send.
 */

import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyMigrations, createBlackboard } from '../../src/blackboard/client.js';
import { DENY_CODES } from '../../src/compliance/types.js';
import { ConsoleBus } from '../../src/stream/bus.js';
import { consoleSnapshotSchema, type ConsoleEvent } from '../../src/stream/contract.js';
import { assertDemoDatabase, createDemoConsole, type DemoConsole } from '../../src/stream/demo/console.js';
import { FIRST_NAMES, LIVE_PROSPECTS, SURNAMES } from '../../src/stream/demo/data.js';
import { seedDemo } from '../../src/stream/demo/seed.js';
import { LiveCallSimulator } from '../../src/stream/demo/simulator.js';
import { Jarvis } from '../../src/stream/jarvis.js';
import { buildSnapshot, SnapshotService } from '../../src/stream/snapshot.js';
import { setKillSwitch } from '../../src/stream/kill.js';
import { REPO_ROOT } from '../../src/config/env.js';

/** Wednesday 7 October 2026, noon in Sydney: inside the calling window, so the gate runs on the real clock. */
const NOON = new Date('2026-10-07T01:00:00.000Z');
/** Sunday night: the window is shut, so the demo has to move the gate's question. */
const SUNDAY_NIGHT = new Date('2026-10-11T12:00:00.000Z');

// Seeding a whole sample world is a few seconds of honest database work.
vi.setConfig({ testTimeout: 60_000 });

const made: DemoConsole[] = [];
afterEach(async () => {
  for (const d of made.splice(0)) await d.close();
});

async function demo(now: Date = NOON): Promise<DemoConsole> {
  const dir = mkdtempSync(join(tmpdir(), 'anzsdr-demo-test-'));
  const d = await createDemoConsole({ dbPath: join(dir, 'console-demo.db'), now: () => now, bus: new ConsoleBus() });
  made.push(d);
  return d;
}

describe('the demo database guard', () => {
  it('refuses the real blackboard and any file not named for the demo', () => {
    expect(() => assertDemoDatabase('data/anzsdr.db')).toThrow(/demo/);
    expect(() => assertDemoDatabase('data/other.db')).toThrow(/"demo" in its file name/);
    expect(() => assertDemoDatabase('data/demo/console-demo.db', { DATABASE_URL: 'file:./data/demo/console-demo.db' })).toThrow(/real blackboard/);
    expect(assertDemoDatabase('data/demo/console-demo.db', {})).toBe(join(REPO_ROOT, 'data/demo/console-demo.db'));
  });

  it('refuses to seed into a database that already holds anything', async () => {
    const d = await demo();
    await expect(
      seedDemo(d.db, { now: NOON, gateAt: NOON, policy: d.deps.policy, calendar: d.deps.calendar, gate: d.deps.gate, plans: d.deps.plans, identity: { agent: { name: 'Lexi', gender: 'female', accent: 'au-neutral' }, operator: { name: 'V', title: 'T', company: 'C', team: 't', email: '' }, callback: { number: '' } } })
    ).rejects.toThrow(/refusing to seed/);
    const fresh = createBlackboard(`file:${join(mkdtempSync(join(tmpdir(), 'anzsdr-demo-empty-')), 'x-demo.db')}`);
    await applyMigrations(fresh);
    expect(await fresh.campaign.count()).toBe(0);
    await fresh.$disconnect();
  });
});

describe('the demo world', () => {
  it('is a labelled snapshot of the whole console, in a world of obviously invented people', async () => {
    const d = await demo();
    const s = await buildSnapshot(d.deps);
    expect(consoleSnapshotSchema.safeParse(s).success).toBe(true);
    expect(s.mode).toBe('demo');
    expect(s.briefing.headline).toMatch(/^Demo data\./);
    expect(s.standingBy.note).toContain('Demo data');

    // About forty calls, three requests waiting, one escalation, a queue, a champion and a challenger.
    expect(d.summary.calls).toBeGreaterThanOrEqual(38);
    expect(d.summary.calls).toBeLessThanOrEqual(46);
    expect(s.needsYou.meetingRequests).toHaveLength(3);
    expect(s.needsYou.escalations).toHaveLength(1);
    expect(s.upNext.length).toBeGreaterThanOrEqual(10);
    expect(s.playbook.champion.version).toBe('hook v3');
    expect(s.playbook.challenger).toMatchObject({ version: 'hook v4', minConversations: 30 });
    expect(s.playbook.history.map((h) => h.outcome)).toEqual(expect.arrayContaining(['champion', 'running', 'rolled_back', 'promoted']));
    expect(s.objections.length).toBeGreaterThanOrEqual(4);
    expect(s.health.providers.length).toBeGreaterThan(4);
    expect(s.today.dialled).toBeGreaterThan(0);
    expect(s.funnel.every((f, i) => i === 0 || f.count <= (s.funnel[i - 1]?.count ?? 0))).toBe(true);
  });

  it('gives each pending request windows on both clocks, in different zones', async () => {
    const d = await demo();
    const s = await buildSnapshot(d.deps);
    const labels = s.needsYou.meetingRequests.flatMap((m) => m.windows.map((w) => w.localLabel));
    expect(labels.some((l) => l.endsWith('NZDT'))).toBe(true);
    expect(labels.some((l) => l.endsWith('AWST'))).toBe(true);
    expect(labels.some((l) => l.endsWith('AEST'))).toBe(true);
    for (const m of s.needsYou.meetingRequests) {
      expect(m.ref).toMatch(/^MR-[0-9A-F]{8}$/);
      expect(m.windows.length).toBeGreaterThan(0);
      for (const w of m.windows) expect(w.sydneyLabel).toMatch(/ Sydney$/);
      expect(m.draftReply).toContain('Hi ');
    }
  });

  it('is invented throughout: no real names, no real organisations, no real domains', async () => {
    const d = await demo();
    const people = await d.db.contact.findMany({ include: { account: true } });
    expect(people.length).toBeGreaterThan(40);
    for (const p of people) {
      expect(FIRST_NAMES, p.firstName).toContain(p.firstName);
      expect(SURNAMES, p.lastName).toContain(p.lastName);
      expect(p.account.name.startsWith('Demo ')).toBe(true);
      expect(p.account.domain.endsWith('.example')).toBe(true);
      expect(p.source).toBe('demo');
    }
    for (const prospect of LIVE_PROSPECTS) expect(prospect.company.startsWith('Demo ')).toBe(true);
  });

  it('shows the real gate saying yes and no, with real reason codes, even when run on a Sunday night', async () => {
    const d = await demo(SUNDAY_NIGHT);
    expect(d.gateAt.getTime()).toBeGreaterThan(SUNDAY_NIGHT.getTime());
    const s = await buildSnapshot(d.deps);
    const reasons = new Set(s.upNext.flatMap((q) => q.gate.reasons));
    expect(s.upNext.some((q) => q.gate.allowed)).toBe(true);
    expect(s.upNext.some((q) => !q.gate.allowed)).toBe(true);
    for (const reason of reasons) expect(DENY_CODES).toContain(reason);
    expect(reasons).toEqual(expect.objectContaining(new Set(['MOBILE_DIALLING_DISABLED', 'ATTEMPT_CAP_REACHED', 'MIN_INTERVAL_NOT_ELAPSED', 'ACCOUNT_WEEKLY_CAP', 'SUPPRESSED'])));
    // Moving the question is said out loud, in the note.
    expect(s.standingBy.note).toMatch(/evaluated as at .* Sydney time/);
    // And the gate's rules were not touched: calls made when the window is open are the only ones allowed.
    expect(s.upNext.filter((q) => q.gate.allowed).every((q) => q.gate.reasons.length === 0)).toBe(true);
  });
});

describe('demo mode cannot dial or send', () => {
  it('is wired with no dialler, voice provider, SMS sender or mailer to reach', async () => {
    const d = await demo();
    expect(Object.keys(d.deps).sort()).toEqual(
      ['audit', 'calendar', 'db', 'demo', 'env', 'gate', 'gateAt', 'killSwitch', 'live', 'meetings', 'mode', 'now', 'operator', 'plans', 'policy', 'suppressions', 'bus'].sort()
    );
    expect(d.deps.env).toEqual({});
    expect(d.deps.operator.email).toBe('');
    expect(d.deps.jarvisModel).toBeUndefined();
  });

  it('keeps its own database, and its Stop all never touches the real kill-switch file', async () => {
    const real = join(REPO_ROOT, 'data/kill-switch.json');
    const before = existsSync(real) ? readFileSync(real, 'utf8') : null;
    const d = await demo();
    expect(d.dbPath).not.toBe(join(REPO_ROOT, 'data/anzsdr.db'));
    const view = await setKillSwitch(d.deps, true, 'demo test');
    expect(view.engaged).toBe(true);
    expect((await d.deps.killSwitch.state()).active).toBe(true);
    expect((await buildSnapshot(d.deps)).upNext.every((q) => q.gate.reasons.includes('KILL_SWITCH_ACTIVE'))).toBe(true);
    expect(existsSync(real) ? readFileSync(real, 'utf8') : null).toBe(before);
    await setKillSwitch(d.deps, false);
  });

  it('answers a meeting request in the demo database and mails nobody', async () => {
    const d = await demo();
    const jarvis = new Jarvis(d.deps, new SnapshotService(d.deps));
    const s = await buildSnapshot(d.deps);
    const ref = s.needsYou.meetingRequests[0]?.ref as string;
    const { decideMeeting } = await import('../../src/stream/meeting-views.js');
    expect((await decideMeeting(d.deps, ref, 'CONFIRMED')).kind).toBe('applied');
    expect((await buildSnapshot(d.deps)).needsYou.meetingRequests).toHaveLength(2);
    expect(await jarvis.ask('what needs me')).toMatchObject({ kind: 'answer' });
  });
});

describe('the live-call simulator', () => {
  function simulator(opts: { kill?: () => boolean } = {}) {
    const bus = new ConsoleBus();
    const events: ConsoleEvent[] = [];
    bus.subscribe((e) => events.push(e));
    let clock = NOON.getTime();
    const sim = new LiveCallSimulator({
      bus,
      killSwitch: { state: async () => ({ active: opts.kill?.() ?? false }) },
      now: () => new Date(clock),
      sleep: async (ms) => {
        clock += ms;
        await new Promise((r) => setImmediate(r));
      },
      random: () => 0.5,
      openingFor: (p) => [
        "Hi, my name's Lexi.",
        "I should say up front — I'm an AI assistant, not a person.",
        'I work with Vinay Kumar, Sales Director at Hexaware Technologies, on the ANZ sales team.',
        `I'm calling about ${p.hook}.`,
        "This call is being recorded — do let me know if you'd rather it wasn't.",
        'Have you got thirty seconds for me to explain why I called?'
      ]
    });
    return { sim, events, bus };
  }

  it('plays a call from disclosure to close, a turn every two to four seconds, and then is off air', async () => {
    const { sim, events } = simulator();
    await sim.playCall(LIVE_PROSPECTS[0]!);

    expect(events[0]?.type).toBe('call_started');
    const stages = events.filter((e) => e.type === 'stage').map((e) => (e as Extract<ConsoleEvent, { type: 'stage' }>).stage);
    expect(stages).toEqual(['reason', 'hook', 'value', 'ask', 'close']);
    const turns = events.filter((e) => e.type === 'transcript').map((e) => (e as Extract<ConsoleEvent, { type: 'transcript' }>).turn);
    expect(turns[0]?.speaker).toBe('lexi');
    // The AI disclosure is in the first fifteen seconds, as the brief requires of every call.
    const disclosure = turns.find((t) => /AI assistant/.test(t.text));
    expect(disclosure).toBeDefined();
    expect(disclosure!.atSecond).toBeLessThanOrEqual(15);
    for (let i = 1; i < turns.length; i++) {
      const gap = (turns[i]?.atSecond ?? 0) - (turns[i - 1]?.atSecond ?? 0);
      expect(gap).toBeGreaterThanOrEqual(2);
      expect(gap).toBeLessThanOrEqual(4);
    }
    const ended = events[events.length - 1];
    expect(ended).toMatchObject({ type: 'call_ended', outcome: 'meeting_requested' });
    expect(await sim.current(new Date())).toBeNull();
    // Nothing Lexi says is a time stated as booked.
    expect(turns.map((t) => t.text).join(' ')).not.toMatch(/\b(is booked|has been booked|see you (on|at))\b/i);
  });

  it('reports the call on air, with its transcript so far and a ticking clock, while it is live', async () => {
    const bus = new ConsoleBus();
    let release: () => void = () => {};
    let clock = NOON.getTime();
    let calls = 0;
    const sim = new LiveCallSimulator({
      bus,
      killSwitch: { state: async () => ({ active: false }) },
      now: () => new Date(clock),
      sleep: async (ms) => {
        clock += ms;
        calls += 1;
        if (calls === 4) await new Promise<void>((r) => (release = r));
      },
      random: () => 0.5,
      openingFor: () => ['Hi, my name\'s Lexi.', 'I am an AI assistant.', 'I work with Vinay.', 'Reason.', 'Recorded.', 'Thirty seconds?']
    });
    const playing = sim.playCall(LIVE_PROSPECTS[1]!);
    await new Promise((r) => setImmediate(r));
    const live = await sim.current(new Date(clock + 5000));
    expect(live).toMatchObject({ prospect: { company: 'Demo Insurer Gamma' }, stage: 'disclosure', variant: 'hook v3' });
    expect(live?.transcript).toHaveLength(3);
    expect(live?.elapsedSeconds).toBeGreaterThanOrEqual(8);
    release();
    await playing;
  });

  it('goes quiet while the kill switch is engaged, and carries on when it is lifted', async () => {
    let killed = true;
    const { sim, events } = simulator({ kill: () => killed });
    sim.start();
    for (let i = 0; i < 40; i++) await new Promise((r) => setImmediate(r));
    expect(events.filter((e) => e.type === 'call_started')).toHaveLength(0);
    expect(sim.nextDialAt()).toBeNull();
    killed = false;
    for (let i = 0; i < 200 && !events.some((e) => e.type === 'call_started'); i++) await new Promise((r) => setImmediate(r));
    sim.stop();
    expect(events.some((e) => e.type === 'call_started')).toBe(true);
  });

  it('feeds the snapshot: live while on air, a countdown while standing by', async () => {
    const d = await demo();
    expect((await buildSnapshot(d.deps)).live).toBeNull();
    d.simulator.start();
    // Give the loop a moment to take its first breath; the standing-by countdown is the simulator's.
    await new Promise((r) => setTimeout(r, 30));
    const s = await buildSnapshot(d.deps);
    expect(s.standingBy.nextDialAt).not.toBeNull();
    expect(new Date(s.standingBy.nextDialAt as string).getTime()).toBeGreaterThan(NOON.getTime());
    d.simulator.stop();
  });
});
