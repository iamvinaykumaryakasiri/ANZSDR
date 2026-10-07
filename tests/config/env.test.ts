import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadDotEnv } from '../../src/config/env.js';

const NAMES = ['SDR_TEST_KEY', 'SDR_TEST_OTHER'];
let dirs: string[] = [];
afterEach(() => {
  for (const n of NAMES) delete process.env[n];
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function envFile(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'env-'));
  dirs.push(dir);
  const path = join(dir, '.env');
  writeFileSync(path, contents);
  return path;
}

describe('loading .env', () => {
  it('puts the file’s variables into the environment', () => {
    expect(loadDotEnv(envFile('SDR_TEST_KEY=from-the-file\nSDR_TEST_OTHER="quoted value"\n'))).toBe(true);
    expect(process.env.SDR_TEST_KEY).toBe('from-the-file');
    expect(process.env.SDR_TEST_OTHER).toBe('quoted value');
  });

  it('never overrides a variable that is already set, so a real secret beats a stale line', () => {
    process.env.SDR_TEST_KEY = 'from-the-shell';
    loadDotEnv(envFile('SDR_TEST_KEY=from-the-file\n'));
    expect(process.env.SDR_TEST_KEY).toBe('from-the-shell');
  });

  it('treats a missing file as normal: a deployed host has real variables and no file', () => {
    expect(loadDotEnv(join(tmpdir(), 'definitely-not-here', '.env'))).toBe(false);
  });

  it('leaves an empty value empty rather than inventing one', () => {
    loadDotEnv(envFile('SDR_TEST_KEY=\n'));
    expect(process.env.SDR_TEST_KEY).toBe('');
  });
});
