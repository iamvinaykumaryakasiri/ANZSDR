/**
 * The record of what Apollo has already sold us.
 *
 * This is the thing that makes "never re-buy" a property of the system rather
 * than a habit. Before any paid call the client asks the ledger; after a paid
 * call it writes the answer down, including the data itself, so the next run
 * gets the email from here for nothing instead of from Apollo for a credit.
 *
 * It is keyed on the Apollo person id and deliberately does not depend on a
 * Contact row existing: Prospector buys an email before the orchestrator has
 * created the contact, and a purchase that could only be remembered after the
 * contact was written would be forgotten by any run that failed in between.
 *
 * The blackboard's `Memory` table holds it (brief section 3.5, contact memory),
 * with a deterministic id per record so a repeated write is the same row rather
 * than a second one.
 */

import { z } from 'zod';
import type { Blackboard } from '../blackboard/client.js';
import { BlackboardDecodeError } from '../blackboard/schemas.js';
import { enrichedPersonSchema, organizationRecordSchema, phoneNumberRecordSchema } from './apollo-types.js';

export const emailPurchaseSchema = z.object({
  apolloId: z.string().min(1),
  boughtAt: z.string().datetime(),
  /** Apollo matched the person. A miss is recorded too, so we do not pay to be told "no" twice. */
  matched: z.boolean(),
  person: enrichedPersonSchema.optional(),
  credits: z.number().nonnegative(),
  /** True when Apollo did not state the credits consumed and the figure is our own estimate. */
  estimated: z.boolean().default(false),
  /** Set once the person has been converted to an Apollo contact, so a later re-enrichment is free. */
  apolloContactId: z.string().optional()
});
export type EmailPurchase = z.infer<typeof emailPurchaseSchema>;

export const phoneRequestSchema = z.object({
  apolloId: z.string().min(1),
  requestedAt: z.string().datetime(),
  /** Credits reserved at request time. An upper bound: Apollo bills only when a number is found. */
  estimatedCredits: z.number().nonnegative(),
  status: z.enum(['requested', 'delivered', 'none']),
  /** One entry per distinct delivery we have applied. Apollo retries; this is how a retry is recognised. */
  deliveries: z.array(z.object({ key: z.string(), at: z.string().datetime() })).default([]),
  numbers: z.array(phoneNumberRecordSchema).default([])
});
export type PhoneRequest = z.infer<typeof phoneRequestSchema>;

export const organizationPurchaseSchema = z.object({
  domain: z.string().min(1),
  boughtAt: z.string().datetime(),
  credits: z.number().nonnegative(),
  organization: organizationRecordSchema.optional()
});
export type OrganizationPurchase = z.infer<typeof organizationPurchaseSchema>;

export type PhoneDeliveryOutcome =
  | { applied: true; request: PhoneRequest }
  | { applied: false; reason: 'unrequested' | 'duplicate' };

export interface EnrichmentLedger {
  getEmail(apolloId: string): Promise<EmailPurchase | null>;
  /** First write wins. Returns false, and changes nothing, if the person is already recorded. */
  recordEmail(purchase: EmailPurchase): Promise<boolean>;
  setApolloContact(apolloId: string, apolloContactId: string): Promise<void>;

  getPhone(apolloId: string): Promise<PhoneRequest | null>;
  /** First write wins, as for email. */
  recordPhoneRequest(request: PhoneRequest): Promise<boolean>;
  /**
   * Apply one delivery of numbers. Idempotent on `key`: Apollo retries webhooks,
   * and a retry must not write twice. A delivery for someone we never asked about
   * is refused rather than recorded.
   */
  recordPhoneDelivery(
    apolloId: string,
    key: string,
    numbers: z.infer<typeof phoneNumberRecordSchema>[],
    at: Date
  ): Promise<PhoneDeliveryOutcome>;

  getOrganization(domain: string): Promise<OrganizationPurchase | null>;
  recordOrganization(purchase: OrganizationPurchase): Promise<boolean>;
}

