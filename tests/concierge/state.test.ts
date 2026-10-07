/**
 * Meeting requests and the reply that changes them.
 *
 * The risk in this module is one specific thing: a REJECT is permanent
 * suppression, so anything that can apply one by accident is the bug. Most of
 * these tests are about the cases where nothing should happen.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createTestBlackboard, type Blackboard } from '../../src/blackboard/client.js';
import { PrismaSuppressionStore } from '../../src/blackboard/compliance-stores.js';
import { MeetingRequestRepository, NUDGE_AFTER_MS, canBeDecided } from '../../src/blackboard/meetings.js';
import { applyOperatorReply } from '../../src/agents/concierge/apply-reply.js';
import { buildMeetingEmail, type MeetingRequest } from '../../src/agents/concierge/meeting-email.js';
import { refFor } from '../../src/agents/concierge/ref.js';
import { seedCall } from '../support/seed.js';

const NOW = new Date('2026-10-07T03:00:00.000Z');

let dbs: Blackboard[] = [];
afterEach(async () => {
  for (const db of dbs) await db.$disconnect();
  dbs = [];
});

async function setup() {
  const db = await createTestBlackboard();
  dbs.push(db);
  const meetings = new MeetingRequestRepository(db);
  const suppressions = new PrismaSuppressionStore(db);
  const deps = { db, meetings, suppressions, now: () => NOW };
  return { db, meetings, suppressions, deps };
}

/** A real request on a real call, with the id its reference is built from. */
async function openRequest(over: Parameters<typeof seedCall>[1] = {}) {
  const ctx = await setup();
  const seeded = await seedCall(ctx.db, over);
  const { record } = await ctx.meetings.create({ callId: seeded.callId, contactId: seeded.contactId }, NOW);
  return { ...ctx, ...seeded, request: record, ref: refFor(record.id) };
}

describe('creating a request', () => {
  it('opens as requested', async () => {
    const { request } = await openRequest();
    expect(request.status).toBe('requested');
    expect(request.emailSentAt).toBeNull();
  });

  it('returns the same request when Scribe runs twice for one call', async () => {
    // A retry or a replayed webhook must not send Vinay the same request twice.
    const { meetings, request, callId, contactId } = await openRequest();
    const again = await meetings.create({ callId, contactId }, NOW);
    expect(again.created).toBe(false);
    expect(again.record.id).toBe(request.id);
  });
});

describe('what may still be changed', () => {
  it('lets a request or a reschedule be decided', () => {
    expect(canBeDecided('requested')).toBe(true);
    expect(canBeDecided('reschedule')).toBe(true);
  });

  it('closes confirmed and rejected for good', () => {
    expect(canBeDecided('confirmed')).toBe(false);
    expect(canBeDecided('rejected')).toBe(false);
  });
});

describe('deciding', () => {
  it('moves requested to confirmed and records who and when', async () => {
    const { meetings, request } = await openRequest();
    const result = await meetings.decide(request.id, 'confirmed', '', 'email-reply', NOW);
    expect(result).toEqual({ applied: true, from: 'requested', to: 'confirmed' });
    const after = await meetings.find(request.id);
    expect(after?.decidedVia).toBe('email-reply');
    expect(after?.decidedAt).toEqual(NOW);
  });

  it('lets a reschedule later become confirmed', async () => {
    const { meetings, request } = await openRequest();
    await meetings.decide(request.id, 'reschedule', 'next week', 'email-reply', NOW);
    expect((await meetings.decide(request.id, 'confirmed', '', 'email-reply', NOW)).applied).toBe(true);
  });

  it('refuses to flip a confirmed meeting into a rejection', async () => {
    // The scenario this exists for: a late or stray reply must not be able to
    // turn a confirmed meeting into a permanent suppression.
    const { meetings, request } = await openRequest();
    await meetings.decide(request.id, 'confirmed', '', 'email-reply', NOW);
    const result = await meetings.decide(request.id, 'rejected', '', 'email-reply', NOW);
    expect(result.applied).toBe(false);
    expect(result.applied === false && result.reason).toContain('cannot change that');
    expect((await meetings.find(request.id))?.status).toBe('confirmed');
  });

  it('refuses to reopen a rejection', async () => {
    const { meetings, request } = await openRequest();
    await meetings.decide(request.id, 'rejected', '', 'email-reply', NOW);
    expect((await meetings.decide(request.id, 'confirmed', '', 'email-reply', NOW)).applied).toBe(false);
  });

  it('treats the same decision twice as a no-op rather than an error', async () => {
    const { meetings, request } = await openRequest();
    await meetings.decide(request.id, 'confirmed', '', 'email-reply', NOW);
    const again = await meetings.decide(request.id, 'confirmed', '', 'email-reply', NOW);
    expect(again.applied).toBe(false);
    expect(again.applied === false && again.noop).toBe(true);
  });

  it('reports an id that does not exist rather than throwing', async () => {
    const { meetings } = await setup();
    const result = await meetings.decide('nope', 'confirmed', '', 'email-reply', NOW);
    expect(result.applied).toBe(false);
  });
});

