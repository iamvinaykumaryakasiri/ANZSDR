/**
 * The console's HTTP surface: exactly the routes listed in contract.ts.
 *
 * Every route is behind the admin token. The account desk's server already gates
 * all of /api/ with it; this plugin checks again on its own, so mounting it on any
 * other server cannot leave the console open by accident.
 *
 * Nothing here decides anything. A route validates its input, hands it to the
 * module that owns the rule (the kill switch, the Concierge reply path, Jarvis),
 * and returns what came back.
 */

import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { callDetail, isFunnelStage, listCalls, listTrace } from './calls.js';
import type { ConsoleEvent } from './contract.js';
import type { ConsoleDeps } from './deps.js';
import { Jarvis, type JarvisOptions } from './jarvis.js';
import { setKillSwitch } from './kill.js';
import { decideMeeting } from './meeting-views.js';
import { SnapshotService } from './snapshot.js';

export interface ConsoleRoutesOptions {
  deps: ConsoleDeps;
  adminToken: string;
  /** How often a watched console is sent a fresh snapshot. */
  refreshMs?: number;
  /** How often an idle stream is sent a comment so proxies do not close it. */
  heartbeatMs?: number;
  jarvis?: Omit<JarvisOptions, 'onChanged'>;
}

export interface ConsoleHandle {
  service: SnapshotService;
  jarvis: Jarvis;
}

