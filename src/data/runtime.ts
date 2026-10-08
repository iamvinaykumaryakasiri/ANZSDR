/**
 * Putting Phase 3 together.
 *
 * Builds the real Prospector and Scout from the environment and hands back the
 * two task kinds the orchestrator registers. Nothing about the task graph
 * changes: these are the same `prospect-account` and `research-contact` kinds,
 * with the real handlers behind the same contracts.
 *
 * Every dependency can be replaced, which is how the acceptance test runs the
 * whole thing against recorded responses with no key and no network. What is
 * missing from the environment is reported rather than guessed:
 *
 *   - no APOLLO_API_KEY: there is no Prospector, and `notes` says so;
 *   - no ANTHROPIC_API_KEY: there is no Scout, and `notes` says so;
 *   - phone enrichment needs PUBLIC_BASE_URL (https) and APOLLO_WEBHOOK_SECRET.
 *
 * To use it in the Campaign Director's CLI, replace the two stub registrations:
 *
 *     const phase3 = await createPhase3Runtime({ db, spend: new SpendLedger(db) });
 *     if (phase3.prospectKind) registry.register(phase3.prospectKind);
 *     if (phase3.researchKind) registry.register(phase3.researchKind);
 */

import Anthropic from '@anthropic-ai/sdk';
import type { Blackboard } from '../blackboard/client.js';
import type { SpendLedger } from '../blackboard/repositories.js';
import type { Agent } from '../agents/contract.js';
import type { ProspectorInput, ProspectorOutput } from '../agents/prospector/contract.js';
import { prospectAccountKindWithEnrichment } from '../agents/prospector/kind.js';
import { createProspector } from '../agents/prospector/prospector.js';
import type { ScoutInput, ScoutOutput } from '../agents/scout/contract.js';
import { loadScoutResearchConfig, ExchangeAnnouncements, type ScoutResearchConfig } from '../agents/scout/announcements.js';
import { PolicyFetcher } from '../agents/scout/fetcher.js';
import { ApolloJobPostings } from '../agents/scout/job-postings.js';
import { researchContactKindWithPhoneGate } from '../agents/scout/kind.js';
import { claudeScoutModel, loadScoutModelConfig, type ScoutModel, type ScoutModelConfig } from '../agents/scout/model.js';
import { createScout } from '../agents/scout/scout.js';
import { AnthropicWebSearch } from '../agents/scout/search-anthropic.js';
import type { ResearchTools } from '../agents/scout/sources.js';
import type { TaskKind } from '../orchestrator/registry.js';
import { buildWebhookUrl } from './apollo-webhook.js';
import { ApolloClient, type CreditEntry } from './apollo-client.js';
import { loadPhase3Config, type Phase3Config } from './config.js';
import { PrismaEnrichmentLedger, type EnrichmentLedger } from './enrichment-ledger.js';
import { createEnrichmentQueue, type EnrichmentQueue } from './enrichment-queue.js';
import { EnrichmentService } from './enrichment.js';
import type { EmailVerifier } from './email.js';

export interface Phase3Options {
  db: Blackboard;
  /** Apollo credits are recorded here, in the `apollo` category, as they are spent. */
  spend: SpendLedger;
  env?: NodeJS.ProcessEnv;
  config?: Phase3Config;
  ledger?: EnrichmentLedger;
  queue?: EnrichmentQueue;
  verifier?: EmailVerifier;
  /** Replaces the network for Apollo. For tests. */
  apolloFetch?: typeof fetch;
  apolloMinIntervalMs?: number;
  apolloSleep?: (ms: number) => Promise<void>;
  /** Replaces Scout's whole research toolset. */
  research?: ResearchTools;
  scoutModel?: ScoutModel;
  scoutModelConfig?: ScoutModelConfig;
  scoutResearchConfig?: ScoutResearchConfig;
  fetch?: typeof fetch;
  now?: () => Date;
}

export interface Phase3Runtime {
  config: Phase3Config;
  ledger: EnrichmentLedger;
  queue: EnrichmentQueue;
  apollo: ApolloClient | undefined;
  enrichment: EnrichmentService;
  prospector: Agent<ProspectorInput, ProspectorOutput> | undefined;
  scout: Agent<ScoutInput, ScoutOutput> | undefined;
  prospectKind: TaskKind<ProspectorInput, ProspectorOutput> | undefined;
  researchKind: TaskKind<ScoutInput, ScoutOutput> | undefined;
  /** What is and is not configured, in plain English, for a script to print. */
  notes: string[];
  close(): Promise<void>;
}

