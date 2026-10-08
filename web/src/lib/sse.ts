import type { ConsoleEvent } from '../contract';
import { authHeaders, reportUnauthorised } from './api';

export type StreamStatus = 'connecting' | 'open' | 'retrying';

export interface StreamHandle {
  stop: () => void;
}

const STREAM_URL = '/api/console/stream';
/** Longest silence tolerated before the connection is assumed dead and reopened. */
const SILENCE_LIMIT_MS = 75_000;

function isConsoleEvent(value: unknown): value is ConsoleEvent {
  return typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string';
}

/**
 * Server-sent events over fetch rather than EventSource, because EventSource
 * cannot carry the Authorization header the API requires. Reconnects with
 * capped backoff; the server's first event on every connection is a snapshot,
 * so a reconnect heals any gap on its own.
 */
export function openStream(handlers: {
  onEvent: (event: ConsoleEvent) => void;
  onStatus: (status: StreamStatus) => void;
}): StreamHandle {
  let stopped = false;
  let controller: AbortController | null = null;

  const run = async (): Promise<void> => {
    let attempt = 0;
    while (!stopped) {
      controller = new AbortController();
      const watchdog = { timer: 0 as unknown as ReturnType<typeof setTimeout> };
      const arm = () => {
        clearTimeout(watchdog.timer);
        watchdog.timer = setTimeout(() => controller?.abort(), SILENCE_LIMIT_MS);
      };
      handlers.onStatus(attempt === 0 ? 'connecting' : 'retrying');
      try {
        arm();
        const response = await fetch(STREAM_URL, {
          headers: { ...authHeaders(), Accept: 'text/event-stream' },
          signal: controller.signal,
          cache: 'no-store'
        });
        if (response.status === 401) {
          reportUnauthorised();
          return;
        }
        if (!response.ok || !response.body) throw new Error(`stream answered ${response.status}`);
        handlers.onStatus('open');
        attempt = 0;
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          arm();
          buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
          let boundary = buffer.indexOf('\n\n');
          while (boundary !== -1) {
            const block = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            boundary = buffer.indexOf('\n\n');
            const data = block
              .split('\n')
              .filter((line) => line.startsWith('data:'))
              .map((line) => line.slice(5).replace(/^ /, ''))
              .join('\n');
            if (data === '') continue; // a comment or heartbeat
            try {
              const parsed: unknown = JSON.parse(data);
              if (isConsoleEvent(parsed)) handlers.onEvent(parsed);
            } catch {
              /* one malformed event must not take the stream down */
            }
          }
        }
      } catch {
        /* fall through to the backoff */
      } finally {
        clearTimeout(watchdog.timer);
      }
      if (stopped) return;
      handlers.onStatus('retrying');
      attempt += 1;
      await new Promise((resolve) => setTimeout(resolve, Math.min(10_000, 800 * 2 ** Math.min(attempt, 4))));
    }
  };

  void run();
  return {
    stop: () => {
      stopped = true;
      controller?.abort();
    }
  };
}
