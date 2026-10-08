export const SYDNEY = 'Australia/Sydney';
export const AUCKLAND = 'Pacific/Auckland';

export function parseTime(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/** m:ss, or h:mm:ss past an hour. */
export function clock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const two = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${two(m)}:${two(r)}` : `${m}:${two(r)}`;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function fmt(timeZone: string, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = timeZone + JSON.stringify(opts);
  let f = formatters.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat('en-AU', { timeZone, ...opts });
    formatters.set(key, f);
  }
  return f;
}

/** 24-hour wall time in a zone, e.g. 09:42. */
export function timeIn(ms: number, timeZone: string): string {
  return fmt(timeZone, { hour: '2-digit', minute: '2-digit', hour12: false }).format(ms).replace(/^24:/, '00:');
}

export function secondsIn(ms: number, timeZone: string): string {
  return fmt(timeZone, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(ms).replace(/^24:/, '00:');
}

/** Tue 14 Oct, 15:30 in a zone. */
export function dayTimeIn(iso: string | null | undefined, timeZone: string): string {
  const t = parseTime(iso);
  if (t === null) return 'unknown time';
  const day = fmt(timeZone, { weekday: 'short', day: 'numeric', month: 'short' }).format(t);
  return `${day}, ${timeIn(t, timeZone)}`;
}

/** Sydney calendar date as yyyy-mm-dd, the key for "has he seen today's briefing". */
export function sydneyDateKey(ms: number): string {
  const parts = fmt(SYDNEY, { year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(ms);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function sydneyHour(ms: number): number {
  return Number(fmt(SYDNEY, { hour: '2-digit', hour12: false }).format(ms).replace(/^24$/, '0'));
}

/** 4m 12s, 1h 03m. For a gap in the future or past, sign handled by the caller. */
export function span(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  if (m < 60) return `${m}m ${String(total % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, '0')}m`;
}

export function ago(iso: string | null | undefined, nowMs: number): string {
  const t = parseTime(iso);
  if (t === null) return 'unknown';
  const diff = Math.max(0, nowMs - t);
  if (diff < 45_000) return 'just now';
  const m = Math.round(diff / 60_000);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}
