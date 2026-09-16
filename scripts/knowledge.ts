/**
 * The knowledge pack from the terminal.
 *
 *   npm run knowledge:status
 *   npm run knowledge:sync
 *   npm run knowledge:approve <claim-id>
 *   npm run knowledge:reject  <claim-id> -- --reason "..."
 *
 * Approve is one claim at a time on purpose. There is no "approve all": the
 * whole value of the index is that a person read each line before an AI said it
 * to a stranger, and a bulk flag would quietly undo that.
 */

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync } from 'node:fs';
import { ClaimIndex } from '../src/knowledge/claims.js';
import { loadPack } from '../src/knowledge/pack.js';
import { mergeDrop, readDrop } from '../src/knowledge/ingest.js';
import type { Claim } from '../src/knowledge/types.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const KNOWLEDGE = join(ROOT, 'knowledge');
const INDEX_PATH = join(KNOWLEDGE, 'approved-claims.json');
const DROP = join(KNOWLEDGE, 'drop');

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}

function describe(claim: Claim): string {
  const source = claim.sources[0];
  const where = source === undefined ? 'no source' : `${source.ref}${source.locator === undefined ? '' : ` · ${source.locator}`}`;
  return `  ${claim.id}\n    ${claim.text}\n    ${where}`;
}

function status(): void {
  const index = ClaimIndex.load(INDEX_PATH);
  const counts = index.counts();
  const pack = loadPack(KNOWLEDGE);

  console.log(
    `\n${counts.total} claim(s): ${counts.approved} approved, ${counts.draft} draft, ${counts.rejected} rejected, ${counts.orphaned} orphaned`
  );

  if (counts.approved === 0) {
    console.log('\n  Nothing is approved, so the agent can currently assert nothing.');
    console.log('  That is the safe default, not a fault.');
  }

  const conflicts = index.conflicts();
  if (conflicts.length > 0) {
    console.log('\ncontradictions:');
    for (const c of conflicts) {
      console.log(`  ${c.a.id} vs ${c.b.id}${c.live ? '  ← BOTH APPROVED, resolve this' : ''}`);
      console.log(`    "${c.a.text}"`);
      console.log(`    "${c.b.text}"`);
    }
  }

  const drafts = index.withStatus('draft');
  if (drafts.length > 0) {
    console.log(`\nwaiting for you (${drafts.length}):`);
    for (const claim of drafts) console.log(describe(claim));
  }

  const orphans = index.withStatus('orphaned');
  if (orphans.length > 0) {
    console.log(`\norphaned — the file they came from no longer contains them (${orphans.length}):`);
    for (const claim of orphans) console.log(`  ${claim.id}  ${claim.text.slice(0, 60)}…`);
  }

  if (pack.missing.length > 0) {
    console.log(`\npack files missing: ${pack.missing.join(', ')}`);
  } else {
    console.log(`\npack: ${pack.sections.length} section(s) across ${new Set(pack.sections.map((s) => s.file)).size} file(s)`);
  }

  console.log('\nApprove one with:  npm run knowledge:approve <claim-id>\n');
}

async function sync(): Promise<void> {
  if (!existsSync(DROP)) mkdirSync(DROP, { recursive: true });
  const index = ClaimIndex.load(INDEX_PATH);
  const { lines, skipped } = await readDrop(DROP);
  const result = mergeDrop(index.all(), lines, new Date());
  index.replaceAll(result.claims);
  index.save(INDEX_PATH);

  console.log(`\nread ${lines.length} candidate line(s) from knowledge/drop/`);
  console.log(`  ${result.added.length} new draft claim(s)`);
  console.log(`  ${result.unchanged} unchanged`);
  if (result.orphaned.length > 0) {
    console.log(`  ${result.orphaned.length} orphaned — their source line has gone, so they are no longer assertable`);
  }
  for (const s of skipped) console.log(`  skipped ${s.file}: ${s.reason}`);

  if (result.added.length > 0) {
    console.log('\nAll new claims are drafts. The agent cannot say any of them until you approve each one:');
    console.log('  npm run knowledge:status\n');
  } else {
    console.log('');
  }
}

function approve(): void {
  const id = process.argv[3];
  if (id === undefined || id.startsWith('-')) {
    console.error('usage: npm run knowledge:approve <claim-id>');
    process.exit(1);
  }
  const index = ClaimIndex.load(INDEX_PATH);
  const claim = index.find(id);
  if (claim === undefined) {
    console.error(`no claim with id "${id}". Run npm run knowledge:status to list them.`);
    process.exit(1);
  }
  const by = arg('--by') ?? 'operator';
  index.approve(id, by, new Date());
  index.save(INDEX_PATH);
  console.log(`\napproved by ${by}:\n  "${claim.text}"\n\nThe agent may now assert this on a call.\n`);
}

function reject(): void {
  const id = process.argv[3];
  const reason = arg('--reason');
  if (id === undefined || id.startsWith('-') || reason === undefined) {
    console.error('usage: npm run knowledge:reject <claim-id> -- --reason "why"');
    process.exit(1);
  }
  const index = ClaimIndex.load(INDEX_PATH);
  if (index.find(id) === undefined) {
    console.error(`no claim with id "${id}".`);
    process.exit(1);
  }
  index.reject(id, reason, new Date());
  index.save(INDEX_PATH);
  console.log(`\nrejected: ${id}\n  ${reason}\n`);
}

const command = process.argv[2] ?? 'status';
try {
  if (command === 'sync') await sync();
  else if (command === 'approve') approve();
  else if (command === 'reject') reject();
  else status();
} catch (error) {
  console.error(`\n${(error as Error).message}\n`);
  process.exit(1);
}
