import { useEffect, useMemo, useRef, useState } from 'react';
import type { CallLogEntry, CallLogSegments, HangupCurveView } from '../contract';
import { distinct, type SegmentKey, type Segments } from '../lib/callFilter';
import { outcomeText } from '../lib/format';
import { clock } from '../lib/time';
import { RecordingPlayer } from './Recording';
import { Market, Tag } from './ui';

const HEIGHT = 232;
const M = { left: 38, right: 10, top: 46, bottom: 30 };

function useWidth(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(560);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => setWidth(Math.max(280, Math.floor(el.getBoundingClientRect().width)));
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

/** Monotone cubic interpolation (Fritsch-Carlson): smooth, and never dips below the data. */
function monotone(points: Array<[number, number]>): string {
  const n = points.length;
  if (n === 0) return '';
  const first = points[0] as [number, number];
  if (n === 1) return `M${first[0]},${first[1]}`;
  const dx: number[] = [];
  const dy: number[] = [];
  const m: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const a = points[i] as [number, number];
    const b = points[i + 1] as [number, number];
    dx.push(b[0] - a[0]);
    dy.push(b[1] - a[1]);
    m.push((b[1] - a[1]) / (b[0] - a[0] || 1));
  }
  const t: number[] = [m[0] ?? 0];
  for (let i = 1; i < n - 1; i++) {
    const a = m[i - 1] ?? 0;
    const b = m[i] ?? 0;
    t.push(a * b <= 0 ? 0 : (a + b) / 2);
  }
  t.push(m[n - 2] ?? 0);
  for (let i = 0; i < n - 1; i++) {
    const mi = m[i] ?? 0;
    if (mi === 0) {
      t[i] = 0;
      t[i + 1] = 0;
      continue;
    }
    const a = (t[i] ?? 0) / mi;
    const b = (t[i + 1] ?? 0) / mi;
    const s = a * a + b * b;
    if (s > 9) {
      const k = 3 / Math.sqrt(s);
      t[i] = k * a * mi;
      t[i + 1] = k * b * mi;
    }
  }
  let d = `M${first[0]},${first[1]}`;
  for (let i = 0; i < n - 1; i++) {
    const p = points[i] as [number, number];
    const q = points[i + 1] as [number, number];
    const h = (dx[i] ?? 0) / 3;
    d += ` C${p[0] + h},${p[1] + h * (t[i] ?? 0)} ${q[0] - h},${q[1] - h * (t[i + 1] ?? 0)} ${q[0]},${q[1]}`;
  }
  return d;
}

function niceMax(v: number): number {
  if (v <= 4) return 4;
  const step = v <= 10 ? 2 : v <= 20 ? 5 : v <= 50 ? 10 : 20;
  return Math.ceil(v / step) * step;
}

type CallRow = CallLogEntry & CallLogSegments;

const SEGMENT_TITLES: Record<SegmentKey, string> = { market: 'Market', variant: 'Script', industry: 'Industry', seniority: 'Seniority' };

function SegmentGroup({
  title,
  options,
  value,
  onChange
}: {
  title: string;
  options: string[];
  value: string | null;
  onChange: (v: string | null) => void;
}) {
  if (options.length === 0) return null;
  return (
    <div role="group" aria-label={`Segment by ${title.toLowerCase()}`} className="flex flex-wrap items-center gap-1.5">
      <span className="mr-1 text-label text-steel-300">{title}</span>
      {[null, ...options].map((o) => {
        const on = value === o;
        return (
          <button
            key={o ?? 'all'}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(o)}
            className={`min-h-9 rounded-control border px-2.5 text-label font-semibold ${
              on ? 'border-steel-100 bg-steel-100 text-ink-900' : 'border-slate-400 text-steel-200'
            }`}
          >
            {o ?? 'All'}
          </button>
        );
      })}
    </div>
  );
}

