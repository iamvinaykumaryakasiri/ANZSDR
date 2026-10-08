import { describe, expect, it } from 'vitest';
import { advanceState } from '../../src/voice/call-store.js';
import {
  assessStale,
  classifyEndedReason,
  detectRecordingObjection,
  recordingObjectionResponse,
  type LifecycleLimits
} from '../../src/voice/lifecycle.js';
import { StreamFilter } from '../../src/agents/guardian/stream-filter.js';

describe('a call only moves forward', () => {
  it('advances, and ignores a late or repeated update', () => {
    expect(advanceState(undefined, 'dialling')).toEqual({ state: 'dialling', changed: true });
    expect(advanceState('dialling', 'ringing')).toEqual({ state: 'ringing', changed: true });
    expect(advanceState('ringing', 'in-progress')).toEqual({ state: 'in-progress', changed: true });
    expect(advanceState('in-progress', 'ended')).toEqual({ state: 'ended', changed: true });

    expect(advanceState('in-progress', 'ringing')).toEqual({ state: 'in-progress', changed: false });
    expect(advanceState('in-progress', 'in-progress')).toEqual({ state: 'in-progress', changed: false });
    expect(advanceState('ended', 'in-progress')).toEqual({ state: 'ended', changed: false });
  });
});

describe('why a call ended', () => {
  it('names an outcome only when the provider is certain nobody had a conversation', () => {
    expect(classifyEndedReason('customer-did-not-answer').outcome).toBe('no_answer');
    expect(classifyEndedReason('customer-busy').outcome).toBe('no_answer');
    expect(classifyEndedReason('voicemail').outcome).toBe('voicemail');
    expect(classifyEndedReason('twilio-reported-customer-misdialed').outcome).toBe('invalid_number');
    expect(classifyEndedReason('watchdog:never-connected').outcome).toBe('no_answer');
  });

  it('says nothing about interest from a hang-up, a silence or a timeout', () => {
    for (const reason of ['customer-ended-call', 'assistant-ended-call', 'silence-timed-out', 'exceeded-max-duration', 'watchdog:overran', 'watchdog:report-missing', '']) {
      expect(classifyEndedReason(reason).outcome, reason).toBeNull();
    }
  });

  it('flags provider-side failures as technical', () => {
    for (const reason of ['pipeline-error-openai-llm-failed', 'call.start.error-get-assistant', 'twilio-failed-to-connect-call', 'unknown-error']) {
      expect(classifyEndedReason(reason).technical, reason).toBe(true);
    }
    expect(classifyEndedReason('customer-ended-call').technical).toBe(false);
  });
});

describe('a prospect who objects to being recorded', () => {
  const objects = [
    "I don't want to be recorded",
    "Please don't record this call.",
    'Can you stop the recording?',
    'Turn off the recording please',
    'Switch the recorder off.',
    "I'd rather not be recorded.",
    'No recording please',
    'Without the recording, then.',
    "I'm not comfortable being recorded",
    'I do not consent to this call being recorded',
    'Can we go off the record?',
    'Do you mind not recording this?',
    'I do mind being recorded, actually',
    "Don't record me.",
    'Recorded? No thanks.',
    'STOP RECORDING'
  ];
  const does_not = [
    'Are you recording this?',
    "That's fine, record away.",
    "I don't mind you recording it.",
    "I don't have a problem with it being recorded.",
    "I don't have a record of that meeting",
    'We keep a record of every vendor call',
    'Okay, go on.',
    'Not now, I am in a meeting',
    'No, recording is fine.',
    '',
    'record scores are not my area'
  ];

  it.each(objects)('hears "%s" as an objection', (said) => {
    expect(detectRecordingObjection(said)).toBe(true);
  });

  it.each(does_not)('does not hear "%s" as one', (said) => {
    expect(detectRecordingObjection(said)).toBe(false);
  });
});

describe('what Lexi says to that', () => {
  it('ends the call and says why, when the recording cannot be stopped', () => {
    const r = recordingObjectionResponse(false, "I've stopped the recording, as you asked.");
    expect(r.endCall).toBe(true);
    expect(r.handling).toBe('call-ended');
    // Never claims to have stopped something that is still running.
    expect(r.line).not.toMatch(/stopped the recording/i);
    expect(r.line).toMatch(/can't switch the recording off/);
  });

  it('carries on without recording, when it can be stopped', () => {
    const r = recordingObjectionResponse(true, "I've stopped the recording, as you asked.");
    expect(r).toMatchObject({ endCall: false, handling: 'recording-stopped', line: "I've stopped the recording, as you asked." });
  });

  it('is a line Guardian\'s layer one lets through, because it is the one thing that must always be sayable', () => {
    const filter = new StreamFilter();
    const line = recordingObjectionResponse(false, '').line;
    const step = filter.push(line);
    const end = filter.end();
    expect(step.breach).toBeUndefined();
    expect(end.breach).toBeUndefined();
    expect(step.emit + end.emit).toBe(line);
  });
});

describe('a call nobody is reporting on', () => {
  const limits: LifecycleLimits = { maxCallSeconds: 240, ringTimeoutSeconds: 90, reportGraceSeconds: 180 };
  const T0 = new Date('2026-10-13T02:00:00Z');
  const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

  it('is closed if it never connects', () => {
    expect(assessStale({ startedAt: T0, endedAt: null, metrics: { state: 'ringing' }, now: at(60), limits })).toBeNull();
    const verdict = assessStale({ startedAt: T0, endedAt: null, metrics: { state: 'ringing' }, now: at(95), limits });
    expect(verdict).toMatchObject({ reason: 'never-connected', hangUp: true });
  });

  it('is closed if it runs past the longest call the assistant allows, plus time for the report', () => {
    const metrics = { state: 'in-progress' as const, answeredAt: at(10).toISOString() };
    expect(assessStale({ startedAt: T0, endedAt: null, metrics, now: at(10 + 240 + 100), limits })).toBeNull();
    expect(assessStale({ startedAt: T0, endedAt: null, metrics, now: at(10 + 240 + 181), limits })).toMatchObject({ reason: 'overran', hangUp: true });
  });

  it('is processed anyway if it ended and the report never came', () => {
    const ended = at(100);
    expect(assessStale({ startedAt: T0, endedAt: ended, metrics: { state: 'ended' }, now: at(200), limits })).toBeNull();
    expect(assessStale({ startedAt: T0, endedAt: ended, metrics: { state: 'ended' }, now: at(100 + 181), limits })).toMatchObject({
      reason: 'report-missing',
      hangUp: false
    });
  });

  it('is left alone once it has been processed, or while it is being processed', () => {
    const ended = at(100);
    for (const status of ['done', 'running', 'failed'] as const) {
      expect(
        assessStale({ startedAt: T0, endedAt: ended, metrics: { state: 'ended', pipeline: { status, at: ended.toISOString() } }, now: at(5000), limits })
      ).toBeNull();
    }
  });
});
