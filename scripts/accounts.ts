/**
 * Move the account list between the committed files and the blackboard.
 *
 *   npm run accounts:import    config/campaign.yaml + config/accounts.csv  ->  blackboard
 *   npm run accounts:export    blackboard  ->  those same files
 *
 * The files are the durable copy. A database lives on one machine and does not
 * survive a fresh clone or a rebuilt container; a committed CSV does, and every
 * change to it is a reviewable diff. The account desk edits the live database,
 * so `export` is how a change made there gets committed.
 *
 * Import is idempotent: the campaign is matched by name, and an account already
 * on it is updated rather than duplicated.
 */

import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { createBlackboard } from '../src/blackboard/client.js';
import {
  campaignGoalSchema,
  campaignStatusSchema,
  encode,
  icpSchema,
  marketSchema
} from '../src/blackboard/schemas.js';
import {
  CONTACT_CSV_COLUMNS,
  contactRowSchema,
  parseAccountRows,
  toCsv,
  upsertContact
} from '../src/web/accounts-api.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const CAMPAIGN_FILE = resolve(ROOT, 'config/campaign.yaml');
const ACCOUNTS_FILE = resolve(ROOT, 'config/accounts.csv');
const CONTACTS_FILE = resolve(ROOT, 'config/contacts.csv');

const fileSchema = z.object({
  campaign: z.object({
    name: z.string().min(1),
    market: marketSchema,
    status: campaignStatusSchema
  }),
  goal: campaignGoalSchema,
  icp: icpSchema
});

