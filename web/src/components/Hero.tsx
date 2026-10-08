import { useLayoutEffect, useRef, useState } from 'react';
import { SCRIPT_STAGES, type LiveCallView, type QueueItemView, type TranscriptTurnView } from '../contract';
import { gateReasonText, outcomeText, STAGE_LABELS } from '../lib/format';
import { useNow } from '../lib/hooks';
import { clock, dayTimeIn, parseTime, SYDNEY } from '../lib/time';
import { useConsole } from '../state/console';
import { ConfidenceMeter, Lamp, Market } from './ui';

/* ---------------------------------------------------------------- the rundown */

/** The script as a rundown: where the call has been, where it is, what is left. */
export function Rundown({ stage, compact = false }: { stage: LiveCallView['stage']; compact?: boolean }) {
  const current = SCRIPT_STAGES.indexOf(stage);
  if (compact) {
    return (
      <div>
        <div aria-hidden="true" className="flex gap-1">
          {SCRIPT_STAGES.map((s, i) => (
            <span key={s} className={`h-1.5 flex-1 ${i < current ? 'bg-steel-300' : i === current ? 'bg-steel-100' : 'bg-slate-500'}`} />
          ))}
        </div>
        <p className="mt-2 text-body text-steel-300">
          Script: <span className="font-bold text-steel-100">{STAGE_LABELS[stage]}</span>, section {current + 1} of {SCRIPT_STAGES.length}
        </p>
      </div>
    );
  }
  return (
    <ol className="grid grid-cols-3 gap-x-1 gap-y-1 tablet:grid-cols-6" aria-label="Script sections">
      {SCRIPT_STAGES.map((s, i) => {
        const state = i < current ? 'past' : i === current ? 'now' : 'next';
        return (
          <li
            key={s}
            aria-current={state === 'now' ? 'step' : undefined}
            className={`border-t-4 px-2 pb-2 pt-2 text-body leading-tight ${
              state === 'now'
                ? 'border-steel-100 bg-steel-100 font-bold text-ink-900'
                : state === 'past'
                  ? 'border-steel-300 text-steel-200'
                  : 'border-slate-500 text-slate-300'
            }`}
          >
            {STAGE_LABELS[s]}
            <span className="sr-only">{state === 'now' ? ' (now)' : state === 'past' ? ' (done)' : ' (to come)'}</span>
          </li>
        );
      })}
    </ol>
  );
}

/* ------------------------------------------------------------------ transcript */

function firstName(full: string): string {
  return full.trim().split(/\s+/)[0] ?? full;
}

