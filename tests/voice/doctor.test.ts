/**
 * The preflight must say exactly what is missing, say what the gate would say,
 * and change nothing while doing it.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { formatDoctorReport, runDoctor, type DoctorInput, type ProviderReader } from '../../src/voice/doctor.js';
import { buildVapiAssistant } from '../../src/voice/vapi.js';
import { loadVoiceConfigFromObject } from '../../src/voice/voice-config.js';
import { calendar } from '../support/fixtures.js';
import { CALLER_ID, IDENTITY, TUESDAY, claimIndex, fakeFetch, seedContact, world, type World } from './support.js';

const FULL_ENV = {
  ANTHROPIC_API_KEY: 'a',
  VAPI_API_KEY: 'v',
  VAPI_WEBHOOK_SECRET: 'h',
  VOICE_SHARED_SECRET: 's',
  VAPI_ASSISTANT_ID: 'assistant-1',
  VAPI_PHONE_NUMBER_ID_AU: 'pn-au',
  PUBLIC_BASE_URL: 'https://lexi.example.ngrok.app',
  TWILIO_ACCOUNT_SID: 'AC1',
  TWILIO_AUTH_TOKEN: 't',
  RECORDING_ENCRYPTION_KEY: 'ab'.repeat(32)
};

let worlds: World[] = [];
afterEach(async () => {
  for (const w of worlds) await w.close();
  worlds = [];
});

async function input(overrides: Parameters<typeof world>[0] = {}, env: Record<string, string | undefined> = FULL_ENV, extra: Partial<DoctorInput> = {}) {
  const w = await world(overrides);
  worlds.push(w);
  const seeded = await seedContact(w.db);
  const base: DoctorInput = {
    env,
    policy: w.policy,
    calendar: calendar(),
    identity: IDENTITY,
    voice: loadVoiceConfigFromObject({}),
    claims: claimIndex('Hexaware has offices in Sydney.'),
    db: w.db,
    gate: w.gate,
    now: TUESDAY,
    ...extra
  };
  return { w, seeded, base };
}

const summaries = (r: Awaited<ReturnType<typeof runDoctor>>, status: string) => r.checks.filter((c) => c.status === status).map((c) => c.summary);

describe('on a fresh checkout', () => {
  it('lists what is missing, by name, with what to do', async () => {
    const { base } = await input({ callerIdAu: '', exemptTestContacts: false }, {});
    const report = await runDoctor(base);
    const missing = summaries(report, 'blocker').join('\n');

    for (const name of ['VAPI_API_KEY', 'VAPI_WEBHOOK_SECRET', 'VOICE_SHARED_SECRET', 'VAPI_ASSISTANT_ID', 'PUBLIC_BASE_URL', 'ANTHROPIC_API_KEY', 'VAPI_PHONE_NUMBER_ID']) {
      expect(missing, name).toContain(name);
    }
    expect(missing).toContain('dnc.exempt_test_contacts');
    expect(report.ready).toBe(false);
    for (const c of report.checks.filter((x) => x.status === 'blocker')) expect(c.fix, c.summary).toBeTruthy();
  });

  it('says exactly what the gate would say for the test contact, and how to clear it', async () => {
    const { base } = await input({ callerIdAu: '', exemptTestContacts: false, requireDailyPlan: true }, {});
    const report = await runDoctor(base);

    expect(report.gate).toHaveLength(1);
    const g = report.gate[0];
    expect(g?.allowed).toBe(false);
    const now = g?.now.map((l) => l.code) ?? [];
    expect(now).toEqual(expect.arrayContaining(['CALLER_ID_NOT_CONFIGURED', 'MOBILE_DIALLING_DISABLED', 'DAY_PLAN_NOT_APPROVED']));
    // Settings are separated from things that clear with time or an approval.
    expect(g?.now.find((l) => l.code === 'DAY_PLAN_NOT_APPROVED')?.kind).toBe('waiting');
    expect(g?.now.find((l) => l.code === 'CALLER_ID_NOT_CONFIGURED')?.kind).toBe('blocker');
    expect(g?.afterApproval.map((l) => l.code)).not.toContain('DAY_PLAN_NOT_APPROVED');

    const text = formatDoctorReport(report, TUESDAY);
    expect(text).toContain('REFUSED right now');
    expect(text).toContain('CALLER_ID_NOT_CONFIGURED');
    expect(text).toContain('config/policy.yaml');
    expect(text).toContain('Read-only: no call is placed');
  });

  it('masks the number, and gives the id to pass to voice:testcall', async () => {
    const { base, seeded } = await input();
    const text = formatDoctorReport(await runDoctor(base), TUESDAY);
    expect(text).not.toContain('+61448455510');
    expect(text).toContain(`--contact ${seeded.contactId}`);
  });
});

describe('when everything is in place', () => {
  it('is ready, and the only thing between the gate and a dial is approving the plan', async () => {
    const { base } = await input({ requireDailyPlan: true });
    const report = await runDoctor(base);

    expect(summaries(report, 'blocker')).toEqual([]);
    expect(report.ready).toBe(true);
    expect(report.gate[0]?.allowed).toBe(false);
    expect(report.gate[0]?.now.map((l) => l.code)).toEqual(['DAY_PLAN_NOT_APPROVED']);
    expect(report.gate[0]?.afterApproval).toEqual([]);
    expect(formatDoctorReport(report, TUESDAY)).toContain("once today's plan is approved, nothing else would stop this dial");
  });

  it('says ALLOWED when the plan is not required', async () => {
    const { base } = await input({ requireDailyPlan: false });
    const report = await runDoctor(base);
    expect(report.gate[0]?.allowed).toBe(true);
  });

  it('reminds you about the 30 days a caller ID must stay answerable', async () => {
    const { base } = await input();
    const notes = summaries(await runDoctor(base), 'info').join('\n');
    expect(notes).toContain('answerable for at least 30 days');
  });
});

describe('a test contact that the day plan would not list', () => {
  it('is a blocker, because approving the plan would not let the call through', async () => {
    const { w, seeded, base } = await input({ requireDailyPlan: true });
    await w.db.contact.update({ where: { id: seeded.contactId }, data: { status: 'enriched' } });
    const report = await runDoctor(base);
    const blocker = report.checks.find((c) => c.status === 'blocker' && c.summary.includes('would not appear in the day plan'));
    expect(blocker?.fix).toContain(`npm run voice:ready -- --contact ${seeded.contactId}`);
    expect(report.ready).toBe(false);
  });

  it('is fine when no plan is required', async () => {
    const { w, seeded, base } = await input({ requireDailyPlan: false });
    await w.db.contact.update({ where: { id: seeded.contactId }, data: { status: 'enriched' } });
    expect((await runDoctor(base)).ready).toBe(true);
  });
});

describe('the settings that can quietly make it unsafe', () => {
  it('warns when test mode is off', async () => {
    const { base } = await input({ testContactsOnly: false });
    expect(summaries(await runDoctor(base), 'warn').join('\n')).toContain('test_contacts_only is FALSE');
  });

  it('rejects a public address the provider cannot reach', async () => {
    for (const bad of ['http://lexi.example.com', 'https://localhost:8081', 'https://127.0.0.1']) {
      const { base } = await input({}, { ...FULL_ENV, PUBLIC_BASE_URL: bad });
      expect(summaries(await runDoctor(base), 'blocker').join('\n'), bad).toContain('PUBLIC_BASE_URL');
    }
  });

  it('rejects an encryption key that is the wrong size', async () => {
    const { base } = await input({}, { ...FULL_ENV, RECORDING_ENCRYPTION_KEY: 'tooshort' });
    expect(summaries(await runDoctor(base), 'blocker').join('\n')).toContain('RECORDING_ENCRYPTION_KEY');
  });

  it('flags a number set up at the provider but not as the caller ID', async () => {
    const { base } = await input({ callerIdAu: '' });
    expect(summaries(await runDoctor(base), 'blocker').join('\n')).toContain('caller_id.au_number');
  });
});

describe('it changes nothing', () => {
  it('writes no audit record, creates no call, and never touches the network offline', async () => {
    const { w, base } = await input();
    const before = { audit: await w.db.auditRecord.count(), calls: await w.db.call.count(), attempts: await w.db.dialAttempt.count() };
    const fetchImpl = fakeFetch(() => ({ status: 500 }));
    const original = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    try {
      await runDoctor(base);
    } finally {
      globalThis.fetch = original;
    }
    expect(fetchImpl.calls).toEqual([]);
    expect({ audit: await w.db.auditRecord.count(), calls: await w.db.call.count(), attempts: await w.db.dialAttempt.count() }).toEqual(before);
  });
});

describe('with --online', () => {
  const goodAssistant = () => JSON.parse(JSON.stringify(buildVapiAssistant({ config: loadVoiceConfigFromObject({}), publicBaseUrl: FULL_ENV.PUBLIC_BASE_URL, webhookSecret: 'h', llmSecret: 's' }))) as Record<string, unknown>;
  const reader = (assistant: Record<string, unknown>, number: string): ProviderReader => ({
    getAssistant: async () => assistant,
    getPhoneNumber: async () => ({ id: 'pn-au', number })
  });
  const twilioOk = fakeFetch(() => ({ json: { status: 'active' } }));

  it('confirms the deployed assistant is ours and the numbers match', async () => {
    const { base } = await input({}, FULL_ENV, { online: { provider: reader(goodAssistant(), CALLER_ID), fetch: twilioOk } });
    const report = await runDoctor(base);
    expect(summaries(report, 'blocker')).toEqual([]);
    expect(summaries(report, 'ok').join('\n')).toContain('assistant assistant-1 is ours');
    expect(summaries(report, 'ok').join('\n')).toContain('Twilio credentials work');
  });

  it('notices that someone has given the assistant a first message of its own', async () => {
    const drifted = { ...goodAssistant(), firstMessage: 'Hello! How can I help?' };
    const { base } = await input({}, FULL_ENV, { online: { provider: reader(drifted, CALLER_ID), fetch: twilioOk } });
    const blockers = summaries(await runDoctor(base), 'blocker').join('\n');
    expect(blockers).toContain('drifted');
    expect(blockers).toContain('firstMessage');
  });

  it('notices a phone number that is not the configured caller ID', async () => {
    const { base } = await input({}, FULL_ENV, { online: { provider: reader(goodAssistant(), '+61299999999'), fetch: twilioOk } });
    expect(summaries(await runDoctor(base), 'blocker').join('\n')).toContain('+61299999999');
  });

  it('notices Twilio refusing the credentials', async () => {
    const { base } = await input({}, FULL_ENV, { online: { provider: reader(goodAssistant(), CALLER_ID), fetch: fakeFetch(() => ({ status: 401 })) } });
    expect(summaries(await runDoctor(base), 'blocker').join('\n')).toContain('refused the credentials');
  });
});
