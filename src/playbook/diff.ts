/**
 * Word-level diffs between two versions of a slot, so a change is reviewable as a
 * diff rather than as "the new text" (section 11 item 6: every change versioned,
 * diffable, reversible).
 */

import { textFields, type PlaybookContent } from './schema.js';

export interface DiffOp {
  type: 'same' | 'add' | 'del';
  text: string;
}

export interface FieldDiff {
  field: string;
  before: string | null;
  after: string | null;
  ops: DiffOp[];
}

/** Longest-common-subsequence diff over whitespace-separated words. */
export function diffWords(before: string, after: string): DiffOp[] {
  const a = before.split(/\s+/).filter((w) => w !== '');
  const b = after.split(/\s+/).filter((w) => w !== '');

  // lengths[i][j] is the LCS length of a[i..] and b[j..].
  const lengths: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lengths[i]![j] = a[i] === b[j] ? lengths[i + 1]![j + 1]! + 1 : Math.max(lengths[i + 1]![j]!, lengths[i]![j + 1]!);
    }
  }

  const ops: DiffOp[] = [];
  const push = (type: DiffOp['type'], text: string): void => {
    const last = ops[ops.length - 1];
    if (last !== undefined && last.type === type) last.text += ` ${text}`;
    else ops.push({ type, text });
  };

  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      push('same', a[i]!);
      i++;
      j++;
    } else if (lengths[i + 1]![j]! >= lengths[i]![j + 1]!) {
      push('del', a[i]!);
      i++;
    } else {
      push('add', b[j]!);
      j++;
    }
  }
  while (i < a.length) push('del', a[i++]!);
  while (j < b.length) push('add', b[j++]!);
  return ops;
}

/** Per-field diffs between two contents of the same slot. `before` may be absent (a first version). */
export function diffContent(before: PlaybookContent | null, after: PlaybookContent): FieldDiff[] {
  const beforeFields = new Map((before === null ? [] : textFields(before)).map((f) => [f.field, f.text]));
  const afterFields = new Map(textFields(after).map((f) => [f.field, f.text]));
  const names = [...new Set([...beforeFields.keys(), ...afterFields.keys()])];

  return names.map((field) => {
    const was = beforeFields.get(field) ?? null;
    const now = afterFields.get(field) ?? null;
    return { field, before: was, after: now, ops: diffWords(was ?? '', now ?? '') };
  });
}

/** `same text [-removed-] {+added+}` per field, for the terminal and the change note. */
export function renderDiff(diffs: FieldDiff[]): string {
  return diffs
    .map(({ field, ops }) => {
      const body = ops
        .map((op) => (op.type === 'same' ? op.text : op.type === 'del' ? `[-${op.text}-]` : `{+${op.text}+}`))
        .join(' ');
      return `${field}: ${body}`;
    })
    .join('\n');
}
