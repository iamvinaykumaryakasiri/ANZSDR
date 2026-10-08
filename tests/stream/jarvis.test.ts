/**
 * Jarvis: grounded answers, sources always listed, and nothing that changes state
 * without a separate confirmation.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { Jarvis, type JarvisModel } from '../../src/stream/jarvis.js';
import { claudeJarvisModel } from '../../src/stream/jarvis-model.js';
import { SnapshotService } from '../../src/stream/snapshot.js';
import { addCall, addContact, addMeetingRequest, at, closeWorlds, NOW, world, type World } from './helpers.js';

afterEach(closeWorlds);

function jarvisFor(w: World, extra: { model?: JarvisModel; ttlMs?: number; now?: () => Date } = {}) {
  if (extra.now) w.deps.now = extra.now;
  return new Jarvis(w.deps, new SnapshotService(w.deps), { ...(extra.model ? { model: extra.model } : {}), ...(extra.ttlMs ? { ttlMs: extra.ttlMs } : {}) });
}

/** Everything a command could change, as one comparable value. */
async function state(w: World) {
  return {
    campaigns: await w.db.campaign.findMany({ orderBy: { id: 'asc' }, select: { id: true, status: true } }),
    suppressions: await w.db.suppression.count(),
    contacts: await w.db.contact.findMany({ orderBy: { id: 'asc' }, select: { id: true, status: true } }),
    playbook: await w.db.playbook.findMany({ orderBy: { id: 'asc' }, select: { id: true, status: true, evidence: true } }),
    memory: await w.db.memory.count(),
    trace: await w.db.traceEvent.count(),
    kill: (await w.killStore.read()).active
  };
}

async function seedPlaybook(w: World) {
  const row = (slot: string, version: number, status: string, evidence: object = {}) =>
    w.db.playbook.create({ data: { id: `pb-${slot}-v${version}`, slot, version, status, content: JSON.stringify({ slot, template: `I noticed {{hook}}, take ${version}.` }), rationale: `v${version}`, evidence: JSON.stringify(evidence) } });
  await row('hook', 1, 'retired', { outcome: 'promoted' });
  await row('hook', 2, 'champion');
  await row('hook', 3, 'challenger');
}

