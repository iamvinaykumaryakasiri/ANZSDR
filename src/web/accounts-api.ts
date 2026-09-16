/**
 * The account desk: the list of organisations to work, and the titles worth
 * calling at them.
 *
 * This is NOT the console in section 14 of the brief. It is a small admin
 * surface so the account list and the ICP can be maintained without editing
 * YAML or the database by hand, and so Phase 3 has something real to prospect
 * against. The console is Phase 8 and starts with a design review.
 *
 * It sits on the same Fastify instance that will host the Apollo phone-enrichment
 * webhook, because that webhook needs a public HTTPS hostname anyway.
 */

import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Blackboard } from '../blackboard/client.js';
import {
  accountStatusSchema,
  campaignGoalSchema,
  campaignStatusSchema,
  decode,
  encode,
  icpSchema,
  marketSchema
} from '../blackboard/schemas.js';

const campaignInput = z.object({
  name: z.string().min(1),
  market: marketSchema,
  status: campaignStatusSchema.default('draft'),
  icp: icpSchema,
  goal: campaignGoalSchema
});

const accountInput = z.object({
  name: z.string().min(1),
  domain: z
    .string()
    .min(3)
    .transform((d) => d.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')),
  country: z.enum(['AU', 'NZ']),
  industry: z.string().min(1).default('financial services'),
  priority: z.coerce.number().int().min(1).max(5).default(3),
  notes: z.string().default('')
});

const accountPatch = z.object({
  priority: z.coerce.number().int().min(1).max(5).optional(),
  status: accountStatusSchema.optional(),
  industry: z.string().min(1).optional(),
  notes: z.string().optional()
});

/** The column names from section 5.1, so a block of Excel rows pastes straight in. */
export const CSV_COLUMNS = ['account_name', 'domain', 'country', 'industry', 'priority', 'notes'] as const;

export interface ImportResult {
  added: number;
  updated: number;
  skipped: Array<{ row: number; reason: string }>;
}

/**
 * Split one row.
 *
 * Quote handling applies to comma-separated input only. Excel pastes cells
 * tab-separated and literal, quoting only when a cell contains a tab or a
 * newline, so treating a stray `"` in a tab-pasted note as a quote character
 * would silently eat it.
 */
function splitLine(line: string, delimiter: string): string[] {
  const honourQuotes = delimiter === ',';
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i] as string;
    if (!honourQuotes) {
      if (c === delimiter) { out.push(cur); cur = ''; } else cur += c;
      continue;
    }
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else { quoted = false; }
      } else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === delimiter) { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out.map((v) => v.trim());
}

/**
 * A paste out of Excel or Sheets is tab-separated; a saved file is comma-
 * separated. Choosing one delimiter for the whole block rather than treating
 * both as separators is what lets an account called "Bank, The" survive a paste.
 */
function delimiterFor(text: string): string {
  return text.includes('\t') ? '\t' : ',';
}

/**
 * Parse pasted rows. A header line is optional; when present its column order is
 * honoured, so a sheet with the columns in a different order still imports.
 */
export function parseAccountRows(text: string): Array<{ row: number; values: Record<string, string> }> {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length === 0) return [];

  const delimiter = delimiterFor(text);
  const first = splitLine(lines[0] as string, delimiter).map((h) => h.toLowerCase().replace(/\s+/g, '_'));
  const hasHeader = first.includes('domain') || first.includes('account_name');
  const columns = hasHeader ? first : [...CSV_COLUMNS];
  const body = hasHeader ? lines.slice(1) : lines;

  return body.map((line, index) => {
    const cells = splitLine(line, delimiter);
    const values: Record<string, string> = {};
    for (const [i, column] of columns.entries()) {
      const cell = cells[i];
      if (cell !== undefined && cell !== '') values[column] = cell;
    }
    return { row: index + (hasHeader ? 2 : 1), values };
  });
}

