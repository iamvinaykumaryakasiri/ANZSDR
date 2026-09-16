/**
 * The live folder: turning dropped decks and notes into draft claims.
 *
 * Three properties matter more than the extraction quality, because they are
 * what makes the folder safe to keep feeding:
 *
 *   1. Everything arrives as `draft`. A dropped deck cannot put words in the
 *      agent's mouth; a person has to approve each line first.
 *   2. Sync is idempotent. Claim ids are derived from the file and the text, so
 *      re-running on an unchanged deck changes nothing and an approval given
 *      last week survives it.
 *   3. Nothing is deleted. A line that has vanished from its source is marked
 *      `orphaned`, because deleting it would quietly discard an approval.
 */

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import { extractSlides } from './pptx.js';
import type { Claim, ClaimSource } from './types.js';

export interface DroppedLine {
  text: string;
  /** Relative to the drop folder, with forward slashes whatever the platform. */
  file: string;
  locator: string;
}

export interface SkippedFile {
  file: string;
  reason: string;
}

export interface IngestResult {
  claims: Claim[];
  added: string[];
  orphaned: string[];
  unchanged: number;
  skipped: SkippedFile[];
}

const READABLE = new Set(['.pptx', '.md', '.txt']);

/**
 * Which lines look like something a person might assert.
 *
 * Deliberately generous: a line wrongly kept becomes a draft claim someone
 * declines, which costs a moment. A line wrongly dropped is a capability the
 * agent silently never had.
 */
export function looksAssertable(line: string): boolean {
  const text = line.trim();
  if (text.length < 15 || text.length > 300) return false;
  // Slide furniture: "AGENDA", "© Hexaware 2026", "3", "www.hexaware.com".
  if (/^[\d\s.,/|-]+$/.test(text)) return false;
  if (/^(?:©|copyright|confidential|internal use)/i.test(text)) return false;
  if (text === text.toUpperCase() && text.length < 40) return false;
  // Needs at least three words to be a statement rather than a label.
  return text.split(/\s+/).length >= 3;
}

function posix(path: string): string {
  return path.split(sep).join('/');
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else {
      out.push(full);
    }
  }
  return out;
}

/**
 * Stable across runs, so an approval survives a re-sync, and distinct across
 * files, so the same sentence in two decks stays two reviewable claims.
 */
export function claimIdFor(file: string, text: string): string {
  const digest = createHash('sha256').update(`${file}\n${text}`).digest('hex').slice(0, 10);
  return `drop.${digest}`;
}

function markdownLines(body: string, file: string): DroppedLine[] {
  const out: DroppedLine[] = [];
  let heading = '(top of file)';
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('#')) {
      heading = line.replace(/^#+\s*/, '');
      continue;
    }
    const text = line.replace(/^[-*+]\s+/, '').trim();
    if (looksAssertable(text)) out.push({ text, file, locator: heading });
  }
  return out;
}

/** Read every readable file under `dir`, newest extraction wins per file. */
export async function readDrop(dir: string): Promise<{ lines: DroppedLine[]; skipped: SkippedFile[] }> {
  const lines: DroppedLine[] = [];
  const skipped: SkippedFile[] = [];

  for (const full of walk(dir)) {
    const file = posix(relative(dir, full));
    if (file === 'README.md') continue;
    const ext = extname(full).toLowerCase();

    if (!READABLE.has(ext)) {
      skipped.push({ file, reason: `${ext === '' ? 'no extension' : ext} is not read; use .pptx, .md or .txt` });
      continue;
    }

    try {
      if (ext === '.pptx') {
        const slides = await extractSlides(readFileSync(full));
        if (slides.length === 0) {
          skipped.push({ file, reason: 'no slides with text were found in the deck' });
          continue;
        }
        for (const slide of slides) {
          for (const text of slide.lines) {
            if (looksAssertable(text)) lines.push({ text, file, locator: `slide ${slide.slide}` });
          }
        }
      } else {
        lines.push(...markdownLines(readFileSync(full, 'utf8'), file));
      }
    } catch (error) {
      skipped.push({ file, reason: `could not be read: ${(error as Error).message}` });
    }
  }

  return { lines, skipped };
}

/**
 * Fold what the folder currently holds into the existing claims.
 *
 * Only claims sourced from the drop are touched. A claim drafted from a public
 * page or written by hand is left exactly as it is, because the folder has no
 * business deciding anything about it.
 */
export function mergeDrop(existing: Claim[], lines: DroppedLine[], at: Date): IngestResult {
  const retrievedAt = at.toISOString().slice(0, 10);
  const fromDrop = (c: Claim): boolean => c.sources.some((s) => s.kind === 'drop');

  const seen = new Map<string, DroppedLine>();
  for (const line of lines) {
    const id = claimIdFor(line.file, line.text);
    if (!seen.has(id)) seen.set(id, line);
  }

  const byId = new Map(existing.map((c) => [c.id, c]));
  const claims: Claim[] = [];
  const added: string[] = [];
  const orphaned: string[] = [];
  let unchanged = 0;

  // Everything not from the drop passes through untouched.
  for (const claim of existing) {
    if (!fromDrop(claim)) claims.push(claim);
  }

  // Drop claims that still have a line behind them.
  for (const [id, line] of seen) {
    const prior = byId.get(id);
    if (prior !== undefined && fromDrop(prior)) {
      // The text is part of the id, so it cannot have changed. An orphaned claim
      // whose line has come back is a draft again; anything else keeps its state.
      if (prior.status === 'orphaned') {
        claims.push({ ...prior, status: 'draft' });
      } else {
        claims.push(prior);
        unchanged += 1;
      }
      continue;
    }
    const source: ClaimSource = {
      kind: 'drop',
      ref: line.file,
      quote: line.text,
      retrievedAt,
      locator: line.locator
    };
    claims.push({
      id,
      text: line.text,
      kind: 'capability',
      status: 'draft',
      markets: ['AU', 'NZ'],
      sources: [source],
      conflictsWith: []
    });
    added.push(id);
  }

  // Drop claims whose line has gone. Kept, marked, never deleted. Only newly
  // orphaned ones are reported, so a stale file does not re-announce itself on
  // every sync.
  for (const claim of existing) {
    if (!fromDrop(claim) || seen.has(claim.id)) continue;
    if (claim.status === 'orphaned') {
      claims.push(claim);
      unchanged += 1;
      continue;
    }
    claims.push({ ...claim, status: 'orphaned' });
    orphaned.push(claim.id);
  }

  return { claims, added, orphaned, unchanged, skipped: [] };
}
