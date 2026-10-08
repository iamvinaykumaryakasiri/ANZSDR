import { useMemo, useState } from 'react';
import type { FunnelStageId } from '../contract';
import { Funnel } from '../components/Funnel';
import { HangupCurve } from '../components/HangupCurve';
import { Hero } from '../components/Hero';
import { NeedsYou } from '../components/Needs';
import { ChampionChallenger, Gatekeepers, Objections, WrongNumbers } from '../components/Reading';
import { Today } from '../components/Today';
import { UpNext } from '../components/UpNext';
import { Button, SectionHead } from '../components/ui';
import { askStartsAt, isFiltering, matchingCallIds, NO_SEGMENTS, type Segments } from '../lib/callFilter';
import { plural } from '../lib/format';
import { useConsole } from '../state/console';

export function Home() {
  const { snapshot, calls } = useConsole();
  const [stage, setStage] = useState<FunnelStageId | null>(null);
  const [segments, setSegments] = useState<Segments>(NO_SEGMENTS);

  const confirmedCallIds = useMemo(
    () => new Set((snapshot?.needsYou.meetingRequests ?? []).filter((m) => m.status === 'confirmed').map((m) => m.callId)),
    [snapshot?.needsYou.meetingRequests]
  );

  const matching = useMemo(() => {
    if (!snapshot) return null;
    return matchingCallIds(calls ?? [], { stage, segments }, { askFromSecond: askStartsAt(snapshot.hangupCurve), confirmedCallIds });
  }, [snapshot, calls, stage, segments, confirmedCallIds]);

  if (!snapshot) return null;

  const filtering = isFiltering({ stage, segments });
  const stageLabel = snapshot.funnel.find((f) => f.id === stage)?.label;
  const queueStage = stage === 'queued' || stage === 'gate_passed';
  const queue = stage === 'gate_passed' ? snapshot.upNext.filter((q) => q.gate.allowed) : snapshot.upNext;
  const clear = () => {
    setStage(null);
    setSegments(NO_SEGMENTS);
  };

  return (
    <div className="grid gap-x-10 gap-y-12 wide:grid-cols-[minmax(0,1fr)_21rem] broad:grid-cols-[minmax(0,1fr)_23rem]">
      <h1 className="sr-only">Home</h1>

      <div className="min-w-0 space-y-12">
        <Hero />

        <section aria-labelledby="drop-title">
          <SectionHead title="Where they drop" id="drop-title">
            Against the trailing seven days
          </SectionHead>

          {filtering ? (
            <div role="status" className="mb-5 flex flex-wrap items-center justify-between gap-3 border-l-4 border-steel-100 bg-ink-800 py-2 pl-3 pr-2">
              <p className="text-body font-semibold text-steel-100">
                {queueStage
                  ? `Showing the queue at "${stageLabel}": ${queue.length} of ${snapshot.upNext.length} people.`
                  : `Filtered to ${matching ? plural(matching.size, 'call') : 'calls'}${stageLabel ? ` that reached "${stageLabel}"` : ''}${
                      Object.values(segments).some(Boolean) ? `, ${Object.values(segments).filter(Boolean).join(', ')}` : ''
                    }. The curve and the queue follow.`}
              </p>
              <Button className="min-h-10" onClick={clear}>
                Clear filters
              </Button>
            </div>
          ) : null}

          <div className="grid gap-x-10 gap-y-10 broad:grid-cols-12">
            <div className="min-w-0 broad:col-span-5">
              <h3 className="mb-3 text-body font-semibold text-steel-100">Stage funnel</h3>
              <Funnel funnel={snapshot.funnel} selected={stage} onSelect={setStage} />
            </div>
            <div className="min-w-0 broad:col-span-7">
              <h3 className="mb-3 text-body font-semibold text-steel-100">Seconds to hang-up</h3>
              <HangupCurve curve={snapshot.hangupCurve} calls={calls} matching={matching} segments={segments} onSegments={setSegments} />
            </div>
          </div>
        </section>

        <Today today={snapshot.today} />

        <div className="grid gap-x-10 gap-y-10 tablet:grid-cols-2">
          <Objections items={snapshot.objections} />
          <Gatekeepers items={snapshot.gatekeeperByAccount} />
          <WrongNumbers rate={snapshot.wrongNumberRate} />
          <ChampionChallenger playbook={snapshot.playbook} />
        </div>
      </div>

      <aside aria-label="What needs you, and what is next" className="min-w-0 space-y-12 wide:sticky wide:top-[5.5rem] wide:max-h-[calc(100dvh-6.5rem)] wide:self-start wide:overflow-y-auto wide:border-l wide:border-slate-500 wide:pl-8">
        <NeedsYou />
        <UpNext items={queue} />
      </aside>
    </div>
  );
}
