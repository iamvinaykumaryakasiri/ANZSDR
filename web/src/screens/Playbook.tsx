import type { PlaybookOutcome } from '../contract';
import { ChampionChallenger } from '../components/Reading';
import { Tag } from '../components/ui';
import { dayTimeIn, SYDNEY } from '../lib/time';
import { useConsole } from '../state/console';

const OUTCOME: Record<PlaybookOutcome, { label: string; tone: 'sand' | 'inverse' | 'plain' }> = {
  champion: { label: 'Champion', tone: 'sand' },
  promoted: { label: 'Promoted', tone: 'sand' },
  rolled_back: { label: 'Rolled back', tone: 'plain' },
  rejected: { label: 'Rejected by the gate', tone: 'plain' },
  running: { label: 'Running now', tone: 'inverse' }
};

export function Playbook() {
  const { snapshot } = useConsole();
  if (!snapshot) return null;
  const { playbook } = snapshot;
  return (
    <div>
      <h1 className="text-statement font-semibold text-steel-100">Playbook</h1>
      <p className="mt-1 max-w-[70ch] text-body text-steel-300">
        The script Lexi is using, the variant being tested against it, and every change Coach has made. The opening, the AI disclosure and the recording announcement are never part of a test.
      </p>

      <div className="mt-8 grid gap-x-12 gap-y-10 wide:grid-cols-2">
        <ChampionChallenger playbook={playbook} />

        <section aria-labelledby="hist-title">
          <h2 id="hist-title" className="mb-4 text-strong font-semibold text-steel-100">
            Version history
          </h2>
          <ol className="border-l-2 border-slate-500">
            {[...playbook.history]
              .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
              .map((h) => {
                const o = OUTCOME[h.outcome];
                return (
                  <li key={`${h.version}-${h.at}`} className="relative pb-6 pl-6">
                    <span
                      aria-hidden="true"
                      className={`absolute -left-[7px] top-1.5 size-3 ${h.outcome === 'running' ? 'border-2 border-steel-100 bg-ink-900' : 'bg-steel-300'}`}
                    />
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span className="text-body font-bold text-steel-100">{h.version}</span>
                      <Tag tone={o.tone}>{o.label}</Tag>
                      <span className="text-label text-steel-300">{dayTimeIn(h.at, SYDNEY)} Sydney</span>
                    </div>
                    <p className="mt-1 max-w-[60ch] text-body text-steel-200">{h.note}</p>
                  </li>
                );
              })}
          </ol>
        </section>
      </div>
    </div>
  );
}
