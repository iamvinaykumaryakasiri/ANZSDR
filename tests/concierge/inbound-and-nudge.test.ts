/**
 * A prospect texting back, and Vinay being nudged once.
 *
 * Both run against a real test database. The mailer is `operatorOnly` in every
 * test, so each one is also a check that nothing here can reach a prospect.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createTestBlackboard, type Blackboard } from '../../src/blackboard/client.js';
import { PrismaSuppressionStore } from '../../src/blackboard/compliance-stores.js';
import { MeetingRequestRepository, NUDGE_AFTER_MS } from '../../src/blackboard/meetings.js';
import { handleInboundSms, type InboundSmsDeps } from '../../src/agents/concierge/inbound-sms.js';
import { buildNudge, runNudges, type NudgeDeps } from '../../src/agents/concierge/nudge.js';
import { applyOperatorReply } from '../../src/agents/concierge/apply-reply.js';
import { MemoryMailer, operatorOnly, type Mailer } from '../../src/agents/concierge/ports.js';
import { findRef } from '../../src/agents/concierge/ref.js';
import { seedCall } from '../support/seed.js';

const VINAY = 'vinay@example.com';
const PHONE = '+61448455510';
const T0 = new Date('2026-10-07T02:03:00.000Z');

let dbs: Blackboard[] = [];
afterEach(async () => {
  for (const db of dbs) await db.$disconnect();
  dbs = [];
});

async function sms(over: Partial<InboundSmsDeps> = {}) {
  const db = await createTestBlackboard();
  dbs.push(db);
  const mail = new MemoryMailer();
  const suppressions = new PrismaSuppressionStore(db);
  const deps: InboundSmsDeps = {
    db,
    suppressions,
    mailer: operatorOnly(mail, [VINAY]),
    operatorEmail: VINAY,
    now: () => T0,
    ...over
  };
  return { db, mail, suppressions, deps };
}

const text = (body: string, sid = 'SM1', from = PHONE) => ({ from, body, messageSid: sid });
const scopes = async (s: PrismaSuppressionStore) => (await s.list()).map((e) => e.scope).sort();

describe('a text that says stop', () => {
  it('suppresses the contact and the number, permanently, and records the opt-out', async () => {
    const w = await sms();
    const seeded = await seedCall(w.db, { kind: 'prospect', phone: PHONE, line: 'mobile' });
    const result = await handleInboundSms(w.deps, text('STOP'));

    expect(result).toMatchObject({ kind: 'opted-out', contacts: 1 });
    expect(await scopes(w.suppressions)).toEqual(['contact', 'number']);
    const entries = await w.suppressions.list();
    expect(entries.every((e) => e.source === 'prospect-request' && e.permanent)).toBe(true);
    const optOut = await w.db.memory.findFirst({ where: { scope: 'contact', key: seeded.contactId, kind: 'sms-opt-out' } });
    expect(optOut).not.toBeNull();
    expect(w.mail.sent).toEqual([]);
  });

  it.each(['please stop texting me', 'Unsubscribe', 'take me off your list', 'do not text me again', 'no more messages'])(
    'honours "%s", which Twilio would not treat as STOP',
    async (said) => {
      const w = await sms();
      await seedCall(w.db, { kind: 'prospect', phone: PHONE, line: 'mobile' });
      const result = await handleInboundSms(w.deps, text(said));
      expect(result.kind).toBe('opted-out');
      expect(await scopes(w.suppressions)).toContain('number');
    }
  );

  it('suppresses a test contact as a contact only, so rehearsing STOP does not burn the phone', async () => {
    const w = await sms();
    await seedCall(w.db, { kind: 'test', phone: PHONE, line: 'mobile' });
    await handleInboundSms(w.deps, text('STOP'));
    expect(await scopes(w.suppressions)).toEqual(['contact']);
  });

  it('is idempotent: a redelivered webhook changes nothing', async () => {
    const w = await sms();
    await seedCall(w.db, { kind: 'prospect', phone: PHONE, line: 'mobile' });
    await handleInboundSms(w.deps, text('STOP'));
    const again = await handleInboundSms(w.deps, text('STOP'));

    expect(again).toMatchObject({ kind: 'opted-out', duplicate: true, suppressed: [] });
    expect(await w.suppressions.list()).toHaveLength(2);
    expect(await w.db.memory.count({ where: { kind: 'sms-opt-out' } })).toBe(1);
  });

  it('still adds a suppression that a half-finished first attempt missed', async () => {
    const w = await sms();
    const seeded = await seedCall(w.db, { kind: 'prospect', phone: PHONE, line: 'mobile' });
    // The first delivery got as far as recording the opt-out and no further.
    await w.db.memory.create({
      data: { id: `sms-opt-out:SM1:${seeded.contactId}`, scope: 'contact', key: seeded.contactId, kind: 'sms-opt-out', summary: '', content: '{}' }
    });
    const result = await handleInboundSms(w.deps, text('STOP'));
    expect(result).toMatchObject({ kind: 'opted-out', suppressed: ['contact', 'number'], duplicate: false });
    expect(await scopes(w.suppressions)).toEqual(['contact', 'number']);
  });

  it('honours a STOP from a number we hold no contact for', async () => {
    const w = await sms();
    const result = await handleInboundSms(w.deps, text('STOP', 'SM9', '+61400000001'));
    expect(result).toMatchObject({ kind: 'opted-out', contacts: 0, suppressed: ['number'] });
    expect((await w.suppressions.list())[0]?.key).toBe('+61400000001');

    const again = await handleInboundSms(w.deps, text('STOP', 'SM9', '+61400000001'));
    expect(again).toMatchObject({ kind: 'opted-out', suppressed: [] });
    expect(await w.suppressions.list()).toHaveLength(1);
  });

  it('suppresses every contact held on the same number', async () => {
    const w = await sms();
    const first = await seedCall(w.db, { kind: 'prospect', phone: PHONE, line: 'mobile' });
    await seedCall(w.db, { kind: 'prospect', phone: PHONE, line: 'mobile', accountId: first.accountId, campaignId: first.campaignId });
    const result = await handleInboundSms(w.deps, text('STOP'));
    expect(result).toMatchObject({ contacts: 2 });
    expect((await w.suppressions.list()).filter((e) => e.scope === 'contact')).toHaveLength(2);
  });
});

describe('a text that is not a stop', () => {
  it('is forwarded to Vinay, and nothing is sent back', async () => {
    const w = await sms();
    await seedCall(w.db, { kind: 'prospect', phone: PHONE, line: 'mobile' });
    const result = await handleInboundSms(w.deps, text('Tuesday at 10 works for me'));

    expect(result).toMatchObject({ kind: 'forwarded', contacts: 1, duplicate: false });
    expect(w.mail.sent).toHaveLength(1);
    expect(w.mail.sent[0]?.to).toBe(VINAY);
    expect(w.mail.sent[0]?.subject).toContain('[SMS REPLY] Priya Raman — Kiwibank');
    expect(w.mail.sent[0]?.body).toContain('Tuesday at 10 works for me');
    expect(w.mail.sent[0]?.body).toContain('Nothing has been sent back');
    expect(await w.suppressions.list()).toEqual([]);
  });

  it('forwards a redelivered message once', async () => {
    const w = await sms();
    await seedCall(w.db, { kind: 'prospect', phone: PHONE, line: 'mobile' });
    await handleInboundSms(w.deps, text('Sounds good', 'SM2'));
    const again = await handleInboundSms(w.deps, text('Sounds good', 'SM2'));
    expect(again).toMatchObject({ kind: 'forwarded', duplicate: true, contacts: 0 });
    expect(w.mail.sent).toHaveLength(1);
  });

  it('forwards two different messages separately', async () => {
    const w = await sms();
    await seedCall(w.db, { kind: 'prospect', phone: PHONE, line: 'mobile' });
    await handleInboundSms(w.deps, text('Sounds good', 'SM2'));
    await handleInboundSms(w.deps, text('Also, who is this?', 'SM3'));
    expect(w.mail.sent).toHaveLength(2);
  });

  it('is sent again if the mail failed, because the reply was not recorded as handled', async () => {
    let up = false;
    const delivered = new MemoryMailer();
    const flaky: Mailer = {
      async send(mail) {
        if (!up) throw new Error('smtp unreachable');
        return delivered.send(mail);
      }
    };
    const w = await sms({ mailer: operatorOnly(flaky, [VINAY]) });
    await seedCall(w.db, { kind: 'prospect', phone: PHONE, line: 'mobile' });

    await expect(handleInboundSms(w.deps, text('Sounds good', 'SM4'))).rejects.toThrow('smtp unreachable');
    up = true;
    const retry = await handleInboundSms(w.deps, text('Sounds good', 'SM4'));
    expect(retry).toMatchObject({ kind: 'forwarded', duplicate: false });
    expect(delivered.sent).toHaveLength(1);
  });

  it('keeps the reply but says it was not forwarded when there is no operator address', async () => {
    const w = await sms({ operatorEmail: '' });
    await seedCall(w.db, { kind: 'prospect', phone: PHONE, line: 'mobile' });
    const result = await handleInboundSms(w.deps, text('Sounds good'));
    expect(result).toMatchObject({ kind: 'recorded' });
    expect(w.mail.sent).toEqual([]);
    expect(await w.db.memory.count({ where: { kind: 'sms-reply' } })).toBe(1);
  });

  it('records a text from an unknown number without emailing anyone', async () => {
    const w = await sms();
    const result = await handleInboundSms(w.deps, text('wrong number', 'SM5', '+61400000002'));
    expect(result).toMatchObject({ kind: 'recorded', contacts: 0 });
    expect(w.mail.sent).toEqual([]);
  });

  it('truncates an enormous message rather than storing or mailing all of it', async () => {
    const w = await sms();
    await seedCall(w.db, { kind: 'prospect', phone: PHONE, line: 'mobile' });
    await handleInboundSms(w.deps, text('x'.repeat(5000), 'SM6'));
    expect((w.mail.sent[0]?.body ?? '').length).toBeLessThan(1500);
  });
});

describe('a text that cannot be attributed', () => {
  it('is rejected when the sender is not an E.164 number', async () => {
    const w = await sms();
    expect(await handleInboundSms(w.deps, text('STOP', 'SM7', '0448455510'))).toMatchObject({ kind: 'rejected' });
    expect(await w.suppressions.list()).toEqual([]);
  });

  it('is rejected without a message id, since a redelivery could not be recognised', async () => {
    const w = await sms();
    expect(await handleInboundSms(w.deps, text('STOP', ' '))).toMatchObject({ kind: 'rejected' });
  });
});

/* ------------------------------------------------------------------ */

