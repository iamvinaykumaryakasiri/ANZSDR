import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { resolveDatabaseUrl } from '../../src/blackboard/client.js';
import {
  BlackboardDecodeError,
  decode,
  EMAIL_PRECEDENCE,
  encode,
  callOutcomeSchema,
  hookSchema,
  icpSchema,
  sourcedFactSchema
} from '../../src/blackboard/schemas.js';

describe('decoding blackboard columns', () => {
  it('round-trips a valid value', () => {
    const icp = { titles: ['head of data'], seniorities: ['director'] };
    const stored = encode(icpSchema, 'Campaign.icp', icp);
    expect(decode(icpSchema, 'Campaign.icp', stored)).toMatchObject({
      titles: ['head of data'],
      industries: [],
      minimumScore: 60
    });
  });

  it('refuses text that is not JSON at all', () => {
    expect(() => decode(icpSchema, 'Campaign.icp', 'not json')).toThrow(BlackboardDecodeError);
  });

  it('refuses JSON that does not match the schema, naming the field', () => {
    try {
      decode(icpSchema, 'Campaign.icp', '{"titles": "not an array"}');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(BlackboardDecodeError);
      expect((error as BlackboardDecodeError).field).toBe('Campaign.icp');
    }
  });

  it('refuses to write a value that does not match, so nothing malformed is stored', () => {
    expect(() => encode(icpSchema, 'Campaign.icp', { titles: 42 })).toThrow(BlackboardDecodeError);
  });
});

describe('sourcing', () => {
  it('will not accept a fact without a usable source URL', () => {
    expect(sourcedFactSchema.safeParse({ fact: 'they use Databricks' }).success).toBe(false);
    expect(sourcedFactSchema.safeParse({ fact: 'they use Databricks', sourceUrl: 'somewhere' }).success).toBe(false);
    expect(
      sourcedFactSchema.safeParse({ fact: 'they use Databricks', sourceUrl: 'https://example.com/careers' }).success
    ).toBe(true);
  });

  it('defaults a hook to the hook slot rather than leaving it unset', () => {
    expect(hookSchema.parse({ text: 'x', sourceUrl: 'https://example.com/' }).slot).toBe('hook');
  });

  it('refuses to store an unsourced hook', () => {
    expect(() => encode(z.array(hookSchema), 'Dossier.hooks', [{ text: 'a rumour' }])).toThrow(
      BlackboardDecodeError
    );
  });
});

describe('conventions', () => {
  it('ranks a confirmed-on-call address above anything Apollo supplied', () => {
    expect(EMAIL_PRECEDENCE[0]).toBe('confirmed_on_call');
    expect(EMAIL_PRECEDENCE).toHaveLength(3);
  });

  it('knows every call outcome the brief defines', () => {
    expect(callOutcomeSchema.options).toHaveLength(10);
    expect(callOutcomeSchema.options).toContain('gatekeeper_blocked');
    expect(callOutcomeSchema.options).toContain('do_not_contact');
  });
});

describe('database url', () => {
  it('anchors a relative sqlite path to the repository root, not the working directory', () => {
    const url = resolveDatabaseUrl('file:./data/anzsdr.db');
    expect(url.startsWith('file:/')).toBe(true);
    expect(url.endsWith('/data/anzsdr.db')).toBe(true);
    // Whatever the caller's cwd, one URL means one file.
    expect(resolveDatabaseUrl('file:data/anzsdr.db')).toBe(url);
  });

  it('leaves an absolute path and a non-file url alone', () => {
    expect(resolveDatabaseUrl('file:/tmp/x.db')).toBe('file:/tmp/x.db');
    expect(resolveDatabaseUrl('postgresql://localhost/anzsdr')).toBe('postgresql://localhost/anzsdr');
  });
});
