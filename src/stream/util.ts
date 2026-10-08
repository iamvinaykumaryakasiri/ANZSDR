/**
 * Small helpers shared across the console backend. Nothing here knows about the
 * blackboard; it is arithmetic, time and tolerant JSON reading.
 */

import { DateTime } from 'luxon';
import type { z } from 'zod';

export const DAY_MS = 86_400_000;

/**
 * Read a JSON text column the way the console needs to: a corrupt row must not
 * take the whole morning view down, so a bad value reads as `fallback`. The
 * agents' own reads of the same columns stay strict (see blackboard/schemas.ts);
 * this is display only.
 */
export function readJson<T>(raw: string | null | undefined, schema: z.ZodType<T>, fallback: T): T;
export function readJson<T, F>(raw: string | null | undefined, schema: z.ZodType<T>, fallback: F): T | F;
export function readJson<T, F>(raw: string | null | undefined, schema: z.ZodType<T>, fallback: F): T | F {
  if (raw === null || raw === undefined || raw === '') return fallback;
  try {
    const parsed = schema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : fallback;
  } catch {
    return fallback;
  }
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

export function round(value: number, places = 4): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

export function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : round(numerator / denominator);
}

export function usd(value: number): number {
  return round(value, 2);
}

/** The operator's calendar day containing `at`, as UTC instants. */
export function dayBounds(at: Date, zone: string, offsetDays = 0): { start: Date; end: Date; date: string } {
  const start = DateTime.fromJSDate(at, { zone }).startOf('day').plus({ days: offsetDays });
  return { start: start.toJSDate(), end: start.plus({ days: 1 }).toJSDate(), date: start.toFormat('yyyy-MM-dd') };
}

export function monthStart(at: Date, zone: string): Date {
  return DateTime.fromJSDate(at, { zone }).startOf('month').toJSDate();
}

/** "Tue 13 Oct, 09:30" on the operator's clock. */
export function stamp(at: Date, zone: string): string {
  return DateTime.fromJSDate(at, { zone }).toFormat('ccc d LLL, HH:mm');
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

export function money(value: number): string {
  return `$${value.toFixed(2)}`;
}
