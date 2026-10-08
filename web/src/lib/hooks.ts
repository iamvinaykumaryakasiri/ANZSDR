import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

/* One shared one-second ticker. Every clock on the page reads the same beat, so
   nothing drifts against anything else. */
let tick = Date.now();
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (timer === null) {
    timer = setInterval(() => {
      tick = Date.now();
      listeners.forEach((l) => l());
    }, 1000);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

/** Local wall-clock milliseconds, updated once a second. */
export function useNow(): number {
  return useSyncExternalStore(subscribe, () => tick, () => tick);
}

export function useMediaQuery(query: string): boolean {
  const get = () => (typeof window !== 'undefined' && 'matchMedia' in window ? window.matchMedia(query).matches : false);
  const [matches, setMatches] = useState(get);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = () => setMatches(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

/** localStorage for per-viewer conveniences only. Every access can throw. */
export function readPref(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
export function writePref(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* a remembered preference is a convenience, not a requirement */
  }
}

/** Hash routing: #/calls/abc -> { name: 'calls', param: 'abc' }. */
export type RouteName = 'home' | 'calls' | 'meetings' | 'trace' | 'playbook' | 'accounts' | 'health' | 'briefing';
const ROUTES: RouteName[] = ['home', 'calls', 'meetings', 'trace', 'playbook', 'accounts', 'health', 'briefing'];
export interface Route {
  name: RouteName;
  param: string | null;
}
function parseHash(): Route {
  const raw = window.location.hash.replace(/^#\/?/, '');
  const [head, ...rest] = raw.split('/');
  const name = (ROUTES as string[]).includes(head ?? '') ? (head as RouteName) : 'home';
  const param = rest.length > 0 ? decodeURIComponent(rest.join('/')) : null;
  return { name, param: param === '' ? null : param };
}
export function routeHref(name: RouteName, param?: string): string {
  if (name === 'home') return '#/';
  return `#/${name}${param ? `/${encodeURIComponent(param)}` : ''}`;
}
export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(parseHash);
  useEffect(() => {
    const onChange = () => setRoute(parseHash());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

/** A value that stays put while the person is mid-interaction. */
export function usePrevious<T>(value: T): T | undefined {
  const ref = useRef<T | undefined>(undefined);
  useEffect(() => {
    ref.current = value;
  });
  return ref.current;
}

/** Runs `fn` after `ms` unless cancelled; returns [arm, cancel]. */
export function useTimeout(): [(fn: () => void, ms: number) => void, () => void] {
  const id = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancel = useCallback(() => {
    if (id.current !== null) clearTimeout(id.current);
    id.current = null;
  }, []);
  const arm = useCallback(
    (fn: () => void, ms: number) => {
      cancel();
      id.current = setTimeout(fn, ms);
    },
    [cancel]
  );
  useEffect(() => cancel, [cancel]);
  return [arm, cancel];
}
