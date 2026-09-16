/**
 * Reading the text out of a PowerPoint deck.
 *
 * A .pptx is a zip of XML. Slide text lives in `ppt/slides/slideN.xml` inside
 * <a:t> elements, one per run, so a single sentence broken across two runs by
 * a stray bold word arrives as two fragments and has to be rejoined.
 *
 * Nothing here interprets what it finds. It returns lines and the slide they
 * sat on; deciding whether a line is an assertion is `ingest.ts`, and deciding
 * whether the agent may say it is a person.
 */

import JSZip from 'jszip';

export interface SlideText {
  /** 1-based, in deck order. */
  slide: number;
  lines: string[];
}

/** Undo the five XML entities that matter, in the one order that is safe. */
function decodeEntities(input: string): string {
  return input
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * A paragraph is <a:p>; the runs inside it are <a:t>. Joining runs within a
 * paragraph and splitting between paragraphs is what keeps "Zero **Tech** Debt"
 * from arriving as three separate claims.
 */
function paragraphsOf(xml: string): string[] {
  const paragraphs: string[] = [];
  for (const block of xml.split(/<a:p[\s>]/)) {
    const runs = [...block.matchAll(/<a:t[^>]*>([\s\S]*?)<\/a:t>/g)].map((m) =>
      decodeEntities(m[1] as string)
    );
    if (runs.length === 0) continue;
    const line = runs.join('').replace(/\s+/g, ' ').trim();
    if (line !== '') paragraphs.push(line);
  }
  return paragraphs;
}

function slideNumber(path: string): number {
  const match = /slide(\d+)\.xml$/.exec(path);
  return match === null ? 0 : Number.parseInt(match[1] as string, 10);
}

/** Slide text in deck order. Throws if the file is not a readable zip. */
export async function extractSlides(data: Buffer): Promise<SlideText[]> {
  const zip = await JSZip.loadAsync(data);
  const paths = Object.keys(zip.files)
    .filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p))
    .sort((a, b) => slideNumber(a) - slideNumber(b));

  const out: SlideText[] = [];
  for (const path of paths) {
    const xml = await (zip.files[path] as JSZip.JSZipObject).async('string');
    const lines = paragraphsOf(xml);
    if (lines.length > 0) out.push({ slide: slideNumber(path), lines });
  }
  return out;
}
