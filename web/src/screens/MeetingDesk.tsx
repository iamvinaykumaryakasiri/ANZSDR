import { useState } from 'react';
import type { MeetingRequestView } from '../contract';
import { MeetingActions, WindowLines } from '../components/Needs';
import { Button, Empty, Tag } from '../components/ui';
import { plural } from '../lib/format';
import { routeHref, useNow, useRoute } from '../lib/hooks';
import { ago } from '../lib/time';
import { useConsole } from '../state/console';

const STATUS_LABEL: Record<MeetingRequestView['status'], string> = {
  pending: 'Waiting for you',
  confirmed: 'Confirmed',
  rescheduled: 'Reschedule asked',
  rejected: 'Rejected'
};

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Clipboard API refused (insecure origin, permissions): fall back to a selection copy.
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

function CopyDraft({ text }: { text: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button
        tone="solid"
        onClick={async () => {
          setState((await copyText(text)) ? 'copied' : 'failed');
          setTimeout(() => setState('idle'), 3000);
        }}
      >
        {state === 'copied' ? 'Copied' : 'Copy the draft'}
      </Button>
      <span role="status" className={`text-label ${state === 'failed' ? 'font-bold text-steel-100' : 'text-steel-300'}`}>
        {state === 'copied' ? 'On your clipboard, ready to paste into Outlook.' : state === 'failed' ? 'Copying was blocked. Select the text below and copy it.' : ''}
      </span>
    </div>
  );
}