describe('questions', () => {
  it('works out cost per meeting from the ledger and the calls, and lists what it read', async () => {
    const w = await world();
    const { callId, contactId } = await addCall(w, { startedAt: at(1, 10), duration: 90, outcome: 'meeting_requested', marks: [['ask', 60]] });
    await addMeetingRequest(w, callId, contactId, 'confirmed');
    await addCall(w, { startedAt: at(0, 10), duration: 80, outcome: 'meeting_requested', marks: [['ask', 60]] });
    await w.db.spendRecord.create({ data: { id: 's1', at: at(1, 12), category: 'llm', usd: 3 } });
    await w.db.spendRecord.create({ data: { id: 's2', at: at(0, 11), category: 'apollo', usd: 1 } });

    const answer = await jarvisFor(w).ask("what's my cost per meeting this month?");
    expect(answer.kind).toBe('answer');
    expect(answer.text).toContain('$4.00');
    expect(answer.text).toContain('2 meeting requests');
    expect(answer.text).toContain('$2.00 per meeting request');
    expect(answer.text).toMatch(/1 has been confirmed.*\$4\.00 per confirmed/);
    expect(answer.sources.length).toBeGreaterThan(0);
    expect(answer.sources.join(' ')).toMatch(/SpendRecord/);
  });

  it('says plainly when there is nothing to divide by', async () => {
    const w = await world();
    const answer = await jarvisFor(w).ask('what is my cost per meeting this month');
    expect(answer.text).toMatch(/no meeting requests/i);
    expect(answer.sources.length).toBeGreaterThan(0);
  });

  it('lists calls that died in the first ten seconds, with the section they died in, and not a ring-out', async () => {
    const w = await world();
    await addCall(w, { startedAt: at(0, 10), duration: 6, outcome: null, marks: [['disclosure', 0]] });
    await addCall(w, { startedAt: at(1, 10), duration: 9, outcome: 'not_interested', marks: [['disclosure', 0]] });
    await addCall(w, { startedAt: at(1, 11), duration: 7, outcome: 'no_answer' });
    await addCall(w, { startedAt: at(1, 12), duration: 70, outcome: 'not_interested' });
    const answer = await jarvisFor(w).ask('show me every call that died in the first ten seconds this week');
    expect(answer.text).toMatch(/^2 calls ended within the first 10 seconds/);
    expect(answer.text).toContain('6 seconds, during the disclosure');
    expect(answer.text).not.toContain('70 seconds');
    expect(answer.sources[0]).toMatch(/Call:/);
  });

  it('explains why an organisation or a person is no longer being called, from the records', async () => {
    const w = await world();
    const { contactId } = await addCall(w, { startedAt: at(2, 10), duration: 50, outcome: 'not_interested' });
    await w.db.suppression.create({ data: { id: 'sp1', scope: 'contact', key: contactId, source: 'not-interested', reason: 'they declined: no further contact' } });
    await w.db.dialAttempt.create({ data: { id: 'att1', contactId, accountId: w.accountId, e164: '+6494960000', at: at(2, 10), hadConversation: true } });
    const answer = await jarvisFor(w).ask('why did we stop calling Kiwibank?');
    expect(answer.kind).toBe('answer');
    expect(answer.text).toContain('suppressed permanently');
    expect(answer.text).toContain('they declined: no further contact');
    expect(answer.text).toContain('1 of 3 attempts used');
    expect(answer.sources.join(' ')).toMatch(/Account Kiwibank/);

    const none = await jarvisFor(w).ask('why did we stop calling Westpac?');
    expect(none.text).toMatch(/cannot find/);
  });

  it('answers which hook is working by market, and does not pass a hook count off as a conversion rate', async () => {
    const w = await world();
    await addCall(w, { startedAt: at(1, 10), duration: 90, outcome: 'meeting_requested', variant: 'hook v3', hook: 'the platform rebuild', marks: [['ask', 60]] });
    await addCall(w, { startedAt: at(1, 11), duration: 80, outcome: 'callback_requested', variant: 'hook v4', hook: 'the hiring', marks: [['ask', 60]] });
    await addCall(w, { startedAt: at(1, 12), duration: 70, outcome: 'not_interested', variant: 'hook v4', marks: [['ask', 60]] });
    const answer = await jarvisFor(w).ask('which hook is working in New Zealand?');
    expect(answer.text).toContain('hook v3: 1 meeting request from 1 real conversation (100%)');
    expect(answer.text).toContain('hook v4: 0 meeting requests from 2 real conversations (0%)');
    expect(answer.text).toContain('not conversion rates');
    expect(answer.text).toContain('treat it as a lead');
    expect((await jarvisFor(w).ask('which hook is working in Australia')).text).toMatch(/No real conversation/);
  });

  it('reads out the calls that got closest, nearest first', async () => {
    const w = await world();
    await addCall(w, { startedAt: at(1, 10), duration: 30, outcome: 'not_interested' });
    await addCall(w, { startedAt: at(1, 11), duration: 85, outcome: 'meeting_requested', marks: [['ask', 60]], summary: ['Open to twenty minutes.'], hook: 'h' });
    await addCall(w, { startedAt: at(1, 12), duration: 66, outcome: 'callback_requested', marks: [['ask', 50]], summary: ['Try Thursday.'], hook: 'h' });
    const answer = await jarvisFor(w).ask('read me the three calls that got closest');
    const lines = answer.text.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^One: .*meeting requested\. Open to twenty minutes\./);
    expect(lines[1]).toMatch(/^Two: .*callback requested/);
  });

  it('says what needs the operator, and what the kill switch is doing', async () => {
    const w = await world();
    const { callId, contactId } = await addCall(w, { startedAt: at(0, 10), duration: 90, outcome: 'meeting_requested', hook: 'x', summary: ['s'], windows: [{ saidAs: 'Tuesday', startsAt: '2026-10-13T09:00:00+13:00', endsAt: '2026-10-13T12:00:00+13:00' }], timezone: 'Pacific/Auckland' });
    await addMeetingRequest(w, callId, contactId, 'requested', 'de00c0d1-0000-4000-8000-000000000001');
    const needs = await jarvisFor(w).ask('what needs me');
    expect(needs.text).toContain('MR-DE00C0D1');
    expect((await jarvisFor(w).ask('is dialling halted?')).text).toMatch(/not halted/);
  });
});

