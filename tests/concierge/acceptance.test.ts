/**
 * Phase 6 acceptance (brief section 13):
 *
 *   "a simulated interested call produces a meeting-request email I'd actually
 *    act on without opening anything else, and replying CONFIRMED updates state
 *    correctly."
 *
 * One call goes through the real pipeline - Scribe, the follow-up executor, the
 * mailer, the workbook - against a real database, and then Vinay answers it
 * the way he would from a phone: one word, on top of a wall of quotation.
 *
 * "Without opening anything else" is checked as a list of things he needs to
 * be able to read in the one email, not as a feeling about it.
 */

import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestBlackboard, type Blackboard } from '../../src/blackboard/client.js';
import { PrismaSuppressionStore } from '../../src/blackboard/compliance-stores.js';
import { MeetingRequestRepository } from '../../src/blackboard/meetings.js';
import { loadIdentityFromObject } from '../../src/agents/caller/identity.js';
import { applyOperatorReply } from '../../src/agents/concierge/apply-reply.js';
import { FileMailer } from '../../src/agents/concierge/file-mailer.js';
import { MemoryMailer, MemorySmsSender, operatorOnly } from '../../src/agents/concierge/ports.js';
import { findRef } from '../../src/agents/concierge/ref.js';
import type { ScribeModel } from '../../src/agents/scribe/scribe.js';
import type { TranscriptTurn } from '../../src/agents/guardian/audit.js';
import { processEndedCall, type PostCallDeps } from '../../src/orchestrator/post-call.js';
import { seedCall } from '../support/seed.js';

const VINAY = 'vinay@example.com';
const STARTED = new Date('2026-10-07T02:00:00.000Z');
const ENDED = new Date('2026-10-07T02:01:30.000Z');
const NOW = new Date('2026-10-07T02:02:00.000Z');

const model: ScribeModel = {
  summarise: async () => ({
    summary: [
      'Priya is mid-way through a core platform rebuild.',
      'She was open to twenty minutes with Vinay.',
      'Free Tuesday morning, Auckland time.',
      'Asked who else at Hexaware worked in banking; Lexi said Vinay would cover it.'
    ],
    hook: 'the platform rebuild',
    sentiment: 'positive',
    sentimentTrace: [],
    attentionLostAtSec: null
  })
};

const talk: TranscriptTurn[] = [
  { speaker: 'lexi', text: "Hi, my name's Lexi. I'm an AI assistant, not a person, working with Vinay Kumar at Hexaware.", atSecond: 0 },
  { speaker: 'prospect', text: 'Okay, go on.', atSecond: 14 },
  { speaker: 'lexi', text: 'I saw Kiwibank is rebuilding its core platform. Would twenty minutes with Vinay be useful?', atSecond: 30 },
  { speaker: 'prospect', text: 'Maybe. We are mid-way through it, honestly. Tuesday morning is better for me.', atSecond: 52 },
  { speaker: 'lexi', text: "What's the best email for you?", atSecond: 60 },
  { speaker: 'prospect', text: 'priya at kiwibank dot co dot nz.', atSecond: 70 }
];

const toolCalls = [
  { name: 'capture_email', value: { email: 'priya@kiwibank.co.nz', confidence: 'read-back-confirmed' } },
  {
    name: 'capture_preferred_times',
    value: {
      slots: [{ saidAs: 'Tuesday morning', startsAt: '2026-10-13T09:00:00+13:00', endsAt: '2026-10-13T12:00:00+13:00' }],
      timezone: 'Pacific/Auckland',
      attendees: ['her head of architecture']
    }
  },
  { name: 'log_objection', value: { kind: 'no-time-now', saidAs: 'We are mid-way through it, honestly', handledAs: 'Said it was a permission call, offered twenty minutes later' } },
  { name: 'mark_outcome', value: { outcome: 'meeting_requested', note: '' } }
];

let dbs: Blackboard[] = [];
let dirs: string[] = [];
afterEach(async () => {
  for (const db of dbs) await db.$disconnect();
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  dbs = [];
  dirs = [];
});

async function world() {
  const db = await createTestBlackboard();
  dbs.push(db);
  const dir = await mkdtemp(join(tmpdir(), 'acceptance-'));
  dirs.push(dir);
  const mail = new MemoryMailer();
  const sms = new MemorySmsSender();
  const meetings = new MeetingRequestRepository(db);
  const suppressions = new PrismaSuppressionStore(db);
  const deps: PostCallDeps = {
    scribe: { db, model, now: () => NOW },
    followUp: {
      db,
      meetings,
      suppressions,
      mailer: operatorOnly(mail, [VINAY]),
      sms,
      smsFrom: '+61412000000',
      identity: loadIdentityFromObject({
        agent: { name: 'Lexi', gender: 'female', accent: 'au-neutral' },
        operator: { name: 'Vinay Kumar', title: 'Sales Director', company: 'Hexaware Technologies', team: 'the ANZ sales team', email: VINAY },
        callback: { number: '+61280001234' }
      }),
      killSwitch: { state: async () => ({ active: false }) },
      now: () => NOW
    },
    workbookPath: join(dir, 'crm.xlsx')
  };
  return { db, dir, mail, sms, meetings, suppressions, deps };
}

