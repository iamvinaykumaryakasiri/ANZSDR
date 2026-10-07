/**
 * The CRM workbook: a view of the blackboard, never a second record.
 */

import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestBlackboard, type Blackboard } from '../../src/blackboard/client.js';
import { MeetingRequestRepository } from '../../src/blackboard/meetings.js';
import { refFor } from '../../src/agents/concierge/ref.js';
import { buildWorkbook, stamp, syncWorkbook, SHEETS } from '../../src/crm/workbook.js';
import { seedCall } from '../support/seed.js';

const NOW = new Date('2026-10-07T21:30:00.000Z'); // 08:30 Thursday 8 Oct, Sydney (AEDT)

let dbs: Blackboard[] = [];
let dirs: string[] = [];
afterEach(async () => {
  for (const db of dbs) await db.$disconnect();
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  dbs = [];
  dirs = [];
});

async function setup() {
  const db = await createTestBlackboard();
  dbs.push(db);
  const dir = await mkdtemp(join(tmpdir(), 'crm-'));
  dirs.push(dir);
  return { db, dir, path: join(dir, 'crm.xlsx') };
}

async function read(path: string): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(path);
  return workbook;
}

/** Every row of a sheet below the header, as plain strings keyed by header. */
function table(workbook: ExcelJS.Workbook, name: string): Array<Record<string, string>> {
  const sheet = workbook.getWorksheet(name);
  if (sheet === undefined) throw new Error(`no sheet ${name}`);
  const headers = (sheet.getRow(1).values as Array<ExcelJS.CellValue>).slice(1).map(String);
  const rows: Array<Record<string, string>> = [];
  sheet.eachRow((row, index) => {
    if (index === 1) return;
    const values = (row.values as Array<ExcelJS.CellValue>).slice(1);
    rows.push(Object.fromEntries(headers.map((h, i) => [h, values[i] === undefined || values[i] === null ? '' : String(values[i])])));
  });
  return rows;
}

async function interested(db: Blackboard, over: Parameters<typeof seedCall>[1] = {}) {
  const seeded = await seedCall(db, { kind: 'prospect', phone: '+64211234567', line: 'mobile', outcome: 'meeting_requested', ...over });
  await db.callRecord.create({
    data: {
      id: `rec-${seeded.callId}`,
      callId: seeded.callId,
      summary: JSON.stringify(['Mid-way through a platform rebuild.', 'Offered Tuesday morning.']),
      hook: 'platform rebuild',
      sentiment: 'positive',
      windows: JSON.stringify([{ saidAs: 'Tuesday morning', startsAt: '2026-10-13T09:00:00+13:00', endsAt: '2026-10-13T12:00:00+13:00' }]),
      timezone: 'Pacific/Auckland'
    }
  });
  await db.contactEmail.create({
    data: { id: `e-${seeded.contactId}`, contactId: seeded.contactId, address: 'priya@kiwibank.co.nz', kind: 'confirmed_on_call', verified: true }
  });
  const meetings = new MeetingRequestRepository(db);
  const { record } = await meetings.create({ callId: seeded.callId, contactId: seeded.contactId }, NOW);
  await meetings.markEmailSent(record.id, NOW);
  return { seeded, record, meetings };
}

