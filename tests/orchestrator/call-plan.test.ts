/**
 * The day's calling is written down, approved by a person, and only then dialled.
 */

import { DateTime } from 'luxon';
import { afterEach, describe, expect, it } from 'vitest';
import { renderPlan } from '../../src/orchestrator/planner.js';
import { harness, prospectTaskSpec, type Harness } from '../support/harness.js';
import type { DialRequest } from '../../src/compliance/types.js';

let open: Harness[] = [];
afterEach(async () => {
  for (const h of open) await h.close();
  open = [];
});

/** Wednesday 12 March 2025, 11:00 Sydney: inside every window, on a signed-off year. */
const GOOD = DateTime.fromISO('2025-03-12T11:00', { zone: 'Australia/Sydney' }).toJSDate();
const TODAY = '2025-03-12';

async function researched(options: { requireDailyPlan?: boolean } = {}): Promise<Harness> {
  const h = await harness({
    now: () => GOOD,
    ...(options.requireDailyPlan !== undefined ? { requireDailyPlan: options.requireDailyPlan } : {})
  });
  open.push(h);
  await h.tasks.create(prospectTaskSpec(h));
  await h.director.tick();
  // Phase 3 supplies numbers from Apollo. Until then, put them on by hand so the
  // plan has something to plan.
  const contacts = await h.db.contact.findMany({ orderBy: { apolloId: 'asc' } });
  for (const [index, contact] of contacts.entries()) {
    await h.db.contact.update({
      where: { id: contact.id },
      data: { phoneE164: `+6128000123${index}`, phoneLine: 'fixed', jurisdiction: 'au-nsw' }
    });
  }
  return h;
}

function dialRequest(h: Harness, contactId: string, accountId: string): DialRequest {
  return {
    requestId: 'r1',
    contactId,
    accountId,
    campaignId: h.campaignId,
    phone: '+61280001230',
    market: 'AU',
    source: 'orchestrator',
    at: GOOD
  };
}

describe('drafting the day', () => {
  it('lists the researched contacts with what the gate already says about each', async () => {
    const h = await researched();
    const plan = await h.planner.draft({ campaignId: h.campaignId });

    expect(plan.planDate).toBe(TODAY);
    expect(plan.status).toBe('draft');
    expect(plan.entries).toHaveLength(2);

    const first = plan.entries[0];
    expect(first?.position).toBe(1);
    expect(first?.displayName).toBe('Priya Raman');
    expect(first?.title).toBe('Chief Data Officer');
    expect(first?.hypothesis).toContain('core banking modernisation');
    expect(first?.gateAllowed).toBe(true);
    expect(first?.earliestAt).not.toBeNull();
  });

  it('puts the best-scoring people first', async () => {
    const h = await researched();
    const plan = await h.planner.draft({ campaignId: h.campaignId });
    expect(plan.entries.map((e) => e.displayName)).toEqual(['Priya Raman', 'Tom Whitcombe']);
  });

  it('shows why an entry is blocked rather than dropping it silently', async () => {
    const h = await researched();
    const contact = await h.db.contact.findFirstOrThrow();
    await h.db.contact.update({ where: { id: contact.id }, data: { phoneE164: '+61412345678', phoneLine: 'mobile' } });

    const plan = await h.planner.draft({ campaignId: h.campaignId });
    const blocked = plan.entries.find((e) => e.contactId === contact.id);
    expect(blocked?.gateAllowed).toBe(false);
    expect(blocked?.gateReasons.map((r) => r.code)).toContain('MOBILE_DIALLING_DISABLED');
  });

  it('supersedes the previous plan for the day rather than losing it', async () => {
    const h = await researched();
    const first = await h.planner.draft({ campaignId: h.campaignId });
    await h.plans.reject(first.id, 'vinay', GOOD, 'wrong accounts');

    const second = await h.planner.draft({ campaignId: h.campaignId });
    expect(second.id).not.toBe(first.id);
    expect((await h.plans.get(first.id))?.status).toBe('superseded');
    expect((await h.plans.get(first.id))?.note).toBe('wrong accounts');
    expect((await h.plans.live(h.campaignId, TODAY))?.id).toBe(second.id);
  });

  it('reads as something a person can approve without opening anything else', async () => {
    const h = await researched();
    const plan = await h.planner.draft({ campaignId: h.campaignId });
    const rendered = renderPlan(plan, 'Australia/Sydney');

    expect(rendered).toContain(`Call plan for ${TODAY}`);
    expect(rendered).toContain('2 contact(s) planned, 2 clear the compliance gate right now');
    expect(rendered).toContain('Priya Raman — Chief Data Officer, Example Bank');
    expect(rendered).toContain('why: ');
  });
});

