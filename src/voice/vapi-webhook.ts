/**
 * The provider's webhook.
 *
 * Vapi tells us about a call as it happens (`status-update`) and when it is over
 * (`end-of-call-report`). This route is public by necessity, so before it reads a
 * word of the body it checks the shared secret the provider was configured to
 * send: an open endpoint here is a way for anyone to end any live call, mark any
 * call as answered, or feed Scribe a transcript of their own composition.
 *
 * It is built around two facts about webhooks.
 *
 *   They are delivered at least once. Every handler is idempotent: a status
 *   update only ever moves a call forward, and the end-of-call report is claimed
 *   atomically, so a report delivered twice (or twice at the same moment) is
 *   processed once.
 *
 *   They have a deadline. The provider gives up after about twenty seconds, and
 *   Scribe, the audit and the follow-up take longer than that on a bad day. So
 *   the route does only the quick local work, acknowledges, and hands the rest
 *   to `schedule`. The stored report makes that safe: if processing fails, it can
 *   be run again from what was kept (`npm run voice:reprocess`).
 */

import type { FastifyInstance } from 'fastify';
import { acceptReport, processReport, type EndedCallDeps } from './ended-call.js';
import type { ProviderAdapter } from './provider.js';

export interface VapiWebhookDeps {
  adapter: ProviderAdapter;
  ended: EndedCallDeps;
  /** Runs the slow part after the acknowledgement. Tests run it inline. */
  schedule?: (job: () => Promise<unknown>) => void;
  log?: (line: string) => void;
  path?: string;
}

export function registerVapiWebhook(app: FastifyInstance, deps: VapiWebhookDeps): void {
  const log = deps.log ?? (() => {});
  const schedule =
    deps.schedule ??
    ((job) => {
      void job().catch((error: unknown) => log(`background job failed: ${(error as Error).message}`));
    });
  const { calls } = deps.ended;

  app.post(deps.path ?? '/vapi/webhook', async (request, reply) => {
    if (!deps.adapter.verifyWebhook(request.headers)) {
      return reply.code(401).send({ error: 'unauthorised' });
    }

    const event = deps.adapter.parseWebhook(request.body);

    if (event.kind === 'ignored') return reply.send({ ignored: event.type });

    if (event.kind === 'status') {
      const call =
        (await calls.find(event.providerCallId)) ?? (event.ourCallId !== null ? await calls.find(event.ourCallId) : null);
      // A call we did not place, or an id that belongs to a different provider
      // call than the one this event names, is none of our business.
      if (call === null || (call.providerCallId !== null && call.providerCallId !== event.providerCallId)) {
        log(`status update for a call we do not hold (${event.providerCallId}); ignored`);
        return reply.send({ ignored: 'unknown-call' });
      }
      if (call.providerCallId === null) await calls.setProvider(call.id, event.providerCallId, event.controlUrl);
      else if (event.controlUrl !== null) await calls.patchMetrics(call.id, (m) => ({ ...m, controlUrl: event.controlUrl as string }));

      switch (event.status) {
        case 'ringing':
          await calls.transition(call.id, 'ringing');
          break;
        case 'in-progress':
          await calls.transition(call.id, 'in-progress');
          break;
        case 'ended':
          // Ending the call here, ahead of the report, frees the one live-call
          // slot as soon as the line drops rather than when processing finishes.
          await calls.markEnded(call.id, { at: deps.ended.now(), endedReason: event.endedReason ?? 'ended' });
          break;
        default:
          break;
      }
      return reply.send({ ok: true });
    }

    // end-of-call-report
    const accepted = await acceptReport(deps.ended, event);
    if (accepted.status === 'unknown-call') {
      log(`end-of-call report for a call we do not hold (${event.providerCallId}); ignored`);
      return reply.send({ ignored: 'unknown-call' });
    }
    if (accepted.status === 'duplicate') return reply.send({ duplicate: true });

    schedule(async () => {
      const outcome = await processReport(deps.ended, accepted.callId);
      log(`call ${accepted.callId.slice(0, 8)} processed: ${outcome.status} (${outcome.detail})`);
    });
    return reply.send({ accepted: true });
  });
}
