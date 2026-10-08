/**
 * The voice server: the one process the provider talks to.
 *
 * Three public doors, each closed to anyone without the secret the provider (or
 * Twilio) was configured with:
 *
 *   POST /v1/chat/completions   every turn of every call - the brain
 *   POST /vapi/webhook          call status and the end-of-call report
 *   POST /twilio/sms            texts replied to a message we sent
 *
 * and one that gives nothing away:
 *
 *   GET  /healthz               "ok", and whether a call is live
 *
 * `buildVoiceServer` only assembles routes from parts it is handed, so a test can
 * mount the real routes over fakes. `wireVoice` builds the parts from a loaded
 * core and is what `start.ts` and the tests of the wiring use.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import { buildOpening } from '../agents/caller/opening.js';
import type { AgentIdentity } from '../agents/caller/identity.js';
import { registerVoiceEndpoint, type EndpointDeps } from './endpoint.js';
import { CallStore } from './call-store.js';
import { CallContextProvider, type BriefingSourceDeps } from './briefing-source.js';
import { PrismaCallJournal } from './call-journal.js';
import { recordingObjectionResponse } from './lifecycle.js';
import type { ProviderAdapter } from './provider.js';
import { registerInboundSms, type InboundSmsRouteDeps } from './twilio-sms.js';
import { registerVapiWebhook, type VapiWebhookDeps } from './vapi-webhook.js';
import type { CallerModel } from '../agents/caller/brain.js';
import type { CheckModel } from '../agents/guardian/check.js';
import type { Blackboard } from '../blackboard/client.js';
import type { KillSwitch } from '../compliance/kill-switch.js';
import type { EndedCallDeps } from './ended-call.js';

export interface VoiceServerParts {
  endpoint: EndpointDeps;
  webhook: VapiWebhookDeps;
  sms?: InboundSmsRouteDeps | undefined;
  health: () => Promise<Record<string, unknown>>;
}

export function buildVoiceServer(parts: VoiceServerParts): FastifyInstance {
  // A report with a long transcript is far bigger than a chat turn.
  const app = Fastify({ logger: false, bodyLimit: 8 * 1024 * 1024 });
  registerVoiceEndpoint(app, parts.endpoint);
  registerVapiWebhook(app, parts.webhook);
  if (parts.sms !== undefined) registerInboundSms(app, parts.sms);
  app.get('/healthz', async () => parts.health());
  return app;
}

/* ------------------------------------------------------------------ */

export interface WireDeps {
  db: Blackboard;
  identity: AgentIdentity;
  adapter: ProviderAdapter;
  briefing: BriefingSourceDeps;
  killSwitch: KillSwitch;
  caller: CallerModel;
  check: CheckModel;
  sharedSecret: string;
  ended: Omit<EndedCallDeps, 'calls' | 'contexts'>;
  closeGraceMs: number;
  now: () => Date;
  log: (line: string) => void;
}

export interface Wired {
  endpoint: EndpointDeps;
  contexts: CallContextProvider;
  calls: CallStore;
  ended: EndedCallDeps;
}

/**
 * Hang up a call from our side if it is still up after the goodbye has had time
 * to be said. The turn that closed the call also asks the provider to hang up;
 * this is the belt to that braces, and a no-op if the call has already ended.
 */
export function closer(calls: CallStore, adapter: ProviderAdapter, graceMs: number, log: (line: string) => void) {
  return (callId: string): void => {
    const timer = setTimeout(() => {
      void (async () => {
        const call = await calls.find(callId);
        if (call === null || call.endedAt !== null || call.providerCallId === null) return;
        const metrics = await calls.metrics(callId);
        await adapter.hangUp({ providerCallId: call.providerCallId, controlUrl: metrics.controlUrl ?? null });
        log(`hung up call ${callId.slice(0, 8)} after its closing turn`);
      })().catch((error: unknown) => log(`could not hang up ${callId.slice(0, 8)}: ${(error as Error).message}`));
    }, graceMs);
    timer.unref();
  };
}

export function wireVoice(deps: WireDeps): Wired {
  const { db, adapter, identity, log } = deps;
  const calls = new CallStore(db, deps.now);
  const contexts = new CallContextProvider(deps.briefing);

  const journal = new PrismaCallJournal(calls, deps.now, (callId, what, error) => {
    log(`JOURNAL WRITE FAILED for ${callId.slice(0, 8)} (${what}): ${(error as Error).message}`);
    // The brief lists "the orchestrator losing contact with the blackboard" as a
    // reason to stop dialling. A journal that cannot be written is that.
    void deps.killSwitch
      .trip('blackboard-unreachable', `the call journal could not be written (${what})`, deps.now())
      .catch(() => {});
  });

  const closeLater = closer(calls, adapter, deps.closeGraceMs, log);

  // The line said when the recording is stopped, from the frozen opening module
  // so the wording lives in one place.
  const stoppedLine =
    buildOpening({ identity, reason: 'placeholder', recording: false }).find((s) => s.id === 'recording')?.text ??
    "I've stopped the recording, as you asked.";

  const endpoint: EndpointDeps = {
    caller: deps.caller,
    check: deps.check,
    sharedSecret: deps.sharedSecret,
    resolveCallId: (key) => contexts.resolve(key),
    briefingFor: async (callId) => (await contexts.get(callId))?.system ?? null,
    openingFor: async (callId) => (await contexts.get(callId))?.openingText ?? null,
    assertableClaims: (callId) => contexts.peek(callId)?.assertableClaims ?? [],
    journal,
    hangUpOnClose: true,
    onClose: (callId, why) => {
      log(`call ${callId.slice(0, 8)} is closing: ${why}`);
      closeLater(callId);
    },
    onDefect: (callId, defect) => log(`defect on ${callId.slice(0, 8)}: ${defect}`),
    onOpeningServed: (callId) => {
      void (async () => {
        const at = deps.now().toISOString();
        await calls.patchMetrics(callId, (m) => ({ ...m, recording: { ...(m.recording ?? {}), announcedAt: m.recording?.announcedAt ?? at } }));
        await calls.append(callId, { kind: 'recording', data: { action: 'announced' } });
      })().catch((error: unknown) => log(`could not record the announcement: ${(error as Error).message}`));
    },
    onRecordingObjection: async (callId) => {
      let response = recordingObjectionResponse(adapter.capabilities.stopRecordingMidCall, stoppedLine);

      if (response.handling === 'recording-stopped') {
        try {
          const call = await calls.get(callId);
          const metrics = await calls.metrics(callId);
          if (adapter.stopRecording === undefined || call.providerCallId === null) throw new Error('the provider cannot stop a recording');
          await adapter.stopRecording({ providerCallId: call.providerCallId, controlUrl: metrics.controlUrl ?? null });
        } catch (error) {
          // Cannot stop it, so do not say we have. End the call instead.
          log(`could not stop the recording on ${callId.slice(0, 8)}: ${(error as Error).message}; ending the call`);
          response = recordingObjectionResponse(false, stoppedLine);
        }
      }

      // Whatever was recorded before they spoke is deleted once the call is over.
      await calls.patchMetrics(callId, (m) => ({
        ...m,
        recording: { ...(m.recording ?? {}), objectedAt: deps.now().toISOString(), objectionHandling: response.handling, deleteNow: true }
      }));
      await calls.append(callId, { kind: 'recording', data: { action: 'objection', handling: response.handling } });
      return { line: response.line, endCall: response.endCall };
    }
  };

  const ended: EndedCallDeps = { ...deps.ended, calls, contexts };
  return { endpoint, contexts, calls, ended };
}
