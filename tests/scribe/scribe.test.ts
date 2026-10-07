/**
 * Scribe against a real database.
 *
 * The design promise worth testing hardest is the failure one: the summariser
 * is the only part that needs a model, so it is the part that can break, and
 * when it does everything else must still be written and nothing may be
 * invented in its place.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createTestBlackboard, type Blackboard } from '../../src/blackboard/client.js';
import {
  MAX_SUMMARY_LINES,
  scribeCall,
  summaryPrompt,
  type ScribeInput,
  type ScribeModel
} from '../../src/agents/scribe/scribe.js';
import type { TranscriptTurn } from '../../src/agents/guardian/audit.js';
import { seedCall, type Seeded } from '../support/seed.js';

const ENDED = new Date('2026-10-07T02:01:30.000Z');
const NOW = new Date('2026-10-07T02:02:00.000Z');

const transcript: TranscriptTurn[] = [
  { speaker: 'lexi', text: "Hi, my name's Lexi. I'm an AI assistant, not a person.", atSecond: 0 },
  { speaker: 'prospect', text: "Okay. We're mid-way through a platform rebuild actually.", atSecond: 12 },
  { speaker: 'lexi', text: 'Would a couple of windows suit?', atSecond: 40 },
  { speaker: 'prospect', text: 'Tuesday morning is fine. priya@kiwibank.co.nz', atSecond: 52 }
];

const goodSummary = {
  summary: ['Mid-way through a platform rebuild.', 'Offered Tuesday morning.', 'Gave a work email.'],
  hook: 'platform rebuild',
  sentiment: 'positive',
  sentimentTrace: [
    { atSecond: 0, sentiment: 'neutral' },
    { atSecond: 52, sentiment: 'positive' }
  ],
  attentionLostAtSec: null
};

const model = (reply: unknown): ScribeModel => ({ summarise: async () => reply });
const throwing: ScribeModel = {
  summarise: async () => {
    throw new Error('rate limited');
  }
};

const windowCall = {
  name: 'capture_preferred_times',
  value: {
    slots: [{ saidAs: 'Tuesday morning', startsAt: '2026-10-13T09:00:00+13:00', endsAt: '2026-10-13T12:00:00+13:00' }],
    timezone: 'Pacific/Auckland',
    attendees: ['our head of architecture']
  }
};
const emailCall = (confidence = 'read-back-confirmed') => ({
  name: 'capture_email',
  value: { email: 'priya@kiwibank.co.nz', confidence }
});
const markCall = (outcome: string) => ({ name: 'mark_outcome', value: { outcome, note: '' } });
const objectionCall = {
  name: 'log_objection',
  value: { kind: 'has-a-partner', saidAs: 'We already have a partner.', handledAs: 'Did not compete on it.' }
};

let dbs: Blackboard[] = [];
afterEach(async () => {
  for (const db of dbs) await db.$disconnect();
  dbs = [];
});

async function setup(options: Parameters<typeof seedCall>[1] = {}): Promise<{ db: Blackboard; seeded: Seeded }> {
  const db = await createTestBlackboard();
  dbs.push(db);
  const seeded = await seedCall(db, { outcome: null, ...options });
  return { db, seeded };
}

function input(seeded: Seeded, over: Partial<ScribeInput> = {}): ScribeInput {
  return {
    callId: seeded.callId,
    endedAt: ENDED,
    durationSec: 90,
    transcript,
    toolCalls: [emailCall(), windowCall, objectionCall, markCall('meeting_requested')],
    turnDefects: [],
    audit: [],
    ...over
  };
}

describe('writing down an interested call', () => {
  it('records the outcome, summary, objections, times and email', async () => {
    const { db, seeded } = await setup();
    const result = await scribeCall({ db, model: model(goodSummary), now: () => NOW }, input(seeded));

    expect(result.outcome).toBe('meeting_requested');
    expect(result.summary).toEqual(goodSummary.summary);
    expect(result.summarySource).toBe('model');
    expect(result.windows).toHaveLength(1);
    expect(result.timezone).toBe('Pacific/Auckland');
    expect(result.attendees).toEqual(['our head of architecture']);
    expect(result.objections).toEqual([{ saidAs: 'We already have a partner.', handledAs: 'Did not compete on it.' }]);
    expect(result.email).toEqual({ address: 'priya@kiwibank.co.nz', source: 'confirmed_on_call' });
  });

  it('puts the outcome and sentiment on the call itself', async () => {
    const { db, seeded } = await setup();
    await scribeCall({ db, model: model(goodSummary), now: () => NOW }, input(seeded));
    const call = await db.call.findUniqueOrThrow({ where: { id: seeded.callId } });
    expect(call.outcome).toBe('meeting_requested');
    expect(call.sentiment).toBe('positive');
    expect(call.durationSec).toBe(90);
  });

  it('stores the captured address as confirmed on the call, which beats the data provider', async () => {
    const { db, seeded } = await setup();
    await db.contactEmail.create({
      data: { id: 'apollo-1', contactId: seeded.contactId, address: 'p.raman@kiwibank.co.nz', kind: 'apollo_work' }
    });
    const result = await scribeCall({ db, model: model(goodSummary), now: () => NOW }, input(seeded));
    expect(result.email?.address).toBe('priya@kiwibank.co.nz');
    expect(result.email?.source).toBe('confirmed_on_call');
  });

  it('labels an address that was only heard once, and mentions the one on file', async () => {
    const { db, seeded } = await setup();
    await db.contactEmail.create({
      data: { id: 'apollo-1', contactId: seeded.contactId, address: 'p.raman@kiwibank.co.nz', kind: 'apollo_work' }
    });
    const result = await scribeCall(
      { db, model: model(goodSummary), now: () => NOW },
      input(seeded, { toolCalls: [emailCall('heard-once'), windowCall, markCall('meeting_requested')] })
    );
    expect(result.email).toEqual({
      address: 'priya@kiwibank.co.nz',
      source: 'heard_once',
      alsoOnFile: 'p.raman@kiwibank.co.nz'
    });
  });

  it('falls back to the data provider’s address when none was captured', async () => {
    const { db, seeded } = await setup();
    await db.contactEmail.create({
      data: { id: 'apollo-1', contactId: seeded.contactId, address: 'p.raman@kiwibank.co.nz', kind: 'apollo_work' }
    });
    const result = await scribeCall(
      { db, model: model(goodSummary), now: () => NOW },
      input(seeded, { toolCalls: [windowCall, markCall('meeting_requested')] })
    );
    expect(result.email?.source).toBe('apollo_work');
  });

  it('keeps a meeting request out of the call plan', async () => {
    const { db, seeded } = await setup();
    await scribeCall({ db, model: model(goodSummary), now: () => NOW }, input(seeded));
    expect((await db.contact.findUniqueOrThrow({ where: { id: seeded.contactId } })).status).toBe('contacted');
  });
});

describe('when the summariser cannot help', () => {
  it('still writes everything else, and says there is no summary rather than inventing one', async () => {
    const { db, seeded } = await setup();
    const result = await scribeCall({ db, model: throwing, now: () => NOW }, input(seeded));

    expect(result.summary).toEqual([]);
    expect(result.summarySource).toBe('unavailable');
    expect(result.sentiment).toBe('unknown');
    // The things that do not need a model are all still there.
    expect(result.outcome).toBe('meeting_requested');
    expect(result.windows).toHaveLength(1);
    expect(result.email?.address).toBe('priya@kiwibank.co.nz');
    expect(result.defects.map((d) => d.kind)).toContain('summary-unavailable');
    expect(result.defects.find((d) => d.kind === 'summary-unavailable')?.detail).toContain('rate limited');
  });

  it('treats a reply that is not a summary as no summary at all', async () => {
    const { db, seeded } = await setup();
    const result = await scribeCall({ db, model: model({ opinion: 'went well' }), now: () => NOW }, input(seeded));
    expect(result.summarySource).toBe('unavailable');
    expect(result.summary).toEqual([]);
  });

  it('rejects a summary with an unknown sentiment rather than guessing what it meant', async () => {
    const { db, seeded } = await setup();
    const result = await scribeCall(
      { db, model: model({ ...goodSummary, sentiment: 'ecstatic' }), now: () => NOW },
      input(seeded)
    );
    expect(result.summarySource).toBe('unavailable');
  });

  it('says so when no summariser is configured at all', async () => {
    const { db, seeded } = await setup();
    const result = await scribeCall({ db, now: () => NOW }, input(seeded));
    expect(result.defects.find((d) => d.kind === 'summary-unavailable')?.detail).toContain('no summariser');
  });

  it('says so when there is nothing to summarise', async () => {
    const { db, seeded } = await setup();
    const result = await scribeCall({ db, model: model(goodSummary), now: () => NOW }, input(seeded, { transcript: [] }));
    expect(result.summarySource).toBe('unavailable');
    expect(result.defects.find((d) => d.kind === 'summary-unavailable')?.detail).toContain('no transcript');
  });

  it('cuts a summary to five lines, which is what the email has room for', async () => {
    const { db, seeded } = await setup();
    const long = { ...goodSummary, summary: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] };
    const result = await scribeCall({ db, model: model(long), now: () => NOW }, input(seeded));
    expect(result.summary).toHaveLength(MAX_SUMMARY_LINES);
  });

  it('asks the model to state only what was said', () => {
    const prompt = summaryPrompt(transcript);
    expect(prompt).toContain('State only what was said');
    expect(prompt).toContain('Do not infer');
    expect(prompt).toContain('[12s] PROSPECT:');
  });
});

describe('when the evidence disagrees with itself', () => {
  it('records a refusal as a refusal even though Lexi marked a meeting', async () => {
    const { db, seeded } = await setup();
    const result = await scribeCall(
      { db, model: model(goodSummary), now: () => NOW },
      input(seeded, {
        toolCalls: [
          markCall('meeting_requested'),
          { name: 'suppress_contact', value: { reason: 'asked-not-to-be-called', saidAs: 'take me off your list' } }
        ]
      })
    );
    expect(result.outcome).toBe('do_not_contact');
    expect(result.defects.map((d) => d.kind)).toContain('outcome-contradicted');
    expect((await db.call.findUniqueOrThrow({ where: { id: seeded.callId } })).outcome).toBe('do_not_contact');
    expect((await db.contact.findUniqueOrThrow({ where: { id: seeded.contactId } })).status).toBe('done');
  });

  it('records nothing irreversible when no outcome was marked', async () => {
    const { db, seeded } = await setup();
    const result = await scribeCall(
      { db, model: model(goodSummary), now: () => NOW },
      input(seeded, { toolCalls: [] })
    );
    expect(result.outcome).toBeNull();
    expect(result.defects.map((d) => d.kind)).toContain('outcome-missing');
    expect((await db.call.findUniqueOrThrow({ where: { id: seeded.callId } })).outcome).toBeNull();
    expect((await db.contact.findUniqueOrThrow({ where: { id: seeded.contactId } })).status).toBe('contacted');
  });

  it('flags a meeting request that arrived with no usable time', async () => {
    const { db, seeded } = await setup();
    const result = await scribeCall(
      { db, model: model(goodSummary), now: () => NOW },
      input(seeded, { toolCalls: [emailCall(), markCall('meeting_requested')] })
    );
    expect(result.defects.map((d) => d.kind)).toContain('window-missing');
  });

  it('drops a window the model put in the past and says so', async () => {
    const { db, seeded } = await setup();
    const past = {
      name: 'capture_preferred_times',
      value: {
        slots: [{ saidAs: 'Tuesday', startsAt: '2026-09-29T09:00:00+13:00', endsAt: '2026-09-29T12:00:00+13:00' }],
        timezone: 'Pacific/Auckland'
      }
    };
    const result = await scribeCall(
      { db, model: model(goodSummary), now: () => NOW },
      input(seeded, { toolCalls: [past, markCall('meeting_requested')] })
    );
    expect(result.windows).toEqual([]);
    expect(result.defects.map((d) => d.kind)).toEqual(expect.arrayContaining(['window-in-the-past', 'window-missing']));
  });

  it('ignores a malformed tool call from the journal and records that it did', async () => {
    const { db, seeded } = await setup();
    const result = await scribeCall(
      { db, model: model(goodSummary), now: () => NOW },
      input(seeded, { toolCalls: [{ name: 'capture_email', value: { email: 'not an email' } }, markCall('no_answer')] })
    );
    expect(result.email).toBeNull();
    expect(result.defects.map((d) => d.kind)).toContain('bad-tool-call');
  });
});

describe('defects from the rest of the system', () => {
  it('merges what Guardian found live and what the audit found afterwards', async () => {
    const { db, seeded } = await setup();
    const result = await scribeCall(
      { db, model: model(goodSummary), now: () => NOW },
      input(seeded, {
        turnDefects: [{ kind: 'banned-topic', detail: 'named a competitor', atSecond: 33 }],
        audit: [
          { kind: 'unsupported-claim', detail: '"four other banks" is not in the claim list', certainty: 'likely' },
          { kind: 'disclosure-missing', detail: 'never reached ai-disclosure', certainty: 'certain' }
        ]
      })
    );
    const kinds = result.defects.map((d) => d.kind);
    expect(kinds).toEqual(expect.arrayContaining(['banned-topic', 'unsupported-claim', 'disclosure-missing']));
  });

  it('marks a model’s reading as uncertain in the stored defect', async () => {
    const { db, seeded } = await setup();
    const result = await scribeCall(
      { db, model: model(goodSummary), now: () => NOW },
      input(seeded, {
        audit: [{ kind: 'unsupported-claim', detail: 'a claim', certainty: 'likely' }]
      })
    );
    expect(result.defects.find((d) => d.kind === 'unsupported-claim')?.detail).toContain("a model's reading");
  });

  it('stores the defects on the call', async () => {
    const { db, seeded } = await setup();
    await scribeCall(
      { db, model: model(goodSummary), now: () => NOW },
      input(seeded, { turnDefects: [{ kind: 'banned-topic', detail: 'x', atSecond: 3 }] })
    );
    const stored = JSON.parse((await db.call.findUniqueOrThrow({ where: { id: seeded.callId } })).defects);
    expect(stored).toHaveLength(1);
    expect(stored[0].kind).toBe('banned-topic');
  });
});

describe('running more than once', () => {
  it('leaves one record and one confirmed address, not two', async () => {
    const { db, seeded } = await setup();
    const deps = { db, model: model(goodSummary), now: () => NOW };
    await scribeCall(deps, input(seeded));
    await scribeCall(deps, input(seeded));

    expect(await db.callRecord.count()).toBe(1);
    expect(await db.contactEmail.count({ where: { kind: 'confirmed_on_call' } })).toBe(1);
  });

  it('takes a corrected address on the second run, not the first one forever', async () => {
    const { db, seeded } = await setup();
    const deps = { db, model: model(goodSummary), now: () => NOW };
    await scribeCall(deps, input(seeded, { toolCalls: [emailCall('heard-once'), markCall('no_answer')] }));
    const result = await scribeCall(deps, input(seeded, { toolCalls: [emailCall('read-back-confirmed'), markCall('no_answer')] }));
    expect(result.email?.source).toBe('confirmed_on_call');
  });

  it('never reopens a contact that has already been closed', async () => {
    const { db, seeded } = await setup();
    await db.contact.update({ where: { id: seeded.contactId }, data: { status: 'done' } });
    await scribeCall({ db, model: model(goodSummary), now: () => NOW }, input(seeded));
    expect((await db.contact.findUniqueOrThrow({ where: { id: seeded.contactId } })).status).toBe('done');
  });
});