describe('the workbook', () => {
  it('has the five sheets, About first, and says it is a view that edits will not survive', async () => {
    const { db, path } = await setup();
    await syncWorkbook(db, path, NOW);
    const workbook = await read(path);

    expect(workbook.worksheets.map((s) => s.name)).toEqual([...SHEETS]);
    const about = workbook.getWorksheet('About');
    const text = (about?.getColumn(1).values as Array<ExcelJS.CellValue>).map(String).join('\n');
    expect(text).toContain('overwritten at the next sync');
    expect(text).toContain('Last synced: 2026-10-08 08:30 Sydney time');
    expect(text).toContain('personal information');
  });

  it('shows an interested call end to end: who, when they are free, how to reach them, and what was said', async () => {
    const { db, path } = await setup();
    const { record } = await interested(db);
    const counts = await syncWorkbook(db, path, NOW);
    const workbook = await read(path);

    expect(counts).toEqual({ meetingRequests: 1, calls: 1, contacts: 1, accounts: 1 });

    const [request] = table(workbook, 'Meeting requests');
    expect(request).toMatchObject({
      Status: 'requested',
      Ref: refFor(record.id),
      Name: 'Priya Raman',
      Company: 'Kiwibank',
      Phone: '+64211234567',
      Email: 'priya@kiwibank.co.nz'
    });
    expect(request?.['Preferred window (their time · Sydney)']).toContain('Tuesday 13 October');
    expect(request?.['Preferred window (their time · Sydney)']).toContain('Sydney');
    expect(request?.['Preferred window (their time · Sydney)']).toContain('"Tuesday morning"');
    expect(request?.['Requested (Sydney)']).toBe('2026-10-08 08:30');

    const [call] = table(workbook, 'Calls');
    expect(call).toMatchObject({ Outcome: 'meeting_requested', Sentiment: 'positive', 'Hook used': 'platform rebuild' });
    expect(call?.Summary).toBe('Mid-way through a platform rebuild.\nOffered Tuesday morning.');
  });

  it('puts what needs Vinay first, oldest first within a status', async () => {
    const { db, path } = await setup();
    const older = await interested(db, { firstName: 'Older' });
    const newer = await interested(db, { firstName: 'Newer' });
    const done = await interested(db, { firstName: 'Done' });
    await db.meetingRequest.update({ where: { id: older.record.id }, data: { createdAt: new Date(NOW.getTime() - 2 * 86_400_000) } });
    await db.meetingRequest.update({ where: { id: newer.record.id }, data: { createdAt: new Date(NOW.getTime() - 86_400_000) } });
    await done.meetings.decide(done.record.id, 'confirmed', '', 'email-reply', NOW);

    await syncWorkbook(db, path, NOW);
    const rows = table(await read(path), 'Meeting requests');
    expect(rows.map((r) => [(r.Name ?? '').split(' ')[0], r.Status])).toEqual([
      ['Older', 'requested'],
      ['Newer', 'requested'],
      ['Done', 'confirmed']
    ]);
  });

  it('uses the confirmed-on-call email over the one Apollo supplied', async () => {
    const { db, path } = await setup();
    const { seeded } = await interested(db);
    await db.contactEmail.create({
      data: { id: 'apollo', contactId: seeded.contactId, address: 'old@kiwibank.co.nz', kind: 'apollo_work', verified: true }
    });
    await syncWorkbook(db, path, NOW);
    const [contact] = table(await read(path), 'Contacts');
    expect(contact).toMatchObject({ Email: 'priya@kiwibank.co.nz', 'Email source': 'confirmed_on_call' });
  });

  it('shows suppression on the contact and the account, so a person cannot look callable when they are not', async () => {
    const { db, path } = await setup();
    const { seeded } = await interested(db);
    for (const [scope, key] of [['contact', seeded.contactId], ['number', '+64211234567'], ['account', seeded.accountId]] as const) {
      await db.suppression.create({ data: { id: `s-${scope}`, scope, key, source: 'operator', reason: 'asked' } });
    }
    await syncWorkbook(db, path, NOW);
    const workbook = await read(path);
    expect(table(workbook, 'Contacts')[0]?.Suppressed).toBe('account + contact + number');
    expect(table(workbook, 'Accounts')[0]?.Suppressed).toBe('yes');
  });

  it('shows an unmarked call as "not marked" rather than blank', async () => {
    const { db, path } = await setup();
    await seedCall(db, { outcome: null });
    await syncWorkbook(db, path, NOW);
    expect(table(await read(path), 'Calls')[0]?.Outcome).toBe('not marked');
  });

  it('copes with an empty system', async () => {
    const { db, path } = await setup();
    const counts = await syncWorkbook(db, path, NOW);
    expect(counts).toEqual({ meetingRequests: 0, calls: 0, contacts: 0, accounts: 0 });
    expect(table(await read(path), 'Calls')).toEqual([]);
  });

  it('stores what a prospect said as text, so a formula in a summary is never evaluated', async () => {
    const { db, path } = await setup();
    const { seeded } = await interested(db);
    await db.callRecord.update({
      where: { callId: seeded.callId },
      data: { summary: JSON.stringify(['=HYPERLINK("http://evil.example","click")']), hook: '=1+1' }
    });
    await syncWorkbook(db, path, NOW);
    const sheet = (await read(path)).getWorksheet('Calls');
    const cell = sheet?.getRow(2).getCell(8);
    expect(cell?.type).toBe(ExcelJS.ValueType.String);
    expect(String(cell?.value)).toBe('=HYPERLINK("http://evil.example","click")');
    expect(sheet?.getRow(2).getCell(7).type).toBe(ExcelJS.ValueType.String);
  });

  it('reads a damaged record as empty rather than failing the whole sync', async () => {
    const { db, path } = await setup();
    const { seeded } = await interested(db);
    await db.callRecord.update({ where: { callId: seeded.callId }, data: { summary: '{not json', windows: 'nope', objections: '7' } });
    await syncWorkbook(db, path, NOW);
    const workbook = await read(path);
    expect(table(workbook, 'Calls')[0]?.Summary).toBe('');
    expect(table(workbook, 'Meeting requests')[0]?.['Preferred window (their time · Sydney)']).toBe('');
  });

  it('never writes to the database', async () => {
    const { db } = await setup();
    await interested(db);
    const before = JSON.stringify({
      requests: await db.meetingRequest.findMany(),
      contacts: await db.contact.findMany(),
      calls: await db.call.findMany()
    });
    await buildWorkbook(db, NOW);
    const after = JSON.stringify({
      requests: await db.meetingRequest.findMany(),
      contacts: await db.contact.findMany(),
      calls: await db.call.findMany()
    });
    expect(after).toBe(before);
  });
});

