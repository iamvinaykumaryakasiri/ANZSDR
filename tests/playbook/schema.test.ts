import { describe, expect, it } from 'vitest';
import { COACH_MAY_NOT_EDIT } from '../../src/agents/caller/opening.js';
import { BASELINE } from '../../src/playbook/baseline.js';
import {
  findImmutableKeys,
  FROZEN_OBJECTIONS,
  immutableFieldsInSchema,
  objectionKindSchema,
  parseVersionName,
  playbookContentSchema,
  PLAYBOOK_SLOTS,
  REWRITABLE_OBJECTIONS,
  schemaFieldNames,
  versionName
} from '../../src/playbook/schema.js';
import { claimIdsIn, parseTemplate, renderTemplate } from '../../src/playbook/template.js';
import { playbookSlotSchema } from '../../src/blackboard/schemas.js';
import { CLAIM_ID, CLAIM_TEXT } from './support.js';

describe('the immutable module cannot be expressed in a playbook', () => {
  it('has no schema field named after anything Coach may never touch', () => {
    expect(immutableFieldsInSchema()).toEqual([]);
    // And the field list is not empty, so that assertion is about something.
    expect(schemaFieldNames()).toContain('template');
    expect(schemaFieldNames()).toContain('responses');
  });

  it.each([...COACH_MAY_NOT_EDIT, 'opening', 'disclosure', 'bannedTopics', 'claims', 'termination', 'deflections'])(
    'rejects a variant that carries "%s"',
    (key) => {
      const candidate = { slot: 'hook', template: 'I read about {{company}} and {{hook}} stood out.', [key]: 'anything' };
      expect(findImmutableKeys(candidate)).toEqual([key]);
      expect(playbookContentSchema.safeParse(candidate).success).toBe(false);
    }
  );

  it('finds the key however it is spelled or nested', () => {
    expect(findImmutableKeys({ slot: 'objection', responses: { other: 'x' }, extra: { 'AI-Disclosure': 'no' } })).toEqual([
      'extra.AI-Disclosure'
    ]);
    expect(findImmutableKeys([{ a: { recording_announcement: true } }])).toEqual(['[0].a.recording_announcement']);
    expect(findImmutableKeys('a string')).toEqual([]);
    expect(findImmutableKeys(null)).toEqual([]);
  });

  it('refuses unknown keys at every level (the schema is strict)', () => {
    expect(playbookContentSchema.safeParse({ slot: 'transition', template: 'That is why I called, honestly.', note: 'x' }).success).toBe(false);
    expect(playbookContentSchema.safeParse({ slot: 'objection', responses: { other: 'Fair enough, thanks for saying.', mystery: 'x' } }).success).toBe(false);
    expect(playbookContentSchema.safeParse({ slot: 'opening', template: 'Hi, I am Lexi, and I am a person.' }).success).toBe(false);
  });

  it('has exactly the five slots section 11 allows', () => {
    expect([...PLAYBOOK_SLOTS].sort()).toEqual([...playbookSlotSchema.options].sort());
  });

  it('accounts for every objection kind: rewritable, or frozen with a reason', () => {
    const accounted = [...REWRITABLE_OBJECTIONS, ...Object.keys(FROZEN_OBJECTIONS)].sort();
    expect(accounted).toEqual([...objectionKindSchema.options].sort());
  });

  it.each(Object.keys(FROZEN_OBJECTIONS))('gives Coach no way to write a response to the frozen objection "%s"', (kind) => {
    const candidate = { slot: 'objection', responses: { [kind]: 'Let me just try one more thing there.' } };
    expect(playbookContentSchema.safeParse(candidate).success).toBe(false);
  });
});

describe('slot rules', () => {
  const parse = (v: unknown) => playbookContentSchema.safeParse(v);

  it('a hook phrasing must carry the dossier hook, and only a hook phrasing may', () => {
    expect(parse({ slot: 'hook', template: 'I wanted to ask you something about Kiwibank today.' }).success).toBe(false);
    expect(parse({ slot: 'transition', template: 'That is why I called about {{hook}} today.' }).success).toBe(false);
  });

  it('a value statement must rest on a claim, and only value statements and objections may cite one', () => {
    expect(parse({ slot: 'value-statement', template: 'We are very good at all of this work.' }).success).toBe(false);
    expect(parse({ slot: 'value-statement', template: `{{claim:${CLAIM_ID}}} Worth a chat, perhaps?` }).success).toBe(true);
    expect(parse({ slot: 'transition', template: `That is why {{claim:${CLAIM_ID}}} matters to me.` }).success).toBe(false);
    expect(parse({ slot: 'objection', responses: { other: `Fair enough. {{claim:${CLAIM_ID}}} Shall I email?` } }).success).toBe(true);
  });

  it('rejects unknown placeholders, stray braces and a variant with no responses', () => {
    expect(parse({ slot: 'transition', template: 'That is why I called {{name}}, honestly.' }).success).toBe(false);
    expect(parse({ slot: 'transition', template: 'That is why I called { firstName }, honestly.' }).success).toBe(false);
    expect(parse({ slot: 'objection', responses: {} }).success).toBe(false);
    expect(parse({ slot: 'transition', template: 'Too short' }).success).toBe(false);
  });

  it('every baseline phrase is valid, and the value statement has none', () => {
    for (const content of Object.values(BASELINE)) expect(parse(content).success).toBe(true);
    expect(BASELINE['value-statement']).toBeUndefined();
  });
});

describe('templates', () => {
  it('parses placeholders and leaves the words Coach wrote', () => {
    const parsed = parseTemplate(`Hi {{firstName}}, {{ claim:${CLAIM_ID} }} and {{bogus}}`);
    expect(parsed.placeholders).toHaveLength(2);
    expect(parsed.invalid).toEqual(['{{bogus}}']);
    expect(parsed.literal).toBe('Hi , and');
    expect(claimIdsIn(`a {{claim:${CLAIM_ID}}} b {{claim:BAD ID}}`)).toEqual([CLAIM_ID]);
  });

  it('renders approved claim text verbatim and reports what could not be filled', () => {
    const ok = renderTemplate(`{{firstName}} at {{company}}: {{claim:${CLAIM_ID}}} ({{hook}})`, {
      firstName: 'Priya',
      company: 'Kiwibank',
      hook: ' a hook ',
      claimText: () => CLAIM_TEXT
    });
    expect(ok).toEqual({ text: `Priya at Kiwibank: ${CLAIM_TEXT} (a hook)`, unresolved: [] });

    const missing = renderTemplate('{{hook}} {{claim:x}} {{nope}}', { firstName: 'P', company: 'C', claimText: () => undefined });
    expect(missing.unresolved).toEqual(['hook', 'claim:x', '{{nope}}']);
    const blankHook = renderTemplate('{{hook}}', { firstName: 'P', company: 'C', hook: '  ', claimText: () => undefined });
    expect(blankHook.unresolved).toEqual(['hook']);
  });

  it('names versions the way the console reads them', () => {
    expect(versionName('hook', 3)).toBe('hook v3');
    expect(parseVersionName('value-statement v12')).toEqual({ slot: 'value-statement', version: 12 });
    expect(parseVersionName('unversioned')).toBeNull();
    expect(parseVersionName('bogus v1')).toBeNull();
    expect(parseVersionName(null)).toBeNull();
  });
});
