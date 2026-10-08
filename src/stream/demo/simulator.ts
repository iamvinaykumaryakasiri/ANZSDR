/**
 * The pretend live call.
 *
 * Plays a scripted call to a synthetic prospect, a turn every two to four
 * seconds, walking the script from disclosure to close, then stands by for a
 * while and plays the next. It exists so the console's hero is never dead in the
 * demo: it is either on air or waiting, which is the room the brief describes.
 *
 * It touches nothing real. It holds no database rows (so the gate's concurrency
 * count is undisturbed), has no phone, no voice provider and no mailer, and its
 * only output is events on the bus and an answer to "is a call live?". When the
 * kill switch is engaged it finishes the call in hand and then stays quiet.
 */

import type { ConsoleBus } from '../bus.js';
import type { LiveCallView, ScriptStage } from '../contract.js';
import type { LiveCallSource } from '../live-source.js';
import { bodyScript, LIVE_PROSPECTS, type LiveProspect, type ScriptLine } from './data.js';

export interface SimulatorOptions {
  bus: ConsoleBus;
  killSwitch: { state(): Promise<{ active: boolean }> };
  /** The frozen opening, as the segments of one utterance: the first three are the disclosure, the rest the reason. */
  openingFor: (prospect: LiveProspect) => string[];
  now?: () => Date;
  /** Waits `ms`, or less if the signal fires. Replaced in tests. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  random?: () => number;
  turnDelayMs?: [number, number];
  gapMs?: [number, number];
  prospects?: LiveProspect[];
}

const realSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    timer.unref();
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });

export class LiveCallSimulator implements LiveCallSource {
  private live: LiveCallView | null = null;
  private nextAt: Date | null = null;
  private running = false;
  private abort = new AbortController();
  private calls = 0;

  constructor(private readonly options: SimulatorOptions) {}

  private now(): Date {
    return (this.options.now ?? (() => new Date()))();
  }

  private sleep(ms: number): Promise<void> {
    return (this.options.sleep ?? realSleep)(ms, this.abort.signal);
  }

  private between([lo, hi]: [number, number]): number {
    return lo + (this.options.random ?? Math.random)() * (hi - lo);
  }

  /** Begin the loop. Safe to call twice. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.abort = new AbortController();
    void this.loop();
  }

  stop(): void {
    this.running = false;
    this.abort.abort();
  }

  async current(now: Date): Promise<LiveCallView | null> {
    const call = this.live;
    if (call === null) return null;
    return {
      ...call,
      elapsedSeconds: Math.max(0, Math.round((now.getTime() - new Date(call.startedAt).getTime()) / 1000)),
      transcript: [...call.transcript]
    };
  }

  nextDialAt(): Date | null {
    return this.live === null ? this.nextAt : null;
  }

  private async loop(): Promise<void> {
    const prospects = this.options.prospects ?? LIVE_PROSPECTS;
    let i = 0;
    while (this.running) {
      await this.standBy();
      if (!this.running) break;
      await this.playCall(prospects[i % prospects.length] as LiveProspect);
      i += 1;
    }
  }

  /** Stand by for a while, and for as long as the kill switch is engaged. */
  private async standBy(): Promise<void> {
    const gap = this.between(this.options.gapMs ?? [9000, 14000]);
    this.nextAt = new Date(this.now().getTime() + gap);
    await this.sleep(gap);
    while (this.running && (await this.options.killSwitch.state()).active) {
      this.nextAt = null;
      await this.sleep(3000);
    }
    this.nextAt = null;
  }

  /** The whole script for one prospect, with the stage each line belongs to. */
  script(prospect: LiveProspect): ScriptLine[] {
    const opening = this.options.openingFor(prospect);
    const lines: ScriptLine[] = opening.map((text, i) => ({
      stage: (i < 3 ? 'disclosure' : 'reason') as ScriptStage,
      speaker: 'lexi' as const,
      text
    }));
    return [...lines, ...bodyScript(prospect)];
  }

  /** Play one complete call. Resolves when it has ended. */
  async playCall(prospect: LiveProspect): Promise<void> {
    const startedAt = this.now();
    this.calls += 1;
    const call: LiveCallView = {
      callId: `demo-live-${this.calls}`,
      prospect: { name: prospect.name, title: prospect.title, company: prospect.company, market: prospect.market },
      hypothesis: prospect.hypothesis,
      startedAt: startedAt.toISOString(),
      elapsedSeconds: 0,
      stage: 'disclosure',
      confidence: prospect.confidence,
      variant: prospect.variant,
      transcript: []
    };
    this.live = call;
    this.options.bus.publish({ type: 'call_started', call: { ...call, transcript: [] } });

    for (const line of this.script(prospect)) {
      await this.sleep(this.between(this.options.turnDelayMs ?? [2000, 4000]));
      if (!this.running) break;

      if (line.stage !== call.stage) {
        call.stage = line.stage;
        this.options.bus.publish({ type: 'stage', callId: call.callId, stage: line.stage });
      }
      const turn = {
        speaker: line.speaker,
        text: line.text,
        atSecond: Math.max(0, Math.round((this.now().getTime() - startedAt.getTime()) / 1000))
      };
      call.transcript.push(turn);
      this.options.bus.publish({ type: 'transcript', callId: call.callId, turn });
    }

    await this.sleep(1200);
    const finished = this.running ? prospect.ends : 'ended';
    this.live = null;
    this.options.bus.publish({ type: 'call_ended', callId: call.callId, outcome: finished });
  }
}