describe('instructions never run until they are confirmed', () => {
  async function commandWorld() {
    const w = await world();
    await seedPlaybook(w);
    const contactId = await addContact(w, { first: 'Priya', last: 'Raman', status: 'contacted' });
    await addCall(w, { contactId, startedAt: at(1, 10), duration: 40, outcome: 'callback_requested' });
    return { w, contactId };
  }

  const cases: Array<{ say: string; changes: (w: World, contactId: string) => Promise<boolean> }> = [
    { say: 'pause the NZ banking campaign', changes: async (w) => (await w.db.campaign.findFirstOrThrow()).status === 'paused' },
    { say: 'suppress Priya Raman', changes: async (w) => (await w.db.suppression.count()) > 0 },
    { say: 'requeue Priya Raman for Thursday', changes: async (w, id) => (await w.db.contact.findUniqueOrThrow({ where: { id } })).status === 'queued' },
    { say: 'roll back to the previous script', changes: async (w) => (await w.db.playbook.findUniqueOrThrow({ where: { id: 'pb-hook-v1' } })).status === 'champion' },
    { say: 'stop all dialling', changes: async (w) => (await w.killStore.read()).active }
  ];

  it.each(cases)('"$say" proposes, changes nothing, and is carried out only by confirm', async ({ say, changes }) => {
    const { w, contactId } = await commandWorld();
    const jarvis = jarvisFor(w);
    const before = await state(w);

    const proposal = await jarvis.ask(say);
    expect(proposal.kind).toBe('needs_confirmation');
    expect(proposal.action?.actionId).toMatch(/^act_/);
    expect(proposal.action?.description.length).toBeGreaterThan(40);
    expect(proposal.text).toContain('Nothing has changed yet');
    expect(await state(w)).toEqual(before);
    expect(await changes(w, contactId)).toBe(false);

    const done = await jarvis.confirm(proposal.action!.actionId);
    expect(done.kind).toBe('done');
    expect(done.sources.length).toBeGreaterThan(0);
    expect(await changes(w, contactId)).toBe(true);
  });

  it('confirming twice does it once', async () => {
    const { w } = await commandWorld();
    const jarvis = jarvisFor(w);
    const proposal = await jarvis.ask('suppress Priya Raman');
    const first = await jarvis.confirm(proposal.action!.actionId);
    const count = await w.db.suppression.count();
    const second = await jarvis.confirm(proposal.action!.actionId);
    expect(second).toEqual(first);
    expect(await w.db.suppression.count()).toBe(count);
    expect(count).toBe(2); // the contact and the number
  });

  it('refuses an id it never issued, and one that has lapsed', async () => {
    const { w } = await commandWorld();
    let clock = NOW.getTime();
    const jarvis = jarvisFor(w, { ttlMs: 60_000, now: () => new Date(clock) });
    expect((await jarvis.confirm('act_made-up')).kind).toBe('refused');

    const proposal = await jarvis.ask('stop all dialling');
    clock += 61_000;
    const late = await jarvis.confirm(proposal.action!.actionId);
    expect(late.kind).toBe('refused');
    expect(late.text).toMatch(/lapsed/);
    expect((await w.killStore.read()).active).toBe(false);
  });

  it('re-checks the world at confirm time: a campaign changed in between is left alone', async () => {
    const { w } = await commandWorld();
    const jarvis = jarvisFor(w);
    const proposal = await jarvis.ask('pause the NZ banking campaign');
    await w.db.campaign.updateMany({ data: { status: 'finished' } });
    const result = await jarvis.confirm(proposal.action!.actionId);
    expect(result.kind).toBe('refused');
    expect((await w.db.campaign.findFirstOrThrow()).status).toBe('finished');
  });

  it('suppress writes the same permanent entries the pipeline does, and closes the contact', async () => {
    const { w, contactId } = await commandWorld();
    const jarvis = jarvisFor(w);
    await jarvis.confirm((await jarvis.ask('suppress Priya Raman')).action!.actionId);
    const rows = await w.db.suppression.findMany({ orderBy: { scope: 'asc' } });
    expect(rows.map((r) => [r.scope, r.source])).toEqual([['contact', 'operator'], ['number', 'operator']]);
    expect(rows[0]?.key).toBe(contactId);
    expect((await w.db.contact.findUniqueOrThrow({ where: { id: contactId } })).status).toBe('done');
    expect(await w.db.auditRecord.count({ where: { kind: 'suppression-added' } })).toBe(2);
  });

  it('rolls back through the playbook store: champion retired as rolled back, the earlier one restored, the challenger stopped', async () => {
    const { w } = await commandWorld();
    const jarvis = jarvisFor(w);
    await jarvis.confirm((await jarvis.ask('roll back to the previous script')).action!.actionId);
    const rows = Object.fromEntries((await w.db.playbook.findMany()).map((r) => [r.version, r]));
    expect(rows[1]?.status).toBe('champion');
    expect(rows[2]?.status).toBe('retired');
    expect(JSON.parse(rows[2]?.evidence ?? '{}').outcome).toBe('rolled_back');
    expect(rows[3]?.status).toBe('retired');
  });

  it('will not requeue someone who is suppressed or who has a meeting waiting', async () => {
    const { w, contactId } = await commandWorld();
    const jarvis = jarvisFor(w);
    await w.db.suppression.create({ data: { id: 'x', scope: 'contact', key: contactId, source: 'operator', reason: 'asked to stop' } });
    const suppressed = await jarvis.ask('requeue Priya Raman for Thursday');
    expect(suppressed.kind).toBe('refused');
    expect(suppressed.text).toMatch(/suppressed/);

    await w.db.suppression.deleteMany();
    const { callId } = await addCall(w, { contactId, startedAt: at(0, 9), duration: 90, outcome: 'meeting_requested' });
    await addMeetingRequest(w, callId, contactId, 'requested');
    expect((await jarvis.ask('requeue Priya Raman for Thursday')).kind).toBe('refused');
  });

  it('does not guess between two people with the same name, or when it does not know who "this contact" is', async () => {
    const w = await world();
    const jarvis = jarvisFor(w);
    expect((await jarvis.ask('suppress this contact')).kind).toBe('refused');
    await addContact(w, { first: 'Sam', last: 'Lee' });
    await addContact(w, { first: 'Sam', last: 'Lee' });
    const ambiguous = await jarvis.ask('suppress Sam Lee');
    expect(ambiguous.kind).toBe('refused');
    expect(ambiguous.text).toMatch(/matches 2 people/);
    expect(await w.db.suppression.count()).toBe(0);
  });

  it('refuses to dial, send, approve a plan, lift a suppression or delete, and never proposes them', async () => {
    const w = await world();
    const jarvis = jarvisFor(w);
    for (const say of ["approve today's plan", 'call Priya now', 'email the prospects', 'unsuppress Priya Raman', 'delete all the calls']) {
      const answer = await jarvis.ask(say);
      expect(answer.kind, say).toBe('refused');
      expect(answer.action).toBeUndefined();
    }
  });

  it('refuses what it does not understand rather than guessing', async () => {
    const w = await world();
    const answer = await jarvisFor(w).ask('make the numbers look better');
    expect(answer.kind).toBe('refused');
    expect(answer.sources).toEqual([]);
  });
});