describe('nothing dials until it is approved', () => {
  it('refuses every contact while the plan is only a draft', async () => {
    const h = await researched({ requireDailyPlan: true });
    const contact = await h.db.contact.findFirstOrThrow();
    await h.planner.draft({ campaignId: h.campaignId });

    const decision = await h.gate.request(dialRequest(h, contact.id, contact.accountId));
    expect(decision.allowed).toBe(false);
    expect(decision.reasons.map((r) => r.code)).toContain('DAY_PLAN_NOT_APPROVED');
    expect(decision.reasons[0]?.detail).toContain('draft');
  });

  it('still refuses once it has only been submitted', async () => {
    const h = await researched({ requireDailyPlan: true });
    const contact = await h.db.contact.findFirstOrThrow();
    const plan = await h.planner.draft({ campaignId: h.campaignId });
    await h.planner.submit(plan.id);

    const decision = await h.gate.request(dialRequest(h, contact.id, contact.accountId));
    expect(decision.reasons[0]?.detail).toContain('pending approval');
  });

  it('allows the people on the list once a person approves it', async () => {
    const h = await researched({ requireDailyPlan: true });
    const contact = await h.db.contact.findFirstOrThrow();
    const plan = await h.planner.draft({ campaignId: h.campaignId });
    await h.planner.submit(plan.id);
    await h.plans.approve(plan.id, 'vinay', GOOD, 'looks right');

    const decision = await h.gate.request(dialRequest(h, contact.id, contact.accountId));
    expect(decision.allowed).toBe(true);

    const approved = await h.plans.get(plan.id);
    expect(approved?.decidedBy).toBe('vinay');
    expect(approved?.note).toBe('looks right');
  });

  it('does not extend that approval to anyone who is not on the list', async () => {
    const h = await researched({ requireDailyPlan: true });
    const contact = await h.db.contact.findFirstOrThrow();
    const plan = await h.planner.draft({ campaignId: h.campaignId });
    await h.plans.approve(plan.id, 'vinay', GOOD);

    const stranger = await h.gate.request(dialRequest(h, 'someone-else', contact.accountId));
    expect(stranger.allowed).toBe(false);
    expect(stranger.reasons[0]?.detail).toContain('someone-else is not one of them');
  });

  it('does not let an approval carry over to the next day', async () => {
    const h = await researched({ requireDailyPlan: true });
    const contact = await h.db.contact.findFirstOrThrow();
    const plan = await h.planner.draft({ campaignId: h.campaignId, planDate: '2025-03-11' });
    await h.plans.approve(plan.id, 'vinay', GOOD);

    const decision = await h.gate.request(dialRequest(h, contact.id, contact.accountId));
    expect(decision.allowed).toBe(false);
    expect(decision.reasons[0]?.detail).toContain('does not carry over');
  });

  it('refuses a rejected plan and says so', async () => {
    const h = await researched({ requireDailyPlan: true });
    const contact = await h.db.contact.findFirstOrThrow();
    const plan = await h.planner.draft({ campaignId: h.campaignId });
    await h.plans.reject(plan.id, 'vinay', GOOD, 'not this week');

    const decision = await h.gate.request(dialRequest(h, contact.id, contact.accountId));
    expect(decision.reasons[0]?.detail).toContain('rejected');
  });

  it('records the refusal in the audit log like any other denial', async () => {
    const h = await researched({ requireDailyPlan: true });
    const contact = await h.db.contact.findFirstOrThrow();
    await h.gate.request(dialRequest(h, contact.id, contact.accountId));

    const records = await h.db.auditRecord.findMany({ where: { kind: 'dial-decision' } });
    expect(records).toHaveLength(1);
    expect(records[0]?.summary).toContain('DAY_PLAN_NOT_APPROVED');
  });
});
