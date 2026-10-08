/** Small helpers shared across the playbook modules. */

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 0.0833 -> "8.3%". Rates are quoted to a tenth of a point everywhere. */
export function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

/** Lower-case, punctuation-free, single-spaced: for comparing two pieces of text. */
export function normaliseText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9{}:._\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Pull the first JSON object out of a model reply, tolerating a stray code fence. */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = fenced !== null ? (fenced[1] as string) : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('no JSON object in the reply');
  return JSON.parse(candidate.slice(start, end + 1)) as unknown;
}