describe('free text through a model that can only read', () => {
  it('answers from what the model read and lists those reads; the tools it was given can only read', async () => {
    const w = await world();
    await addCall(w, { startedAt: at(0, 10), duration: 50, outcome: 'not_interested' });
    const before = await state(w);
    const seen: string[] = [];
    const model: JarvisModel = {
      async answer({ tools }) {
        seen.push(...tools.map((t) => t.name));
        for (const tool of tools) await tool.run(tool.name === 'get_call' ? { id: 'none' } : tool.name === 'get_spend' ? { period: 'week' } : tool.name === 'find_suppressions' ? { text: 'x' } : {});
        return 'There was one call today.';
      }
    };
    const answer = await jarvisFor(w, { model }).ask('compare Auckland with Wellington');
    expect(answer.kind).toBe('answer');
    expect(answer.text).toBe('There was one call today.');
    expect(answer.sources.length).toBeGreaterThanOrEqual(3);
    expect(seen.sort()).toEqual(['find_suppressions', 'get_call', 'get_snapshot', 'get_spend', 'list_calls']);
    expect(await state(w)).toEqual(before);
  });

  it('refuses an answer nothing was read for, and a model that fails', async () => {
    const w = await world();
    const guessing: JarvisModel = { answer: async () => 'Everything is going brilliantly.' };
    const broken: JarvisModel = { answer: async () => { throw new Error('overloaded'); } };
    expect((await jarvisFor(w, { model: guessing }).ask('compare Auckland with Wellington')).kind).toBe('refused');
    const failed = await jarvisFor(w, { model: broken }).ask('compare Auckland with Wellington');
    expect(failed.kind).toBe('refused');
    expect(failed.text).toContain('overloaded');
  });

  it('never lets free text become an instruction: a command is parsed, not asked of the model', async () => {
    const w = await world();
    let asked = 0;
    const model: JarvisModel = { answer: async () => { asked += 1; return 'done'; } };
    const answer = await jarvisFor(w, { model }).ask('stop all dialling');
    expect(answer.kind).toBe('needs_confirmation');
    expect(asked).toBe(0);
    expect((await w.killStore.read()).active).toBe(false);
  });

  it('runs the tool loop against the Messages API shape, feeding tool results back', async () => {
    const calls: unknown[] = [];
    const client = {
      messages: {
        create: async (params: { messages: unknown[] }) => {
          calls.push(params.messages.length);
          return calls.length === 1
            ? { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'get_snapshot', input: {} }] }
            : { stop_reason: 'end_turn', content: [{ type: 'text', text: 'All quiet.' }] };
        }
      }
    };
    const model = claudeJarvisModel({ client: client as never, model: 'test-model' });
    let ran = 0;
    const text = await model.answer({
      question: 'q',
      system: 's',
      tools: [{ name: 'get_snapshot', description: 'd', inputSchema: { type: 'object' }, run: async () => { ran += 1; return { ok: true }; } }]
    });
    expect(text).toBe('All quiet.');
    expect(ran).toBe(1);
    expect(calls).toEqual([1, 3]);
  });
});