describe('finding a request by its reference', () => {
  it('finds exactly one', async () => {
    const { meetings, request, ref } = await openRequest();
    const found = await meetings.findByRef(ref);
    expect(found.kind === 'found' && found.record.id).toBe(request.id);
  });

  it('reports no match', async () => {
    const { meetings } = await setup();
    expect((await meetings.findByRef('MR-00000000')).kind).toBe('none');
  });

  it('refuses to pick between two that share a reference', async () => {
    // Eight hex digits is plenty for a few hundred requests and still not a
    // guarantee, and a wrong guess is applied to a real person.
    const { db, meetings } = await setup();
    const a = await seedCall(db);
    const b = await seedCall(db, { campaignId: a.campaignId, accountId: a.accountId });
    await db.meetingRequest.create({ data: { id: 'abcd1234-aaaa', callId: a.callId, contactId: a.contactId, status: 'requested' } });
    await db.meetingRequest.create({ data: { id: 'abcd1234-bbbb', callId: b.callId, contactId: b.contactId, status: 'requested' } });
    const found = await meetings.findByRef('MR-ABCD1234');
    expect(found).toEqual({ kind: 'ambiguous', count: 2 });
  });
});

describe('the 24-hour nudge', () => {
  it('is due once a request has gone a day unanswered', async () => {
    const { meetings, request } = await openRequest();
    await meetings.markEmailSent(request.id, new Date(NOW.getTime() - NUDGE_AFTER_MS));
    expect((await meetings.dueForNudge(NOW)).map((r) => r.id)).toEqual([request.id]);
  });

  it('is not due a moment early', async () => {
    const { meetings, request } = await openRequest();
    await meetings.markEmailSent(request.id, new Date(NOW.getTime() - NUDGE_AFTER_MS + 1));
    expect(await meetings.dueForNudge(NOW)).toEqual([]);
  });

  it('happens once, not every time it is checked', async () => {
    const { meetings, request } = await openRequest();
    await meetings.markEmailSent(request.id, new Date(NOW.getTime() - NUDGE_AFTER_MS * 2));
    await meetings.markNudged(request.id, NOW);
    expect(await meetings.dueForNudge(NOW)).toEqual([]);
  });

  it('never fires for a request that was never emailed', async () => {
    const { meetings } = await openRequest();
    expect(await meetings.dueForNudge(NOW)).toEqual([]);
  });

  it('stops once Vinay has answered', async () => {
    const { meetings, request } = await openRequest();
    await meetings.markEmailSent(request.id, new Date(NOW.getTime() - NUDGE_AFTER_MS * 2));
    await meetings.decide(request.id, 'confirmed', '', 'email-reply', NOW);
    expect(await meetings.dueForNudge(NOW)).toEqual([]);
  });

  it('stops for a reschedule too, because he has answered', async () => {
    const { meetings, request } = await openRequest();
    await meetings.markEmailSent(request.id, new Date(NOW.getTime() - NUDGE_AFTER_MS * 2));
    await meetings.decide(request.id, 'reschedule', 'later', 'email-reply', NOW);
    expect(await meetings.dueForNudge(NOW)).toEqual([]);
  });
});