async function nudgeWorld(over: Partial<NudgeDeps> = {}) {
  const db = await createTestBlackboard();
  dbs.push(db);
  const mail = new MemoryMailer();
  const meetings = new MeetingRequestRepository(db);
  let clock = T0;
  const deps: NudgeDeps = {
    db,
    meetings,
    mailer: operatorOnly(mail, [VINAY]),
    operatorEmail: VINAY,
    now: () => clock,
    ...over
  };
  const advance = (ms: number) => {
    clock = new Date(clock.getTime() + ms);
  };
  return { db, mail, meetings, deps, advance };
}

async function requested(w: Awaited<ReturnType<typeof nudgeWorld>>, sent = true) {
  const seeded = await seedCall(w.db, { kind: 'prospect', phone: PHONE, line: 'mobile' });
  await w.db.callRecord.create({
    data: {
      id: `rec-${seeded.callId}`,
      callId: seeded.callId,
      windows: JSON.stringify([
        { saidAs: 'Tuesday morning', startsAt: '2026-10-13T09:00:00+13:00', endsAt: '2026-10-13T12:00:00+13:00' }
      ]),
      timezone: 'Pacific/Auckland'
    }
  });
  const { record } = await w.meetings.create({ callId: seeded.callId, contactId: seeded.contactId }, T0);
  if (sent) await w.meetings.markEmailSent(record.id, T0);
  return { seeded, record };
}