describe('writing it', () => {
  it('replaces the previous workbook whole: an edit made in Excel does not survive', async () => {
    const { db, path } = await setup();
    await interested(db);
    await syncWorkbook(db, path, NOW);

    const edited = await read(path);
    const requests = edited.getWorksheet('Meeting requests');
    if (requests === undefined) throw new Error('no sheet');
    requests.getRow(2).getCell(1).value = 'confirmed';
    await edited.xlsx.writeFile(path);

    await syncWorkbook(db, path, NOW);
    expect(table(await read(path), 'Meeting requests')[0]?.Status).toBe('requested');
  });

  it('leaves no temporary file behind', async () => {
    const { db, path, dir } = await setup();
    await syncWorkbook(db, path, NOW);
    expect(await readdir(dir)).toEqual(['crm.xlsx']);
  });

  it('creates the directory it is asked to write into', async () => {
    const { db, dir } = await setup();
    const nested = join(dir, 'a', 'b', 'crm.xlsx');
    await syncWorkbook(db, nested, NOW);
    expect(await readdir(join(dir, 'a', 'b'))).toEqual(['crm.xlsx']);
  });

  it('keeps the last good workbook, and cleans up, when the new one cannot be put in place', async () => {
    const { db, dir } = await setup();
    // A directory sits where the workbook should go, so the final rename fails.
    const blocked = join(dir, 'crm.xlsx');
    await mkdir(blocked);
    await writeFile(join(blocked, 'keep.txt'), 'last good');
    await expect(syncWorkbook(db, blocked, NOW)).rejects.toThrow();
    expect((await readdir(dir)).sort()).toEqual(['crm.xlsx']);
    expect(await readdir(blocked)).toEqual(['keep.txt']);
  });
});

describe('stamp', () => {
  it('is on the operator clock, with daylight saving, as sortable text', () => {
    expect(stamp(new Date('2026-10-07T21:30:00.000Z'))).toBe('2026-10-08 08:30'); // AEDT
    expect(stamp(new Date('2026-07-07T21:30:00.000Z'))).toBe('2026-07-08 07:30'); // AEST
    expect(stamp(null)).toBe('');
    expect(stamp(undefined)).toBe('');
  });
});
