import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, type ReactNode } from 'react';
import { api, ApiError } from '../lib/api';
import { openStream, type StreamStatus } from '../lib/sse';
import { parseTime } from '../lib/time';
import type {
  CallLogEntry,
  ConsoleEvent,
  ConsoleSnapshot,
  KillSwitchView,
  LiveCallView,
  MeetingRequestView
} from '../contract';

interface LastEnded {
  callId: string;
  outcome: string;
  name: string;
  company: string;
}

interface State {
  snapshot: ConsoleSnapshot | null;
  conn: StreamStatus;
  /** Local clock reading when the newest event arrived. */
  lastEventAt: number | null;
  /** serverNow = Date.now() + serverOffsetMs. Corrects for a wrong laptop clock. */
  serverOffsetMs: number;
  /** Local clock reading at which live.elapsedSeconds was true. */
  liveReceivedAt: number | null;
  /** Set when a call went live while the person was watching; drives the one animation. */
  enteringCallId: string | null;
  lastEnded: LastEnded | null;
  calls: CallLogEntry[] | null;
  callsError: string | null;
  callsVersion: number;
}

type Action =
  | { type: 'event'; event: ConsoleEvent; at: number }
  | { type: 'snapshot'; snapshot: ConsoleSnapshot; at: number }
  | { type: 'conn'; conn: StreamStatus }
  | { type: 'entered' }
  | { type: 'kill'; killSwitch: KillSwitchView }
  | { type: 'meeting'; meeting: MeetingRequestView }
  | { type: 'calls'; calls: CallLogEntry[] }
  | { type: 'calls_error'; message: string };

const initial: State = {
  snapshot: null,
  conn: 'connecting',
  lastEventAt: null,
  serverOffsetMs: 0,
  liveReceivedAt: null,
  enteringCallId: null,
  lastEnded: null,
  calls: null,
  callsError: null,
  callsVersion: 0
};

function withLive(state: State, snapshot: ConsoleSnapshot, live: LiveCallView | null, at: number): State {
  const wentLive =
    live !== null && state.snapshot !== null && (state.snapshot.live === null || state.snapshot.live.callId !== live.callId);
  return {
    ...state,
    snapshot: { ...snapshot, live },
    liveReceivedAt: live ? at : null,
    enteringCallId: wentLive ? live.callId : state.enteringCallId
  };
}

function applySnapshot(state: State, snapshot: ConsoleSnapshot, at: number): State {
  const generated = parseTime(snapshot.generatedAt);
  const prevLive = state.snapshot?.live ?? null;
  const next = withLive(state, snapshot, snapshot.live, at);
  // A snapshot that carries the same live call keeps the clock we already have
  // unless the server's elapsed figure has moved on past it.
  return {
    ...next,
    conn: 'open',
    lastEventAt: at,
    serverOffsetMs: generated !== null ? generated - at : state.serverOffsetMs,
    lastEnded: snapshot.live ? null : state.lastEnded,
    callsVersion: prevLive && !snapshot.live ? state.callsVersion + 1 : state.callsVersion
  };
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'conn':
      return { ...state, conn: action.conn };
    case 'entered':
      return { ...state, enteringCallId: null };
    case 'calls':
      return { ...state, calls: action.calls, callsError: null };
    case 'calls_error':
      return { ...state, callsError: action.message };
    case 'snapshot':
      return applySnapshot(state, action.snapshot, action.at);
    case 'kill':
      return state.snapshot ? { ...state, snapshot: { ...state.snapshot, killSwitch: action.killSwitch } } : state;
    case 'meeting': {
      if (!state.snapshot) return state;
      const list = state.snapshot.needsYou.meetingRequests;
      const exists = list.some((m) => m.ref === action.meeting.ref);
      const meetingRequests = exists ? list.map((m) => (m.ref === action.meeting.ref ? action.meeting : m)) : [action.meeting, ...list];
      return { ...state, snapshot: { ...state.snapshot, needsYou: { ...state.snapshot.needsYou, meetingRequests } } };
    }
    case 'event': {
      const { event, at } = action;
      const base: State = { ...state, lastEventAt: at, conn: 'open' };
      if (event.type === 'snapshot') return applySnapshot(base, event.snapshot, at);
      const snap = base.snapshot;
      if (!snap) return base; // nothing to apply a delta to until the first snapshot arrives
      switch (event.type) {
        case 'call_started':
          return withLive(base, snap, event.call, at);
        case 'transcript': {
          const live = snap.live;
          if (!live || live.callId !== event.callId) return base;
          const dup = live.transcript.some((t) => t.atSecond === event.turn.atSecond && t.text === event.turn.text && t.speaker === event.turn.speaker);
          if (dup) return base;
          return { ...base, snapshot: { ...snap, live: { ...live, transcript: [...live.transcript, event.turn] } } };
        }
        case 'stage': {
          const live = snap.live;
          if (!live || live.callId !== event.callId) return base;
          return { ...base, snapshot: { ...snap, live: { ...live, stage: event.stage } } };
        }
        case 'call_ended': {
          const live = snap.live;
          if (!live || live.callId !== event.callId) return base;
          return {
            ...base,
            snapshot: { ...snap, live: null },
            liveReceivedAt: null,
            enteringCallId: null,
            lastEnded: { callId: live.callId, outcome: event.outcome, name: live.prospect.name, company: live.prospect.company },
            callsVersion: base.callsVersion + 1
          };
        }
        case 'kill_switch':
          return { ...base, snapshot: { ...snap, killSwitch: event.killSwitch } };
      }
    }
  }
}

