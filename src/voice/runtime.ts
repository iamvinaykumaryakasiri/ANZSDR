/**
 * Loading the things every voice command needs: the blackboard, the policy, the
 * calendar, the compliance gate, who Lexi is, and the voice configuration.
 *
 * One function, used by the server and by each of the commands, so that
 * `voice:doctor` answers about the same gate `voice:testcall` asks and the same
 * gate the server will. Built the way `plan-cli` builds it, on purpose.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadIdentity, type AgentIdentity } from '../agents/caller/identity.js';
import { createBlackboard, type Blackboard } from '../blackboard/client.js';
import { CallPlanRepository } from '../blackboard/call-plans.js';
import {
  PrismaAttemptStore,
  PrismaAuditLog,
  PrismaCallStateStore,
  PrismaContactStore,
  PrismaDncStore,
  PrismaSuppressionStore
} from '../blackboard/compliance-stores.js';
import { HolidayCalendar } from '../compliance/holidays.js';
import { KillSwitch } from '../compliance/kill-switch.js';
import { loadPolicy, type CompliancePolicy } from '../compliance/policy.js';
import { ComplianceGate } from '../compliance/service.js';
import { ClaimIndex } from '../knowledge/claims.js';
import { loadPack, type KnowledgePack } from '../knowledge/pack.js';
import { FileKillSwitchStore } from '../ops/kill-switch-store.js';
import { VapiAdapter } from './vapi.js';
import { loadVoiceConfig, type VoiceConfig } from './voice-config.js';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export type Env = Record<string, string | undefined>;

export interface Core {
  db: Blackboard;
  policy: CompliancePolicy;
  calendar: HolidayCalendar;
  gate: ComplianceGate;
  killSwitch: KillSwitch;
  identity: AgentIdentity;
  voice: VoiceConfig;
  audit: PrismaAuditLog;
  paths: { claims: string; knowledge: string; recordings: string; outbox: string; workbook: string };
  claims: () => ClaimIndex;
  pack: () => KnowledgePack;
}

export function loadCore(env: Env = process.env): Core {
  const db = createBlackboard();
  const policy = loadPolicy(resolve(ROOT, 'config/policy.yaml'));
  const calendar = HolidayCalendar.fromFiles([resolve(ROOT, 'config/holidays/au.json'), resolve(ROOT, 'config/holidays/nz.json')]);
  const audit = new PrismaAuditLog(db);
  const killSwitch = new KillSwitch(
    new FileKillSwitchStore(env.KILL_SWITCH_PATH ?? resolve(ROOT, 'data/kill-switch.json')),
    audit
  );

  const gate = new ComplianceGate({
    policy,
    calendar,
    killSwitch,
    suppression: new PrismaSuppressionStore(db),
    dnc: new PrismaDncStore(db),
    attempts: new PrismaAttemptStore(db),
    calls: new PrismaCallStateStore(db),
    dayPlans: new CallPlanRepository(db),
    contacts: new PrismaContactStore(db),
    audit
  });

  const claimsPath = resolve(ROOT, 'knowledge/approved-claims.json');
  const knowledge = resolve(ROOT, 'knowledge');
  return {
    db,
    policy,
    calendar,
    gate,
    killSwitch,
    audit,
    identity: loadIdentity(resolve(ROOT, 'config/agent.yaml')),
    voice: loadVoiceConfig(resolve(ROOT, 'config/voice.yaml')),
    paths: {
      claims: claimsPath,
      knowledge,
      recordings: resolve(ROOT, env.RECORDINGS_DIR ?? 'data/recordings'),
      outbox: resolve(ROOT, env.OUTBOX_DIR ?? 'data/outbox'),
      workbook: resolve(ROOT, 'data/crm.xlsx')
    },
    // Re-read per call, so a claim approved since startup reaches the next call.
    claims: () => ClaimIndex.load(claimsPath),
    pack: () => loadPack(knowledge)
  };
}

/** The Vapi adapter, or null if there is no API key to build it with. */
export function buildVapiAdapter(env: Env, options: { assistantRequired: boolean }): VapiAdapter | null {
  const apiKey = (env.VAPI_API_KEY ?? '').trim();
  if (apiKey === '') return null;
  const assistantId = (env.VAPI_ASSISTANT_ID ?? '').trim();
  if (options.assistantRequired && assistantId === '') return null;
  return new VapiAdapter({
    apiKey,
    webhookSecret: (env.VAPI_WEBHOOK_SECRET ?? '').trim(),
    assistantId,
    phoneNumberIds: { AU: env.VAPI_PHONE_NUMBER_ID_AU, NZ: env.VAPI_PHONE_NUMBER_ID_NZ }
  });
}
