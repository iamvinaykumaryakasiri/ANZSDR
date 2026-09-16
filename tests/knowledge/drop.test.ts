/**
 * The live folder.
 *
 * Vinay keeps dropping capability decks in; the system keeps turning them into
 * draft claims. Three properties make that safe to do repeatedly, and they are
 * what these tests are for: a drop can never assert anything by itself, a
 * re-sync never walks back an approval, and a line that vanishes is marked
 * rather than deleted.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import { afterEach, describe, expect, it } from 'vitest';
import { claimIdFor, looksAssertable, mergeDrop, readDrop } from '../../src/knowledge/ingest.js';
import { extractSlides } from '../../src/knowledge/pptx.js';
import type { Claim } from '../../src/knowledge/types.js';

const NOW = new Date('2026-09-17T00:00:00.000Z');

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function drop(): string {
  const dir = mkdtempSync(join(tmpdir(), 'anzsdr-drop-'));
  dirs.push(dir);
  return dir;
}

/**
 * A .pptx is a zip of XML; build a real one rather than mocking the reader.
 * Nesting is slide -> paragraph -> run, which is the shape PowerPoint writes.
 */
async function deck(slides: string[][][]): Promise<Buffer> {
  const zip = new JSZip();
  slides.forEach((paragraphs, i) => {
    const body = paragraphs
      .map((p) => `<a:p>${p.map((r) => `<a:t>${r}</a:t>`).join('')}</a:p>`)
      .join('');
    zip.file(`ppt/slides/slide${i + 1}.xml`, `<p:sld><p:cSld><p:spTree>${body}</p:spTree></p:cSld></p:sld>`);
  });
  return zip.generateAsync({ type: 'nodebuffer' });
}

describe('reading a deck', () => {
  it('rejoins a sentence broken across runs by a bold word', async () => {
    // PowerPoint splits a run wherever formatting changes, so "Zero Tech Debt"
    // with one bold word arrives as three fragments of one paragraph.
    const data = await deck([[['We remove ', 'Zero Tech Debt', ' across the estate']]]);
    const slides = await extractSlides(data);
    expect(slides[0]?.lines).toEqual(['We remove Zero Tech Debt across the estate']);
  });

  it('keeps separate paragraphs separate', async () => {
    const data = await deck([[['First bullet on the slide'], ['Second bullet on the slide']]]);
    expect((await extractSlides(data))[0]?.lines).toHaveLength(2);
  });

  it('returns slides in deck order, not zip order', async () => {
    const zip = new JSZip();
    for (const n of [10, 2, 1]) {
      zip.file(`ppt/slides/slide${n}.xml`, `<a:p><a:t>This is slide number ${n} of the deck</a:t></a:p>`);
    }
    const slides = await extractSlides(await zip.generateAsync({ type: 'nodebuffer' }));
    expect(slides.map((s) => s.slide)).toEqual([1, 2, 10]);
  });

  it('decodes XML entities back into the characters they stand for', async () => {
    const data = await deck([[['Data &amp; AI for banking &lt;and&gt; insurance']]]);
    expect((await extractSlides(data))[0]?.lines[0]).toBe('Data & AI for banking <and> insurance');
  });
});

describe('what counts as something a person might assert', () => {
  it('keeps a sentence', () => {
    expect(looksAssertable('Hexaware has a Data and AI practice in Sydney')).toBe(true);
  });

  it('drops slide furniture', () => {
    expect(looksAssertable('AGENDA')).toBe(false);
    expect(looksAssertable('12')).toBe(false);
    expect(looksAssertable('© Hexaware Technologies 2026')).toBe(false);
    expect(looksAssertable('Confidential — internal use only')).toBe(false);
  });

  it('drops anything too short to be a statement', () => {
    expect(looksAssertable('Our services')).toBe(false);
    expect(looksAssertable('a b c')).toBe(false);
  });

  it('drops a wall of text that is really a paragraph of notes', () => {
    expect(looksAssertable('x '.repeat(200))).toBe(false);
  });
});

