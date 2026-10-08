import type { TodayView } from '../contract';
import { int, usd } from '../lib/format';
import { Fig, SectionHead } from './ui';

/** A flat strip of figures, not a row of cards. */
export function Today({ today, compact = false }: { today: TodayView; compact?: boolean }) {
  const items: Array<{ label: string; value: string; note?: string; sand?: boolean }> = [
    { label: 'Dialled', value: int(today.dialled) },
    { label: 'Connected', value: int(today.connected) },
    { label: 'Conversations', value: int(today.conversations) },
    { label: 'Meeting requests', value: int(today.requests), sand: true },
    { label: 'Spend', value: usd(today.spendUsd) },
    {
      label: 'Cost per meeting',
      value: today.costPerMeetingUsd === null ? '-' : usd(today.costPerMeetingUsd),
      note: today.costPerMeetingUsd === null ? 'No meetings yet' : undefined
    }
  ];
  return (
    <section aria-labelledby="today-title">
      <SectionHead title="Today" id="today-title" />
      <dl className={`grid ${compact ? 'grid-cols-2' : 'grid-cols-2 tablet:grid-cols-3 broad:grid-cols-6'} gap-px bg-slate-500`}>
        {items.map((it) => (
          <div key={it.label} className="bg-ink-900 px-3 py-3">
            <dt className="text-label text-steel-300">{it.label}</dt>
            <dd className={`mt-1 ${compact ? 'text-statement' : 'text-statement'} font-semibold ${it.sand ? 'text-sand-300' : 'text-steel-100'}`}>
              <Fig>{it.value}</Fig>
            </dd>
            {it.note ? <dd className="text-label text-steel-300">{it.note}</dd> : null}
          </div>
        ))}
      </dl>
    </section>
  );
}
