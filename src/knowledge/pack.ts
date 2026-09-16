/**
 * Loading the markdown half of the pack.
 *
 * These files are context, not permission. Caller is briefed on them; what it
 * may actually assert is decided entirely by the claim index. Loading a file
 * that says something the index does not carry grants nothing.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const PACK_FILES = [
  'company.md',
  'services.md',
  'anz-story.md',
  'proof-points.md',
  'frameworks.md',
  'icp.md',
  'objections.md'
] as const;
export type PackFile = (typeof PACK_FILES)[number];

export interface PackSection {
  file: PackFile;
  /** The `##` heading this text sat under, or the file name for the preamble. */
  heading: string;
  body: string;
}

export interface KnowledgePack {
  sections: PackSection[];
  /** Files section 6 names that are not on disk. Reported, never invented. */
  missing: PackFile[];
}

/** Split on `##`, which is the granularity a briefing pack extract wants. */
function sectionsOf(file: PackFile, markdown: string): PackSection[] {
  const out: PackSection[] = [];
  let heading: string = file;
  let buffer: string[] = [];

  const flush = (): void => {
    const body = buffer.join('\n').trim();
    if (body !== '') out.push({ file, heading, body });
    buffer = [];
  };

  for (const line of markdown.split('\n')) {
    if (/^##\s+/.test(line)) {
      flush();
      heading = line.replace(/^##\s+/, '').trim();
      continue;
    }
    buffer.push(line);
  }
  flush();
  return out;
}

export function loadPack(dir: string): KnowledgePack {
  const sections: PackSection[] = [];
  const missing: PackFile[] = [];

  for (const file of PACK_FILES) {
    const path = join(dir, file);
    if (!existsSync(path)) {
      missing.push(file);
      continue;
    }
    sections.push(...sectionsOf(file, readFileSync(path, 'utf8')));
  }

  return { sections, missing };
}

/** The sections from one file, for a briefing pack that only needs part of it. */
export function sectionsFrom(pack: KnowledgePack, file: PackFile): PackSection[] {
  return pack.sections.filter((s) => s.file === file);
}
