import { useEffect, useMemo, useState } from 'react';
import type { CallDetail, CallLogEntry } from '../contract';
import { RecordingPlayer } from '../components/Recording';
import { Empty, Failure, Market, Tag } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { isLandedOutcome, outcomeText, plural } from '../lib/format';
import { routeHref, useRoute } from '../lib/hooks';
import { clock, dayTimeIn, SYDNEY } from '../lib/time';
import { useConsole } from '../state/console';

function OutcomeTag({ outcome }: { outcome: string }) {
  return <Tag tone={isLandedOutcome(outcome) ? 'sand' : 'plain'}>{outcomeText(outcome)}</Tag>;
}

function DefectMark({ count }: { count: number }) {
  if (count === 0) return <span className="text-steel-300">None</span>;
  return (
    <span className="inline-flex items-center gap-1.5 font-bold text-steel-100">
      <span aria-hidden="true" className="inline-block size-2.5 bg-steel-100" />
      {plural(count, 'defect')}
    </span>
  );
}

/* ------------------------------------------------------------ one call, opened */

function firstName(full: string): string {
  return full.trim().split(/\s+/)[0] ?? full;
}

function CallDetailPanel({ id }: { id: string }) {
  const [detail, setDetail] = useState<CallDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setError(null);
    api
      .call(id)
      .then((d) => !cancelled && setDetail(d))
      .catch((e: unknown) => !cancelled && setError(e instanceof ApiError ? e.message : 'The call could not be loaded.'));
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (error) return <Failure>{error}</Failure>;
  if (!detail) return <p className="py-6 text-body text-steel-300">Opening the call.</p>;

  // Defects sit inside the transcript at the moment they happened.
  const positioned = detail.defectDetails.filter((d) => typeof d.atSecond === 'number');
  const floating = detail.defectDetails.filter((d) => typeof d.atSecond !== 'number');
  const placed = new Set<number>();
  const defectsAfter = (index: number): typeof positioned => {
    const turn = detail.transcript[index];
    const next = detail.transcript[index + 1];
    if (!turn) return [];
    return positioned.filter((d, i) => {
      if (placed.has(i)) return false;
      const at = d.atSecond ?? 0;
      const fits = at >= turn.atSecond && (next === undefined || at < next.atSecond);
      if (fits) placed.add(i);
      return fits;
    });
  };

  return (
    <article aria-label={`Call with ${detail.name}`}>
      <header>
        <h2 className="text-statement font-semibold text-steel-100">
          {detail.name} <Market market={detail.market} />
        </h2>
        <p className="mt-1 text-body text-steel-300">{detail.company}</p>
        <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-body">
          <dt className="text-steel-300">Started</dt>
          <dd className="font-semibold text-steel-100">{dayTimeIn(detail.startedAt, SYDNEY)} Sydney</dd>
          <dt className="text-steel-300">Length</dt>
          <dd className="font-semibold text-steel-100">{clock(detail.durationSeconds)}</dd>
          <dt className="text-steel-300">Outcome</dt>
          <dd>
            <OutcomeTag outcome={detail.outcome} />
          </dd>
          <dt className="text-steel-300">Script</dt>
          <dd className="font-semibold text-steel-100">{detail.variant}</dd>
        </dl>
      </header>

      {detail.dossierSummary ? (
        <section className="mt-6" aria-labelledby="dossier-h">
          <h3 id="dossier-h" className="mb-1 text-body font-semibold text-steel-100">
            What we knew going in
          </h3>
          <p className="max-w-[70ch] text-body text-steel-200">{detail.dossierSummary}</p>
        </section>
      ) : null}

      <section className="mt-6" aria-labelledby="rec-h">
        <h3 id="rec-h" className="mb-2 text-body font-semibold text-steel-100">
          Recording
        </h3>
        <RecordingPlayer callId={detail.id} url={detail.recordingUrl} startAt={0} autoPlay={false} label="Load the recording" />
      </section>

      {detail.defectDetails.length > 0 ? (
        <section className="mt-6" aria-labelledby="def-h">
          <h3 id="def-h" className="mb-2 text-body font-semibold text-steel-100">
            {plural(detail.defectDetails.length, 'defect')} flagged
          </h3>
          <ul className="space-y-2">
            {[...positioned, ...floating].map((d, i) => (
              <li key={i} className="border-l-4 border-steel-100 bg-ink-700 py-2 pl-3 pr-3">
                <p className="font-bold text-steel-100">
                  {d.kind}
                  {typeof d.atSecond === 'number' ? <span className="font-medium text-steel-300">, at {clock(d.atSecond)}</span> : null}
                </p>
                <p className="text-body text-steel-200">{d.detail}</p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="mt-8" aria-labelledby="tr-h">
        <h3 id="tr-h" className="mb-3 text-body font-semibold text-steel-100">
          Transcript
        </h3>
        {detail.transcript.length === 0 ? <Empty>No transcript was kept.</Empty> : null}
        <div className="flex flex-col gap-4">
          {detail.transcript.map((t, i) => {
            const them = t.speaker === 'prospect';
            return (
              <div key={i}>
                <div className="grid grid-cols-[2.75rem_1fr] gap-x-3">
                  <span className="pt-1 text-label text-slate-300">{clock(t.atSecond)}</span>
                  <div className={them ? 'border-l-2 border-sand-300 pl-4' : ''}>
                    <p className="text-label font-semibold text-steel-300">{them ? firstName(detail.name) : 'Lexi'}</p>
                    <p className={`speech text-speech ${them ? 'text-steel-100' : 'text-steel-300'}`}>{t.text}</p>
                  </div>
                </div>
                {defectsAfter(i).map((d, j) => (
                  <div key={j} className="ml-[3.5rem] mt-2 border-l-4 border-steel-100 bg-ink-700 py-2 pl-3 pr-3">
                    <p className="font-bold text-steel-100">Defect flagged here: {d.kind}</p>
                    <p className="text-body text-steel-200">{d.detail}</p>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </section>
    </article>
  );
}

/* --------------------------------------------------------------------- the list */

export function CallLog() {
  const { calls, callsError } = useConsole();
  const route = useRoute();
  const selected = route.name === 'calls' ? route.param : null;
  const [q, setQ] = useState('');
  const [outcome, setOutcome] = useState('');
  const [market, setMarket] = useState('');
  const [variant, setVariant] = useState('');
  const [defectsOnly, setDefectsOnly] = useState(false);

  const rows: CallLogEntry[] = useMemo(() => [...(calls ?? [])].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt)), [calls]);
  const outcomes = useMemo(() => [...new Set(rows.map((r) => r.outcome))].sort(), [rows]);
  const variants = useMemo(() => [...new Set(rows.map((r) => r.variant))].sort(), [rows]);

  const shown = rows.filter(
    (r) =>
      (outcome === '' || r.outcome === outcome) &&
      (market === '' || r.market === market) &&
      (variant === '' || r.variant === variant) &&
      (!defectsOnly || r.defects > 0) &&
      (q === '' || `${r.name} ${r.company}`.toLowerCase().includes(q.toLowerCase()))
  );

  const field = 'min-h-11 rounded-control border border-slate-400 bg-ink-900 px-3 text-body text-steel-100';

  return (
    <div>
      <h1 className="text-statement font-semibold text-steel-100">Call log</h1>
      <p className="mt-1 text-body text-steel-300">Every call, newest first. Open one to read it, hear it and see what the guardrails flagged.</p>

      <div className="mt-6 grid gap-x-10 gap-y-8 wide:grid-cols-[minmax(0,1fr)_minmax(0,32rem)]">
        <div className={`min-w-0 ${selected ? 'hidden wide:block' : ''}`}>
          <form role="search" aria-label="Filter the call log" className="mb-4 flex flex-wrap items-end gap-3" onSubmit={(e) => e.preventDefault()}>
            <label className="flex flex-col gap-1 text-label text-steel-300">
              Person or company
              <input type="search" value={q} onChange={(e) => setQ(e.target.value)} className={`${field} w-56`} />
            </label>
            <label className="flex flex-col gap-1 text-label text-steel-300">
              Outcome
              <select value={outcome} onChange={(e) => setOutcome(e.target.value)} className={field}>
                <option value="">All outcomes</option>
                {outcomes.map((o) => (
                  <option key={o} value={o}>
                    {outcomeText(o)}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-label text-steel-300">
              Market
              <select value={market} onChange={(e) => setMarket(e.target.value)} className={field}>
                <option value="">AU and NZ</option>
                <option value="AU">AU</option>
                <option value="NZ">NZ</option>
              </select>
            </label>
            <label className="flex flex-col gap-1 text-label text-steel-300">
              Script
              <select value={variant} onChange={(e) => setVariant(e.target.value)} className={field}>
                <option value="">All scripts</option>
                {variants.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex min-h-11 items-center gap-2 text-body text-steel-200">
              <input type="checkbox" checked={defectsOnly} onChange={(e) => setDefectsOnly(e.target.checked)} className="size-5 accent-[#e6edf4]" />
              Only calls with defects
            </label>
          </form>

          {callsError ? <Failure>{callsError}</Failure> : null}
          {calls === null && !callsError ? <p className="py-4 text-body text-steel-300">Loading the call log.</p> : null}
          {calls !== null && shown.length === 0 ? <Empty>No calls match those filters.</Empty> : null}

          {shown.length > 0 ? (
            <>
              <p className="mb-2 text-label text-steel-300" aria-live="polite">
                {plural(shown.length, 'call')}
                {shown.length !== rows.length ? ` of ${rows.length}` : ''}
              </p>
              <table className="w-full border-collapse text-left text-body">
                <thead>
                  <tr className="border-b border-slate-400 text-label text-steel-300">
                    <th scope="col" className="py-2 pr-3 font-medium">Who</th>
                    <th scope="col" className="hidden py-2 pr-3 font-medium tablet:table-cell">Started, Sydney</th>
                    <th scope="col" className="py-2 pr-3 text-right font-medium">Length</th>
                    <th scope="col" className="py-2 pr-3 font-medium">Outcome</th>
                    <th scope="col" className="hidden py-2 pr-3 font-medium broad:table-cell">Script</th>
                    <th scope="col" className="py-2 font-medium">Defects</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((r) => {
                    const sel = selected === r.id;
                    return (
                      <tr key={r.id} className={`border-b border-slate-500 align-top ${sel ? 'bg-ink-700' : ''}`}>
                        <td className={`border-l-4 py-3 pl-2 pr-3 ${sel ? 'border-steel-100' : 'border-transparent'}`}>
                          <a href={routeHref('calls', r.id)} aria-current={sel ? 'true' : undefined} className="font-semibold text-steel-100 no-underline">
                            {r.name}
                          </a>{' '}
                          <Market market={r.market} />
                          <br />
                          <span className="text-label text-steel-300">{r.company}</span>
                        </td>
                        <td className="hidden py-3 pr-3 text-steel-200 tablet:table-cell">{dayTimeIn(r.startedAt, SYDNEY)}</td>
                        <td className="py-3 pr-3 text-right text-steel-200">{clock(r.durationSeconds)}</td>
                        <td className="py-3 pr-3">
                          <OutcomeTag outcome={r.outcome} />
                        </td>
                        <td className="hidden py-3 pr-3 text-steel-200 broad:table-cell">{r.variant}</td>
                        <td className="py-3 text-label">
                          <DefectMark count={r.defects} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </>
          ) : null}
        </div>

        {selected ? (
          <div className="min-w-0 wide:border-l wide:border-slate-500 wide:pl-8">
            <p className="mb-4 wide:hidden">
              <a href={routeHref('calls')}>Back to the call log</a>
            </p>
            <CallDetailPanel id={selected} />
          </div>
        ) : (
          <div className="hidden min-w-0 wide:block wide:border-l wide:border-slate-500 wide:pl-8">
            <p className="text-body text-steel-300">Choose a call to read it.</p>
          </div>
        )}
      </div>
    </div>
  );
}