export function HangupCurve({
  curve,
  calls,
  matching,
  segments,
  onSegments
}: {
  curve: HangupCurveView;
  calls: CallRow[] | null;
  matching: Set<string> | null;
  segments: Segments;
  onSegments: (next: Segments) => void;
}) {
  const [wrap, width] = useWidth();
  const [active, setActive] = useState<number | null>(null);
  const byId = useMemo(() => new Map((calls ?? []).map((c) => [c.id, c])), [calls]);

  const bins = useMemo(
    () =>
      curve.bins.map((b) => {
        const ids = matching ? b.callIds.filter((id) => matching.has(id)) : b.callIds;
        return { fromSecond: b.fromSecond, ids, count: matching ? ids.length : b.count };
      }),
    [curve.bins, matching]
  );

  const bin = curve.binSeconds > 0 ? curve.binSeconds : 5;
  const lastBinEnd = bins.reduce((m, b) => Math.max(m, b.fromSecond + bin), 0);
  const lastSection = curve.sections.reduce((m, s) => Math.max(m, s.toSecond), 0);
  const maxSecond = Math.max(lastBinEnd, lastSection, 30);
  const maxCount = niceMax(bins.reduce((m, b) => Math.max(m, b.count), 0));
  const plotW = Math.max(120, width - M.left - M.right);
  const plotH = HEIGHT - M.top - M.bottom;
  const x = (s: number) => M.left + (s / maxSecond) * plotW;
  const y = (c: number) => M.top + plotH - (c / maxCount) * plotH;
  const total = bins.reduce((s, b) => s + b.count, 0);

  const points: Array<[number, number]> = bins.map((b) => [x(b.fromSecond + bin / 2), y(b.count)]);
  const line = monotone(points);
  const first = points[0];
  const last = points[points.length - 1];
  const area = first && last ? `${line} L${last[0]},${y(0)} L${first[0]},${y(0)} Z` : '';

  // Section labels: first row that fits, else the second.
  const labelRows = useMemo(() => {
    const ends: number[] = [-Infinity, -Infinity];
    return curve.sections.map((s) => {
      const startX = x(s.fromSecond) + 5;
      const w = s.label.length * 7.4;
      for (let r = 0; r < 2; r++) {
        if (startX >= (ends[r] ?? -Infinity) + 8) {
          ends[r] = startX + w;
          return r;
        }
      }
      return 1;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [curve.sections, plotW, maxSecond]);

  const sectionAt = (s: number) => curve.sections.find((sec) => s >= sec.fromSecond && s < sec.toSecond) ?? curve.sections[curve.sections.length - 1];

  const peak = bins.reduce<(typeof bins)[number] | null>((p, b) => (b.count > (p?.count ?? 0) ? b : p), null);
  const tickStep = maxSecond > 150 ? 30 : 15;
  const xTicks: number[] = [];
  for (let s = 0; s <= maxSecond; s += tickStep) xTicks.push(s);
  const yTicks = [0, maxCount / 2, maxCount];

  const activeBin = active !== null ? bins[active] : undefined;
  const activeCalls = activeBin ? activeBin.ids : [];

  const setSegment = (key: SegmentKey, v: string | null) => {
    setActive(null);
    onSegments({ ...segments, [key]: v });
  };

  const rows: CallRow[] = calls ?? [];
  const options = {
    market: distinct(rows, 'market'),
    variant: distinct(rows, 'variant'),
    industry: distinct(rows, 'industry'),
    seniority: distinct(rows, 'seniority')
  };

  return (
    <div>
      <div className="mb-3 flex flex-wrap gap-x-6 gap-y-2">
        {(Object.keys(options) as SegmentKey[]).map((k) => (
          <SegmentGroup key={k} title={SEGMENT_TITLES[k]} options={options[k]} value={segments[k]} onChange={(v) => setSegment(k, v)} />
        ))}
      </div>

      <p className="mb-3 min-h-[3rem] max-w-[70ch] text-body text-steel-200" aria-live="polite">
        {total === 0 ? (
          'No hang-ups in view.'
        ) : peak ? (
          <>
            The biggest loss: <span className="font-bold text-steel-100">{peak.count} {peak.count === 1 ? 'call' : 'calls'}</span> ended between{' '}
            {clock(peak.fromSecond)} and {clock(peak.fromSecond + bin)}, during{' '}
            <span className="font-bold text-steel-100">{(sectionAt(peak.fromSecond + bin / 2)?.label ?? 'the call').toLowerCase()}</span>.
          </>
        ) : null}
      </p>

      <div ref={wrap} className="relative" style={{ height: HEIGHT }}>
        <svg
          width={width}
          height={HEIGHT}
          role="img"
          aria-label={`Seconds to hang-up. ${total} calls. ${peak ? `Most ended around ${clock(peak.fromSecond)} to ${clock(peak.fromSecond + bin)}.` : ''}`}
          className="block font-data"
        >
          {/* script sections */}
          {curve.sections.map((s, i) => (
            <g key={s.id}>
              <rect x={x(s.fromSecond)} y={M.top} width={Math.max(0, x(s.toSecond) - x(s.fromSecond))} height={plotH} className={i % 2 === 0 ? 'fill-slate-500/25' : 'fill-transparent'} />
              <line x1={x(s.fromSecond)} x2={x(s.fromSecond)} y1={12} y2={M.top + plotH} className="stroke-slate-500" />
              <text x={x(s.fromSecond) + 5} y={M.top - 20 + (labelRows[i] ?? 0) * 17} className="fill-steel-200 text-label font-semibold">
                {s.label}
              </text>
            </g>
          ))}

          {/* y grid */}
          {yTicks.map((t) => (
            <g key={t}>
              <line x1={M.left} x2={M.left + plotW} y1={y(t)} y2={y(t)} className={t === 0 ? 'stroke-slate-400' : 'stroke-slate-500/60'} strokeDasharray={t === 0 ? undefined : '2 4'} />
              <text x={M.left - 8} y={y(t) + 4} textAnchor="end" className="fill-steel-300 text-label">
                {Math.round(t)}
              </text>
            </g>
          ))}

          {/* x axis */}
          {xTicks.map((t) => (
            <text key={t} x={x(t)} y={HEIGHT - 8} textAnchor={t === 0 ? 'start' : 'middle'} className="fill-steel-300 text-label">
              {t === 0 ? '0s' : `${t}s`}
            </text>
          ))}

          {/* active bin */}
          {activeBin ? (
            <rect x={x(activeBin.fromSecond)} y={M.top} width={Math.max(2, x(activeBin.fromSecond + bin) - x(activeBin.fromSecond))} height={plotH} className="fill-sand-300/25" />
          ) : null}

          {/* the density */}
          {area ? <path d={area} className="fill-steel-300/30" /> : null}
          {line ? <path d={line} fill="none" className="stroke-steel-100" strokeWidth={2} strokeLinejoin="round" /> : null}
          {activeBin && activeBin.count > 0 ? (
            <circle cx={x(activeBin.fromSecond + bin / 2)} cy={y(activeBin.count)} r={5} className="fill-sand-300 stroke-ink-900" strokeWidth={2} />
          ) : null}
        </svg>

        {bins.map((b, i) => (
          <button
            key={b.fromSecond}
            type="button"
            aria-pressed={active === i}
            aria-label={`${clock(b.fromSecond)} to ${clock(b.fromSecond + bin)}: ${b.count} ${b.count === 1 ? 'call' : 'calls'} ended. Show them.`}
            onPointerEnter={() => setActive(i)}
            onFocus={() => setActive(i)}
            onClick={() => setActive(i)}
            className="absolute"
            style={{ left: x(b.fromSecond), width: Math.max(4, x(b.fromSecond + bin) - x(b.fromSecond)), top: M.top, height: plotH }}
          />
        ))}
      </div>

      <div className="mt-4 min-h-[6rem] border-t border-slate-500 pt-3" aria-live="polite">
        {activeBin ? (
          <>
            <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-body font-semibold text-steel-100">
                {activeBin.count} {activeBin.count === 1 ? 'call' : 'calls'} ended between {clock(activeBin.fromSecond)} and {clock(activeBin.fromSecond + bin)}
                <span className="font-normal text-steel-300">, during {(sectionAt(activeBin.fromSecond + bin / 2)?.label ?? 'the call').toLowerCase()}</span>
              </h3>
              <button type="button" onClick={() => setActive(null)} className="min-h-9 px-1 text-label text-steel-200 underline underline-offset-4">
                Clear
              </button>
            </div>
            {activeCalls.length === 0 ? <p className="text-body text-steel-300">None in this view.</p> : null}
            <ul className="divide-y divide-slate-500">
              {activeCalls.map((id) => {
                const c = byId.get(id);
                return (
                  <li key={id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-2.5">
                    <div className="min-w-0">
                      <p className="text-body font-semibold text-steel-100">
                        {c ? c.name : `Call ${id}`} {c ? <Market market={c.market} /> : null}
                      </p>
                      <p className="text-label text-steel-300">
                        {c ? `${c.company}, lasted ${clock(c.durationSeconds)}, ${c.variant}` : 'Not in the call log yet'}
                        {c ? <> {' '}<Tag tone="plain" className="ml-1">{outcomeText(c.outcome)}</Tag></> : null}
                      </p>
                    </div>
                    <RecordingPlayer callId={id} startAt={c ? c.durationSeconds - 3 : 0} />
                  </li>
                );
              })}
            </ul>
          </>
        ) : (
          <p className="text-body text-steel-300">Point at, focus or tap a stretch of the curve to list the calls that ended there. Each one plays from three seconds before the hang-up.</p>
        )}
      </div>
    </div>
  );
}