/* ------------------------------------------------------------------ */
/* In memory                                                           */
/* ------------------------------------------------------------------ */

export class InMemoryEnrichmentLedger implements EnrichmentLedger {
  private readonly emails = new Map<string, EmailPurchase>();
  private readonly phones = new Map<string, PhoneRequest>();
  private readonly orgs = new Map<string, OrganizationPurchase>();

  async getEmail(apolloId: string): Promise<EmailPurchase | null> {
    const found = this.emails.get(apolloId);
    return found === undefined ? null : structuredClone(found);
  }

  async recordEmail(purchase: EmailPurchase): Promise<boolean> {
    const parsed = emailPurchaseSchema.parse(purchase);
    if (this.emails.has(parsed.apolloId)) return false;
    this.emails.set(parsed.apolloId, structuredClone(parsed));
    return true;
  }

  async setApolloContact(apolloId: string, apolloContactId: string): Promise<void> {
    const found = this.emails.get(apolloId);
    if (found !== undefined) this.emails.set(apolloId, { ...found, apolloContactId });
  }

  async getPhone(apolloId: string): Promise<PhoneRequest | null> {
    const found = this.phones.get(apolloId);
    return found === undefined ? null : structuredClone(found);
  }

  async recordPhoneRequest(request: PhoneRequest): Promise<boolean> {
    const parsed = phoneRequestSchema.parse(request);
    if (this.phones.has(parsed.apolloId)) return false;
    this.phones.set(parsed.apolloId, structuredClone(parsed));
    return true;
  }

  async recordPhoneDelivery(
    apolloId: string,
    key: string,
    numbers: z.infer<typeof phoneNumberRecordSchema>[],
    at: Date
  ): Promise<PhoneDeliveryOutcome> {
    const existing = this.phones.get(apolloId);
    if (existing === undefined) return { applied: false, reason: 'unrequested' };
    if (existing.deliveries.some((d) => d.key === key)) return { applied: false, reason: 'duplicate' };
    const next = applyDelivery(existing, key, numbers, at);
    this.phones.set(apolloId, next);
    return { applied: true, request: structuredClone(next) };
  }

  async getOrganization(domain: string): Promise<OrganizationPurchase | null> {
    const found = this.orgs.get(domain.toLowerCase());
    return found === undefined ? null : structuredClone(found);
  }

  async recordOrganization(purchase: OrganizationPurchase): Promise<boolean> {
    const parsed = organizationPurchaseSchema.parse(purchase);
    const key = parsed.domain.toLowerCase();
    if (this.orgs.has(key)) return false;
    this.orgs.set(key, structuredClone(parsed));
    return true;
  }
}

function applyDelivery(
  existing: PhoneRequest,
  key: string,
  numbers: z.infer<typeof phoneNumberRecordSchema>[],
  at: Date
): PhoneRequest {
  const merged = [...existing.numbers];
  for (const n of numbers) {
    if (!merged.some((m) => m.number === n.number)) merged.push(n);
  }
  return {
    ...existing,
    status: merged.length > 0 ? 'delivered' : 'none',
    numbers: merged,
    deliveries: [...existing.deliveries, { key, at: at.toISOString() }]
  };
}

/* ------------------------------------------------------------------ */
/* On the blackboard                                                   */
/* ------------------------------------------------------------------ */

const EMAIL_KIND = 'apollo-email';
const PHONE_KIND = 'apollo-phone';
const ORG_KIND = 'apollo-organization';

/** Parse a stored row through its schema. A corrupt record is a stop, not a shrug. */
function parseRow<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, field: string, raw: string): T {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (cause) {
    throw new BlackboardDecodeError(field, cause);
  }
  const result = schema.safeParse(json);
  if (!result.success) throw new BlackboardDecodeError(field, result.error);
  return result.data;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2002';
}

export class PrismaEnrichmentLedger implements EnrichmentLedger {
  constructor(private readonly db: Blackboard) {}

