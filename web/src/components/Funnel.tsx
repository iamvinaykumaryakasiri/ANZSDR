import type { FunnelStageId, FunnelStageView } from '../contract';
import { int, pct } from '../lib/format';

const SETTLED: ReadonlySet<FunnelStageId> = new Set(['meeting_requested', 'confirmed']);

function pts(rate: number, baseline: number): number {
  return Math.round((rate - baseline) * 100);
}

/**
 * The stage funnel. Each bar is drawn against the stage before it: the filled
 * part is how many arrived, the rest is the loss. The tick marks where the bar
 * would have ended at the seven-day baseline rate, so a bar that stops short of
 * its tick is a worse-than-usual day. Position carries it; colour is not spent.
 */
export function Funnel({
  funnel,
  selected,
  onSelect
}: {
  funnel: FunnelStageView[];
  selected: FunnelStageId | null;
  onSelect: (id: FunnelStageId | null) => void;
}) {
  if (funnel.length === 0) return <p className="py-3 text-body text-steel-300">No calls have been queued yet.</p>;

  return (
    <div>
      <div
        aria-hidden="true"
        className="grid grid-cols-[minmax(0,1fr)_3.25rem_2.75rem_2.75rem] gap-x-2 border-b border-slate-400 pb-1 text-label text-steel-300"
      >
        <span>Stage</span>
        <span className="text-right">Count</span>
        <span className="text-right">Rate</span>
        <span className="text-right">Lost</span>
      </div>
      <ol>
        {funnel.map((stage, index) => {
          const first = index === 0;
          const isSel = selected === stage.id;
          const fill = first ? 1 : Math.max(0, Math.min(1, stage.rate));
          const base = first ? null : Math.max(0, Math.min(1, stage.baselineRate));
          const delta = first ? 0 : pts(stage.rate, stage.baselineRate);
          const under = !first && delta <= -3;
          const settled = SETTLED.has(stage.id);
          const fillClass = isSel ? (settled ? 'bg-sand-300' : 'bg-steel-100') : settled ? 'bg-sand-400' : 'bg-steel-300';
          const prev = funnel[index - 1];

          const summary = first
            ? `${stage.label}: ${int(stage.count)}`
            : `${stage.label}: ${int(stage.count)} of ${int(prev?.count)}, ${pct(stage.rate)}, ${int(stage.loss)} lost, ${
                delta === 0 ? 'level with' : `${Math.abs(delta)} points ${delta < 0 ? 'under' : 'over'}`
              } the seven-day rate of ${pct(stage.baselineRate)}`;

          return (
            <li key={stage.id} className="border-b border-slate-500">
              <button
                type="button"
                aria-pressed={isSel}
                aria-label={summary}
                onClick={() => onSelect(isSel ? null : stage.id)}
                className={`block w-full border-l-4 py-2.5 pl-2 pr-1 text-left ${isSel ? 'border-steel-100 bg-ink-700' : 'border-transparent'}`}
              >
                <span className="grid grid-cols-[minmax(0,1fr)_3.25rem_2.75rem_2.75rem] items-baseline gap-x-2">
                  <span className={`${isSel || under ? 'font-bold' : 'font-semibold'} text-body text-steel-100`}>{stage.label}</span>
                  <span className="text-right text-body font-semibold text-steel-100">{int(stage.count)}</span>
                  <span className={`text-right text-body ${under ? 'font-bold text-steel-100' : 'text-steel-200'}`}>{first ? '-' : pct(stage.rate)}</span>
                  <span className="text-right text-body text-steel-300">{first ? '-' : int(stage.loss)}</span>
                </span>
                <span className="mt-1.5 flex items-center gap-3">
                  <span aria-hidden="true" className="relative block h-3 min-w-0 flex-1 bg-slate-500/50">
                    <span className={`absolute inset-y-0 left-0 ${fillClass}`} style={{ width: `${fill * 100}%` }} />
                    {under && base !== null ? (
                      <span className="hatch absolute inset-y-0 bg-steel-300/40" style={{ left: `${fill * 100}%`, width: `${Math.max(0, (base - fill) * 100)}%` }} />
                    ) : null}
                    {base !== null ? (
                      <span className="absolute -inset-y-1 w-0.5 bg-steel-100" style={{ left: `calc(${base * 100}% - 1px)` }} />
                    ) : null}
                  </span>
                  <span className={`w-[8.5rem] shrink-0 text-label ${under ? 'font-bold text-steel-100' : 'text-steel-300'}`}>
                    {first ? 'Everything queued' : delta === 0 ? `Level with 7-day ${pct(stage.baselineRate)}` : `${Math.abs(delta)} pts ${delta < 0 ? 'under' : 'over'} 7-day ${pct(stage.baselineRate)}`}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ol>
      <p className="mt-3 text-label text-steel-300">
        The tick on each bar is where it would end at the seven-day rate. Select a stage to filter the curve and the lists beside it.
      </p>
    </div>
  );
}