export async function createPhase3Runtime(options: Phase3Options): Promise<Phase3Runtime> {
  const env = options.env ?? process.env;
  const config = options.config ?? loadPhase3Config();
  const ledger = options.ledger ?? new PrismaEnrichmentLedger(options.db);
  const queue = options.queue ?? (await createEnrichmentQueue(env));
  const notes: string[] = [];

  const apolloKey = (env.APOLLO_API_KEY ?? '').trim();
  const apollo =
    apolloKey === ''
      ? undefined
      : ApolloClient.fromEnv(env, {
          ledger,
          costs: {
            emailCredits: config.enrichment.emailCredits,
            phoneCredits: config.enrichment.phoneCredits,
            organizationCredits: config.enrichment.organizationCredits,
            usdPerCredit: config.enrichment.usdPerCredit
          },
          ...(options.apolloFetch !== undefined ? { fetch: options.apolloFetch } : {}),
          ...(options.apolloSleep !== undefined ? { sleep: options.apolloSleep } : {}),
          minIntervalMs: options.apolloMinIntervalMs ?? 1200,
          ...(options.now !== undefined ? { now: options.now } : {}),
          onSpend: async (entry: CreditEntry) => {
            await options.spend.record(
              'apollo',
              entry.usd,
              entry.at,
              undefined,
              `${entry.endpoint}: ${entry.note}${entry.estimated ? ' (estimated)' : ''}`
            );
          }
        });
  if (apollo === undefined) notes.push('APOLLO_API_KEY is not set: there is no Prospector. Everything else works against fixtures.');

  const publicBase = (env.PUBLIC_BASE_URL ?? '').trim();
  const secret = (env.APOLLO_WEBHOOK_SECRET ?? '').trim();
  const webhookUrl = buildWebhookUrl(publicBase, secret);
  if (config.enrichment.phone.enabled && webhookUrl === undefined) {
    notes.push('phone enrichment is enabled but PUBLIC_BASE_URL (https) and APOLLO_WEBHOOK_SECRET are not both set, so phones will not be requested');
  }
  if (!config.enrichment.phone.enabled) notes.push('phone enrichment is off (enrichment.phone.enabled in config/campaign.yaml)');

  const enrichment = new EnrichmentService({
    db: options.db,
    ledger,
    apollo,
    config: config.enrichment,
    webhookUrl,
    queue,
    ...(options.verifier !== undefined ? { verifier: options.verifier } : {}),
    ...(options.now !== undefined ? { now: options.now } : {})
  });

  const prospector =
    apollo === undefined
      ? undefined
      : createProspector({ db: options.db, directory: apollo, enrichment, config });

  // Scout
  const modelConfig = options.scoutModelConfig ?? loadScoutModelConfig();
  const anthropicKey = (env.ANTHROPIC_API_KEY ?? '').trim();
  let research = options.research;
  let model = options.scoutModel;
  if ((research === undefined || model === undefined) && anthropicKey === '') {
    notes.push('ANTHROPIC_API_KEY is not set: there is no Scout (it needs a model and a search provider).');
  } else {
    // The client is only built when something needs it: with no key it would throw.
    const client = research === undefined || model === undefined ? new Anthropic() : undefined;
    if (research === undefined && client !== undefined) {
      const fetcher = new PolicyFetcher({
        ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
        ...(env.SCOUT_USER_AGENT !== undefined && env.SCOUT_USER_AGENT.trim() !== '' ? { userAgent: env.SCOUT_USER_AGENT.trim() } : {}),
        ...(options.now !== undefined ? { now: options.now } : {})
      });
      research = {
        search: new AnthropicWebSearch({ client, model: modelConfig.scout_search }),
        fetcher,
        announcements: new ExchangeAnnouncements(fetcher, options.scoutResearchConfig ?? loadScoutResearchConfig()),
        ...(apollo !== undefined ? { jobs: new ApolloJobPostings(apollo, options.now) } : {})
      };
    }
    if (model === undefined && client !== undefined) model = claudeScoutModel({ client, config: modelConfig });
  }
  const scout =
    research !== undefined && model !== undefined
      ? createScout({ tools: research, model, ...(options.now !== undefined ? { now: options.now } : {}) })
      : undefined;

  return {
    config,
    ledger,
    queue,
    apollo,
    enrichment,
    prospector,
    scout,
    prospectKind: prospector === undefined ? undefined : prospectAccountKindWithEnrichment(prospector, enrichment),
    researchKind: scout === undefined ? undefined : researchContactKindWithPhoneGate(scout, enrichment),
    notes,
    close: async () => {
      await queue.close();
    }
  };
}
