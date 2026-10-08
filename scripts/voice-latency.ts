/**
 * Latency, as text.
 *
 *   npm run voice:latency                       the last 10 calls, from the blackboard
 *   npm run voice:latency -- --call <id>        one call (an id or the start of one)
 *   npm run voice:latency -- --last 25
 *   npm run voice:latency -- --probe            no phone: drive the real endpoint with a scripted
 *                                               prospect and the real model, and time each turn.
 *                                               SPENDS MONEY (a few cents of model time).
 *
 * Section 13 phase 5 wants sub-800ms perceived response. A call's report shows
 * two figures: first-token (ours, a floor) and perceived (the provider's, end of
 * the prospect's speech to first audio). See src/voice/latency.ts.
 */

import '../src/config/env-autoload.js';
import { resolve } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { assembleBriefing, renderBriefing } from '../src/agents/caller/briefing.js';
import { parseMetrics, type LatencySummary } from '../src/voice/call-store.js';
import { claudeCallerModel, claudeCheckModel, loadModelConfig } from '../src/voice/claude-model.js';
import { formatLatencyReport, stats, type ReportCall } from '../src/voice/latency.js';
import { probeLatency } from '../src/voice/latency-probe.js';
import { loadCore, ROOT } from '../src/voice/runtime.js';

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : (process.argv[i + 1] ?? '');
}

async function main(): Promise<void> {
  const core = loadCore(process.env);
  const targetMs = core.voice.latency.target_ms;
  try {
    if (process.argv.includes('--probe')) {
      if ((process.env.ANTHROPIC_API_KEY ?? '').trim() === '') {
        console.error('ANTHROPIC_API_KEY is not set (in a cloud session, LEXI_ANTHROPIC_API_KEY).');
        process.exit(1);
      }
      const briefing = assembleBriefing({
        identity: core.identity,
        prospect: { contactId: 'probe', name: 'Priya Raman', firstName: 'Priya', title: 'Head of Data', accountName: 'Kiwibank', market: 'NZ' },
        dossier: { hypothesis: '', confidence: 'low', hooks: [], landmines: [], unverified: [] },
        claims: core.claims(),
        pack: core.pack()
      });
      const deps = { client: new Anthropic(), config: loadModelConfig(resolve(ROOT, 'config/models.yaml')) };
      console.log(`Probing ${deps.config.caller} through the real endpoint (this spends a few cents).\n`);
      const turns = await probeLatency({
        caller: claudeCallerModel(deps),
        check: claudeCheckModel(deps),
        system: renderBriefing(briefing),
        opening: briefing.openingText
      });
      for (const t of turns) {
        const over = t.firstTokenMs > targetMs ? '  OVER' : '';
        console.log(`  ${String(t.firstTokenMs).padStart(5)}ms first words  ${String(t.totalMs).padStart(5)}ms total${t.held ? '  (held for layer two)' : ''}${over}`);
        console.log(`        they: ${t.prospectSaid}`);
        console.log(`        she:  ${t.reply}\n`);
      }
      const s = stats(turns.map((t) => t.firstTokenMs));
      if (s !== null) console.log(`first-token  p50=${s.p50}ms  p95=${s.p95}ms  max=${s.max}ms   (target ${targetMs}ms; a floor, since speech-to-text and text-to-speech come on top)`);
      return;
    }

    const wanted = flag('--call');
    const last = Number(flag('--last') ?? '10');
    const rows = await core.db.call.findMany({
      where: wanted !== undefined ? { id: { startsWith: wanted } } : { providerMetrics: { contains: '"latency"' } },
      orderBy: { startedAt: 'desc' },
      take: wanted !== undefined ? 5 : Number.isFinite(last) && last > 0 ? last : 10,
      select: { id: true, startedAt: true, providerMetrics: true }
    });
    const calls: ReportCall[] = rows.flatMap((row) => {
      const latency = parseMetrics(row.providerMetrics).latency as LatencySummary | undefined;
      return latency === undefined ? [] : [{ callId: row.id, startedAt: row.startedAt, summary: latency }];
    });
    console.log(formatLatencyReport(calls.reverse(), targetMs));
  } finally {
    await core.db.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