export function toCsv(rows: Array<Record<string, string | number>>): string {
  const escape = (v: string | number): string => {
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [
    CSV_COLUMNS.join(','),
    ...rows.map((r) => CSV_COLUMNS.map((c) => escape(r[c] ?? '')).join(','))
  ].join('\n');
}

export function registerAccountsApi(app: FastifyInstance, db: Blackboard): void {
  app.get('/api/campaigns', async () => {
    const rows = await db.campaign.findMany({ orderBy: { createdAt: 'asc' } });
    return rows.map((c) => ({
      id: c.id,
      name: c.name,
      market: c.market,
      status: c.status,
      icp: decode(icpSchema, 'Campaign.icp', c.icp),
      goal: decode(campaignGoalSchema, 'Campaign.goal', c.goal)
    }));
  });

  app.post('/api/campaigns', async (request, reply) => {
    const parsed = campaignInput.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues });
    const id = randomUUID();
    await db.campaign.create({
      data: {
        id,
        name: parsed.data.name,
        market: parsed.data.market,
        status: parsed.data.status,
        icp: encode(icpSchema, 'Campaign.icp', parsed.data.icp),
        goal: encode(campaignGoalSchema, 'Campaign.goal', parsed.data.goal)
      }
    });
    return reply.code(201).send({ id });
  });

  /** Titles, seniorities, disqualifiers and the score below which we do not spend. */
  app.put('/api/campaigns/:id/icp', async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = icpSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues });
    const campaign = await db.campaign.findUnique({ where: { id } });
    if (campaign === null) return reply.code(404).send({ error: 'no such campaign' });
    await db.campaign.update({
      where: { id },
      data: { icp: encode(icpSchema, 'Campaign.icp', parsed.data) }
    });
    return { ok: true };
  });

  /** Meetings wanted per week, and the hard weekly spend ceiling the Director obeys. */
  app.put('/api/campaigns/:id/goal', async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = campaignGoalSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues });
    const campaign = await db.campaign.findUnique({ where: { id } });
    if (campaign === null) return reply.code(404).send({ error: 'no such campaign' });
    await db.campaign.update({
      where: { id },
      data: { goal: encode(campaignGoalSchema, 'Campaign.goal', parsed.data) }
    });
    return { ok: true };
  });

  app.get('/api/campaigns/:id/accounts', async (request, reply) => {
    const { id } = request.params as { id: string };
    const campaign = await db.campaign.findUnique({ where: { id } });
    if (campaign === null) return reply.code(404).send({ error: 'no such campaign' });
    const rows = await db.account.findMany({
      where: { campaignId: id },
      orderBy: [{ priority: 'asc' }, { name: 'asc' }],
      include: { _count: { select: { contacts: true } } }
    });
    return rows.map((a) => ({
      id: a.id,
      name: a.name,
      domain: a.domain,
      country: a.country,
      industry: a.industry,
      priority: a.priority,
      status: a.status,
      notes: a.notes,
      contacts: a._count.contacts
    }));
  });

  app.post('/api/campaigns/:id/accounts', async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = accountInput.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues });
    const campaign = await db.campaign.findUnique({ where: { id } });
    if (campaign === null) return reply.code(404).send({ error: 'no such campaign' });

    const existing = await db.account.findFirst({ where: { campaignId: id, domain: parsed.data.domain } });
    if (existing !== null) {
      return reply.code(409).send({ error: `${parsed.data.domain} is already on this campaign` });
    }
    const accountId = randomUUID();
    await db.account.create({
      data: { id: accountId, campaignId: id, status: 'new', ...parsed.data }
    });
    return reply.code(201).send({ id: accountId });
  });

  app.patch('/api/accounts/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = accountPatch.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues });
    const account = await db.account.findUnique({ where: { id } });
    if (account === null) return reply.code(404).send({ error: 'no such account' });
    // Only the fields actually supplied are written, so a patch of one field
    // cannot blank the others.
    const changes = Object.fromEntries(
      Object.entries(parsed.data).filter(([, value]) => value !== undefined)
    );
    await db.account.update({ where: { id }, data: { ...changes, updatedAt: new Date() } });
    return { ok: true };
  });

  /**
   * Removing an account we have already worked would orphan its contacts and the
   * record of what was said to them, so once there are contacts the account is
   * closed rather than deleted.
   */
  app.delete('/api/accounts/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const account = await db.account.findUnique({
      where: { id },
      include: { _count: { select: { contacts: true } } }
    });
    if (account === null) return reply.code(404).send({ error: 'no such account' });
    if (account._count.contacts > 0) {
      await db.account.update({ where: { id }, data: { status: 'closed' } });
      return {
        ok: true,
        closed: true,
        message: `${account.name} has ${account._count.contacts} contact(s) on the record, so it was closed rather than deleted`
      };
    }
    await db.account.delete({ where: { id } });
    return { ok: true, closed: false };
  });

  /** Paste a block of rows straight out of a spreadsheet. */
  app.post('/api/campaigns/:id/accounts/import', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = z.object({ text: z.string() }).safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues });
    const campaign = await db.campaign.findUnique({ where: { id } });
    if (campaign === null) return reply.code(404).send({ error: 'no such campaign' });

    const result: ImportResult = { added: 0, updated: 0, skipped: [] };
    for (const { row, values } of parseAccountRows(body.data.text)) {
      const parsed = accountInput.safeParse({
        name: values.account_name ?? values.name,
        domain: values.domain,
        country: (values.country ?? campaign.market).toUpperCase(),
        industry: values.industry,
        priority: values.priority,
        notes: values.notes
      });
      if (!parsed.success) {
        result.skipped.push({ row, reason: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
        continue;
      }
      const existing = await db.account.findFirst({ where: { campaignId: id, domain: parsed.data.domain } });
      if (existing !== null) {
        await db.account.update({ where: { id: existing.id }, data: { ...parsed.data, updatedAt: new Date() } });
        result.updated += 1;
      } else {
        await db.account.create({ data: { id: randomUUID(), campaignId: id, status: 'new', ...parsed.data } });
        result.added += 1;
      }
    }
    return result;
  });

  app.get('/api/campaigns/:id/accounts.csv', async (request, reply) => {
    const { id } = request.params as { id: string };
    const rows = await db.account.findMany({ where: { campaignId: id }, orderBy: { name: 'asc' } });
    reply.header('content-type', 'text/csv; charset=utf-8');
    reply.header('content-disposition', 'attachment; filename="accounts.csv"');
    return toCsv(
      rows.map((a) => ({
        account_name: a.name,
        domain: a.domain,
        country: a.country,
        industry: a.industry,
        priority: a.priority,
        notes: a.notes
      }))
    );
  });
}
