/**
 * Coach from the terminal. Every command reports by default and changes nothing;
 * `--apply` carries it out.
 *
 *   npm run coach -- status
 *   npm run coach -- seed      [--apply]
 *   npm run coach -- propose   [--slot hook] [--week-ending 2026-10-04] [--proposals file.json] [--apply]
 *   npm run coach -- evaluate  [--apply]
 *   npm run coach -- promote   [--apply]
 *   npm run coach -- rollback  [--slot hook] [--to 2] [--apply]
 *   npm run coach -- history   [--slot hook]
 *   npm run coach -- diff <slot> <from> <to>
 *
 * `propose` needs an Anthropic key: the compliance review and the adversarial calls
 * are model work, and a gate that cannot reach them passes nothing. `evaluate`,
 * `promote` and `rollback` need no key and no network - they count calls and
 * compare arms. `promote` carries out a promotion decision and no other; there is
 * no `--force`, because a promotion the gate has not reached is exactly what the gate
 * exists to refuse.
 */

import '../../config/env-autoload.js';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { DateTime } from 'luxon';
import { createBlackboard } from '../../blackboard/client.js';
import { PrismaJournal, TaskRepository } from '../../blackboard/repositories.js';
import { ClaimIndex } from '../../knowledge/claims.js';
import { loadPack } from '../../knowledge/pack.js';
import { loadCoachConfig } from '../../playbook/config.js';
import { diffContent, renderDiff } from '../../playbook/diff.js';
import { FailureMemory } from '../../playbook/failure-memory.js';
import type { ComplianceReviewer } from '../../playbook/review.js';
import { PLAYBOOK_SLOTS, versionName, type PlaybookSlot } from '../../playbook/schema.js';
import { createAdversarialSimulator } from '../../playbook/simulation.js';
import type { AdversarialSimulator } from '../../playbook/simulation-types.js';
import { PlaybookStore } from '../../playbook/store.js';
import { describeError, pct } from '../../playbook/util.js';
import { claudeAuditModel, claudeCallerModel, claudeCheckModel, loadModelConfig } from '../../voice/claude-model.js';
import { genericReasons, openingTexts } from '../analyst/opening-lines.js';
import { dayContaining, OPERATOR_ZONE, shiftDays } from '../analyst/metrics.js';
import { loadIdentity } from '../caller/identity.js';
import { InMemoryJournal, type AgentJournal } from '../journal.js';
import { claudeCoachModel, claudeComplianceReviewer } from './claude.js';
import { createCoach } from './agent.js';
import { coachTools } from './tools.js';
import type { CoachModel } from './model.js';
import { evaluateLiveTest, monitorPromotions, runWeekly, type CycleDeps } from './cycle.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

interface Flags {
  apply: boolean;
  slot?: PlaybookSlot;
  to?: number;
  weekEnding?: string;
  proposals?: string;
  rest: string[];
}

function parseFlags(args: string[]): Flags {
  const flags: Flags = { apply: false, rest: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === '--apply') flags.apply = true;
    else if (a === '--slot') {
      const v = args[++i] as string | undefined;
      const slot = PLAYBOOK_SLOTS.find((s) => s === v);
      if (slot === undefined) throw new Error(`--slot must be one of ${PLAYBOOK_SLOTS.join(', ')}`);
      flags.slot = slot;
    } else if (a === '--to') flags.to = Number(args[++i]);
    else if (a === '--week-ending') flags.weekEnding = args[++i] as string;
    else if (a === '--proposals') flags.proposals = args[++i] as string;
    else flags.rest.push(a);
  }
  return flags;
}

const unavailable = (what: string): never => {
  throw new Error(`${what} is not available for this command`);
};

/** Stands in where a command never reaches a model. If it ever is reached, it fails closed. */
const NO_REVIEWER: ComplianceReviewer = { instanceId: 'none', review: async () => unavailable('the compliance reviewer') };
const NO_SIMULATOR: AdversarialSimulator = { run: async () => unavailable('the adversarial simulation') };