async function interestedCall(w: Awaited<ReturnType<typeof world>>) {
  const seeded = await seedCall(w.db, { outcome: null, kind: 'prospect', phone: '+64211234567', line: 'mobile', startedAt: STARTED, endedAt: ENDED });
  await w.db.dossier.create({
    data: {
      id: 'd1',
      contactId: seeded.contactId,
      hypothesis: 'Mid-way through a core platform rebuild and likely to want a second view on delivery risk.',
      confidence: 'high',
      person: '{}',
      account: '{}',
      hooks: '[]',
      landmines: '[]',
      unverified: '[]',
      sources: '[]'
    }
  });
  const result = await processEndedCall(w.deps, {
    callId: seeded.callId,
    endedAt: ENDED,
    durationSec: 90,
    transcript: talk,
    toolCalls,
    turnDefects: [],
    audit: []
  });
  return { seeded, result };
}

describe('phase 6 acceptance: an interested call', () => {
  it('produces one email to Vinay that he can act on without opening anything else', async () => {
    const w = await world();
    const { result } = await interestedCall(w);

    expect(result.scribe.outcome).toBe('meeting_requested');
    expect(result.followUp.complete).toBe(true);
    expect(w.mail.sent).toHaveLength(1);

    const mail = w.mail.sent[0];
    expect(mail?.to).toBe(VINAY);
    // The subject names who, where, and the first window, so it can be triaged from a lock screen.
    expect(mail?.subject).toBe('[MEETING REQUEST] Priya Raman — Kiwibank — Tuesday 13 October, 09:00 NZDT');

    const body = mail?.body ?? '';
    // Who: enough to ring or write to her.
    for (const needle of ['Priya Raman', 'Head of Data', 'Kiwibank', '+64211234567', 'priya@kiwibank.co.nz']) {
      expect(body, `who: ${needle}`).toContain(needle);
    }
    // When: both clocks, so he does not have to convert.
    expect(body).toContain('NZDT');
    expect(body).toContain('Sydney');
    expect(body).toContain('"Tuesday morning"');
    // Who else should be on it.
    expect(body).toContain('her head of architecture');
    // Why this person, and what worked.
    expect(body).toContain('platform rebuild');
    // What was actually said, and what she pushed back on.
    expect(body).toContain('mid-way through a core platform rebuild');
    expect(body).toContain('We are mid-way through it, honestly');
    // How to answer it, and the draft to send her.
    for (const word of ['CONFIRMED', 'RESCHEDULE', 'REJECT']) expect(body).toContain(word);
    expect(body).toContain('copy from the next line');
    expect(body).toContain('Hi Priya,');
    // The invite, tentative, for the top window only.
    expect(mail?.attachments).toHaveLength(1);
    expect(mail?.attachments[0]?.filename).toMatch(/\.ics$/);
    expect(mail?.attachments[0]?.content).toContain('STATUS:TENTATIVE');

    // Nothing in it states a time as booked.
    expect(body).not.toMatch(/\b(is booked|has been booked|is confirmed for|see you (on|at))\b/i);
    // Nothing went to a prospect: one email, and it was to him.
    expect(w.mail.sent.every((m) => m.to === VINAY)).toBe(true);
  });

  it('texts her once, promising only an email from Vinay today, identifying as an AI, and offering STOP', async () => {
    const w = await world();
    await interestedCall(w);
    expect(w.sms.sent).toHaveLength(1);
    const text = w.sms.sent[0]?.body ?? '';
    expect(text).toContain('Lexi');
    expect(text).toMatch(/\bAI\b/);
    expect(text).toContain('email you today');
    expect(text).toContain('STOP');
    expect(text).not.toMatch(/\b\d{1,2}(:\d{2})?\s?(am|pm)\b/i);
  });

  it('records the call, the request and the contact in the CRM workbook', async () => {
    const w = await world();
    const { result } = await interestedCall(w);
    expect(result.workbook).toMatchObject({ status: 'synced', counts: { meetingRequests: 1, calls: 1 } });

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(join(w.dir, 'crm.xlsx'));
    const requests = workbook.getWorksheet('Meeting requests');
    expect(requests?.getRow(2).getCell(1).value).toBe('requested');
    expect(requests?.getRow(2).getCell(3).value).toBe('Priya Raman');
  });

  it('is safe to run twice: a replayed end-of-call webhook sends nothing more', async () => {
    const w = await world();
    const { seeded } = await interestedCall(w);
    const again = await processEndedCall(w.deps, {
      callId: seeded.callId,
      endedAt: ENDED,
      durationSec: 90,
      transcript: talk,
      toolCalls,
      turnDefects: [],
      audit: []
    });
    expect(again.followUp.alreadyRun).toBe(true);
    expect(w.mail.sent).toHaveLength(1);
    expect(w.sms.sent).toHaveLength(1);
    expect(await w.db.meetingRequest.count()).toBe(1);
  });
});