function tokensMatch(supplied: string, expected: string): boolean {
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function suppliedToken(request: FastifyRequest): string {
  const header = request.headers.authorization ?? '';
  if (header.startsWith('Bearer ')) return header.slice(7);
  const alt = request.headers['x-admin-token'];
  return typeof alt === 'string' ? alt : '';
}

const killBody = z.object({ engage: z.boolean(), reason: z.string().max(500).optional() });
const decisionBody = z.object({ decision: z.enum(['CONFIRMED', 'RESCHEDULE', 'REJECT']) });
const jarvisBody = z.object({ query: z.string().min(1).max(600), contactId: z.string().min(1).max(100).optional() });
const confirmBody = z.object({ actionId: z.string().min(1).max(200) });

const int = (max: number) => z.coerce.number().int().min(1).max(max);
const callsQuery = z.object({
  limit: int(500).optional(),
  days: int(365).optional(),
  market: z.enum(['AU', 'NZ']).optional(),
  outcome: z.string().max(60).optional(),
  variant: z.string().max(80).optional(),
  industry: z.string().max(80).optional(),
  seniority: z.string().max(40).optional(),
  stage: z.string().max(40).refine(isFunnelStage, 'not a funnel stage').optional()
});
const traceQuery = z.object({ limit: int(500).optional(), taskId: z.string().max(100).optional() });

function bad(reply: FastifyReply, error: z.ZodError): FastifyReply {
  return reply.code(400).send({ error: 'bad request', issues: error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`) });
}

export function registerConsole(app: FastifyInstance, options: ConsoleRoutesOptions): ConsoleHandle {
  const { deps } = options;
  const service = new SnapshotService(deps);
  const refreshMs = options.refreshMs ?? 5000;
  const heartbeatMs = options.heartbeatMs ?? 15_000;

  /** Redraw the room after a change. A failure to redraw never undoes the change. */
  const refresh = async (): Promise<void> => {
    service.invalidate();
    try {
      await service.refresh();
    } catch (error) {
      app.log.warn({ err: error }, 'console snapshot refresh failed');
    }
  };

  const jarvis = new Jarvis(deps, service, { ...options.jarvis, onChanged: refresh });

  // One timer, running only while someone is watching.
  let watchers = 0;
  let timer: NodeJS.Timeout | null = null;
  const attach = (): void => {
    watchers += 1;
    if (timer === null) {
      timer = setInterval(() => {
        service
          .refresh()
          .catch((error: unknown) => app.log.warn({ err: error }, 'console snapshot refresh failed'));
      }, refreshMs);
      timer.unref();
    }
  };
  const detach = (): void => {
    watchers = Math.max(0, watchers - 1);
    if (watchers === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };

  const streams = new Set<FastifyReply['raw']>();

  app.register(
    async (scope) => {
      scope.addHook('onRequest', async (request, reply) => {
        if (!tokensMatch(suppliedToken(request), options.adminToken)) {
          return reply.code(401).send({ error: 'unauthorised' });
        }
      });

      scope.addHook('onClose', async () => {
        if (timer !== null) clearInterval(timer);
        timer = null;
        for (const raw of streams) raw.end();
        streams.clear();
      });

      scope.get('/snapshot', async () => service.get(1000));

      scope.get('/stream', async (request, reply) => {
        reply.hijack();
        const raw = reply.raw;
        raw.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          // Tell a reverse proxy not to hold the stream back to batch it.
          'x-accel-buffering': 'no'
        });
        streams.add(raw);

        const write = (event: ConsoleEvent): void => {
          if (!raw.writableEnded) raw.write(`data: ${JSON.stringify(event)}\n\n`);
        };

        // Subscribe first and hold what arrives, so nothing published while the
        // opening snapshot is being built is lost; then send the snapshot, then
        // whatever was held. The first event on the wire is always a snapshot.
        const held: ConsoleEvent[] = [];
        let ready = false;
        const unsubscribe = deps.bus.subscribe((event) => (ready ? write(event) : held.push(event)));
        attach();

        const heartbeat = setInterval(() => {
          if (!raw.writableEnded) raw.write(': keep-alive\n\n');
        }, heartbeatMs);
        heartbeat.unref();

        let closed = false;
        const cleanup = (): void => {
          if (closed) return;
          closed = true;
          clearInterval(heartbeat);
          unsubscribe();
          detach();
          streams.delete(raw);
          if (!raw.writableEnded) raw.end();
        };
        request.raw.on('close', cleanup);

        try {
          write({ type: 'snapshot', snapshot: await service.get(1000) });
        } catch (error) {
          app.log.error({ err: error }, 'console could not build its opening snapshot');
          cleanup();
          return;
        }
        ready = true;
        for (const event of held) write(event);
      });

      scope.post('/kill', async (request, reply) => {
        const body = killBody.safeParse(request.body);
        if (!body.success) return bad(reply, body.error);
        const view = await setKillSwitch(deps, body.data.engage, body.data.reason);
        await refresh();
        return view;
      });

      scope.post<{ Params: { ref: string } }>('/meetings/:ref', async (request, reply) => {
        const body = decisionBody.safeParse(request.body);
        if (!body.success) return bad(reply, body.error);
        const result = await decideMeeting(deps, request.params.ref, body.data.decision);
        switch (result.kind) {
          case 'applied':
            await refresh();
            return result.view;
          case 'unchanged':
            return result.view;
          case 'refused':
            return reply.code(result.status).send({ error: result.error, ...(result.view !== undefined ? { request: result.view } : {}) });
        }
      });

      scope.get('/calls', async (request, reply) => {
        const query = callsQuery.safeParse(request.query);
        if (!query.success) return bad(reply, query.error);
        const q = query.data;
        return listCalls(deps, {
          ...(q.limit !== undefined ? { limit: q.limit } : {}),
          ...(q.days !== undefined ? { days: q.days } : {}),
          ...(q.market !== undefined ? { market: q.market } : {}),
          ...(q.outcome !== undefined ? { outcome: q.outcome } : {}),
          ...(q.variant !== undefined ? { variant: q.variant } : {}),
          ...(q.industry !== undefined ? { industry: q.industry } : {}),
          ...(q.seniority !== undefined ? { seniority: q.seniority } : {}),
          ...(q.stage !== undefined ? { stage: q.stage } : {})
        });
      });

      scope.get<{ Params: { id: string } }>('/calls/:id', async (request, reply) => {
        const detail = await callDetail(deps, request.params.id);
        return detail ?? reply.code(404).send({ error: `no call ${request.params.id}` });
      });

      scope.get('/trace', async (request, reply) => {
        const query = traceQuery.safeParse(request.query);
        if (!query.success) return bad(reply, query.error);
        return listTrace(deps.db, {
          ...(query.data.limit !== undefined ? { limit: query.data.limit } : {}),
          ...(query.data.taskId !== undefined ? { taskId: query.data.taskId } : {})
        });
      });

      scope.post('/jarvis', async (request, reply) => {
        const body = jarvisBody.safeParse(request.body);
        if (!body.success) return bad(reply, body.error);
        return jarvis.ask(body.data.query, body.data.contactId !== undefined ? { contactId: body.data.contactId } : {});
      });

      scope.post('/jarvis/confirm', async (request, reply) => {
        const body = confirmBody.safeParse(request.body);
        if (!body.success) return bad(reply, body.error);
        return jarvis.confirm(body.data.actionId);
      });
    },
    { prefix: '/api/console' }
  );

  return { service, jarvis };
}
