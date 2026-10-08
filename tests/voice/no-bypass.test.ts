/**
 * The structural half of "no path from the adapter to the provider that
 * bypasses the gate": a scan of the source, so a future file that dials some
 * other way fails a test rather than passing review by luck.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === 'node_modules' || name === 'dist') return [];
    if (statSync(path).isDirectory()) return sources(path);
    return path.endsWith('.ts') || path.endsWith('.tsx') || path.endsWith('.mjs') ? [path] : [];
  });
}

const files = [...sources(join(ROOT, 'src')), ...sources(join(ROOT, 'scripts'))].map((path) => ({
  path: relative(ROOT, path),
  text: readFileSync(path, 'utf8')
}));

const only = (pattern: RegExp): string[] => files.filter((f) => pattern.test(f.text)).map((f) => f.path).sort();

describe('where a call can come from', () => {
  it('only the Vapi adapter knows where the provider\'s call-creation endpoint is', () => {
    expect(only(/POST['"`]\s*,\s*['"`]\/call['"`]/)).toEqual(['src/voice/vapi.ts']);
    expect(only(/api\.vapi\.ai/)).toEqual(['src/voice/vapi.ts']);
  });

  it('nothing reaches Twilio\'s call-creation API at all', () => {
    // Calls leave through the provider. A second route out would be a second
    // route round the gate.
    expect(only(/Calls\.json/)).toEqual([]);
    expect(only(/from ['"]twilio['"]/)).toEqual([]);
    // The one place that talks to Twilio's REST API is the preflight's read of
    // the account, which cannot create anything.
    expect(only(/api\.twilio\.com/)).toEqual(['src/voice/doctor.ts']);
  });

  it('only the Vapi adapter redeems a permit', () => {
    expect(only(/\bredeemPermit\(/)).toEqual(['src/voice/permit.ts', 'src/voice/vapi.ts']);
  });

  it('the only callers of placeCall are the adapter itself and the gated dial function', () => {
    const callers = only(/\.placeCall\(/).filter((p) => p !== 'src/voice/vapi.ts');
    expect(callers).toEqual(['src/voice/dial.ts']);
  });

  it('the dial function asks the gate for its permit before it touches the provider', () => {
    const dial = files.find((f) => f.path === 'src/voice/dial.ts')?.text ?? '';
    const gate = dial.indexOf('requestDialPermit(');
    const provider = dial.indexOf('.placeCall(');
    expect(gate).toBeGreaterThan(-1);
    expect(provider).toBeGreaterThan(gate);
  });

  it('the preflight and the purge are handed no way to place a call', () => {
    for (const path of ['src/voice/doctor.ts', 'src/voice/recordings.ts', 'src/voice/latency-probe.ts']) {
      const text = files.find((f) => f.path === path)?.text ?? '';
      expect(text, path).not.toMatch(/placeCall|requestDialPermit|VapiAdapter/);
    }
  });
});