interface ConsoleContextValue extends State {
  /** The server's clock, as best this browser can tell. */
  serverNow: () => number;
  refresh: () => Promise<void>;
  applyKill: (view: KillSwitchView) => void;
  applyMeeting: (view: MeetingRequestView) => void;
}

const ConsoleContext = createContext<ConsoleContextValue | null>(null);

export function ConsoleProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initial);
  const offsetRef = useRef(0);
  offsetRef.current = state.serverOffsetMs;

  const refresh = useCallback(async () => {
    try {
      const snapshot = await api.snapshot();
      dispatch({ type: 'snapshot', snapshot, at: Date.now() });
    } catch {
      /* the stream is the source of truth; a failed refresh changes nothing */
    }
  }, []);

  // The stream: one connection, first event is a snapshot.
  useEffect(() => {
    const handle = openStream({
      onEvent: (event) => dispatch({ type: 'event', event, at: Date.now() }),
      onStatus: (conn) => dispatch({ type: 'conn', conn })
    });
    void refresh();
    return handle.stop;
  }, [refresh]);

  // Belt and braces: re-read the snapshot now and then, so the funnel and
  // today's figures settle even if the server only pushes deltas.
  useEffect(() => {
    const id = setInterval(() => void refresh(), 45_000);
    return () => clearInterval(id);
  }, [refresh]);

  // A call just ended: its funnel figures changed.
  const endedRef = useRef<string | null>(null);
  useEffect(() => {
    if (state.lastEnded && endedRef.current !== state.lastEnded.callId) {
      endedRef.current = state.lastEnded.callId;
      void refresh();
    }
  }, [state.lastEnded, refresh]);

  // The call log: loaded once, and again whenever a call ends.
  useEffect(() => {
    let cancelled = false;
    api
      .calls()
      .then((calls) => {
        if (!cancelled) dispatch({ type: 'calls', calls });
      })
      .catch((error: unknown) => {
        if (!cancelled) dispatch({ type: 'calls_error', message: error instanceof ApiError ? error.message : 'The call log could not be loaded.' });
      });
    return () => {
      cancelled = true;
    };
  }, [state.callsVersion]);

  // The entrance animation plays once, not on every return to the Home screen.
  useEffect(() => {
    if (!state.enteringCallId) return;
    const id = setTimeout(() => dispatch({ type: 'entered' }), 2200);
    return () => clearTimeout(id);
  }, [state.enteringCallId]);

  const value = useMemo<ConsoleContextValue>(
    () => ({
      ...state,
      serverNow: () => Date.now() + offsetRef.current,
      refresh,
      applyKill: (killSwitch) => dispatch({ type: 'kill', killSwitch }),
      applyMeeting: (meeting) => dispatch({ type: 'meeting', meeting })
    }),
    [state, refresh]
  );

  return <ConsoleContext.Provider value={value}>{children}</ConsoleContext.Provider>;
}

export function useConsole(): ConsoleContextValue {
  const value = useContext(ConsoleContext);
  if (!value) throw new Error('useConsole must be used inside ConsoleProvider');
  return value;
}
