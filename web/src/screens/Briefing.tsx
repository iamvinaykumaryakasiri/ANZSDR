import { useEffect, useState } from 'react';
import { Button } from '../components/ui';
import { dayTimeIn, SYDNEY } from '../lib/time';
import { useConsole } from '../state/console';

export function Briefing({ onDone }: { onDone: () => void }) {
  const { snapshot } = useConsole();
  const [speaking, setSpeaking] = useState(false);
  const canSpeak = typeof window !== 'undefined' && 'speechSynthesis' in window;

  useEffect(
    () => () => {
      if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    },
    []
  );

  if (!snapshot) return null;
  const { briefing } = snapshot;

  const toggle = () => {
    if (!canSpeak) return;
    const synth = window.speechSynthesis;
    if (speaking) {
      synth.cancel();
      setSpeaking(false);
      return;
    }
    const text = [briefing.headline, ...briefing.sections.map((s) => `${s.title}. ${s.body}`)].join('\n\n');
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'en-AU';
    utterance.rate = 1;
    utterance.onend = () => setSpeaking(false);
    utterance.onerror = () => setSpeaking(false);
    synth.cancel();
    synth.speak(utterance);
    setSpeaking(true);
  };

  return (
    <div className="mx-auto max-w-[44rem]">
      <p className="text-label text-steel-300">Morning briefing, written {dayTimeIn(briefing.generatedAt, SYDNEY)} Sydney</p>
      <h1 className="mt-2 text-statement font-semibold leading-tight text-steel-100 phone:text-state">{briefing.headline}</h1>

      <div className="mt-6 flex flex-wrap items-center gap-3">
        {canSpeak ? (
          <Button tone="solid" onClick={toggle} aria-pressed={speaking}>
            {speaking ? 'Stop reading' : 'Read it aloud'}
          </Button>
        ) : (
          <p className="text-label text-steel-300">This browser cannot read aloud.</p>
        )}
        <Button
          onClick={() => {
            if (canSpeak) window.speechSynthesis.cancel();
            onDone();
          }}
        >
          Open the console
        </Button>
      </div>

      <div className="mt-10 space-y-8">
        {briefing.sections.map((s) => (
          <section key={s.title} aria-label={s.title}>
            <h2 className="mb-2 text-strong font-semibold text-steel-100">{s.title}</h2>
            <div className="space-y-3 text-strong text-steel-200">
              {s.body.split(/\n{2,}/).map((p, i) => (
                <p key={i} className="max-w-[62ch]">
                  {p}
                </p>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
