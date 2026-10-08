/**
 * Shared furniture for the phase 5 tests: a world with a real (temporary)
 * blackboard, a real compliance gate, and fakes for everything that would touch
 * the network. Nothing here can reach a provider or a phone.
 */

import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { loadIdentityFromObject } from '../../src/agents/caller/identity.js';
import { createTestBlackboard, type Blackboard } from '../../src/blackboard/client.js';
import { CallPlanRepository } from '../../src/blackboard/call-plans.js';
import {
  PrismaAttemptStore,
  PrismaAuditLog,
  PrismaCallStateStore,
  PrismaContactStore,
  PrismaDncStore,
  PrismaSuppressionStore
} from '../../src/blackboard/compliance-stores.js';
import { InMemoryKillSwitchStore, KillSwitch } from '../../src/compliance/kill-switch.js';
import type { CompliancePolicy } from '../../src/compliance/policy.js';
import { ComplianceGate } from '../../src/compliance/service.js';
import { ClaimIndex } from '../../src/knowledge/claims.js';
import type { KnowledgePack } from '../../src/knowledge/pack.js';
import type { DialPermit } from '../../src/voice/permit.js';
import type {
  HeaderBag,
  PlaceCallRequest,
  PlacedCall,
  ProviderAdapter,
  ProviderCapabilities,
  ProviderEvent
} from '../../src/voice/provider.js';
import { parseVapiWebhook } from '../../src/voice/vapi.js';
import { calendar, policy as makePolicy, type PolicyOverrides } from '../support/fixtures.js';

/** A Tuesday, 13:00 in Sydney: inside the operator window and every Australian statutory window. */
export const TUESDAY = new Date('2026-10-13T13:00:00+11:00');

export const OPERATOR_EMAIL = 'vinay@example.com';
export const CALLER_ID = '+61280000000';
export const TEST_PHONE = '+61448455510';

export const IDENTITY = loadIdentityFromObject({
  agent: { name: 'Lexi', gender: 'female', accent: 'au-neutral' },
  operator: { name: 'Vinay Kumar', title: 'Sales Director', company: 'Hexaware Technologies', team: 'the ANZ sales team', email: OPERATOR_EMAIL },
  callback: { number: CALLER_ID }
});

export const EMPTY_PACK: KnowledgePack = { sections: [], missing: [] };

export function claimIndex(...texts: string[]): ClaimIndex {
  return ClaimIndex.fromObject({
    version: 1,
    claims: texts.map((text, i) => ({
      id: `claim-${i}`,
      text,
      kind: 'fact',
      status: 'approved',
      markets: ['AU', 'NZ'],
      sources: [{ kind: 'url', ref: 'https://example.com', quote: text, retrievedAt: '2026-09-17' }],
      conflictsWith: []
    }))
  });
}

export interface World {
  db: Blackboard;
  policy: CompliancePolicy;
  gate: ComplianceGate;
  killSwitch: KillSwitch;
  plans: CallPlanRepository;
  audit: PrismaAuditLog;
  /** How many dial decisions the gate has audited. */
  auditCount(): Promise<number>;
  close(): Promise<void>;
}

export async function world(overrides: PolicyOverrides = {}): Promise<World> {
  const db = await createTestBlackboard();
  const audit = new PrismaAuditLog(db);
  const killSwitch = new KillSwitch(new InMemoryKillSwitchStore(), audit);
  const plans = new CallPlanRepository(db);
  const policy = makePolicy({ testContactsOnly: true, exemptTestContacts: true, ...overrides });
  const gate = new ComplianceGate({
    policy,
    calendar: calendar(),
    killSwitch,
    suppression: new PrismaSuppressionStore(db),
    dnc: new PrismaDncStore(db),
    attempts: new PrismaAttemptStore(db),
    calls: new PrismaCallStateStore(db),
    dayPlans: plans,
    contacts: new PrismaContactStore(db),
    audit
  });
  return {
    db,
    policy,
    gate,
    killSwitch,
    plans,
    audit,
    auditCount: async () => db.auditRecord.count({ where: { kind: 'dial-decision' } }),
    close: () => db.$disconnect()
  };
}

export interface SeedOptions {
  kind?: 'test' | 'prospect';
  phone?: string | null;
  firstName?: string;
  campaignId?: string;
  accountId?: string;
  line?: 'mobile' | 'fixed';
}

export interface Seeded {
  campaignId: string;
  accountId: string;
  contactId: string;
}

