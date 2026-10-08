/**
 * The event bus behind the console's single SSE stream.
 *
 * In-process on purpose: one operator, one server, and the console "can be
 * killed without affecting the agents" (section 14.6). Producers publish and
 * forget; nothing that publishes ever waits on, or fails because of, a viewer.
 *
 * Two rules keep it honest:
 *
 *   - Every event is checked against the wire contract on the way in. A producer
 *     that builds a malformed event has it dropped and counted, never forwarded
 *     to a browser that would have to guess what it meant (rule three).
 *   - A new subscriber can be given the latest snapshot at once, so a console that
 *     connects mid-morning sees the state of the room, not a blank until the next
 *     tick.
 */

import { consoleEventSchema, type ConsoleEvent, type ConsoleSnapshot } from './contract.js';

export type ConsoleListener = (event: ConsoleEvent) => void;

export interface SubscribeOptions {
  /** Deliver the latest snapshot, if one has been published, before anything else. */
  replay?: boolean;
}

export class ConsoleBus {
  private readonly listeners = new Set<ConsoleListener>();
  private latest: ConsoleSnapshot | null = null;
  private rejected = 0;

  /**
   * Publish an event. Returns false, and delivers nothing, when the event does
   * not match the contract. A listener that throws is skipped; it cannot stop
   * the others or the producer.
   */
  publish(event: ConsoleEvent): boolean {
    const checked = consoleEventSchema.safeParse(event);
    if (!checked.success) {
      this.rejected += 1;
      return false;
    }
    if (checked.data.type === 'snapshot') this.latest = checked.data.snapshot;

    for (const listener of [...this.listeners]) {
      try {
        listener(checked.data);
      } catch {
        // A viewer that has gone away is its own route's problem to clean up.
      }
    }
    return true;
  }

  subscribe(listener: ConsoleListener, options: SubscribeOptions = {}): () => void {
    this.listeners.add(listener);
    if (options.replay === true && this.latest !== null) {
      try {
        listener({ type: 'snapshot', snapshot: this.latest });
      } catch {
        // As above.
      }
    }
    return () => {
      this.listeners.delete(listener);
    };
  }

  latestSnapshot(): ConsoleSnapshot | null {
    return this.latest;
  }

  get subscriberCount(): number {
    return this.listeners.size;
  }

  /** Events refused for not matching the contract, for health reporting and tests. */
  get rejectedCount(): number {
    return this.rejected;
  }
}

/**
 * The process-wide bus. The voice layer imports this and publishes transcript
 * and stage events as a call unfolds; the console routes subscribe to it.
 */
export const consoleBus = new ConsoleBus();
