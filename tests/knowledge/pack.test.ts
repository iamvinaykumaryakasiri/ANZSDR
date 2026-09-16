/**
 * The markdown half of the pack.
 *
 * These files brief the agent; they do not permit it anything. A sentence in
 * `company.md` that is not also an approved claim is context Caller has read
 * and still may not say.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PACK_FILES, loadPack, sectionsFrom } from '../../src/knowledge/pack.js';
import { ROOT } from '../support/fixtures.js';

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function tempPack(): string {
  const dir = mkdtempSync(join(tmpdir(), 'anzsdr-pack-'));
  dirs.push(dir);
  return dir;
}

describe('loading the pack', () => {
  it('splits a file into its sections', () => {
    const dir = tempPack();
    writeFileSync(join(dir, 'company.md'), '# Title\n\npreamble\n\n## One\n\nbody one\n\n## Two\n\nbody two\n');
    const pack = loadPack(dir);
    const company = sectionsFrom(pack, 'company.md');

    expect(company.map((s) => s.heading)).toEqual(['company.md', 'One', 'Two']);
    expect(company[1]?.body).toBe('body one');
  });

  it('drops a heading with nothing under it', () => {
    const dir = tempPack();
    writeFileSync(join(dir, 'company.md'), '## Empty\n\n## Has content\n\nsomething\n');
    expect(sectionsFrom(loadPack(dir), 'company.md').map((s) => s.heading)).toEqual(['Has content']);
  });

  it('reports a file section 6 names but that is not on disk', () => {
    const dir = tempPack();
    writeFileSync(join(dir, 'company.md'), '## One\n\nbody\n');
    const pack = loadPack(dir);
    expect(pack.missing).toContain('objections.md');
    expect(pack.missing).not.toContain('company.md');
  });
});

describe('the pack in the repository', () => {
  const pack = loadPack(resolve(ROOT, 'knowledge'));

  it('has every file section 6 asks for', () => {
    expect(pack.missing).toEqual([]);
    expect(PACK_FILES.length).toBe(7);
  });

  it('has content in each of them', () => {
    for (const file of PACK_FILES) {
      expect(sectionsFrom(pack, file).length, `${file} has no sections`).toBeGreaterThan(0);
    }
  });
});
