import { useCallback, useEffect, useRef, useState } from 'react';
import { ConnectionStrip, DemoStrip, HaltedStrip, TopBar } from './components/Chrome';
import { Jarvis } from './components/Jarvis';
import { StopAll } from './components/StopAll';
import { Button, Lamp } from './components/ui';
import { clearToken, getToken, setUnauthorisedHandler } from './lib/api';
import { readPref, routeHref, useMediaQuery, useRoute, writePref } from './lib/hooks';
import { sydneyDateKey, sydneyHour } from './lib/time';
import { Accounts } from './screens/Accounts';
import { Briefing } from './screens/Briefing';
import { CallLog } from './screens/CallLog';
import { Gate } from './screens/Gate';
import { Health } from './screens/Health';
import { Home } from './screens/Home';
import { MeetingDesk } from './screens/MeetingDesk';
import { MobileHome } from './screens/MobileHome';
import { Playbook } from './screens/Playbook';
import { Trace } from './screens/Trace';
import { ConsoleProvider, useConsole } from './state/console';
import { NoticeProvider } from './state/notice';

const BRIEFING_KEY = 'anzsdr.console.briefing-seen';
const LAYOUT_KEY = 'anzsdr.console.layout';

/** The first open of each Sydney day, from 07:00, lands on the briefing. */
function shouldOpenBriefing(): boolean {
  const now = Date.now();
  if (sydneyHour(now) < 7) return false;
  return readPref(BRIEFING_KEY) !== sydneyDateKey(now);
}

function markBriefingSeen() {
  writePref(BRIEFING_KEY, sydneyDateKey(Date.now()));
}

function Waiting({ onReset }: { onReset: () => void }) {
  const { conn } = useConsole();
  return (
    <main className="mx-auto flex min-h-dvh max-w-[34rem] flex-col justify-center px-6 py-12">
      <div className="flex items-center gap-3">
        <Lamp on={false} size="lg" />
        <p className="text-strong font-semibold text-steel-100">ANZ Voice SDR</p>
      </div>
      <h1 className="mt-8 text-statement font-semibold text-steel-100">{conn === 'retrying' ? 'Cannot reach the server' : 'Connecting'}</h1>
      <p className="mt-3 max-w-[46ch] text-body text-steel-300" role="status">
        {conn === 'retrying'
          ? 'The console cannot get its first data from the server. It keeps trying. If the server is running, check that the token is the right one.'
          : 'Waiting for the first data from the server.'}
      </p>
      <div className="mt-6">
        <Button onClick={onReset}>Use a different token</Button>
      </div>
    </main>
  );
}

function Screen({ onBriefingDone }: { onBriefingDone: () => void }) {
  const route = useRoute();
  switch (route.name) {
    case 'calls':
      return <CallLog />;
    case 'meetings':
      return <MeetingDesk />;
    case 'trace':
      return <Trace />;
    case 'playbook':
      return <Playbook />;
    case 'accounts':
      return <Accounts />;
    case 'health':
      return <Health />;
    case 'briefing':
      return <Briefing onDone={onBriefingDone} />;
    default:
      return <Home />;
  }
}

function useHeaderHeight() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const set = () => document.documentElement.style.setProperty('--header-h', `${el.getBoundingClientRect().height}px`);
    set();
    const ro = new ResizeObserver(set);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return ref;
}

function DesktopShell({ onBriefingDone, onJarvis, offerPhone }: { onBriefingDone: () => void; onJarvis: () => void; offerPhone: boolean }) {
  const header = useHeaderHeight();
  return (
    <>
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-2 focus:z-50 focus:bg-steel-100 focus:px-3 focus:py-2 focus:text-ink-900">
        Skip to the content
      </a>
      <div ref={header} className="sticky top-0 z-30">
        <DemoStrip />
        <TopBar onJarvis={onJarvis} />
        <HaltedStrip />
        <ConnectionStrip />
      </div>
      <main id="main" tabIndex={-1} className="mx-auto max-w-[100rem] px-6 pb-24 pt-8 outline-none">
        <Screen onBriefingDone={onBriefingDone} />
        {offerPhone ? (
          <p className="mt-16 border-t border-slate-500 pt-4 text-label text-steel-300">
            This screen is narrow.{' '}
            <button
              type="button"
              className="underline underline-offset-4"
              onClick={() => {
                writePref(LAYOUT_KEY, 'auto');
                window.dispatchEvent(new Event('layoutchange'));
              }}
            >
              Switch to the phone layout
            </button>
          </p>
        ) : null}
      </main>
    </>
  );
}

