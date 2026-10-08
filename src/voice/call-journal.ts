/**
 * The journal of a live call.
 *
 * The endpoint writes here as the call goes: what the prospect said, what Lexi
 * said, which tools Lexi used, which defects Guardian found, and how long each
 * turn took. It is the `CallEvent` table, append-only, so a crash mid-call loses
 * nothing that had already happened - and it is what Scribe reads afterwards for
 * the things only we saw: the tool calls and the defects. (What was actually
 * *heard* comes from the provider's report, which knows about interruptions.)
 *
 * The journal never stands between a prospect and an answer. Writes are retried,
 * and if they still fail the endpoint is told through `onError` rather than the
 * turn being held up.
 */

import { CallStore } from './call-store.js';

export interface TurnMeta {
  /** This was the frozen opening, served without a model. */
  opening?: boolean;
  /** Said by a deterministic rule, not a model: the recording-objection reply, say. */
  deterministic?: string;
  held?: boolean;
  /** The prospect talked over it. What was sent may not be what was heard. */
  interrupted?: boolean;
  firstTokenMs?: number;
  totalMs?: number;
}

export interface CallJournal {
  prospectTurn(callId: string, text: string): Promise<void>;
  lexiTurn(callId: string, text: string, meta: TurnMeta): Promise<void>;
  /** `source` is `provider` when the fact came from the provider rather than from Lexi. */
  tool(callId: string, name: string, value: unknown, source?: 'lexi' | 'provider'): Promise<void>;
  defect(callId: string, kind: string, detail: string): Promise<void>;
}

async function retried<T>(work: () => Promise<T>, attempts = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await work();
    } catch (error) {
      last = error;
      await new Promise((resolve) => setTimeout(resolve, 25 * (i + 1)));
    }
  }
  throw last;
}

export class PrismaCallJournal implements CallJournal {
  private readonly anchors = new Map<string, number>();
  private readonly answered = new Set<string>();

  constructor(
    private readonly store: CallStore,
    private readonly now: () => Date = () => new Date(),
    /** Called when a write still fails after retries. Never throws into the call. */
    private readonly onError: (callId: string, what: string, error: unknown) => void = () => {}
  ) {}

  /**
   * Seconds since the call was answered. The first request our endpoint receives
   * for a call proves it was answered, so that is also where the call moves to
   * `in-progress`, if the provider's status webhook has not already said so.
   */
  private async seconds(callId: string): Promise<number> {
    let anchor = this.anchors.get(callId);
    if (anchor === undefined) {
      if (!this.answered.has(callId)) {
        this.answered.add(callId);
        await this.store.transition(callId, 'in-progress', { via: 'first-turn' }).catch(() => {});
      }
      const metrics = await this.store.metrics(callId);
      anchor = metrics.answeredAt !== undefined ? new Date(metrics.answeredAt).getTime() : this.now().getTime();
      this.anchors.set(callId, anchor);
    }
    return Math.max(0, Math.round((this.now().getTime() - anchor) / 1000));
  }

  private async write(callId: string, what: string, work: () => Promise<void>): Promise<void> {
    try {
      await retried(work);
    } catch (error) {
      this.onError(callId, what, error);
    }
  }

  async prospectTurn(callId: string, text: string): Promise<void> {
    if (text.trim() === '') return;
    await this.write(callId, 'prospect turn', async () => {
      // The provider resends the whole conversation on every request, and again
      // when it regenerates a turn the prospect interrupted. The same words
      // arriving twice with nothing said in between is one turn, not two.
      const last = await this.store.lastEvent(callId, 'turn');
      if (last !== null && last.speaker === 'prospect' && last.text === text) return;
      await this.store.append(callId, { kind: 'turn', speaker: 'prospect', text, atSecond: await this.seconds(callId) });
    });
  }

  async lexiTurn(callId: string, text: string, meta: TurnMeta): Promise<void> {
    if (text.trim() === '') return;
    await this.write(callId, 'lexi turn', async () => {
      await this.store.append(callId, {
        kind: 'turn',
        speaker: 'lexi',
        text,
        atSecond: await this.seconds(callId),
        data: meta
      });
    });
  }

  async tool(callId: string, name: string, value: unknown, source: 'lexi' | 'provider' = 'lexi'): Promise<void> {
    await this.write(callId, `tool ${name}`, async () => {
      await this.store.append(callId, {
        kind: 'tool',
        text: name,
        atSecond: await this.seconds(callId),
        data: { name, args: value, source }
      });
    });
  }

  async defect(callId: string, kind: string, detail: string): Promise<void> {
    await this.write(callId, 'defect', async () => {
      await this.store.append(callId, { kind: 'defect', text: detail, atSecond: await this.seconds(callId), data: { kind } });
    });
  }
}
