import { useState } from 'react';
import type { MeetingDecision, MeetingRequestView } from '../contract';
import { api, ApiError } from '../lib/api';
import { plural } from '../lib/format';
import { routeHref } from '../lib/hooks';
import { ago } from '../lib/time';
import { useNow } from '../lib/hooks';
import { useConsole } from '../state/console';
import { useNotice } from '../state/notice';
import { Button, Empty, Failure, SectionHead, Tag } from './ui';

const DECIDED: Record<Exclude<MeetingRequestView['status'], 'pending'>, string> = {
  confirmed: 'Confirmed',
  rescheduled: 'Reschedule asked',
  rejected: 'Rejected and suppressed'
};

const DECISION_DONE: Record<MeetingDecision, string> = {
  CONFIRMED: 'Marked confirmed',
  RESCHEDULE: 'Marked for reschedule',
  REJECT: 'Rejected and suppressed'
};

/**
 * Confirm, reschedule, reject. Confirm and reschedule are one press. Reject
 * permanently suppresses the person, so it takes a second, in place.
 */
export function MeetingActions({ meeting, large = false }: { meeting: MeetingRequestView; large?: boolean }) {
  const { applyMeeting } = useConsole();
  const { notify } = useNotice();
  const [busy, setBusy] = useState<MeetingDecision | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmReject, setConfirmReject] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  if (meeting.status !== 'pending') {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <Tag tone={meeting.status === 'confirmed' ? 'sand' : 'plain'}>{DECIDED[meeting.status]}</Tag>
        {done ? (
          <p role="status" className="text-label text-steel-300">
            {done}. Send your reply from Outlook; the draft is ready.
          </p>
        ) : null}
      </div>
    );
  }

  const send = async (decision: MeetingDecision) => {
    setBusy(decision);
    setError(null);
    try {
      const view = await api.decide(meeting.ref, decision);
      setDone(DECISION_DONE[decision]);
      applyMeeting(view);
      notify(`${DECISION_DONE[decision]}: ${meeting.name}, ${meeting.company}.`);
    } catch (e) {
      setConfirmReject(false);
      setError(e instanceof ApiError && e.status !== 0 ? `That did not save: ${e.message}` : 'That did not save: the server could not be reached.');
    } finally {
      setBusy(null);
    }
  };

  const size = large ? 'min-h-12' : '';

  if (confirmReject) {
    return (
      <div role="alertdialog" aria-label={`Confirm rejecting ${meeting.name}`} className="border-2 border-steel-100 p-3">
        <p className="font-bold text-steel-100">Reject {meeting.name} and suppress them permanently?</p>
        <p className="mt-1 text-label text-steel-300">They will not be contacted again, by any campaign. This cannot be undone.</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button tone="solid" className={size} disabled={busy !== null} onClick={() => void send('REJECT')} autoFocus>
            {busy === 'REJECT' ? 'Rejecting…' : 'Reject and suppress'}
          </Button>
          <Button className={size} onClick={() => setConfirmReject(false)}>
            Keep the request
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="flex flex-wrap gap-2">
        <Button
          tone="sand"
          className={`${size} ${large ? 'w-full' : 'flex-1'}`}
          disabled={busy !== null}
          onClick={() => void send('CONFIRMED')}
          aria-label={`Confirm meeting with ${meeting.name}`}
        >
          {busy === 'CONFIRMED' ? 'Confirming…' : 'Confirm'}
        </Button>
        <Button className={`${size} ${large ? 'flex-1' : ''}`} disabled={busy !== null} onClick={() => void send('RESCHEDULE')} aria-label={`Ask to reschedule with ${meeting.name}`}>
          {busy === 'RESCHEDULE' ? 'Saving…' : 'Reschedule'}
        </Button>
        <Button className={`${size} ${large ? 'flex-1' : ''}`} disabled={busy !== null} onClick={() => setConfirmReject(true)} aria-label={`Reject ${meeting.name}`}>
          Reject
        </Button>
      </div>
      {error ? (
        <div className="mt-2">
          <Failure>{error}</Failure>
        </div>
      ) : null}
    </div>
  );
}

export function WindowLines({ meeting, limit = 1 }: { meeting: MeetingRequestView; limit?: number }) {
  const windows = meeting.windows.slice(0, limit);
  if (windows.length === 0) return <p className="text-body text-steel-300">No time given yet.</p>;
  return (
    <div className="space-y-3">
      {windows.map((w) => (
        <div key={w.startsAt}>
          {w.said ? <p className="speech text-speech text-steel-100">“{w.said}”</p> : null}
          <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-body">
            <dt className="text-steel-300">Their time</dt>
            <dd className="font-semibold text-steel-100">{w.localLabel}</dd>
            <dt className="text-steel-300">Sydney</dt>
            <dd className="font-semibold text-steel-100">{w.sydneyLabel}</dd>
          </dl>
        </div>
      ))}
    </div>
  );
}

export function MeetingRow({ meeting, large = false }: { meeting: MeetingRequestView; large?: boolean }) {
  const now = useNow();
  return (
    <li className="border-t border-slate-500 py-5 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <h3 className="text-strong font-semibold text-steel-100">{meeting.name}</h3>
        <span className="text-label text-steel-300">{ago(meeting.createdAt, now)}</span>
      </div>
      <p className="text-body text-steel-300">
        {meeting.title} at {meeting.company}
      </p>
      <div className="mt-3">
        <WindowLines meeting={meeting} />
      </div>
      {meeting.hookThatWorked && !large ? (
        <p className="mt-3 text-body text-steel-200">
          <span className="font-semibold text-steel-100">What landed.</span> {meeting.hookThatWorked}
        </p>
      ) : null}
      <div className="mt-4">
        <MeetingActions meeting={meeting} large={large} />
      </div>
      {large ? null : (
        <p className="mt-3 text-label">
          <a href={routeHref('meetings', meeting.ref)}>Open the draft reply and full summary</a>
        </p>
      )}
    </li>
  );
}

export function NeedsYou({ large = false }: { large?: boolean }) {
  const { snapshot } = useConsole();
  const now = useNow();
  if (!snapshot) return null;
  const pending = snapshot.needsYou.meetingRequests.filter((m) => m.status === 'pending');
  const esc = snapshot.needsYou.escalations;
  const parts = [
    pending.length > 0 ? plural(pending.length, 'meeting request') : null,
    esc.length > 0 ? plural(esc.length, 'escalation') : null
  ].filter(Boolean);

  return (
    <section aria-labelledby="needs-title">
      <SectionHead title="Needs you" id="needs-title">
        {parts.length > 0 ? parts.join(', ') : null}
      </SectionHead>

      {pending.length === 0 && esc.length === 0 ? <Empty>Nothing is waiting on you.</Empty> : null}

      {esc.length > 0 ? (
        <ul className="mb-6 space-y-4">
          {esc.map((e) => (
            <li key={e.id} className="border-l-4 border-steel-100 bg-ink-800 py-3 pl-4 pr-3">
              <p className="font-bold text-steel-100">Escalation, {e.contact} at {e.company}</p>
              <p className="mt-1 text-body text-steel-200">{e.reason}</p>
              <p className="mt-1 text-label text-steel-300">
                {ago(e.at, now)}. <a href={routeHref('calls')}>Read it in the call log</a>.
              </p>
            </li>
          ))}
        </ul>
      ) : null}

      {pending.length > 0 ? (
        <ul>
          {pending.map((m) => (
            <MeetingRow key={m.ref} meeting={m} large={large} />
          ))}
        </ul>
      ) : null}
    </section>
  );
}