function PhoneShell({ onBriefingDone }: { onBriefingDone: () => void }) {
  const route = useRoute();
  const showBriefing = route.name === 'briefing';
  return (
    <div className="min-h-dvh pb-32">
      <div className="sticky top-0 z-30">
        <DemoStrip />
        <HaltedStrip />
        <ConnectionStrip />
        <div className="flex items-center justify-between gap-3 border-b border-slate-500 bg-ink-900 px-4 py-1">
          <a href={routeHref('home')} className="flex items-center gap-2 py-2 text-body font-semibold text-steel-100 no-underline">
            <Lamp on={false} size="sm" />
            ANZ Voice SDR
          </a>
          <div className="flex items-center gap-4 text-label">
            <a href={routeHref('briefing')} className="flex min-h-11 items-center">
              Briefing
            </a>
            <button
              type="button"
              className="min-h-11 underline underline-offset-4"
              onClick={() => {
                writePref(LAYOUT_KEY, 'full');
                window.dispatchEvent(new Event('layoutchange'));
              }}
            >
              Full console
            </button>
          </div>
        </div>
      </div>
      <main id="main">
        {showBriefing ? (
          <div className="px-4 py-6">
            <Briefing onDone={onBriefingDone} />
          </div>
        ) : (
          <MobileHome />
        )}
      </main>
      <div className="fixed inset-x-0 bottom-0 z-40 border-t border-slate-400 bg-ink-900 px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3">
        <StopAll layout="dock" />
      </div>
    </div>
  );
}

function Shell({ onReset }: { onReset: () => void }) {
  const { snapshot } = useConsole();
  const route = useRoute();
  const isPhone = useMediaQuery('(max-width: 639px)');
  const [layoutPref, setLayoutPref] = useState(() => readPref(LAYOUT_KEY));
  const [jarvis, setJarvis] = useState(false);
  const openedBriefing = useRef(false);

  useEffect(() => {
    const onChange = () => setLayoutPref(readPref(LAYOUT_KEY));
    window.addEventListener('layoutchange', onChange);
    return () => window.removeEventListener('layoutchange', onChange);
  }, []);

  const phone = isPhone && layoutPref !== 'full';

  const goHome = useCallback(() => {
    markBriefingSeen();
    window.location.hash = routeHref('home');
  }, []);

  // Land on the briefing once per Sydney morning, if nothing else was asked for.
  useEffect(() => {
    if (!snapshot || openedBriefing.current) return;
    openedBriefing.current = true;
    if (route.name === 'home' && shouldOpenBriefing()) window.location.hash = routeHref('briefing');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot]);

  useEffect(() => {
    if (route.name === 'briefing') markBriefingSeen();
  }, [route.name]);

  // The phone shows four things; any other address falls back to them.
  useEffect(() => {
    if (phone && route.name !== 'home' && route.name !== 'briefing') window.location.hash = routeHref('home');
  }, [phone, route.name]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setJarvis((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!snapshot) return <Waiting onReset={onReset} />;

  return phone ? (
    <PhoneShell onBriefingDone={goHome} />
  ) : (
    <>
      <DesktopShell onBriefingDone={goHome} onJarvis={() => setJarvis(true)} offerPhone={isPhone} />
      <Jarvis open={jarvis} onClose={() => setJarvis(false)} />
    </>
  );
}

export default function App() {
  const [token, setTokenState] = useState<string | null>(() => getToken());
  const [expired, setExpired] = useState(false);

  const reset = useCallback((wasExpired: boolean) => {
    clearToken();
    setExpired(wasExpired);
    setTokenState(null);
  }, []);

  useEffect(() => {
    setUnauthorisedHandler(() => reset(true));
    return () => setUnauthorisedHandler(null);
  }, [reset]);

  if (!token) return <Gate expired={expired} onToken={(t) => { setExpired(false); setTokenState(t); }} />;

  return (
    <ConsoleProvider>
      <NoticeProvider>
        <Shell onReset={() => reset(false)} />
      </NoticeProvider>
    </ConsoleProvider>
  );
}