export function Transcript({
  turns,
  prospectName,
  limit,
  scroll = true
}: {
  turns: TranscriptTurnView[];
  prospectName: string;
  limit?: number;
  scroll?: boolean;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [stuck, setStuck] = useState(true);
  const shown = limit ? turns.slice(-limit) : turns;

  useLayoutEffect(() => {
    const el = box.current;
    if (el && stuck && scroll) el.scrollTop = el.scrollHeight;
  }, [shown.length, stuck, scroll]);

  const onScroll = () => {
    const el = box.current;
    if (!el) return;
    setStuck(el.scrollHeight - el.scrollTop - el.clientHeight < 48);
  };

  return (
    <div className="relative">
      <div
        ref={box}
        onScroll={onScroll}
        role="log"
        aria-live="polite"
        aria-label="Live transcript"
        tabIndex={scroll ? 0 : undefined}
        className={`${scroll ? 'max-h-[22rem] overflow-y-auto pr-2' : ''} flex flex-col gap-4`}
      >
        {shown.length === 0 ? <p className="py-6 text-body text-steel-300">Waiting for the first words.</p> : null}
        {shown.map((turn, i) => {
          const them = turn.speaker === 'prospect';
          return (
            <div key={`${turn.atSecond}-${i}`} className="grid grid-cols-[2.75rem_1fr] gap-x-3">
              <span className="pt-1 text-label text-slate-300">{clock(turn.atSecond)}</span>
              <div className={them ? 'border-l-2 border-sand-300 pl-4' : ''}>
                <p className="text-label font-semibold text-steel-300">{them ? firstName(prospectName) : 'Lexi'}</p>
                <p className={`speech text-speech ${them ? 'text-steel-100' : 'text-steel-300'}`}>{turn.text}</p>
              </div>
            </div>
          );
        })}
      </div>
      {!stuck && scroll ? (
        <button
          type="button"
          onClick={() => {
            const el = box.current;
            if (el) el.scrollTop = el.scrollHeight;
            setStuck(true);
          }}
          className="absolute bottom-2 right-4 rounded-control border-2 border-steel-100 bg-ink-800 px-3 py-1.5 text-label font-bold text-steel-100"
        >
          Jump to latest
        </button>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------- on air */

function OnAir({ live, receivedAt, entering, compact }: { live: LiveCallView; receivedAt: number; entering: boolean; compact: boolean }) {
  const now = useNow();
  const elapsed = live.elapsedSeconds + Math.max(0, (now - receivedAt) / 1000);

  return (
    <section
      aria-labelledby="hero-title"
      data-entering={entering ? 'true' : undefined}
      className={`relative overflow-hidden bg-ink-800 ${compact ? 'px-4 pb-5 pt-6' : 'px-6 pb-6 pt-8'}`}
    >
      <span aria-hidden="true" className="hero-sweep absolute inset-x-0 top-0 h-[3px] bg-tally" />

      <div className="flex flex-wrap items-start justify-between gap-x-8 gap-y-4">
        <div className="min-w-0">
          <div className="flex items-center gap-4">
            <span className="hero-bloom rounded-lamp">
              <Lamp on size={compact ? 'md' : 'lg'} />
            </span>
            <h2 id="hero-title" className={`${compact ? 'text-statement' : 'text-state'} font-semibold leading-none text-steel-100`}>
              On air
            </h2>
          </div>
        </div>
        <p
          role="timer"
          aria-label={`Call length ${clock(elapsed)}`}
          className={`hero-rise ${compact ? 'text-state' : 'text-clock'} font-semibold leading-none text-steel-100`}
        >
          {clock(elapsed)}
        </p>
      </div>

      <div className="hero-rise mt-5">
        <p className={`${compact ? 'text-strong' : 'text-statement'} font-semibold text-steel-100`}>
          {live.prospect.name} <Market market={live.prospect.market} />
        </p>
        <p className="mt-1 text-body text-steel-300">
          {live.prospect.title} at {live.prospect.company}
        </p>
        {compact ? null : (
          <p className="mt-3 max-w-[70ch] text-body text-steel-200">
            <span className="font-semibold text-steel-100">Hypothesis.</span> {live.hypothesis}
          </p>
        )}
        <dl className="mt-4 flex flex-wrap gap-x-8 gap-y-2 text-body">
          <div className="flex items-center gap-2">
            <dt className="text-steel-300">Script</dt>
            <dd className="font-semibold text-steel-100">{live.variant}</dd>
          </div>
          <div className="flex items-center gap-2">
            <dt className="text-steel-300">Confidence</dt>
            <dd>
              <ConfidenceMeter level={live.confidence} />
            </dd>
          </div>
        </dl>
      </div>

      <div className="hero-rise mt-6">
        <Rundown stage={live.stage} compact={compact} />
      </div>

      <div className="hero-rise mt-6">
        <Transcript turns={live.transcript} prospectName={live.prospect.name} limit={compact ? 3 : undefined} scroll={!compact} />
      </div>
    </section>
  );
}

/* --------------------------------------------------------------- standing by */

function ReasonList({ item }: { item: QueueItemView }) {
  if (item.gate.allowed || item.gate.reasons.length === 0) return null;
  return (
    <ul className="mt-3 space-y-1 border-l-4 border-steel-100 pl-3">
      {item.gate.reasons.map((r) => (
        <li key={r} className="font-bold text-steel-100">
          {gateReasonText(r)}
        </li>
      ))}
    </ul>
  );
}

function StandingBy({ compact }: { compact: boolean }) {
  const { snapshot, lastEnded, serverOffsetMs } = useConsole();
  const now = useNow() + serverOffsetMs;
  if (!snapshot) return null;
  const { next, nextDialAt, note } = snapshot.standingBy;
  const dialAt = parseTime(nextDialAt);
  const remaining = dialAt !== null ? (dialAt - now) / 1000 : null;

  return (
    <section aria-labelledby="hero-title" className={`relative bg-ink-900 ${compact ? 'px-4 pb-5 pt-6' : 'border border-slate-500 px-6 pb-6 pt-8'}`}>
      <div className="flex flex-wrap items-start justify-between gap-x-8 gap-y-4">
        <div className="flex items-center gap-4">
          <Lamp on={false} size={compact ? 'md' : 'lg'} />
          <h2 id="hero-title" className={`${compact ? 'text-statement' : 'text-state'} font-semibold leading-none text-steel-100`}>
            Standing by
          </h2>
        </div>
        {remaining !== null ? (
          <div className={compact ? 'text-left' : 'text-right'}>
            <p className={`${compact ? 'text-state' : 'text-clock'} font-semibold leading-none text-steel-200`}>
              {remaining > 0 ? clock(remaining) : '0:00'}
            </p>
            <p className="mt-2 text-label text-steel-300">
              {remaining > 0 ? `until the next dial, ${dayTimeIn(nextDialAt, SYDNEY)} Sydney` : 'The next dial is due now'}
            </p>
          </div>
        ) : null}
      </div>

      {lastEnded ? (
        <p className="mt-5 text-body text-steel-300">
          Last call, {lastEnded.name} at {lastEnded.company}, ended:{' '}
          <span className="font-semibold text-sand-300">{outcomeText(lastEnded.outcome)}</span>.
        </p>
      ) : null}

      <div className="mt-6">
        {next ? (
          <>
            <p className="text-label text-steel-300">Next number in the queue</p>
            <p className={`mt-1 ${compact ? 'text-strong' : 'text-statement'} font-semibold text-steel-100`}>
              {next.name} <Market market={next.market} />
            </p>
            <p className="mt-1 text-body text-steel-300">
              {next.title} at {next.company}
            </p>
            {compact ? null : (
              <p className="mt-3 max-w-[70ch] text-body text-steel-200">
                <span className="font-semibold text-steel-100">Hypothesis.</span> {next.hypothesis}
              </p>
            )}
            <ReasonList item={next} />
          </>
        ) : (
          <p className="text-body text-steel-200">Nothing is queued. The next tick will look for work.</p>
        )}
        {note ? <p className="mt-4 max-w-[70ch] text-body text-steel-300">{note}</p> : null}
      </div>
    </section>
  );
}

/* ----------------------------------------------------------------- the hero */

export function Hero({ compact = false }: { compact?: boolean }) {
  const { snapshot, liveReceivedAt, enteringCallId } = useConsole();
  const live = snapshot?.live ?? null;
  if (live && liveReceivedAt !== null) {
    return <OnAir key={live.callId} live={live} receivedAt={liveReceivedAt} entering={enteringCallId === live.callId} compact={compact} />;
  }
  return <StandingBy compact={compact} />;
}
