#!/usr/bin/env node
// Drift check: every field name declared in the zod source of truth
// (src/stream/contract.ts) must also appear as a field in web/src/contract.ts.
// Heuristic by design: it compares identifier sets, not types.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(here, '../../src/stream/contract.ts'), 'utf8');
const copy = readFileSync(resolve(here, '../src/contract.ts'), 'utf8');

const fields = (text) => new Set([...text.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\??\s*:/gm)].map((m) => m[1]));
const enumValues = (text) => new Set([...text.matchAll(/'([a-z][a-z0-9_]+)'/g)].map((m) => m[1]));

const missingFields = [...fields(source)].filter((f) => !fields(copy).has(f) && !['type'].includes(f));
const ignoredValues = new Set(['zod', 'type']);
const missingValues = [...enumValues(source)].filter((v) => !ignoredValues.has(v) && !enumValues(copy).has(v));

if (missingFields.length || missingValues.length) {
  console.error('web/src/contract.ts has drifted from src/stream/contract.ts');
  if (missingFields.length) console.error('  fields missing:', missingFields.join(', '));
  if (missingValues.length) console.error('  literal values missing:', missingValues.join(', '));
  process.exit(1);
}
console.log('web/src/contract.ts matches src/stream/contract.ts (field names and literal values).');
