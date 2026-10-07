/**
 * The CRM: a live Excel workbook, synced from the blackboard.
 *
 * Section 2 asks for "a live Excel workbook synced from the internal store".
 * The word that matters is *from*. The blackboard is the system of record and
 * the workbook is a view of it, rebuilt whole on every sync:
 *
 *   - Nothing here ever reads the workbook back or writes to the database. A
 *     cell edited in Excel is overwritten at the next sync, and the About sheet
 *     says so, because the alternative - two-way sync - means a typo in a
 *     spreadsheet can un-suppress a person.
 *   - It is written to a temporary file and renamed into place, so a reader
 *     (Vinay, or a OneDrive sync) never sees half a workbook, and a crash in
 *     the middle leaves the last good one untouched.
 *   - It holds personal information: names, numbers, work emails, what was said.
 *     The default path is under `data/`, which is not committed. Where it is
 *     synced to is the operator's decision, and the About sheet says that too.
 *
 * Every timestamp is shown on the operator's clock (Sydney), as sortable text.
 * Excel has no time zones, so a real date cell would silently mean "whatever
 * the viewer's machine thinks"; the header says what the clock is instead.
 */

import { mkdir, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import ExcelJS from 'exceljs';
import { DateTime } from 'luxon';
import type { Blackboard } from '../blackboard/client.js';
import { bestEmail } from '../agents/scribe/rules.js';
import { refFor } from '../agents/concierge/ref.js';
import { renderWindow, type PreferredWindow } from '../agents/concierge/meeting-email.js';

export const OPERATOR_ZONE = 'Australia/Sydney';

export const SHEETS = ['About', 'Meeting requests', 'Calls', 'Contacts', 'Accounts'] as const;

const STATUS_ORDER: Record<string, number> = { requested: 0, reschedule: 1, confirmed: 2, rejected: 3 };

export function stamp(date: Date | null | undefined): string {
  if (date === null || date === undefined) return '';
  return DateTime.fromJSDate(date, { zone: OPERATOR_ZONE }).toFormat('yyyy-MM-dd HH:mm');
}

function parseList<T>(raw: string | null | undefined): T[] {
  if (raw === null || raw === undefined) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

/** A window as one line, in the prospect's clock and Sydney's, with the prompt's two-line form flattened. */
function windowLine(window: PreferredWindow | undefined, timezone: string | null): string {
  if (window === undefined) return '';
  return renderWindow(window, timezone ?? 'Pacific/Auckland').replace(/\n\s+/g, '  ');
}

interface Column {
  header: string;
  width: number;
}

function addTable(sheet: ExcelJS.Worksheet, columns: Column[], rows: Array<Array<string | number>>): void {
  sheet.columns = columns.map((c) => ({ header: c.header, width: c.width }));
  for (const row of rows) sheet.addRow(row);

  const header = sheet.getRow(1);
  header.font = { bold: true };
  header.alignment = { vertical: 'middle', wrapText: true };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE7EBF0' } };
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  if (rows.length > 0) {
    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
  }
  sheet.eachRow((row, index) => {
    if (index > 1) row.alignment = { vertical: 'top', wrapText: true };
  });
}

export interface WorkbookCounts {
  meetingRequests: number;
  calls: number;
  contacts: number;
  accounts: number;
}

export interface BuiltWorkbook {
  workbook: ExcelJS.Workbook;
  counts: WorkbookCounts;
}

export async function buildWorkbook(db: Blackboard, now: Date): Promise<BuiltWorkbook> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'ANZ Voice SDR';
  workbook.created = now;
  workbook.modified = now;

  const [accounts, contacts, calls, requests, suppressions] = await Promise.all([
    db.account.findMany({ orderBy: [{ priority: 'asc' }, { name: 'asc' }] }),
    db.contact.findMany({ include: { emails: true, account: true }, orderBy: [{ account: { name: 'asc' } }, { lastName: 'asc' }] }),
    db.call.findMany({ include: { contact: true, account: true, record: true }, orderBy: { startedAt: 'desc' } }),
    db.meetingRequest.findMany({ include: { contact: { include: { account: true, emails: true } }, call: { include: { record: true } } } }),
    db.suppression.findMany()
  ]);

  const suppressedKeys = new Map<string, string[]>();
  for (const s of suppressions) suppressedKeys.set(s.key, [...(suppressedKeys.get(s.key) ?? []), s.scope]);
  const suppressionOf = (contact: { id: string; phoneE164: string | null; accountId: string }): string => {
    const scopes = new Set<string>();
    for (const key of [contact.id, contact.phoneE164 ?? '', contact.accountId]) {
      for (const scope of suppressedKeys.get(key) ?? []) scopes.add(scope);
    }
    return [...scopes].sort().join(' + ');
  };

  /* About ---------------------------------------------------------- */
  const about = workbook.addWorksheet('About');
  about.columns = [{ width: 100 }];
  for (const line of [
    'ANZ Voice SDR: CRM view',
    '',
    `Last synced: ${stamp(now)} Sydney time`,
    '',
    'This workbook is rebuilt from the system’s database on every sync. It is a view, not a record.',
    'Edits made here are overwritten at the next sync and are never read back. To change something, change it in the system.',
    'All times are Sydney time, as text, so they sort correctly and mean the same thing wherever the file is opened.',
    '',
    'It contains personal information (names, phone numbers, work emails, what was said on calls). Keep it where you would keep the call recordings.'
  ]) {
    about.addRow([line]);
  }
  about.getRow(1).font = { bold: true, size: 14 };
  about.getColumn(1).alignment = { wrapText: true, vertical: 'top' };

  /* Meeting requests: what needs him comes first --------------------- */
  const sortedRequests = [...requests].sort(
    (a, b) =>
      (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9) || a.createdAt.getTime() - b.createdAt.getTime()
  );
  addTable(
    workbook.addWorksheet('Meeting requests'),
    [
      { header: 'Status', width: 13 },
      { header: 'Ref', width: 13 },
      { header: 'Name', width: 22 },
      { header: 'Title', width: 26 },
      { header: 'Company', width: 22 },
      { header: 'Phone', width: 16 },
      { header: 'Email', width: 30 },
      { header: 'Preferred window (their time · Sydney)', width: 58 },
      { header: 'Requested (Sydney)', width: 18 },
      { header: 'Email sent (Sydney)', width: 18 },
      { header: 'Reminded (Sydney)', width: 18 },
      { header: 'Decided (Sydney)', width: 18 },
      { header: 'Decided via', width: 12 },
      { header: 'Note', width: 40 }
    ],
    sortedRequests.map((r) => {
      const windows = parseList<PreferredWindow>(r.call.record?.windows);
      const email = bestEmail(r.contact.emails.map((e) => ({ address: e.address, kind: e.kind, verified: e.verified })));
      return [
        r.status,
        refFor(r.id),
        `${r.contact.firstName} ${r.contact.lastName}`,
        r.contact.title,
        r.contact.account.name,
        r.contact.phoneE164 ?? '',
        email?.address ?? '',
        windowLine(windows[0], r.call.record?.timezone ?? null),
        stamp(r.createdAt),
        stamp(r.emailSentAt),
        stamp(r.nudgedAt),
        stamp(r.decidedAt),
        r.decidedVia ?? '',
        r.decisionNote
      ];
    })
  );

  /* Calls ------------------------------------------------------------ */
  addTable(
    workbook.addWorksheet('Calls'),
    [
      { header: 'Started (Sydney)', width: 18 },
      { header: 'Seconds', width: 9 },
      { header: 'Name', width: 22 },
      { header: 'Company', width: 22 },
      { header: 'Outcome', width: 20 },
      { header: 'Sentiment', width: 11 },
      { header: 'Hook used', width: 30 },
      { header: 'Summary', width: 80 },
      { header: 'Objections', width: 40 },
      { header: 'Playbook', width: 10 },
      { header: 'Defects', width: 9 },
      { header: 'Recording', width: 30 },
      { header: 'Transcript', width: 30 }
    ],
    calls.map((c) => [
      stamp(c.startedAt),
      c.durationSec ?? '',
      `${c.contact.firstName} ${c.contact.lastName}`,
      c.account.name,
      c.outcome ?? 'not marked',
      c.record?.sentiment ?? c.sentiment ?? '',
      c.record?.hook ?? '',
      c.record === null ? '' : parseList<string>(c.record.summary).join('\n'),
      c.record === null ? '' : parseList<{ saidAs?: string }>(c.record.objections).map((o) => o.saidAs ?? '').filter(Boolean).join('\n'),
      c.playbookVersion ?? '',
      parseList(c.defects).length,
      c.recordingUrl ?? '',
      c.transcriptUrl ?? ''
    ])
  );

  /* Contacts --------------------------------------------------------- */
  addTable(
    workbook.addWorksheet('Contacts'),
    [
      { header: 'Name', width: 22 },
      { header: 'Title', width: 28 },
      { header: 'Company', width: 22 },
      { header: 'Status', width: 12 },
      { header: 'Suppressed', width: 16 },
      { header: 'Kind', width: 10 },
      { header: 'Phone', width: 16 },
      { header: 'Line', width: 12 },
      { header: 'Email', width: 30 },
      { header: 'Email source', width: 18 },
      { header: 'ICP score', width: 10 },
      { header: 'Calls', width: 7 },
      { header: 'Source', width: 12 },
      { header: 'Lawful basis', width: 40 }
    ],
    contacts.map((c) => {
      const email = bestEmail(c.emails.map((e) => ({ address: e.address, kind: e.kind, verified: e.verified })));
      return [
        `${c.firstName} ${c.lastName}`,
        c.title,
        c.account.name,
        c.status,
        suppressionOf(c),
        c.kind,
        c.phoneE164 ?? '',
        c.phoneLine ?? '',
        email?.address ?? '',
        email?.source ?? '',
        c.icpScore,
        calls.filter((call) => call.contactId === c.id).length,
        c.source,
        c.lawfulBasis
      ];
    })
  );

  /* Accounts --------------------------------------------------------- */
  addTable(
    workbook.addWorksheet('Accounts'),
    [
      { header: 'Account', width: 26 },
      { header: 'Domain', width: 26 },
      { header: 'Country', width: 9 },
      { header: 'Industry', width: 22 },
      { header: 'Priority', width: 9 },
      { header: 'Status', width: 12 },
      { header: 'Suppressed', width: 12 },
      { header: 'Contacts', width: 9 },
      { header: 'Calls', width: 7 },
      { header: 'Last call (Sydney)', width: 18 },
      { header: 'Last outcome', width: 20 },
      { header: 'Notes', width: 50 }
    ],
    accounts.map((a) => {
      const theirCalls = calls.filter((c) => c.accountId === a.id);
      const last = theirCalls[0];
      return [
        a.name,
        a.domain,
        a.country,
        a.industry,
        a.priority,
        a.status,
        (suppressedKeys.get(a.id) ?? []).length > 0 ? 'yes' : '',
        contacts.filter((c) => c.accountId === a.id).length,
        theirCalls.length,
        stamp(last?.startedAt),
        last?.outcome ?? '',
        a.notes
      ];
    })
  );

  return {
    workbook,
    counts: { meetingRequests: requests.length, calls: calls.length, contacts: contacts.length, accounts: accounts.length }
  };
}

/**
 * Build the workbook and put it at `path`, atomically.
 *
 * Returns what went in, so the caller can log "synced 3 requests, 12 calls".
 */
export async function syncWorkbook(db: Blackboard, path: string, now: Date): Promise<WorkbookCounts> {
  const { workbook, counts } = await buildWorkbook(db, now);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    await workbook.xlsx.writeFile(temporary);
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return counts;
}