describe('what needs him', () => {
  it('lists open requests, oldest first, and drops closed ones', async () => {
    const { db, meetings } = await setup();
    const a = await seedCall(db);
    const b = await seedCall(db, { campaignId: a.campaignId, accountId: a.accountId });
    const c = await seedCall(db, { campaignId: a.campaignId, accountId: a.accountId });
    const ra = await meetings.create({ callId: a.callId, contactId: a.contactId }, new Date('2026-10-05T00:00:00Z'));
    await meetings.create({ callId: b.callId, contactId: b.contactId }, new Date('2026-10-06T00:00:00Z'));
    const rc = await meetings.create({ callId: c.callId, contactId: c.contactId }, new Date('2026-10-07T00:00:00Z'));
    await meetings.decide(rc.record.id, 'confirmed', '', 'email-reply', NOW);
    const open = await meetings.open();
    expect(open).toHaveLength(2);
    expect(open[0]?.id).toBe(ra.record.id);
  });
});

/* ------------------------------------------------------------------ */

describe('applying a reply', () => {
  it('CONFIRMED confirms, closes the contact and suppresses nobody', async () => {
    const { deps, ref, request, db, contactId, suppressions } = await openRequest();
    const result = await applyOperatorReply(deps, `CONFIRMED\n\n${ref}`);

    expect(result.kind).toBe('applied');
    expect((await deps.meetings.find(request.id))?.status).toBe('confirmed');
    expect((await db.contact.findUniqueOrThrow({ where: { id: contactId } })).status).toBe('done');
    expect(await suppressions.list()).toEqual([]);
  });

  it('REJECT rejects, closes the contact, and suppresses a prospect by contact and number', async () => {
    const { deps, ref, suppressions, db, contactId } = await openRequest({ kind: 'prospect' });
    const result = await applyOperatorReply(deps, `REJECT\n\n${ref}`);

    expect(result.kind).toBe('applied');
    const rows = await suppressions.list();
    expect(rows.map((r) => r.scope).sort()).toEqual(['contact', 'number']);
    expect(rows.every((r) => r.source === 'operator' && r.permanent)).toBe(true);
    expect((await db.contact.findUniqueOrThrow({ where: { id: contactId } })).status).toBe('done');
  });

  it('REJECT on a test contact suppresses the contact only, so rehearsal does not burn the phone', async () => {
    const { deps, ref, suppressions } = await openRequest({ kind: 'test' });
    await applyOperatorReply(deps, `REJECT\n\n${ref}`);
    expect((await suppressions.list()).map((r) => r.scope)).toEqual(['contact']);
  });

  it('RESCHEDULE keeps it open, keeps his note, and leaves the contact alone', async () => {
    const { deps, ref, request, db, contactId } = await openRequest();
    const result = await applyOperatorReply(deps, `RESCHEDULE — try the following week\n\n${ref}`);

    expect(result.kind).toBe('applied');
    const after = await deps.meetings.find(request.id);
    expect(after?.status).toBe('reschedule');
    expect(after?.decisionNote).toBe('try the following week');
    expect((await db.contact.findUniqueOrThrow({ where: { id: contactId } })).status).toBe('contacted');
  });

  it('refuses a REJECT for a meeting that was already confirmed, and suppresses nobody', async () => {
    // The whole module exists to make this one case safe.
    const { deps, ref, suppressions, request } = await openRequest();
    await applyOperatorReply(deps, `CONFIRMED\n\n${ref}`);
    const result = await applyOperatorReply(deps, `REJECT\n\n${ref}`);

    expect(result.kind).toBe('not-applied');
    expect((await deps.meetings.find(request.id))?.status).toBe('confirmed');
    expect(await suppressions.list()).toEqual([]);
  });

  it('treats a repeated CONFIRMED as a no-op', async () => {
    const { deps, ref } = await openRequest();
    await applyOperatorReply(deps, `CONFIRMED\n\n${ref}`);
    const again = await applyOperatorReply(deps, `CONFIRMED\n\n${ref}`);
    expect(again.kind === 'not-applied' && again.noop).toBe(true);
  });

  it('does nothing without a reference, however clear the word', async () => {
    const { deps, request, suppressions } = await openRequest();
    const result = await applyOperatorReply(deps, 'REJECT');
    expect(result).toEqual({ kind: 'no-reference' });
    expect((await deps.meetings.find(request.id))?.status).toBe('requested');
    expect(await suppressions.list()).toEqual([]);
  });

  it('does nothing for a reference that matches no request', async () => {
    const { deps, suppressions } = await openRequest();
    const result = await applyOperatorReply(deps, 'REJECT MR-00000000');
    expect(result.kind).toBe('unknown-reference');
    expect(await suppressions.list()).toEqual([]);
  });

  it('does nothing for an ambiguous reference, rather than picking one', async () => {
    const { db, deps, suppressions } = await setup();
    const a = await seedCall(db);
    const b = await seedCall(db, { campaignId: a.campaignId, accountId: a.accountId });
    await db.meetingRequest.create({ data: { id: 'beef0000-aaaa', callId: a.callId, contactId: a.contactId, status: 'requested' } });
    await db.meetingRequest.create({ data: { id: 'beef0000-bbbb', callId: b.callId, contactId: b.contactId, status: 'requested' } });
    const result = await applyOperatorReply(deps, 'REJECT MR-BEEF0000');
    expect(result).toEqual({ kind: 'ambiguous-reference', ref: 'MR-BEEF0000', count: 2 });
    expect(await suppressions.list()).toEqual([]);
  });

  it('does nothing when the word is unclear, even with a valid reference', async () => {
    const { deps, ref, request } = await openRequest();
    const result = await applyOperatorReply(deps, `who is this again?\n\n${ref}`);
    expect(result.kind).toBe('unclear');
    expect((await deps.meetings.find(request.id))?.status).toBe('requested');
  });

  it('does not duplicate a suppression that already exists', async () => {
    const { deps, ref, suppressions, contactId } = await openRequest({ kind: 'test' });
    await suppressions.add({ scope: 'contact', key: contactId, source: 'prospect-request', reason: 'asked on the call', createdAt: NOW, permanent: true });
    await applyOperatorReply(deps, `REJECT\n\n${ref}`);
    expect(await suppressions.list()).toHaveLength(1);
  });
});

