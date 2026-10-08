import { useEffect, useMemo, useState } from 'react';
import type { TraceEntry } from '../contract';
import { Empty, Failure } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { plural, titleCase, usd } from '../lib/format';
import { dayTimeIn, SYDNEY } from '../lib/time';

export function Trace() {
  const [entries, setEntries] = useState<TraceEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [agent, setAgent] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .trace()
      .then((e) => !cancelled && setEntries(e))
      .catch((e: unknown) => !cancelled && setError(e instanceof ApiError ? e.message : 'The trace could not be loaded.'));
    return () => {
      cancelled = true;
    };
  }, []);

  const sorted = useMemo(() => [...(entries ?? [])].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)), [entries]);
  const agents = useMemo(() => [...new Set(sorted.map((e) => e.agent))].sort(), [sorted]);
  const shown = agent ? sorted.filter((e) => e.agent === agent) : sorted;
  const cost = shown.reduce((s, e) => s + e.costUsd, 0);

  return (
    <div>
      <h1 className="text-statement font-semibold text-steel-100">Agent trace</h1>
      <p className="mt-1 max-w-[70ch] text-body text-steel-300">
        What the Campaign Director decided and why, which agent ran, what came back and what it cost. Newest first.
      </p>

      {error ? (
        <div className="mt-6">
          <Failure>{error}</Failure>
        </div>
      ) : null}
      {entries === null && !error ? <p className="mt-6 text-body text-steel-300">Loading the trace.</p> : null}

      {entries !== null ? (
        <>
          <div role="group" aria-label="Filter by agent" className="mt-6 flex flex-wrap items-center gap-2">
            {[null, ...agents].map((a) => (
              <button
                key={a ?? 'all'}
                type="button"
                aria-pressed={agent === a}
                onClick={() => setAgent(a)}
                className={`min-h-10 rounded-control border px-3 text-body font-semibold ${
                  agent === a ? 'border-steel-100 bg-steel-100 text-ink-900' : 'border-slate-400 text-steel-200'
                }`}
              >
                {a ? titleCase(a) : 'All agents'}
              </button>
            ))}
          </div>
          <p className="mt-4 text-label text-steel-300" aria-live="polite">
            {plural(shown.length, 'decision')}, {usd(cost, 4)} in total.
          </p>
          {shown.length === 0 ? <Empty>No decisions recorded yet.</Empty> : null}
          <ol className="mt-2 max-w-[60rem] divide-y divide-slate-500 border-y border-slate-500">
            {shown.map((e) => (
              <li key={e.id}>
                <details className="group py-3">
                  <summary className="cursor-pointer list-none">
                    <span className="grid grid-cols-[6.5rem_1fr] gap-x-4 gap-y-1 tablet:grid-cols-[9rem_8rem_1fr]">
                      <span className="text-label text-steel-300 tablet:pt-0.5">{dayTimeIn(e.at, SYDNEY)}</span>
                      <span className="text-body font-bold text-steel-100">{titleCase(e.agent)}</span>
                      <span className="col-span-2 text-body text-steel-100 tablet:col-span-1">{e.decision}</span>
                    </span>
                  </summary>
                  <div className="mt-3 border-l-2 border-slate-400 pl-4 tablet:ml-[9rem]">
                    <p className="text-body text-steel-200">
                      <span className="font-semibold text-steel-100">What came back.</span> {e.result}
                    </p>
                    <p className="mt-1 text-label text-steel-300">Cost {usd(e.costUsd, 4)}</p>
                  </div>
                </details>
              </li>
            ))}
          </ol>
        </>
      ) : null}
    </div>
  );
}