function line(text = ''): void {
  console.log(text);
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);

  if (command === undefined) {
    console.error('Usage: npm run coach -- status | seed | propose | evaluate | promote | rollback | history | diff   (add --apply to change anything)');
    process.exit(1);
  }

  const db = createBlackboard();
  try {
    const config = loadCoachConfig(resolve(ROOT, 'config/coach.yaml'));
    const identity = loadIdentity(resolve(ROOT, 'config/agent.yaml'));
    const claims = ClaimIndex.load(resolve(ROOT, 'knowledge/approved-claims.json'));
    const store = new PlaybookStore(db);
    const memory = new FailureMemory(db);

    const deps: CycleDeps = {
      db,
      store,
      memory,
      config,
      claims,
      markets: ['AU', 'NZ'],
      reviewer: NO_REVIEWER,
      simulator: NO_SIMULATOR,
      proposerInstanceId: 'coach-proposer',
      openingTexts: openingTexts(identity, genericReasons()),
      now: () => new Date()
    };

    switch (command) {
      case 'status': {
        const snapshot = await store.snapshot();
        line('Champions');
        for (const slot of PLAYBOOK_SLOTS) {
          const v = snapshot.championVersions[slot];
          line(`  ${slot.padEnd(20)} ${v === undefined ? '(none)' : versionName(slot, v)}`);
        }
        line();
        line(snapshot.challenger === null ? 'No test is running.' : `Under test: ${versionName(snapshot.challenger.slot, snapshot.challenger.version)}`);
        const evaluation = await evaluateLiveTest(deps, { apply: false });
        if (evaluation !== null) line(`  ${evaluation.note}`);
        line();
        line('Recent changes');
        for (const e of (await store.history(undefined, 10)).reverse()) {
          line(`  ${DateTime.fromJSDate(e.at, { zone: OPERATOR_ZONE }).toFormat('ccc d LLL HH:mm')}  ${e.note}`);
        }
        return;
      }

      case 'seed': {
        if (!flags.apply) {
          line('Would seed version 1 of every slot that has a baseline and no versions. Run again with --apply to do it.');
          return;
        }
        const seeded = await store.ensureBaseline();
        line(seeded.length === 0 ? 'Nothing to seed: every slot already has a version.' : `Seeded: ${seeded.join(', ')}`);
        return;
      }

      case 'evaluate':
      case 'promote': {
        const options = command === 'promote' ? { apply: flags.apply, only: ['promote'] as const } : { apply: flags.apply };
        const evaluation = await evaluateLiveTest(deps, options);
        if (evaluation === null) line('No test is running.');
        else {
          line(`${evaluation.note}`);
          line(`  decision: ${evaluation.decision.decision}${evaluation.applied ? ' (carried out)' : flags.apply ? ' (not carried out)' : ' (dry run)'}`);
          line(`  champion:   ${evaluation.champion.completed} completed, ${pct(evaluation.decision.comparison.base.requestRate)} request rate`);
          line(`  challenger: ${evaluation.challenger.completed} completed, ${pct(evaluation.decision.comparison.other.requestRate)} request rate`);
          const [lo, hi] = [evaluation.decision.comparison.liftInterval.lower, evaluation.decision.comparison.liftInterval.upper];
          line(`  lift ${pct(evaluation.decision.comparison.lift)}, 95% interval ${pct(lo)} to ${pct(hi)}, one-sided p = ${evaluation.decision.comparison.liftP.toFixed(3)}`);
        }
        if (command === 'evaluate') {
          for (const m of await monitorPromotions(deps, { apply: flags.apply })) {
            line(`${m.note}${m.applied ? ' (carried out)' : ''}`);
          }
        }
        if (!flags.apply) line('\nDry run. Add --apply to carry out the decision.');
        return;
      }

      case 'rollback': {
        const slot = flags.slot;
        if (slot === undefined) throw new Error('rollback needs --slot');
        const plan = await store.planRollback(slot, flags.to);
        line(`${versionName(slot, plan.current.version)} -> ${versionName(slot, plan.target.version)}`);
        line(renderDiff(diffContent(plan.current.content, plan.target.content)));
        if (!flags.apply) {
          line('\nDry run. Add --apply to roll back.');
          return;
        }
        const note = `${versionName(slot, plan.current.version)} was rolled back to ${versionName(slot, plan.target.version)} by the operator.`;
        await store.rollback(slot, { note, ...(flags.to !== undefined ? { toVersion: flags.to } : {}) });
        line(`Done. ${note}`);
        return;
      }

      case 'history': {
        for (const e of await store.history(flags.slot, 50)) {
          line(`${DateTime.fromJSDate(e.at, { zone: OPERATOR_ZONE }).toFormat('ccc d LLL HH:mm')}  [${e.kind}] ${e.note}`);
        }
        return;
      }

      case 'diff': {
        const [slotArg, fromArg, toArg] = flags.rest;
        const slot = PLAYBOOK_SLOTS.find((s) => s === slotArg);
        if (slot === undefined || fromArg === undefined || toArg === undefined) throw new Error('usage: diff <slot> <from> <to>');
        const from = await store.get(slot, Number(fromArg));
        const to = await store.get(slot, Number(toArg));
        if (from === null || to === null) throw new Error('no such version');
        line(renderDiff(diffContent(from.content, to.content)));
        return;
      }

      case 'propose': {
        const key = (process.env.ANTHROPIC_API_KEY ?? '').trim();
        if (key === '') {
          console.error(
            'propose needs ANTHROPIC_API_KEY. The compliance review and the adversarial calls are model work, and a gate that cannot reach them passes nothing.'
          );
          process.exit(1);
        }
        const client = new Anthropic();
        const modelConfig = loadModelConfig(resolve(ROOT, 'config/models.yaml'));
        const modelDeps = { client, config: modelConfig };

        deps.reviewer = claudeComplianceReviewer(client, config);
        deps.simulator = createAdversarialSimulator({
          caller: claudeCallerModel(modelDeps),
          check: claudeCheckModel(modelDeps),
          audit: claudeAuditModel(modelDeps),
          claims,
          pack: loadPack(resolve(ROOT, 'knowledge')),
          identity
        });

        const model: CoachModel =
          flags.proposals !== undefined
            ? {
                // Hand-written proposals take the place of the model's. They go through
                // exactly the same validation and the same gate.
                instanceId: 'operator-file',
                propose: async () => ({ output: JSON.parse(readFileSync(resolve(flags.proposals as string), 'utf8')) as unknown })
              }
            : claudeCoachModel(client, config);
        deps.proposerInstanceId = model.instanceId;

        const today = dayContaining(deps.now());
        const weekEnding = flags.weekEnding ?? shiftDays(today, -1).date;

        let journal: AgentJournal = new InMemoryJournal();
        let taskId = 'dry-run';
        if (flags.apply) {
          const task = await new TaskRepository(db).create({ kind: 'coach-weekly', payload: { weekEnding } });
          journal = new PrismaJournal(db);
          taskId = task.id;
        }

        const agent = createCoach({ model, config, tools: coachTools({ db, store, memory, claims }) });
        const report = await runWeekly(deps, {
          apply: flags.apply,
          weekEnding,
          agent,
          journal,
          taskId,
          ...(flags.slot !== undefined ? { slot: flags.slot } : {})
        });

        for (const n of report.notes) line(`- ${n}`);
        for (const p of report.proposals) line(`  [${p.verdict}] ${p.summary}${p.reasons.length > 0 ? `\n      ${p.reasons.join('\n      ')}` : ''}`);
        if (!flags.apply) line('\nDry run: nothing was written. Add --apply to start the first surviving variant as a challenger.');
        return;
      }

      default:
        throw new Error(`unknown command "${command}"`);
    }
  } finally {
    await db.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(describeError(error));
  process.exit(1);
});