  private async read<T>(id: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>, field: string): Promise<T | null> {
    const row = await this.db.memory.findUnique({ where: { id } });
    return row === null ? null : parseRow(schema, field, row.content);
  }

  /** Create-if-absent. A row that already exists is left exactly as it is. */
  private async createOnce(
    id: string,
    scope: 'contact' | 'account',
    key: string,
    kind: string,
    summary: string,
    content: unknown
  ): Promise<boolean> {
    if ((await this.db.memory.findUnique({ where: { id } })) !== null) return false;
    try {
      await this.db.memory.create({
        data: { id, scope, key, kind, summary, content: JSON.stringify(content) }
      });
      return true;
    } catch (error) {
      if (isUniqueViolation(error)) return false;
      throw error;
    }
  }

  async getEmail(apolloId: string): Promise<EmailPurchase | null> {
    return this.read(`apollo:email:${apolloId}`, emailPurchaseSchema, 'Memory.apollo-email');
  }

  async recordEmail(purchase: EmailPurchase): Promise<boolean> {
    const parsed = emailPurchaseSchema.parse(purchase);
    return this.createOnce(
      `apollo:email:${parsed.apolloId}`,
      'contact',
      `apollo:${parsed.apolloId}`,
      EMAIL_KIND,
      parsed.matched ? 'Apollo email enrichment bought' : 'Apollo email enrichment found no match',
      parsed
    );
  }

  async setApolloContact(apolloId: string, apolloContactId: string): Promise<void> {
    const current = await this.getEmail(apolloId);
    if (current === null) return;
    await this.db.memory.update({
      where: { id: `apollo:email:${apolloId}` },
      data: { content: JSON.stringify({ ...current, apolloContactId }) }
    });
  }

  async getPhone(apolloId: string): Promise<PhoneRequest | null> {
    return this.read(`apollo:phone:${apolloId}`, phoneRequestSchema, 'Memory.apollo-phone');
  }

  async recordPhoneRequest(request: PhoneRequest): Promise<boolean> {
    const parsed = phoneRequestSchema.parse(request);
    return this.createOnce(
      `apollo:phone:${parsed.apolloId}`,
      'contact',
      `apollo:${parsed.apolloId}`,
      PHONE_KIND,
      'Apollo phone reveal requested',
      parsed
    );
  }

  async recordPhoneDelivery(
    apolloId: string,
    key: string,
    numbers: z.infer<typeof phoneNumberRecordSchema>[],
    at: Date
  ): Promise<PhoneDeliveryOutcome> {
    // Read-modify-write inside one transaction, so two retries of the same
    // webhook arriving together cannot both find the key absent.
    return this.db.$transaction(async (tx) => {
      const row = await tx.memory.findUnique({ where: { id: `apollo:phone:${apolloId}` } });
      if (row === null) return { applied: false, reason: 'unrequested' } as const;
      const existing = parseRow(phoneRequestSchema, 'Memory.apollo-phone', row.content);
      if (existing.deliveries.some((d) => d.key === key)) return { applied: false, reason: 'duplicate' } as const;
      const next = applyDelivery(existing, key, numbers, at);
      await tx.memory.update({
        where: { id: row.id },
        data: {
          content: JSON.stringify(next),
          summary: next.status === 'delivered' ? 'Apollo phone numbers delivered' : 'Apollo phone reveal found nothing'
        }
      });
      return { applied: true, request: next } as const;
    });
  }

  async getOrganization(domain: string): Promise<OrganizationPurchase | null> {
    return this.read(`apollo:org:${domain.toLowerCase()}`, organizationPurchaseSchema, 'Memory.apollo-organization');
  }

  async recordOrganization(purchase: OrganizationPurchase): Promise<boolean> {
    const parsed = organizationPurchaseSchema.parse(purchase);
    const domain = parsed.domain.toLowerCase();
    return this.createOnce(
      `apollo:org:${domain}`,
      'account',
      domain,
      ORG_KIND,
      'Apollo organization enrichment bought',
      parsed
    );
  }
}