describe('syncing the folder', () => {
  it('turns dropped lines into drafts and nothing else', async () => {
    const dir = drop();
    writeFileSync(join(dir, 'capability.md'), '# Deck\n- Hexaware runs a governed AI delivery layer\n');
    const { lines } = await readDrop(dir);
    const result = mergeDrop([], lines, NOW);

    expect(result.claims).toHaveLength(1);
    expect(result.claims[0]?.status).toBe('draft');
    expect(result.claims[0]?.sources[0]).toMatchObject({ kind: 'drop', ref: 'capability.md', locator: 'Deck' });
  });

  it('is idempotent: running it twice changes nothing', async () => {
    const dir = drop();
    writeFileSync(join(dir, 'a.md'), '- Hexaware runs a governed AI delivery layer\n');
    const { lines } = await readDrop(dir);

    const first = mergeDrop([], lines, NOW);
    const second = mergeDrop(first.claims, lines, NOW);

    expect(second.added).toEqual([]);
    expect(second.orphaned).toEqual([]);
    expect(second.unchanged).toBe(1);
    expect(second.claims).toEqual(first.claims);
  });

  it('does not walk back an approval you have already given', async () => {
    const dir = drop();
    writeFileSync(join(dir, 'a.md'), '- Hexaware runs a governed AI delivery layer\n');
    const { lines } = await readDrop(dir);
    const first = mergeDrop([], lines, NOW);

    const approved = first.claims.map((c) => ({ ...c, status: 'approved' as const, approvedBy: 'Vinay Kumar' }));
    const second = mergeDrop(approved, lines, NOW);

    expect(second.claims[0]?.status).toBe('approved');
    expect(second.claims[0]?.approvedBy).toBe('Vinay Kumar');
  });

  it('orphans a line that has gone from the deck rather than deleting it', async () => {
    const dir = drop();
    writeFileSync(join(dir, 'a.md'), '- Hexaware runs a governed AI delivery layer\n');
    const before = mergeDrop([], (await readDrop(dir)).lines, NOW);
    const approved = before.claims.map((c) => ({ ...c, status: 'approved' as const, approvedBy: 'Vinay Kumar' }));

    writeFileSync(join(dir, 'a.md'), '- Something completely different is now on the slide\n');
    const after = mergeDrop(approved, (await readDrop(dir)).lines, NOW);

    const orphan = after.claims.find((c) => c.id === before.claims[0]?.id);
    expect(orphan).toBeDefined();
    expect(orphan?.status).toBe('orphaned');
    // The approval is kept on the record; it is simply no longer assertable.
    expect(orphan?.approvedBy).toBe('Vinay Kumar');
    expect(after.orphaned).toEqual([before.claims[0]?.id]);
  });

  it('does not re-announce a claim that was already orphaned', async () => {
    const dir = drop();
    writeFileSync(join(dir, 'a.md'), '- Hexaware runs a governed AI delivery layer\n');
    const before = mergeDrop([], (await readDrop(dir)).lines, NOW);
    writeFileSync(join(dir, 'a.md'), '');

    const once = mergeDrop(before.claims, (await readDrop(dir)).lines, NOW);
    const twice = mergeDrop(once.claims, (await readDrop(dir)).lines, NOW);

    expect(once.orphaned).toHaveLength(1);
    expect(twice.orphaned).toEqual([]);
  });

  it('brings an orphan back as a draft when its line reappears, not as approved', async () => {
    const dir = drop();
    const line = '- Hexaware runs a governed AI delivery layer\n';
    writeFileSync(join(dir, 'a.md'), line);
    const before = mergeDrop([], (await readDrop(dir)).lines, NOW);
    const approved = before.claims.map((c) => ({ ...c, status: 'approved' as const }));

    writeFileSync(join(dir, 'a.md'), '');
    const gone = mergeDrop(approved, (await readDrop(dir)).lines, NOW);
    writeFileSync(join(dir, 'a.md'), line);
    const back = mergeDrop(gone.claims, (await readDrop(dir)).lines, NOW);

    // Deliberately a draft again: the deck changed under it, so it is re-read.
    expect(back.claims[0]?.status).toBe('draft');
  });

  it('leaves claims that did not come from the folder completely alone', async () => {
    const dir = drop();
    writeFileSync(join(dir, 'a.md'), '- Hexaware runs a governed AI delivery layer\n');
    const handWritten: Claim = {
      id: 'company.headquarters',
      text: 'Hexaware is headquartered in Navi Mumbai.',
      kind: 'fact',
      status: 'approved',
      markets: ['AU', 'NZ'],
      sources: [{ kind: 'url', ref: 'https://example.com', quote: 'Navi Mumbai', retrievedAt: '2026-09-17' }],
      conflictsWith: []
    };

    const result = mergeDrop([handWritten], (await readDrop(dir)).lines, NOW);
    expect(result.claims.find((c) => c.id === 'company.headquarters')).toEqual(handWritten);
    expect(result.orphaned).toEqual([]);
  });

  it('gives the same sentence in two decks two separate claims to review', () => {
    expect(claimIdFor('one.pptx', 'the same sentence entirely')).not.toBe(
      claimIdFor('two.pptx', 'the same sentence entirely')
    );
  });
});

describe('files it cannot read', () => {
  it('says so rather than failing silently', async () => {
    const dir = drop();
    writeFileSync(join(dir, 'notes.docx'), 'not really a docx');
    const { skipped } = await readDrop(dir);
    expect(skipped).toEqual([{ file: 'notes.docx', reason: '.docx is not read; use .pptx, .md or .txt' }]);
  });

  it('reports a corrupt deck by name instead of throwing', async () => {
    const dir = drop();
    writeFileSync(join(dir, 'broken.pptx'), 'this is not a zip');
    const { skipped, lines } = await readDrop(dir);
    expect(lines).toEqual([]);
    expect(skipped[0]?.file).toBe('broken.pptx');
    expect(skipped[0]?.reason).toContain('could not be read');
  });

  it('walks sub-folders so the operator can organise however they like', async () => {
    const dir = drop();
    mkdirSync(join(dir, 'banking'));
    writeFileSync(join(dir, 'banking', 'nz.md'), '- Hexaware runs a governed AI delivery layer\n');
    const { lines } = await readDrop(dir);
    expect(lines[0]?.file).toBe('banking/nz.md');
  });

  it('ignores its own README', async () => {
    const dir = drop();
    writeFileSync(join(dir, 'README.md'), '- This line explains how the folder works\n');
    expect((await readDrop(dir)).lines).toEqual([]);
  });
});
