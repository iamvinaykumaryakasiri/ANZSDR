/**
 * Everything the end-of-call pipeline needs, built from the environment.
 *
 * Shared by the server (which runs it after each call) and `voice:reprocess`
 * (which runs it again for a call whose processing failed), so the two cannot
 * drift into processing a call differently.
 */

import { resolve } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { FileMailer } from '../agents/concierge/file-mailer.js';
import { operatorOnly } from '../agents/concierge/ports.js';
import { PrismaSuppressionStore } from '../blackboard/compliance-stores.js';
import { MeetingRequestRepository } from '../blackboard/meetings.js';
import { claudeAuditModel, claudeCallerModel, claudeCheckModel, claudeScribeModel, loadModelConfig } from './claude-model.js';
import type { CallerModel } from '../agents/caller/brain.js';
import type { CheckModel } from '../agents/guardian/check.js';
import type { EndedCallDeps } from './ended-call.js';
import type { ProviderAdapter } from './provider.js';
import { EncryptedFileRecordingStore, parseEncryptionKey, type RecordingStore } from './recordings.js';
import { ROOT, type Core, type Env } from './runtime.js';

export interface Composed {
  caller: CallerModel;
  check: CheckModel;
  recordingStore: RecordingStore | undefined;
  /** Everything `EndedCallDeps` needs except the call store and the context provider. */
  ended: Omit<EndedCallDeps, 'calls' | 'contexts'>;
  mailer: ReturnType<typeof operatorOnly>;
}

export function composeEnded(core: Core, env: Env, adapter: ProviderAdapter | undefined, log: (line: string) => void): Composed {
  const models = loadModelConfig(resolve(ROOT, 'config/models.yaml'));
  const modelDeps = { client: new Anthropic(), config: models };
  const now = (): Date => new Date();

  const operatorEmail = core.identity.operator.email.trim();
  // The only mailer there is can address only the operator. With no operator
  // email configured its allow-list is empty and it sends nothing.
  const mailer = operatorOnly(
    new FileMailer({ dir: core.paths.outbox, from: env.MAIL_FROM ?? 'anz-voice-sdr@localhost' }),
    operatorEmail === '' ? [] : [operatorEmail]
  );

  const keyHex = (env.RECORDING_ENCRYPTION_KEY ?? '').trim();
  const recordingStore = keyHex === '' ? undefined : new EncryptedFileRecordingStore(core.paths.recordings, parseEncryptionKey(keyHex));

  return {
    caller: claudeCallerModel(modelDeps),
    check: claudeCheckModel(modelDeps),
    recordingStore,
    mailer,
    ended: {
      db: core.db,
      now,
      claims: core.claims,
      auditModel: claudeAuditModel(modelDeps),
      adapter,
      recordingStore,
      retentionDays: core.policy.recording.retention_days,
      latencyTargetMs: core.voice.latency.target_ms,
      log,
      post: {
        scribe: { db: core.db, model: claudeScribeModel(modelDeps), now },
        followUp: {
          db: core.db,
          meetings: new MeetingRequestRepository(core.db),
          suppressions: new PrismaSuppressionStore(core.db),
          mailer,
          // No SMS sender yet: Twilio sending is not built. The executor skips
          // the text and says why.
          sms: undefined,
          smsFrom: core.identity.callback.number,
          identity: core.identity,
          killSwitch: core.killSwitch,
          now
        },
        workbookPath: core.paths.workbook
      }
    }
  };
}