describe('the whole loop: the real email, replied to from a phone', () => {
  function emailFor(requestId: string): string {
    const request: MeetingRequest = {
      requestId,
      prospect: {
        name: 'Priya Raman',
        firstName: 'Priya',
        title: 'Head of Data',
        company: 'Kiwibank',
        phone: '+6444960000',
        email: 'priya@kiwibank.co.nz',
        emailSource: 'confirmed_on_call'
      },
      windows: [{ saidAs: 'Tuesday morning', startsAt: '2026-10-13T09:00:00+13:00', endsAt: '2026-10-13T09:20:00+13:00' }],
      timezone: 'Pacific/Auckland',
      attendees: [],
      hypothesis: 'A rebuild is under way.',
      hookUsed: '',
      summary: ['Agreed to a call.'],
      objections: [],
      operator: { name: 'Vinay Kumar', firstName: 'Vinay', email: 'vinay@example.com' }
    };
    return buildMeetingEmail(request).body;
  }

  /** What a phone does: your word, a signature, and the whole original quoted. */
  const phoneReply = (word: string, original: string): string =>
    `${word}\n\nSent from my iPhone\n\nOn Wed, 7 Oct 2026 at 14:02, ANZ Voice SDR wrote:\n${original
      .split('\n')
      .map((l) => `> ${l}`)
      .join('\n')}`;

  it('reads CONFIRMED even though the quoted email lists REJECT as an instruction', async () => {
    // The email Vinay replies to contains all three words, plus the reference.
    // Reading the quotation would see REJECT and suppress a prospect who had
    // just agreed to a meeting.
    const { deps, request, suppressions } = await openRequest();
    const reply = phoneReply('CONFIRMED', emailFor(request.id));

    const result = await applyOperatorReply(deps, reply);

    expect(result.kind).toBe('applied');
    expect((await deps.meetings.find(request.id))?.status).toBe('confirmed');
    expect(await suppressions.list()).toEqual([]);
  });

  it('reads REJECT and finds the reference in the quotation', async () => {
    const { deps, request, suppressions } = await openRequest({ kind: 'prospect' });
    const result = await applyOperatorReply(deps, phoneReply('REJECT', emailFor(request.id)));
    expect(result.kind).toBe('applied');
    expect((await suppressions.list()).length).toBeGreaterThan(0);
  });
});
