/**
 * The first real conversation, on a keyboard rather than a phone.
 *
 *   npm run caller:smoke
 *
 * This is the only thing in the build that spends money, so it says what it
 * cost when it finishes. Everything else - including the thirty acceptance
 * scenarios - runs against scripted models and costs nothing.
 *
 * Nothing here dials. Section 13 phase 5 is the phone; this is the brain with a
 * terminal attached, which is what phase 4 is accepted on.
 */

import { createInterface } from 'node:readline/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { ClaimIndex } from '../src/knowledge/claims.js';
import { loadPack } from '../src/knowledge/pack.js';
import { loadIdentity, identityGaps } from '../src/agents/caller/identity.js';
import { assembleBriefing, renderBriefing } from '../src/agents/caller/briefing.js';
import { runTurn } from '../src/agents/caller/brain.js';
import { checkTurn } from '../src/agents/guardian/check.js';
import { auditCall, type TranscriptTurn } from '../src/agents/guardian/audit.js';
import { claudeAuditModel, claudeCallerModel, claudeCheckModel, loadModelConfig } from '../src/voice/claude-model.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function main(): Promise<void> {
  if ((process.env.ANTHROPIC_API_KEY ?? '').trim() === '') {
    console.error('\nANTHROPIC_API_KEY is not set.\n');
    console.error('Put it in .env (which is gitignored) or export it, then run this again.');
    console.error('Everything else in the build runs without it — see npm test.\n');
    process.exit(1);
  }

  const identity = loadIdentity(resolve(ROOT, 'config/agent.yaml'));
  const config = loadModelConfig(resolve(ROOT, 'config/models.yaml'));
  const claims = ClaimIndex.load(resolve(ROOT, 'knowledge/approved-claims.json'));
  const pack = loadPack(resolve(ROOT, 'knowledge'));

  for (const gap of identityGaps(identity)) console.log(`  note: ${gap}`);

  const briefing = assembleBriefing({
    identity,
    prospect: {
      contactId: 'smoke',
      name: 'Priya Raman',
      firstName: 'Priya',
      title: 'Head of Data',
      accountName: 'Kiwibank',
      market: 'NZ'
    },
    dossier: {
      hypothesis:
        "I'm calling because Kiwibank has had data platform roles open since March, which usually means a rebuild.",
      confidence: 'high',
      hooks: [{ text: 'Four data platform roles open since March.', sourceUrl: 'https://example.com/careers' }],
      landmines: [],
      unverified: []
    },
    claims,
    pack
  });

  const counts = claims.counts();
  console.log(`\n  ${counts.approved} approved claim(s) of ${counts.total}.`);
  if (counts.approved === 0) {
    console.log('  Lexi can assert nothing factual and will defer anything it is asked.');
    console.log('  That is the shipped default — npm run knowledge:status to approve.');
  }
  for (const note of briefing.notes) console.log(`  ${note}`);

  const client = new Anthropic();
  const deps = { client, config };
  const caller = claudeCallerModel(deps);
  const check = claudeCheckModel(deps);

  const transcript: TranscriptTurn[] = [];
  const history: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  const startedAt = Date.now();

  console.log('\n─────────────────────────────────────────────');
  console.log(briefing.openingText);
  console.log('─────────────────────────────────────────────\n');
  transcript.push({ speaker: 'lexi', text: briefing.openingText, atSecond: 0 });
  history.push({ role: 'assistant', content: briefing.openingText });

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const system = renderBriefing(briefing);

  for (;;) {
    const said = (await rl.question('you: ')).trim();
    if (said === '' || said === '/quit') break;

    const at = Math.round((Date.now() - startedAt) / 1000);
    transcript.push({ speaker: 'prospect', text: said, atSecond: at });
    history.push({ role: 'user', content: said });

    const began = Date.now();
    const turn = await runTurn({ model: caller, system, history, prospectSaid: said });
    const checked = await checkTurn({
      model: check,
      prospectSaid: said,
      draftReply: turn.spoken,
      assertableClaims: claims.assertable('NZ').map((c) => c.text)
    });
    const took = Date.now() - began;

    console.log(`\nLexi: ${checked.reply}`);
    console.log(`      (${took}ms, guardian: ${checked.level}${checked.overridden ? ', overridden' : ''})`);
    for (const defect of turn.defects) console.log(`      defect — ${defect.detail}`);
    for (const defect of checked.defects) console.log(`      defect — ${defect}`);
    for (const call of turn.toolCalls) console.log(`      tool — ${call.name} ${JSON.stringify(call.value)}`);
    console.log('');

    transcript.push({ speaker: 'lexi', text: checked.reply, atSecond: Math.round((Date.now() - startedAt) / 1000) });
    history.push({ role: 'assistant', content: checked.reply });
  }
  rl.close();

  console.log('\n─── post-call audit ─────────────────────────');
  const audit = await auditCall({
    transcript,
    claims,
    openingSaid: briefing.opening,
    model: claudeAuditModel(deps)
  });
  if (audit.clean) {
    console.log('  clean: nothing found.');
  } else {
    for (const finding of audit.findings) {
      console.log(`  ${finding.certainty === 'certain' ? '!' : '?'} ${finding.kind}: ${finding.detail}`);
    }
  }
  if (audit.modelUnavailable !== undefined) console.log(`  ${audit.modelUnavailable}`);
  console.log('');
}

await main();
