/**
 * Failure memory (section 3.5): hooks that died, objections handled badly, and
 * variants that did not survive - kept so Coach attacks new ground instead of
 * proposing last month's idea again.
 *
 * Stored as `Memory` rows of scope `failure`. An entry is keyed by the pattern, not
 * the occurrence, and counts how often it has been seen: the second time a hook
 * dies the entry says so, rather than a second row appearing.
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Blackboard } from '../blackboard/client.js';
import { decode, encode } from '../blackboard/schemas.js';
import { textFields, type PlaybookContent, type PlaybookSlot } from './schema.js';
import { normaliseText } from './util.js';

export const FAILURE_KINDS = [
  'hook-died',
  'objection-handled-badly',
  'variant-rejected',
  'variant-withdrawn',
  'variant-inconclusive'
] as const;
export type FailureKind = (typeof FAILURE_KINDS)[number];

const bodySchema = z.object({
  slot: z.string().nullable(),
  count: z.number().int().positive(),
  firstAt: z.string(),
  lastAt: z.string(),
  /** For a variant: its normalised text, so a near-copy can be recognised. */
  text: z.string().nullable(),
  detail: z.record(z.unknown())
});

export interface FailureEntry {
  kind: FailureKind;
  key: string;
  slot: PlaybookSlot | null;
  summary: string;
  count: number;
  firstAt: Date;
  lastAt: Date;
  text: string | null;
  detail: Record<string, unknown>;
}

export interface FailureInput {
  kind: FailureKind;
  key: string;
  slot?: PlaybookSlot;
  summary: string;
  text?: string;
  detail?: Record<string, unknown>;
}

/** The text of a variant, normalised, as one string. */
export function contentText(content: PlaybookContent): string {
  return normaliseText(textFields(content).map((f) => f.text).join(' '));
}

export function variantKey(content: PlaybookContent): string {
  return `variant:${content.slot}:${createHash('sha1').update(contentText(content)).digest('hex').slice(0, 12)}`;
}

/** Jaccard similarity of the word sets of two texts. 1 is identical, 0 shares nothing. */
export function similarity(a: string, b: string): number {
  const wa = new Set(a.split(' ').filter((w) => w !== ''));
  const wb = new Set(b.split(' ').filter((w) => w !== ''));
  if (wa.size === 0 && wb.size === 0) return 1;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared += 1;
  return shared / (wa.size + wb.size - shared);
}

/** A proposal this close to one that already failed is the same idea in other words. */
export const NEAR_DUPLICATE = 0.85;

export class FailureMemory {
  constructor(
    private readonly db: Blackboard,
    private readonly now: () => Date = () => new Date()
  ) {}

  async record(input: FailureInput): Promise<FailureEntry> {
    const id = `fail-${input.kind}-${createHash('sha1').update(input.key).digest('hex').slice(0, 16)}`;
    const at = this.now().toISOString();
    const existing = await this.db.memory.findUnique({ where: { id } });
    const prior = existing === null ? null : decode(bodySchema, 'Memory.content', existing.content);

    const body = {
      slot: input.slot ?? prior?.slot ?? null,
      count: (prior?.count ?? 0) + 1,
      firstAt: prior?.firstAt ?? at,
      lastAt: at,
      text: input.text ?? prior?.text ?? null,
      detail: input.detail ?? prior?.detail ?? {}
    };
    const content = encode(bodySchema, 'Memory.content', body);

    await this.db.memory.upsert({
      where: { id },
      create: { id, scope: 'failure', key: input.key, kind: input.kind, summary: input.summary, content, createdAt: this.now() },
      update: { summary: input.summary, content }
    });
    return this.toEntry({ key: input.key, kind: input.kind, summary: input.summary, content });
  }

  async list(kinds: readonly FailureKind[] = FAILURE_KINDS): Promise<FailureEntry[]> {
    const rows = await this.db.memory.findMany({
      where: { scope: 'failure', kind: { in: [...kinds] } },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }]
    });
    return rows.map((r) => this.toEntry(r));
  }

  /** An earlier failed variant that `content` is a copy of, or close enough to be one. */
  async priorFailureOf(content: PlaybookContent): Promise<FailureEntry | null> {
    const text = contentText(content);
    const failures = await this.list(['variant-rejected', 'variant-withdrawn', 'variant-inconclusive']);
    return failures.find((f) => f.slot === content.slot && f.text !== null && similarity(text, f.text) >= NEAR_DUPLICATE) ?? null;
  }

  /** The most recent variant failure for a slot at or after `since`: the cooldown check. */
  async recentVariantFailure(slot: PlaybookSlot, since: Date): Promise<FailureEntry | null> {
    const failures = await this.list(['variant-rejected', 'variant-withdrawn', 'variant-inconclusive']);
    return failures.find((f) => f.slot === slot && f.lastAt >= since) ?? null;
  }

  private toEntry(row: { key: string; kind: string; summary: string; content: string }): FailureEntry {
    const body = decode(bodySchema, 'Memory.content', row.content);
    return {
      kind: row.kind as FailureKind,
      key: row.key,
      slot: body.slot as PlaybookSlot | null,
      summary: row.summary,
      count: body.count,
      firstAt: new Date(body.firstAt),
      lastAt: new Date(body.lastAt),
      text: body.text,
      detail: body.detail
    };
  }
}