const accountRowSchema = z.object({
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

const db = createBlackboard();

async function importFiles(): Promise<void> {
  const file = fileSchema.parse(parseYaml(readFileSync(CAMPAIGN_FILE, 'utf8')));

  const existing = await db.campaign.findFirst({ where: { name: file.campaign.name } });
  const campaignId = existing?.id ?? randomUUID();
  const data = {
    name: file.campaign.name,
    market: file.campaign.market,
    status: file.campaign.status,
    icp: encode(icpSchema, 'Campaign.icp', file.icp),
    goal: encode(campaignGoalSchema, 'Campaign.goal', file.goal)
  };

  if (existing === null) {
    await db.campaign.create({ data: { id: campaignId, ...data } });
    console.log(`created campaign "${file.campaign.name}"`);
  } else {
    await db.campaign.update({ where: { id: campaignId }, data });
    console.log(`updated campaign "${file.campaign.name}"`);
  }
  console.log(
    `  ${file.icp.titles.length} title(s), ${file.icp.disqualifiers.length} never-call word(s), ` +
      `minimum score ${file.icp.minimumScore}, $${file.goal.maxUsdPerWeek}/week ceiling`
  );

  let added = 0;
  let updated = 0;
  const skipped: string[] = [];

  for (const { row, values } of parseAccountRows(readFileSync(ACCOUNTS_FILE, 'utf8'))) {
    const parsed = accountRowSchema.safeParse({
      name: values.account_name ?? values.name,
      domain: values.domain,
      country: (values.country ?? file.campaign.market).toUpperCase(),
      industry: values.industry,
      priority: values.priority,
      notes: values.notes
    });
    if (!parsed.success) {
      skipped.push(`row ${row}: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join(', ')}`);
      continue;
    }

    const current = await db.account.findFirst({ where: { campaignId, domain: parsed.data.domain } });
    if (current === null) {
      await db.account.create({ data: { id: randomUUID(), campaignId, status: 'new', ...parsed.data } });
      added += 1;
    } else {
      // Status is left alone: it is worked state, not list state, and the file
      // should not drag an account we are already calling back to "new".
      await db.account.update({ where: { id: current.id }, data: { ...parsed.data, updatedAt: new Date() } });
      updated += 1;
    }
  }

  console.log(`  ${added} account(s) added, ${updated} updated`);
  for (const s of skipped) console.log(`  skipped ${s}`);

  await importContacts(campaignId);
}

/**
 * People. Every row lands as either a test number the operator controls or a real
 * prospect, and the count of each is printed, because which one a row is decides
 * whether the compliance gate will let it be dialled at all.
 */
async function importContacts(campaignId: string): Promise<void> {
  if (!existsSync(CONTACTS_FILE)) return;

  let added = 0;
  let updated = 0;
  let prospects = 0;
  const skipped: string[] = [];

  for (const { row, values } of parseAccountRows(readFileSync(CONTACTS_FILE, 'utf8'), CONTACT_CSV_COLUMNS)) {
    const parsed = contactRowSchema.safeParse({
      firstName: values.first_name,
      lastName: values.last_name,
      title: values.title,
      accountDomain: values.account_domain ?? values.domain,
      phone: values.phone,
      email: values.email,
      seniority: values.seniority,
      linkedinUrl: values.linkedin_url,
      kind: values.kind,
      notes: values.notes
    });
    if (!parsed.success) {
      skipped.push(`row ${row}: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join(', ')}`);
      continue;
    }

    const account = await db.account.findFirst({
      where: { campaignId, domain: parsed.data.accountDomain }
    });
    if (account === null) {
      skipped.push(`row ${row}: no account on this campaign with the domain ${parsed.data.accountDomain}`);
      continue;
    }

    const outcome = await upsertContact(db, campaignId, account.id, parsed.data);
    if (outcome === 'added') added += 1;
    else updated += 1;
    if (parsed.data.kind === 'prospect') prospects += 1;
  }

  if (added + updated + skipped.length === 0) return;
  console.log(`  ${added} contact(s) added, ${updated} updated`);
  console.log(
    prospects === 0
      ? '  all of them test numbers, so the gate will allow them while the system is in test mode'
      : `  ${prospects} of them real prospects, which the gate refuses while dialling.test_contacts_only is true`
  );
  for (const s of skipped) console.log(`  skipped ${s}`);
}

async function exportFiles(): Promise<void> {
  const campaign = await db.campaign.findFirst({ where: { status: 'active' }, orderBy: { createdAt: 'asc' } });
  if (campaign === null) {
    console.error('no active campaign to export');
    process.exit(1);
  }

  const accounts = await db.account.findMany({ where: { campaignId: campaign.id }, orderBy: [{ priority: 'asc' }, { name: 'asc' }] });
  writeFileSync(
    ACCOUNTS_FILE,
    `${toCsv(
      accounts.map((a) => ({
        account_name: a.name,
        domain: a.domain,
        country: a.country,
        industry: a.industry,
        priority: a.priority,
        notes: a.notes
      }))
    )}\n`
  );

  // Only the parts the desk can change are rewritten; the comments in
  // campaign.yaml are worth keeping, so the file is patched rather than
  // regenerated.
  const icp = JSON.parse(campaign.icp) as Record<string, unknown>;
  const goal = JSON.parse(campaign.goal) as Record<string, unknown>;
  const yaml = readFileSync(CAMPAIGN_FILE, 'utf8');
  const patched = yaml
    .replace(/^(\s*meetingsPerWeek:\s*)\d+/m, `$1${goal.meetingsPerWeek as number}`)
    .replace(/^(\s*maxUsdPerWeek:\s*)\d+(\.\d+)?/m, `$1${goal.maxUsdPerWeek as number}`)
    .replace(/^(\s*minimumScore:\s*)\d+/m, `$1${icp.minimumScore as number}`);
  writeFileSync(CAMPAIGN_FILE, patched);

  const contacts = await db.contact.findMany({
    where: { campaignId: campaign.id },
    orderBy: [{ kind: 'asc' }, { lastName: 'asc' }],
    include: { account: { select: { domain: true } }, emails: true }
  });
  writeFileSync(
    CONTACTS_FILE,
    `${toCsv(
      contacts.map((c) => ({
        first_name: c.firstName,
        last_name: c.lastName,
        title: c.title,
        account_domain: c.account.domain,
        phone: c.phoneE164 ?? '',
        email: c.emails[0]?.address ?? '',
        seniority: c.seniority,
        linkedin_url: c.linkedinUrl ?? '',
        kind: c.kind,
        notes: ''
      })),
      CONTACT_CSV_COLUMNS
    )}\n`
  );

  console.log(`exported ${accounts.length} account(s) to config/accounts.csv`);
  console.log(`exported ${contacts.length} contact(s) to config/contacts.csv`);
  console.log('goal and minimum score written back to config/campaign.yaml');
  console.log('Title and never-call lists are not rewritten automatically — edit those in the file.');
  console.log('\nCommit both so the list survives this machine.');
}

const command = process.argv[2];
if (command === 'export') {
  await exportFiles();
} else if (command === 'import' || command === undefined) {
  await importFiles();
} else {
  console.error(`unknown command "${command}". Use: import | export`);
  process.exit(2);
}

await db.$disconnect();
