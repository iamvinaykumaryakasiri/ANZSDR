import type { ProviderStatus } from '../contract';
import { Empty, Fig } from '../components/ui';
import { gateReasonText, int, usd } from '../lib/format';
import { useConsole } from '../state/console';

const STATUS: Record<ProviderStatus, { label: string; rank: number }> = {
  down: { label: 'Down', rank: 0 },
  degraded: { label: 'Degraded', rank: 1 },
  not_configured: { label: 'Not set up', rank: 2 },
  ok: { label: 'Working', rank: 3 }
};

/** Four statuses, four shapes, each with its word. No colour is used to say which. */
function StatusShape({ status }: { status: ProviderStatus }) {
  const common = 'size-4 shrink-0';
  switch (status) {
    case 'down':
      return (
        <svg aria-hidden="true" viewBox="0 0 16 16" className={common}>
          <rect x="1" y="1" width="14" height="14" className="fill-steel-100" />
        </svg>
      );
    case 'degraded':
      return (
        <svg aria-hidden="true" viewBox="0 0 16 16" className={common}>
          <rect x="1.5" y="1.5" width="13" height="13" className="fill-none stroke-steel-100" strokeWidth="2" />
          <rect x="1.5" y="8" width="13" height="6.5" className="fill-steel-100" />
        </svg>
      );
    case 'not_configured':
      return (
        <svg aria-hidden="true" viewBox="0 0 16 16" className={common}>
          <rect x="1.5" y="1.5" width="13" height="13" className="fill-none stroke-slate-300" strokeWidth="2" strokeDasharray="3 2" />
        </svg>
      );
    case 'ok':
      return (
        <svg aria-hidden="true" viewBox="0 0 16 16" className={common}>
          <circle cx="8" cy="8" r="6" className="fill-none stroke-steel-300" strokeWidth="2" />
        </svg>
      );
  }
}

export function Health() {
  const { snapshot } = useConsole();
  if (!snapshot) return null;
  const { health } = snapshot;
  const providers = [...health.providers].sort((a, b) => STATUS[a.status].rank - STATUS[b.status].rank || a.name.localeCompare(b.name));
  const rejections = [...health.gateRejections].sort((a, b) => b.count - a.count);
  const maxRej = rejections[0]?.count ?? 0;
  const ceiling = health.spendCeilingUsd;
  const used = ceiling && ceiling > 0 ? Math.min(1, health.spendMonthUsd / ceiling) : null;

  return (
    <div>
      <h1 className="text-statement font-semibold text-steel-100">Health</h1>
      <p className="mt-1 text-body text-steel-300">What is running, what it is costing, and what the compliance gate has been refusing.</p>

      <div className="mt-8 grid gap-x-12 gap-y-10 wide:grid-cols-2">
        <section aria-labelledby="prov-title">
          <h2 id="prov-title" className="mb-3 text-strong font-semibold text-steel-100">Providers</h2>
          {providers.length === 0 ? <Empty>No providers reported.</Empty> : null}
          <ul className="divide-y divide-slate-500 border-y border-slate-500">
            {providers.map((p) => (
              <li key={p.name} className={`flex items-start gap-3 py-3 ${p.status === 'down' || p.status === 'degraded' ? 'border-l-4 border-steel-100 pl-3' : 'pl-0'}`}>
                <span className="mt-1">
                  <StatusShape status={p.status} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className={`text-body ${p.status === 'down' ? 'font-bold' : 'font-semibold'} text-steel-100`}>
                    {p.name} <span className="font-normal text-steel-300">{STATUS[p.status].label}</span>
                  </p>
                  {p.detail ? <p className="text-label text-steel-300">{p.detail}</p> : null}
                </div>
              </li>
            ))}
          </ul>
        </section>

        <section aria-labelledby="num-title">
          <h2 id="num-title" className="mb-3 text-strong font-semibold text-steel-100">Money and queue</h2>
          <dl className="grid grid-cols-2 gap-px bg-slate-500">
            <div className="bg-ink-900 py-3 pr-3">
              <dt className="text-label text-steel-300">Queue depth</dt>
              <dd className="mt-1 text-statement font-semibold text-steel-100"><Fig>{int(health.queueDepth)}</Fig></dd>
            </div>
            <div className="bg-ink-900 px-3 py-3">
              <dt className="text-label text-steel-300">Apollo credits left</dt>
              <dd className="mt-1 text-statement font-semibold text-steel-100">{health.apolloCreditsRemaining === null ? 'Unknown' : <Fig>{int(health.apolloCreditsRemaining)}</Fig>}</dd>
            </div>
          </dl>
          <div className="mt-6">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="text-body font-semibold text-steel-100">Spend this month</p>
              <p className="text-body text-steel-200">
                {usd(health.spendMonthUsd)}
                {ceiling !== null ? ` of ${usd(ceiling)} ceiling` : ', no ceiling set'}
              </p>
            </div>
            {used !== null ? (
              <span aria-hidden="true" className="relative mt-2 block h-3 bg-slate-500/50">
                <span className="absolute inset-y-0 left-0 bg-steel-300" style={{ width: `${used * 100}%` }} />
              </span>
            ) : null}
            {used !== null ? <p className="mt-1 text-label text-steel-300">{Math.round(used * 100)}% of the monthly ceiling used.</p> : null}
          </div>
        </section>

        <section aria-labelledby="rej-title" className="wide:col-span-2">
          <h2 id="rej-title" className="mb-3 text-strong font-semibold text-steel-100">What the compliance gate refused</h2>
          {rejections.length === 0 ? <Empty>The gate has refused nothing.</Empty> : null}
          <ol className="max-w-[48rem] space-y-3">
            {rejections.map((r) => (
              <li key={r.reason}>
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-body font-semibold text-steel-100">{gateReasonText(r.reason)}</span>
                  <span className="text-body font-semibold text-steel-100">{int(r.count)}</span>
                </div>
                <span aria-hidden="true" className="relative mt-1 block h-2.5 bg-slate-500/50">
                  <span className="absolute inset-y-0 left-0 bg-steel-300" style={{ width: `${maxRej > 0 ? (r.count / maxRej) * 100 : 0}%` }} />
                </span>
              </li>
            ))}
          </ol>
        </section>
      </div>
    </div>
  );
}
