import { useMemo } from 'react';
import { Empty, Tag } from '../components/ui';
import { outcomeText, plural } from '../lib/format';
import { useConsole } from '../state/console';

interface Row {
  company: string;
  calls: number;
  blocks: number;
  queued: string[];
  held: number;
  requests: number;
  pendingRequests: number;
  escalations: number;
  lastOutcome: string | null;
}

/**
 * The console feed has no accounts table, so this is a roll-up of what it does
 * carry: the call log, the queue, gatekeeper blocks and the meeting desk, grouped
 * by company. It never invents a field.
 */
export function Accounts() {
  const { snapshot, calls } = useConsole();

  const rows = useMemo<Row[]>(() => {
    if (!snapshot) return [];
    const map = new Map<string, Row>();
    const get = (company: string): Row => {
      let r = map.get(company);
      if (!r) {
        r = { company, calls: 0, blocks: 0, queued: [], held: 0, requests: 0, pendingRequests: 0, escalations: 0, lastOutcome: null };
        map.set(company, r);
      }
      return r;
    };
    const newest = new Map<string, number>();
    for (const c of calls ?? []) {
      const r = get(c.company);
      r.calls += 1;
      const t = Date.parse(c.startedAt);
      if ((newest.get(c.company) ?? -Infinity) < t) {
        newest.set(c.company, t);
        r.lastOutcome = c.outcome;
      }
    }
    for (const g of snapshot.gatekeeperByAccount) get(g.company).blocks = g.blocks;
    for (const q of snapshot.upNext) {
      const r = get(q.company);
      r.queued.push(q.name);
      if (!q.gate.allowed) r.held += 1;
    }
    for (const m of snapshot.needsYou.meetingRequests) {
      const r = get(m.company);
      r.requests += 1;
      if (m.status === 'pending') r.pendingRequests += 1;
    }
    for (const e of snapshot.needsYou.escalations) get(e.company).escalations += 1;
    return [...map.values()].sort(
      (a, b) => b.escalations - a.escalations || b.pendingRequests - a.pendingRequests || b.calls - a.calls || a.company.localeCompare(b.company)
    );
  }, [snapshot, calls]);

  if (!snapshot) return null;

  return (
    <div>
      <h1 className="text-statement font-semibold text-steel-100">Accounts</h1>
      <p className="mt-1 max-w-[70ch] text-body text-steel-300">
        Each organisation we are working, rolled up from the calls, the queue and the meeting desk. Accounts that need you come first.
      </p>
      {rows.length === 0 ? (
        <div className="mt-6">
          <Empty>No accounts have been worked yet.</Empty>
        </div>
      ) : (
        <table className="mt-6 w-full max-w-[64rem] border-collapse text-left text-body">
          <thead>
            <tr className="border-b border-slate-400 text-label text-steel-300">
              <th scope="col" className="py-2 pr-3 font-medium">Account</th>
              <th scope="col" className="py-2 pr-3 text-right font-medium">Calls</th>
              <th scope="col" className="py-2 pr-3 text-right font-medium">Gatekeeper blocks</th>
              <th scope="col" className="py-2 pr-3 font-medium">In the queue</th>
              <th scope="col" className="py-2 pr-3 font-medium">Meeting requests</th>
              <th scope="col" className="hidden py-2 font-medium tablet:table-cell">Last outcome</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.company} className="border-b border-slate-500 align-top">
                <th scope="row" className="py-3 pr-3 font-semibold text-steel-100">
                  {r.company}
                  {r.escalations > 0 ? <span className="ml-2 font-bold">{plural(r.escalations, 'escalation')}</span> : null}
                </th>
                <td className="py-3 pr-3 text-right text-steel-200">{r.calls}</td>
                <td className="py-3 pr-3 text-right text-steel-200">{r.blocks}</td>
                <td className="py-3 pr-3 text-steel-200">
                  {r.queued.length === 0 ? <span className="text-steel-300">None</span> : r.queued.join(', ')}
                  {r.held > 0 ? <span className="block text-label font-bold text-steel-100">{r.held} held by the gate</span> : null}
                </td>
                <td className="py-3 pr-3">
                  {r.requests === 0 ? (
                    <span className="text-steel-300">None</span>
                  ) : (
                    <Tag tone={r.pendingRequests > 0 ? 'inverse' : 'sand'}>
                      {r.pendingRequests > 0 ? `${r.pendingRequests} waiting` : plural(r.requests, 'request')}
                    </Tag>
                  )}
                </td>
                <td className="hidden py-3 text-steel-200 tablet:table-cell">{r.lastOutcome ? outcomeText(r.lastOutcome) : <span className="text-steel-300">No calls</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="mt-6 max-w-[70ch] text-label text-steel-300">
        Attempts remaining and what has been learned about each account are not part of the console feed yet, so they are not shown.
      </p>
    </div>
  );
}