function Detail({ m }: { m: MeetingRequestView }) {
  const now = useNow();
  return (
    <article aria-label={`Meeting request from ${m.name}`}>
      <header>
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-statement font-semibold text-steel-100">{m.name}</h2>
          <Tag tone={m.status === 'confirmed' ? 'sand' : m.status === 'pending' ? 'inverse' : 'plain'}>{STATUS_LABEL[m.status]}</Tag>
        </div>
        <p className="mt-1 text-body text-steel-300">
          {m.title} at {m.company}. Asked {ago(m.createdAt, now)}. Reference {m.ref}.
        </p>
        <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-body">
          <dt className="text-steel-300">Phone</dt>
          <dd className="font-semibold">
            <a href={`tel:${m.phone.replace(/[^\d+]/g, '')}`}>{m.phone}</a>
          </dd>
          <dt className="text-steel-300">Email</dt>
          <dd className="font-semibold">{m.email ? <a href={`mailto:${m.email}`}>{m.email}</a> : <span className="text-steel-300">Not captured</span>}</dd>
          <dt className="text-steel-300">LinkedIn</dt>
          <dd className="font-semibold">
            {m.linkedinUrl ? (
              <a href={m.linkedinUrl} target="_blank" rel="noopener noreferrer">
                Open the profile
              </a>
            ) : (
              <span className="text-steel-300">None on file</span>
            )}
          </dd>
        </dl>
      </header>

      <section className="mt-8" aria-labelledby="win-h">
        <h3 id="win-h" className="mb-3 text-body font-semibold text-steel-100">
          When they are free
        </h3>
        <WindowLines meeting={m} limit={m.windows.length || 1} />
        <p className="mt-3 text-body text-steel-300">
          {m.attendees.length > 0 ? `They want on the call: ${m.attendees.join(', ')}.` : 'Nobody else was asked for.'}
        </p>
      </section>

      <section className="mt-8" aria-labelledby="dec-h">
        <h3 id="dec-h" className="mb-3 text-body font-semibold text-steel-100">
          Your answer
        </h3>
        <MeetingActions meeting={m} />
      </section>

      <section className="mt-10" aria-labelledby="draft-h">
        <h3 id="draft-h" className="mb-2 text-body font-semibold text-steel-100">
          Draft reply to {m.name.split(' ')[0]}
        </h3>
        <p className="mb-3 text-label text-steel-300">Sent from your own mailbox, never by the system. Copy it, paste it, send it.</p>
        <CopyDraft text={m.draftReply} />
        <div className="speech mt-3 max-w-[68ch] whitespace-pre-wrap border-l-2 border-slate-400 bg-ink-800 px-5 py-4 text-speech text-steel-100" tabIndex={0} aria-label="Draft reply text">
          {m.draftReply}
        </div>
      </section>

      <section className="mt-10 grid gap-x-10 gap-y-8 broad:grid-cols-2" aria-label="Background to the call">
        <div>
          <h3 className="mb-1 text-body font-semibold text-steel-100">The hypothesis</h3>
          <p className="max-w-[60ch] text-body text-steel-200">{m.hypothesis}</p>
          {m.hookThatWorked ? (
            <>
              <h3 className="mb-1 mt-4 text-body font-semibold text-steel-100">What landed</h3>
              <p className="max-w-[60ch] text-body text-steel-200">{m.hookThatWorked}</p>
            </>
          ) : null}
        </div>
        <div>
          <h3 className="mb-1 text-body font-semibold text-steel-100">What was actually said</h3>
          <ol className="list-decimal space-y-1 pl-5 text-body text-steel-200">
            {m.summary.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ol>
        </div>
        <div>
          <h3 className="mb-1 text-body font-semibold text-steel-100">Objections and how they went</h3>
          {m.objections.length === 0 ? (
            <p className="text-body text-steel-300">None raised.</p>
          ) : (
            <ul className="space-y-1 text-body text-steel-200">
              {m.objections.map((o, i) => (
                <li key={i} className="speech text-speech">
                  “{o}”
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <h3 className="mb-1 text-body font-semibold text-steel-100">The call itself</h3>
          <p className="text-body text-steel-200">
            <a href={routeHref('calls', m.callId)}>Read the transcript and play the recording</a>
          </p>
        </div>
      </section>
    </article>
  );
}

export function MeetingDesk() {
  const { snapshot } = useConsole();
  const route = useRoute();
  if (!snapshot) return null;

  const order: Record<MeetingRequestView['status'], number> = { pending: 0, rescheduled: 1, confirmed: 2, rejected: 3 };
  const all = [...snapshot.needsYou.meetingRequests].sort(
    (a, b) => order[a.status] - order[b.status] || Date.parse(b.createdAt) - Date.parse(a.createdAt)
  );
  const pending = all.filter((m) => m.status === 'pending').length;
  const selected = all.find((m) => m.ref === route.param) ?? (route.param ? undefined : all[0]);
  const showDetailOnly = route.param !== null && selected !== undefined;

  return (
    <div>
      <h1 className="text-statement font-semibold text-steel-100">Meeting desk</h1>
      <p className="mt-1 text-body text-steel-300">
        {pending > 0 ? `${plural(pending, 'request')} waiting for you.` : 'Nothing is waiting for you.'} Replying CONFIRMED, RESCHEDULE or REJECT to the email does the same thing.
      </p>

      {all.length === 0 ? (
        <div className="mt-6">
          <Empty>No meeting requests yet. When Lexi gets someone to name a time, it lands here and in your inbox.</Empty>
        </div>
      ) : (
        <div className="mt-6 grid gap-x-10 gap-y-8 wide:grid-cols-[minmax(0,19rem)_minmax(0,1fr)]">
          <nav aria-label="Meeting requests" className={`${showDetailOnly ? 'hidden wide:block' : ''}`}>
            <ul className="divide-y divide-slate-500 border-y border-slate-500">
              {all.map((m) => {
                const sel = selected?.ref === m.ref;
                return (
                  <li key={m.ref}>
                    <a
                      href={routeHref('meetings', m.ref)}
                      aria-current={sel ? 'true' : undefined}
                      className={`block border-l-4 py-3 pl-3 pr-2 no-underline ${sel ? 'border-steel-100 bg-ink-700' : 'border-transparent'}`}
                    >
                      <span className="block text-body font-semibold text-steel-100">{m.name}</span>
                      <span className="block text-label text-steel-300">{m.company}</span>
                      <span className="mt-1 block text-label text-steel-200">{m.windows[0]?.localLabel ?? 'No time given'}</span>
                      <span className="mt-1 block">
                        <Tag tone={m.status === 'confirmed' ? 'sand' : m.status === 'pending' ? 'inverse' : 'plain'}>{STATUS_LABEL[m.status]}</Tag>
                      </span>
                    </a>
                  </li>
                );
              })}
            </ul>
          </nav>
          <div className="min-w-0">
            {showDetailOnly ? (
              <p className="mb-4 wide:hidden">
                <a href={routeHref('meetings')}>Back to all requests</a>
              </p>
            ) : null}
            {selected ? <Detail key={selected.ref} m={selected} /> : <Empty>That request is not on the desk any more.</Empty>}
          </div>
        </div>
      )}
    </div>
  );
}