describe('the nudge', () => {
  it('does nothing before 24 hours have passed', async () => {
    const w = await nudgeWorld();
    await requested(w);
    w.advance(NUDGE_AFTER_MS - 60_000);
    expect(await runNudges(w.deps)).toEqual([]);
    expect(w.mail.sent).toEqual([]);
  });

  it('sends one reminder after 24 hours, carrying the reference and the window', async () => {
    const w = await nudgeWorld();
    const { record } = await requested(w);
    w.advance(NUDGE_AFTER_MS + 60_000);

    const results = await runNudges(w.deps);
    expect(results).toEqual([expect.objectContaining({ requestId: record.id, status: 'sent' })]);
    const mail = w.mail.sent[0];
    expect(mail?.to).toBe(VINAY);
    expect(mail?.subject).toContain('[REMINDER] [MEETING REQUEST] Priya Raman — Kiwibank');
    expect(mail?.body).toContain('Tuesday morning');
    expect(mail?.body).toContain('only reminder');
    expect(findRef(mail?.body ?? '')).not.toBeNull();
  });

  it('sends it once: later ticks do not nag', async () => {
    const w = await nudgeWorld();
    await requested(w);
    w.advance(NUDGE_AFTER_MS + 60_000);
    await runNudges(w.deps);
    w.advance(NUDGE_AFTER_MS * 3);
    expect(await runNudges(w.deps)).toEqual([]);
    expect(w.mail.sent).toHaveLength(1);
  });

  it('can be answered: replying CONFIRMED to the nudge confirms the request', async () => {
    const w = await nudgeWorld();
    const { record } = await requested(w);
    w.advance(NUDGE_AFTER_MS + 60_000);
    await runNudges(w.deps);

    const quoted = (w.mail.sent[0]?.body ?? '').split('\n').map((l) => `> ${l}`).join('\n');
    const result = await applyOperatorReply(
      {
        meetings: w.meetings,
        suppressions: new PrismaSuppressionStore(w.db),
        db: w.db,
        now: () => new Date(T0.getTime() + NUDGE_AFTER_MS + 120_000)
      },
      `CONFIRMED\n\nOn Wed, Vinay wrote:\n${quoted}`
    );
    expect(result.kind).toBe('applied');
    expect((await w.meetings.find(record.id))?.status).toBe('confirmed');
  });

  it('does not nudge a request that has been answered', async () => {
    const w = await nudgeWorld();
    const { record } = await requested(w);
    await w.meetings.decide(record.id, 'confirmed', '', 'email-reply', T0);
    w.advance(NUDGE_AFTER_MS + 60_000);
    expect(await runNudges(w.deps)).toEqual([]);
  });

  it('does not nudge about an email that never went out', async () => {
    const w = await nudgeWorld();
    await requested(w, false);
    w.advance(NUDGE_AFTER_MS * 2);
    expect(await runNudges(w.deps)).toEqual([]);
  });

  it('leaves the request due when the send fails, and carries on with the others', async () => {
    let calls = 0;
    const delivered = new MemoryMailer();
    const flaky: Mailer = {
      async send(mail) {
        calls += 1;
        if (calls === 1) throw new Error('smtp unreachable');
        return delivered.send(mail);
      }
    };
    const w = await nudgeWorld({ mailer: operatorOnly(flaky, [VINAY]) });
    await requested(w);
    await requested(w);
    w.advance(NUDGE_AFTER_MS + 60_000);

    const results = await runNudges(w.deps);
    expect(results.map((r) => r.status).sort()).toEqual(['failed', 'sent']);
    expect(delivered.sent).toHaveLength(1);

    // The one that failed is still due, so the next tick picks it up.
    const retry = await runNudges(w.deps);
    expect(retry).toHaveLength(1);
    expect(retry[0]?.status).toBe('sent');
    expect(delivered.sent).toHaveLength(2);
  });

  it('says why when there is nowhere to send it, and does not mark it nudged', async () => {
    const w = await nudgeWorld({ operatorEmail: '' });
    const { record } = await requested(w);
    w.advance(NUDGE_AFTER_MS + 60_000);
    const results = await runNudges(w.deps);
    expect(results[0]).toMatchObject({ requestId: record.id, status: 'skipped' });
    expect((await w.meetings.find(record.id))?.nudgedAt).toBeNull();
  });

  it('copes with a call record that has no windows', async () => {
    const w = await nudgeWorld();
    const seeded = await seedCall(w.db, { kind: 'prospect', phone: PHONE, line: 'mobile' });
    const { record } = await w.meetings.create({ callId: seeded.callId, contactId: seeded.contactId }, T0);
    await w.meetings.markEmailSent(record.id, T0);
    w.advance(NUDGE_AFTER_MS + 60_000);
    const mail = await buildNudge(w.deps, (await w.meetings.find(record.id)) as NonNullable<Awaited<ReturnType<typeof w.meetings.find>>>);
    expect(mail.body).not.toContain('THEY SAID THEY ARE FREE');
    expect(mail.body).toContain('MR-');
  });
});