describe('phase 6 acceptance: replying CONFIRMED', () => {
  /** What a phone sends: the word, a signature, and the whole original quoted underneath. */
  const fromAPhone = (word: string, original: string) =>
    `${word}\n\nSent from my iPhone\n\nOn Wed, 7 Oct 2026 at 1:02 pm, ANZ Voice SDR <noreply@example.com> wrote:\n${original
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n')}`;

  async function answered(word: string) {
    const w = await world();
    const { seeded } = await interestedCall(w);
    const reply = fromAPhone(word, w.mail.sent[0]?.body ?? '');
    const applied = await applyOperatorReply(
      { db: w.db, meetings: w.meetings, suppressions: w.suppressions, now: () => new Date(NOW.getTime() + 3_600_000) },
      reply
    );
    const request = await w.db.meetingRequest.findFirstOrThrow();
    return { w, seeded, applied, request };
  }

  it('marks the request confirmed and leaves the contact callable by nobody it should not', async () => {
    const { applied, request, w, seeded } = await answered('CONFIRMED');
    expect(applied.kind).toBe('applied');
    expect(request.status).toBe('confirmed');
    expect(request.decidedVia).toBe('email-reply');
    expect(request.decidedAt).not.toBeNull();
    // Confirming is not suppressing: she is not on the list.
    expect(await w.suppressions.list()).toEqual([]);
    expect((await w.db.contact.findUniqueOrThrow({ where: { id: seeded.contactId } })).status).not.toBe('queued');
  });

  it('is not nudged once confirmed', async () => {
    const { w } = await answered('CONFIRMED');
    const due = await w.meetings.dueForNudge(new Date(NOW.getTime() + 3 * 86_400_000));
    expect(due).toEqual([]);
  });

  it('a later REJECT cannot undo a confirmed meeting', async () => {
    const { w, request } = await answered('CONFIRMED');
    const second = await applyOperatorReply(
      { db: w.db, meetings: w.meetings, suppressions: w.suppressions, now: () => NOW },
      `REJECT\n\n${findRef(w.mail.sent[0]?.body ?? '')}`
    );
    expect(second.kind).toBe('not-applied');
    expect((await w.meetings.find(request.id))?.status).toBe('confirmed');
    expect(await w.suppressions.list()).toEqual([]);
  });

  it('REJECT suppresses her permanently, and says what it did', async () => {
    const { applied, w } = await answered('REJECT');
    expect(applied.kind).toBe('applied');
    expect((await w.suppressions.list()).map((e) => e.scope).sort()).toEqual(['contact', 'number']);
  });

  it('RESCHEDULE keeps it open and stops the reminder', async () => {
    const { request, w } = await answered('RESCHEDULE');
    expect(request.status).toBe('reschedule');
    expect(await w.meetings.dueForNudge(new Date(NOW.getTime() + 3 * 86_400_000))).toEqual([]);
  });

  it('does nothing on a reply it cannot read, rather than guessing', async () => {
    const { applied, request } = await answered('sounds good, thanks');
    expect(applied.kind).toBe('unclear');
    expect(request.status).toBe('requested');
  });
});

describe('phase 6 acceptance: the email as a file', () => {
  it('lands as an .eml with the invite attached, so the operator can see how his mail client treats it', async () => {
    const w = await world();
    const out = join(w.dir, 'outbox');
    w.deps.followUp.mailer = operatorOnly(new FileMailer({ dir: out, from: 'noreply@example.com', now: () => NOW, newId: () => 'fixed' }), [VINAY]);
    await interestedCall(w);

    const files = await readdir(out);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/\.eml$/);
    const eml = await readFile(join(out, files[0] as string), 'utf8');
    expect(eml).toContain('To: vinay@example.com');
    expect(eml).toContain('Content-Type: text/calendar');
    expect(eml).toMatch(/Content-Disposition: attachment; filename="?[^"\r\n]+\.ics/);
  });
});
