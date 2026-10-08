import { useEffect, useRef, useState } from 'react';
import type { JarvisAnswer } from '../contract';
import { api, ApiError } from '../lib/api';
import { useConsole } from '../state/console';
import { Button } from './ui';

interface Entry {
  id: number;
  query: string;
  state: 'thinking' | 'answered' | 'cancelled' | 'failed';
  answer?: JarvisAnswer;
  failure?: string;
  confirming?: boolean;
}

const EXAMPLES = [
  'Show me every call that died in the first ten seconds this week',
  'Which hook is working in New Zealand?',
  "What's my cost per meeting this month?",
  'Read me the three calls that got closest',
  'Pause the ANZ banking campaign',
  'Roll back to the previous script'
];

function failureText(e: unknown): string {
  return e instanceof ApiError && e.status !== 0 ? e.message : 'Jarvis could not be reached. Nothing was changed.';
}

function Sources({ sources }: { sources: string[] }) {
  return (
    <div className="mt-3">
      <p className="text-label font-semibold text-steel-300">Read from</p>
      {sources.length === 0 ? (
        <p className="text-label text-steel-300">Nothing. This answer is not backed by any record.</p>
      ) : (
        <ul className="mt-0.5 list-disc pl-5 text-label text-steel-200">
          {sources.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Result({ entry, onConfirm, onCancel }: { entry: Entry; onConfirm: () => void; onCancel: () => void }) {
  if (entry.state === 'thinking') return <p className="text-body text-steel-300">Reading the blackboard.</p>;
  if (entry.state === 'cancelled') return <p className="text-body font-semibold text-steel-100">Cancelled. Nothing was changed.</p>;
  if (entry.state === 'failed') return <p className="border-l-4 border-steel-100 pl-3 font-bold text-steel-100">{entry.failure}</p>;
  const a = entry.answer;
  if (!a) return null;

  if (a.kind === 'refused') {
    return (
      <div className="border-l-4 border-steel-100 pl-3">
        <p className="font-bold text-steel-100">Jarvis won't do that.</p>
        <p className="mt-1 text-body text-steel-200">{a.text}</p>
        <Sources sources={a.sources} />
      </div>
    );
  }

  if (a.kind === 'needs_confirmation') {
    // Fail closed: a confirmation that cannot say what it will do is not offered.
    if (!a.action || a.action.description.trim() === '' || a.action.actionId.trim() === '') {
      return (
        <div className="border-l-4 border-steel-100 pl-3">
          <p className="font-bold text-steel-100">Jarvis asked for confirmation but did not say what it would do.</p>
          <p className="mt-1 text-body text-steel-200">Nothing was done, and nothing can be confirmed. Ask again more specifically.</p>
        </div>
      );
    }
    return (
      <div role="group" aria-label="Confirm this action" className="border-2 border-steel-100 p-4">
        <p className="text-body text-steel-200">{a.text}</p>
        <p className="mt-3 text-label font-semibold text-steel-300">If you confirm, this will happen</p>
        <p className="mt-1 text-strong font-bold text-steel-100">{a.action.description}</p>
        <p className="mt-2 text-label text-steel-300">Nothing has happened yet.</p>
        <Sources sources={a.sources} />
        <div className="mt-4 flex flex-wrap gap-2">
          <Button tone="solid" disabled={entry.confirming} onClick={onConfirm}>
            {entry.confirming ? 'Doing it…' : 'Confirm'}
          </Button>
          <Button disabled={entry.confirming} onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div>
      {a.kind === 'done' ? <p className="mb-1 text-label font-bold text-steel-100">Done</p> : null}
      <p className="whitespace-pre-wrap text-body text-steel-100">{a.text}</p>
      <Sources sources={a.sources} />
    </div>
  );
}

export function Jarvis({ open, onClose }: { open: boolean; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState('');
  const [entries, setEntries] = useState<Entry[]>([]);
  const next = useRef(1);
  const { refresh } = useConsole();

  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
      input.current?.focus();
    }
    if (!open && d.open) d.close();
  }, [open]);

  useEffect(() => {
    end.current?.scrollIntoView({ block: 'nearest' });
  }, [entries]);

  const patch = (id: number, p: Partial<Entry>) => setEntries((es) => es.map((e) => (e.id === id ? { ...e, ...p } : e)));

  const ask = async (text: string) => {
    const q = text.trim();
    if (q === '') return;
    const id = next.current++;
    setEntries((es) => [...es, { id, query: q, state: 'thinking' }]);
    setQuery('');
    try {
      const answer = await api.jarvis(q);
      patch(id, { state: 'answered', answer });
    } catch (e) {
      patch(id, { state: 'failed', failure: failureText(e) });
    }
  };

  const confirm = async (entry: Entry) => {
    const actionId = entry.answer?.action?.actionId;
    if (!actionId) return;
    patch(entry.id, { confirming: true });
    try {
      const answer = await api.jarvisConfirm(actionId);
      patch(entry.id, { state: 'answered', answer, confirming: false });
      void refresh();
    } catch (e) {
      patch(entry.id, { state: 'failed', failure: failureText(e), confirming: false });
    }
  };

  return (
    <dialog
      ref={dialog}
      aria-labelledby="jarvis-title"
      onClose={onClose}
      onClick={(e) => {
        if (e.target === dialog.current) onClose();
      }}
      className="m-0 mx-auto mt-[8vh] max-h-[84dvh] w-[min(46rem,calc(100vw-2rem))] overflow-hidden border-2 border-steel-100 bg-ink-800 p-0 text-steel-200 backdrop:bg-ink-900/80"
    >
      <div className="flex max-h-[84dvh] flex-col">
        <div className="flex items-center justify-between gap-4 border-b border-slate-500 px-5 py-3">
          <h2 id="jarvis-title" className="text-strong font-semibold text-steel-100">
            Ask Jarvis
          </h2>
          <button type="button" onClick={onClose} className="min-h-10 rounded-control border border-slate-400 px-3 text-label font-semibold text-steel-100">
            Close
          </button>
        </div>

        <div className="min-h-[8rem] flex-1 overflow-y-auto px-5 py-4" aria-live="polite">
          {entries.length === 0 ? (
            <div>
              <p className="max-w-[56ch] text-body text-steel-200">
                Ask about anything on the blackboard and the answer shows what it was read from. Ask for a change and you will see exactly what it would do before anything happens.
              </p>
              <ul className="mt-4 flex flex-wrap gap-2">
                {EXAMPLES.map((ex) => (
                  <li key={ex}>
                    <button
                      type="button"
                      onClick={() => {
                        setQuery(ex);
                        input.current?.focus();
                      }}
                      className="min-h-10 rounded-control border border-slate-400 px-3 py-1 text-left text-label text-steel-200"
                    >
                      {ex}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <ol className="space-y-6">
              {entries.map((e) => (
                <li key={e.id}>
                  <p className="speech mb-2 text-speech text-steel-100">“{e.query}”</p>
                  <Result entry={e} onConfirm={() => void confirm(e)} onCancel={() => patch(e.id, { state: 'cancelled' })} />
                </li>
              ))}
            </ol>
          )}
          <div ref={end} />
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void ask(query);
          }}
          className="flex gap-2 border-t border-slate-500 px-5 py-4"
        >
          <label className="sr-only" htmlFor="jarvis-input">
            Ask or tell Jarvis
          </label>
          <input
            id="jarvis-input"
            ref={input}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoComplete="off"
            placeholder="Ask a question, or tell it what to do"
            className="min-h-11 min-w-0 flex-1 rounded-control border border-slate-400 bg-ink-900 px-3 text-body text-steel-100 placeholder:text-slate-300"
          />
          <Button tone="solid" type="submit" disabled={query.trim() === ''}>
            Ask
          </Button>
        </form>
      </div>
    </dialog>
  );
}
