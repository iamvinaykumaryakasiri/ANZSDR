import type { QueueItemView } from '../contract';
import { gateReasonText } from '../lib/format';
import { dayTimeIn, SYDNEY } from '../lib/time';
import { Empty, Market, SectionHead } from './ui';

export function UpNext({ items, note }: { items: QueueItemView[]; note?: string }) {
  return (
    <section aria-labelledby="upnext-title">
      <SectionHead title="Up next" id="upnext-title">
        {items.length > 0 ? `${items.length} in the queue` : null}
      </SectionHead>
      {note ? <p className="mb-3 text-label text-steel-300">{note}</p> : null}
      {items.length === 0 ? <Empty>The queue is empty.</Empty> : null}
      <ol className="divide-y divide-slate-500">
        {items.map((q) => (
          <li key={q.contactId} className="py-3 first:pt-0">
            <p className="text-body font-semibold text-steel-100">
              {q.name} <Market market={q.market} />
            </p>
            <p className="text-label text-steel-300">
              {q.title} at {q.company}
            </p>
            {q.gate.allowed ? (
              <p className="mt-1.5 flex items-center gap-2 text-label text-steel-200">
                <span aria-hidden="true" className="inline-block size-2.5 bg-steel-300" />
                Cleared by the gate
                {q.earliestLawfulAt ? `, earliest ${dayTimeIn(q.earliestLawfulAt, SYDNEY)} Sydney` : ''}
              </p>
            ) : (
              <div className="mt-1.5 flex items-start gap-2">
                <span aria-hidden="true" className="mt-1 inline-block size-2.5 shrink-0 border-2 border-steel-100" />
                <div>
                  <p className="text-label font-bold text-steel-100">Held</p>
                  <ul>
                    {q.gate.reasons.map((r) => (
                      <li key={r} className="text-label font-semibold text-steel-100">
                        {gateReasonText(r)}
                      </li>
                    ))}
                  </ul>
                  {q.earliestLawfulAt ? (
                    <p className="text-label text-steel-300">Earliest lawful {dayTimeIn(q.earliestLawfulAt, SYDNEY)} Sydney</p>
                  ) : null}
                </div>
              </div>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
