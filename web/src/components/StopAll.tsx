import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { useTimeout } from '../lib/hooks';
import { timeIn, parseTime, SYDNEY } from '../lib/time';
import { useConsole } from '../state/console';
import { Button } from './ui';

type Phase = 'rest' | 'armed' | 'working';

const ARMED_MS = 8000;

function StopGlyph() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" className="size-4 shrink-0">
      <rect x="2" y="2" width="12" height="12" fill="currentColor" />
    </svg>
  );
}

/**
 * The kill switch. Visible on every screen, never behind a menu, and deliberately
 * not red: red means a call is live. It earns its urgency from size, weight and a
 * fixed place. Two steps, in place: press, then confirm. Resuming is the same
 * shape. Never optimistic: it says "Halting" until the server answers.
 */
export function StopAll({ layout }: { layout: 'bar' | 'dock' }) {
  const { snapshot, applyKill } = useConsole();
  const engaged = snapshot?.killSwitch.engaged ?? false;
  const [phase, setPhase] = useState<Phase>('rest');
  const [error, setError] = useState<string | null>(null);
  const [announce, setAnnounce] = useState('');
  const [arm, disarm] = useTimeout();
  const confirmRef = useRef<HTMLButtonElement>(null);
  const mainRef = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);

  // The switch can trip itself (an auto-trip) or be flipped from another tab.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    disarm();
    setPhase('rest');
    setAnnounce(engaged ? 'All dialling is halted.' : 'Dialling is allowed again.');
  }, [engaged, disarm]);

  useEffect(() => {
    if (phase === 'armed') confirmRef.current?.focus();
    if (phase === 'rest' && returnFocus.current) {
      returnFocus.current = false;
      mainRef.current?.focus();
    }
  }, [phase]);

  const press = () => {
    setError(null);
    setPhase('armed');
    arm(() => {
      returnFocus.current = false;
      setPhase('rest');
    }, ARMED_MS);
  };

  const cancel = () => {
    disarm();
    returnFocus.current = true;
    setPhase('rest');
  };

  const confirm = async () => {
    disarm();
    setPhase('working');
    try {
      const view = await api.kill(!engaged, engaged ? undefined : 'Stopped from the console');
      applyKill(view);
      returnFocus.current = true;
      setPhase('rest');
    } catch (e) {
      returnFocus.current = true;
      setPhase('rest');
      setError(
        e instanceof ApiError && e.status === 401
          ? 'That did not go through: the token was not accepted.'
          : engaged
            ? 'Resume did not go through. Dialling is still halted. Try again.'
            : 'Stop did not go through. Dialling may still be running. Try again, or run npm run kill.'
      );
    }
  };

  const since = parseTime(snapshot?.killSwitch.since);
  const dock = layout === 'dock';

  const restButton = engaged ? (
    <button
      ref={mainRef}
      type="button"
      onClick={press}
      aria-label="Dialling is halted. Press to resume dialling."
      className={`flex items-center gap-3 rounded-control border-2 border-steel-100 bg-steel-100 text-left text-ink-900 ${
        dock ? 'min-h-14 w-full px-5 py-2' : 'min-h-12 px-4 py-1.5'
      }`}
    >
      <StopGlyph />
      <span className="flex flex-col leading-tight">
        <span className="text-strong font-bold">Dialling halted</span>
        <span className="text-label font-medium">{since !== null ? `Since ${timeIn(since, SYDNEY)} Sydney. ` : ''}Press to resume</span>
      </span>
    </button>
  ) : (
    <button
      ref={mainRef}
      type="button"
      onClick={press}
      className={`flex items-center justify-center gap-3 rounded-control border-2 border-steel-100 bg-ink-900 font-bold text-steel-100 hover:bg-ink-700 ${
        dock ? 'min-h-14 w-full px-5 text-strong' : 'min-h-12 px-5 text-strong'
      }`}
    >
      <StopGlyph />
      Stop all
    </button>
  );

  const armedPanel = (
    <div
      role="alertdialog"
      aria-label={engaged ? 'Confirm resuming dialling' : 'Confirm halting all dialling'}
      onKeyDown={(e) => {
        if (e.key === 'Escape') cancel();
      }}
      className={`flex items-center gap-2 border-2 border-steel-100 bg-ink-800 p-1.5 ${
        dock ? 'w-full flex-wrap' : 'absolute right-0 top-1/2 z-50 -translate-y-1/2 whitespace-nowrap'
      }`}
    >
      <p className={`px-2 text-body font-bold text-steel-100 ${dock ? 'basis-full pb-1' : ''}`}>
        {engaged ? 'Resume dialling?' : 'Halt all dialling?'}
      </p>
      <Button tone="solid" className={dock ? 'min-h-14 flex-[2]' : ''} onClick={confirm} ref={confirmRef}>
        {engaged ? 'Resume now' : 'Halt now'}
      </Button>
      <Button tone="outline" className={dock ? 'min-h-14 flex-1' : ''} onClick={cancel}>
        Cancel
      </Button>
    </div>
  );

  return (
    <div role="group" aria-label="Stop all dialling" className={dock ? 'w-full' : 'relative'}>
      <p className="sr-only" role="status" aria-live="polite">
        {announce}
      </p>
      {phase === 'armed' ? (
        // Keep the resting button's footprint so nothing in the bar moves.
        <>
          {dock ? null : <div aria-hidden="true" className="invisible">{restButton}</div>}
          {armedPanel}
        </>
      ) : phase === 'working' ? (
        <button
          type="button"
          disabled
          aria-busy="true"
          className={`flex items-center justify-center gap-3 rounded-control border-2 border-steel-100 bg-ink-700 font-bold text-steel-100 ${
            dock ? 'min-h-14 w-full px-5 text-strong' : 'min-h-12 px-5 text-strong'
          }`}
        >
          {engaged ? 'Resuming…' : 'Halting…'}
        </button>
      ) : (
        restButton
      )}
      {error ? (
        <div
          role="alert"
          className={`border-l-4 border-steel-100 bg-ink-700 p-3 font-bold text-steel-100 ${
            dock ? 'mt-2' : 'absolute right-0 top-full z-50 mt-2 w-80'
          }`}
        >
          {error}
        </div>
      ) : null}
    </div>
  );
}
