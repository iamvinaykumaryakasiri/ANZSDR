import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

interface NoticeApi {
  notify: (text: string) => void;
}

const NoticeContext = createContext<NoticeApi>({ notify: () => undefined });

/** A single status line for results of actions whose row has just left the page. */
export function NoticeProvider({ children }: { children: ReactNode }) {
  const [notice, setNotice] = useState<{ id: number; text: string } | null>(null);
  const notify = useCallback((text: string) => setNotice({ id: Date.now(), text }), []);

  useEffect(() => {
    if (!notice) return;
    const id = setTimeout(() => setNotice(null), 9000);
    return () => clearTimeout(id);
  }, [notice]);

  const api = useMemo(() => ({ notify }), [notify]);
  return (
    <NoticeContext.Provider value={api}>
      {children}
      <div role="status" aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-24 z-40 flex justify-center px-4 phone:bottom-6 phone:justify-start">
        {notice ? (
          <p className="pointer-events-auto flex max-w-xl items-center gap-4 border-2 border-sand-300 bg-ink-800 py-2 pl-4 pr-2 text-body font-semibold text-sand-200">
            <span>{notice.text}</span>
            <button
              type="button"
              onClick={() => setNotice(null)}
              className="min-h-10 shrink-0 rounded-control border border-slate-400 px-3 text-label text-steel-100"
            >
              Dismiss
            </button>
          </p>
        ) : null}
      </div>
    </NoticeContext.Provider>
  );
}

export function useNotice(): NoticeApi {
  return useContext(NoticeContext);
}
