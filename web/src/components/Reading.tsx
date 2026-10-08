import type { PlaybookView } from '../contract';
import { int, pct } from '../lib/format';
import { Empty, SectionHead } from './ui';

function Bar({ value, max, settled = false }: { value: number; max: number; settled?: boolean }) {
  const w = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
  return (
    <span aria-hidden="true" className="relative block h-2.5 w-full bg-slate-500/50">
      <span className={`absolute inset-y-0 left-0 ${settled ? 'bg-sand-400' : 'bg-steel-300'}`} style={{ width: `${w * 100}%` }} />
    </span>
  );
}

export function Objections({ items }: { items: Array<{ label: string; count: number }> }) {
  const sorted = [...items].sort((a, b) => b.count - a.count);
  const max = sorted[0]?.count ?? 0;
  return (
    <section aria-labelledby="obj-title">
      <SectionHead title="Objections, most common first" id="obj-title" />
      {sorted.length === 0 ? <Empty>No objections logged yet.</Empty> : null}
      <ol className="space-y-3">
        {sorted.map((o) => (
          <li key={o.label}>
            <div className="flex items-baseline justify-between gap-3">
              <span className="speech text-strong text-steel-100">“{o.label}”</span>
              <span className="text-body font-semibold text-steel-100">{int(o.count)}</span>
            </div>
            <Bar value={o.count} max={max} />
          </li>
        ))}
      </ol>
    </section>
  );
}

export function Gatekeepers({ items }: { items: Array<{ company: string; blocks: number; calls: number }> }) {
  const rows = items
    .map((g) => ({ ...g, rate: g.calls > 0 ? g.blocks / g.calls : 0 }))
    .sort((a, b) => b.rate - a.rate || b.blocks - a.blocks);
  return (
    <section aria-labelledby="gate-title">
      <SectionHead title="Gatekeeper blocks by account" id="gate-title" />
      {rows.length === 0 ? <Empty>No gatekeeper blocks yet.</Empty> : null}
      <ol className="space-y-3">
        {rows.map((g) => (
          <li key={g.company}>
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-body font-semibold text-steel-100">{g.company}</span>
              <span className="text-body text-steel-200">
                {g.blocks} of {g.calls} <span className="text-steel-300">({pct(g.rate)})</span>
              </span>
            </div>
            <Bar value={g.rate} max={1} />
          </li>
        ))}
      </ol>
    </section>
  );
}

export function WrongNumbers({ rate }: { rate: number }) {
  return (
    <section aria-labelledby="wrong-title">
      <SectionHead title="Wrong numbers" id="wrong-title" />
      <p className="text-state font-semibold leading-none text-steel-100">{pct(rate, 1)}</p>
      <p className="mt-2 max-w-[34ch] text-body text-steel-300">of dials reached the wrong person. This is a data-quality signal about the contact list, not about the script.</p>
    </section>
  );
}

export function ChampionChallenger({ playbook }: { playbook: PlaybookView }) {
  const { champion, challenger } = playbook;
  const max = Math.max(champion.requestRate, challenger?.requestRate ?? 0, 0.01) * 1.2;
  const gap = challenger ? Math.round((challenger.requestRate - champion.requestRate) * 1000) / 10 : 0;
  const early = challenger ? challenger.conversations < challenger.minConversations : false;
  return (
    <section aria-labelledby="cc-title">
      <SectionHead title="Champion against challenger" id="cc-title" />
      <div className="space-y-4">
        <div>
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-body font-semibold text-steel-100">Champion {champion.version}</span>
            <span className="text-body font-semibold text-steel-100">{pct(champion.requestRate, 1)}</span>
          </div>
          <Bar value={champion.requestRate} max={max} settled />
          <p className="mt-1 text-label text-steel-300">
            {int(champion.conversations)} conversations. {champion.summary}
          </p>
        </div>
        {challenger ? (
          <div>
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-body font-semibold text-steel-100">Challenger {challenger.version}</span>
              <span className="text-body font-semibold text-steel-100">{pct(challenger.requestRate, 1)}</span>
            </div>
            <Bar value={challenger.requestRate} max={max} />
            <p className="mt-1 text-label text-steel-300">{challenger.summary}</p>
            <p className={`mt-2 text-body ${early ? 'text-steel-200' : 'font-semibold text-steel-100'}`}>
              {int(challenger.conversations)} of {int(challenger.minConversations)} conversations before any promotion decision.
              {early ? ` Too early to call; it is ${Math.abs(gap)} points ${gap >= 0 ? 'ahead' : 'behind'} so far.` : ` It is ${Math.abs(gap)} points ${gap >= 0 ? 'ahead' : 'behind'}.`}
            </p>
          </div>
        ) : (
          <p className="text-body text-steel-300">No challenger is running. Coach proposes variants weekly.</p>
        )}
      </div>
    </section>
  );
}
