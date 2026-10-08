import { useEffect, useState } from 'react';
import { ago, parseTime, secondsIn, SYDNEY, AUCKLAND, timeIn, clock } from '../lib/time';
import { routeHref, useNow, useRoute, type RouteName } from '../lib/hooks';
import { useConsole } from '../state/console';
import { StopAll } from './StopAll';
import { Lamp } from './ui';

/* --------------------------------------------------------- the status strips */

/** Present on every screen whenever the data is seeded sample data. */
export function DemoStrip() {
  const { snapshot } = useConsole();
  if (snapshot?.mode !== 'demo') return null;
  return (
    <div role="note" className="hatch bg-steel-200 px-4 py-1.5 text-label font-bold text-ink-900 phone:px-6">
      Demo data. Every person, call and figure on this page is a sample; nothing here has happened.
    </div>
  );
}

export function HaltedStrip() {
  const { snapshot } = useConsole();
  const kill = snapshot?.killSwitch;
  if (!kill?.engaged) return null;
  const since = parseTime(kill.since);
  return (
    <div role="status" className="bg-steel-100 px-4 py-2 text-body font-bold text-ink-900 phone:px-6">
      All dialling is halted{since !== null ? ` since ${timeIn(since, SYDNEY)} Sydney` : ''}.
      {kill.reason ? ` Reason: ${kill.reason}.` : ''} Nothing will be dialled until you resume.
    </div>
  );
}

export function ConnectionStrip() {
  const { conn, lastEventAt } = useConsole();
  const now = useNow();
  if (conn === 'open') return null;
  return (
    <div role="status" className="border-b-4 border-steel-100 bg-ink-700 px-4 py-2 text-body font-bold text-steel-100 phone:px-6">
      {lastEventAt === null
        ? 'Connecting to the server.'
        : `Connection lost. This page is showing what was true ${ago(new Date(lastEventAt).toISOString(), now)}. Retrying. Stop all still works.`}
    </div>
  );
}

/* -------------------------------------------------------------------- clocks */

export function Clocks() {
  const now = useNow();
  return (
    <dl className="grid grid-cols-[auto_auto] gap-x-2 text-label leading-snug">
      <dt className="text-steel-300">Sydney</dt>
      <dd className="text-right font-semibold text-steel-100">{timeIn(now, SYDNEY)}</dd>
      <dt className="text-steel-300">Auckland</dt>
      <dd className="text-right font-semibold text-steel-100">{timeIn(now, AUCKLAND)}</dd>
    </dl>
  );
}

export { secondsIn };

/* -------------------------------------------------------------------- top bar */

const NAV: Array<{ name: RouteName; label: string }> = [
  { name: 'home', label: 'Home' },
  { name: 'calls', label: 'Call log' },
  { name: 'meetings', label: 'Meeting desk' },
  { name: 'trace', label: 'Agent trace' },
  { name: 'playbook', label: 'Playbook' },
  { name: 'accounts', label: 'Accounts' },
  { name: 'health', label: 'Health' },
  { name: 'briefing', label: 'Briefing' }
];

function isMac(): boolean {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
}

export function TopBar({ onJarvis }: { onJarvis: () => void }) {
  const { snapshot, liveReceivedAt } = useConsole();
  const route = useRoute();
  const now = useNow();
  const pending = snapshot?.needsYou.meetingRequests.filter((m) => m.status === 'pending').length ?? 0;
  const live = snapshot?.live ?? null;
  const elapsed = live && liveReceivedAt !== null ? live.elapsedSeconds + Math.max(0, (now - liveReceivedAt) / 1000) : 0;
  const [mac, setMac] = useState(false);
  useEffect(() => setMac(isMac()), []);

  return (
    <header className="border-b border-slate-500 bg-ink-900">
      <div className="mx-auto flex max-w-[100rem] flex-wrap items-center gap-x-6 gap-y-1 px-6 py-2">
        <a href={routeHref('home')} className="order-1 flex items-center gap-3 py-1 text-strong font-semibold text-steel-100 no-underline">
          <Lamp on={false} size="sm" />
          ANZ Voice SDR
        </a>

        <nav aria-label="Screens" className="order-3 -mx-2 flex basis-full flex-wrap gap-x-1 nav:order-2 nav:mx-0 nav:basis-auto nav:flex-1">
          {NAV.map((item) => {
            const here = route.name === item.name;
            return (
              <a
                key={item.name}
                href={routeHref(item.name)}
                aria-current={here ? 'page' : undefined}
                className={`flex min-h-10 items-center gap-2 border-b-2 px-2 text-body no-underline ${
                  here ? 'border-steel-100 font-bold text-steel-100' : 'border-transparent font-medium text-steel-200'
                }`}
              >
                {item.label}
                {item.name === 'meetings' && pending > 0 ? (
                  <span className="rounded-control bg-sand-300 px-1.5 text-label font-bold text-ink-900">
                    {pending}
                    <span className="sr-only"> waiting</span>
                  </span>
                ) : null}
              </a>
            );
          })}
        </nav>

        <div className="order-2 ml-auto flex items-center gap-x-5 nav:order-3">
          {live ? (
            <a
              href={routeHref('home')}
              aria-label={`A call is live with ${live.prospect.name}, ${clock(elapsed)}. Go to the live call.`}
              className="flex items-center gap-2 text-body font-semibold text-steel-100 no-underline"
            >
              <Lamp on size="sm" />
              <span>On air</span>
              <span className="hidden wide:inline text-steel-200">{live.prospect.name}</span>
              <span>{clock(elapsed)}</span>
            </a>
          ) : null}
          <div className="hidden wide:block">
            <Clocks />
          </div>
          <button
            type="button"
            onClick={onJarvis}
            className="hidden min-h-11 items-center gap-3 rounded-control border border-slate-400 px-3 text-body font-semibold text-steel-100 hover:border-steel-200 tablet:flex"
          >
            Ask Jarvis
            <kbd className="rounded-control border border-slate-400 px-1.5 text-label font-medium text-steel-300">{mac ? '⌘K' : 'Ctrl K'}</kbd>
          </button>
          <StopAll layout="bar" />
        </div>
      </div>
    </header>
  );
}