/** A campaign, an account and one contact. A fresh account each time unless one is given. */
export async function seedContact(db: Blackboard, options: SeedOptions = {}): Promise<Seeded> {
  const campaignId = options.campaignId ?? randomUUID();
  if ((await db.campaign.findUnique({ where: { id: campaignId } })) === null) {
    await db.campaign.create({
      data: {
        id: campaignId,
        name: 'NZ banking pilot',
        market: 'NZ',
        status: 'active',
        icp: JSON.stringify({ titles: [], seniorities: [], industries: [], disqualifiers: [] }),
        goal: JSON.stringify({ meetingsPerWeek: 3, maxUsdPerWeek: 25 })
      }
    });
  }
  const accountId = options.accountId ?? randomUUID();
  if ((await db.account.findUnique({ where: { id: accountId } })) === null) {
    await db.account.create({
      data: {
        id: accountId,
        campaignId,
        name: 'Kiwibank',
        domain: `${accountId.slice(0, 8)}.example.co.nz`,
        country: 'NZ',
        industry: 'financial services',
        priority: 1,
        status: 'calling'
      }
    });
  }
  const contactId = randomUUID();
  await db.contact.create({
    data: {
      id: contactId,
      accountId,
      campaignId,
      firstName: options.firstName ?? 'Vinay',
      lastName: 'Test',
      title: 'Head of Data',
      status: 'researched',
      kind: options.kind ?? 'test',
      phoneE164: options.phone === undefined ? TEST_PHONE : options.phone,
      phoneLine: options.line ?? 'mobile'
    }
  });
  return { campaignId, accountId, contactId };
}

/* ------------------------------------------------------------------ */
/* Fakes                                                               */
/* ------------------------------------------------------------------ */

/** A provider that places nothing. Records every permit it is given. */
export class FakeAdapter implements ProviderAdapter {
  readonly name = 'vapi' as const;
  capabilities: ProviderCapabilities = { stopRecordingMidCall: false, deleteArtifacts: true, hangUp: true };
  readonly placed: Array<{ permit: DialPermit; request: PlaceCallRequest }> = [];
  readonly hungUp: string[] = [];
  readonly deleted: string[] = [];
  placeResult: PlacedCall | Error = { providerCallId: 'prov-1', controlUrl: 'https://phone-call-websocket.aws.vapi.ai/prov-1/control', providerStatus: 'queued' };
  secret = 'webhook-secret';

  async placeCall(permit: DialPermit, request: PlaceCallRequest): Promise<PlacedCall> {
    this.placed.push({ permit, request });
    if (this.placeResult instanceof Error) throw this.placeResult;
    return this.placeResult;
  }
  async hangUp(call: { providerCallId: string }): Promise<void> {
    this.hungUp.push(call.providerCallId);
  }
  async deleteArtifacts(providerCallId: string): Promise<void> {
    this.deleted.push(providerCallId);
  }
  artifactHeaders(): Record<string, string> {
    return {};
  }
  verifyWebhook(headers: HeaderBag): boolean {
    return headers['x-vapi-secret'] === this.secret;
  }
  parseWebhook(body: unknown): ProviderEvent {
    return parseVapiWebhook(body);
  }
}

export interface FetchCall {
  url: string;
  method: string;
  body: unknown;
  headers: Record<string, string>;
}

type Reply = { status?: number; json?: unknown; text?: string } | Error;

/** A `fetch` that answers from a table and remembers what it was asked. */
export function fakeFetch(route: (call: FetchCall) => Reply): typeof fetch & { calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const impl = async (input: URL | string | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const call: FetchCall = {
      url,
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
      headers
    };
    calls.push(call);
    const reply = route(call);
    if (reply instanceof Error) throw reply;
    return new Response(reply.text ?? (reply.json === undefined ? '' : JSON.stringify(reply.json)), { status: reply.status ?? 200 });
  };
  return Object.assign(impl, { calls }) as unknown as typeof fetch & { calls: FetchCall[] };
}

/** The data lines of an SSE body, parsed. */
export function frames(body: string): Array<{ choices: Array<{ delta: Record<string, unknown>; finish_reason: string | null }> }> {
  return body
    .split('\n')
    .filter((l) => l.startsWith('data: ') && !l.includes('[DONE]'))
    .map((l) => JSON.parse(l.slice(6)) as { choices: Array<{ delta: Record<string, unknown>; finish_reason: string | null }> });
}

export function spoken(body: string): string {
  return frames(body)
    .map((f) => (typeof f.choices[0]?.delta.content === 'string' ? f.choices[0].delta.content : ''))
    .join('');
}

export async function closeAll(apps: FastifyInstance[]): Promise<void> {
  for (const app of apps) await app.close();
  apps.length = 0;
}
