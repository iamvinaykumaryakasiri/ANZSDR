import type { ComponentProps, ReactNode } from 'react';

/* Small shared pieces. No component kit; each is a few classes. */

type Tone = 'solid' | 'sand' | 'outline' | 'quiet';

const TONES: Record<Tone, string> = {
  solid: 'bg-steel-100 text-ink-900 border border-steel-100 hover:bg-steel-200 hover:border-steel-200',
  sand: 'bg-sand-200 text-ink-900 border border-sand-200 hover:bg-sand-300 hover:border-sand-300',
  outline: 'border border-slate-400 text-steel-100 hover:border-steel-200',
  quiet: 'border border-transparent text-steel-200 underline underline-offset-4 decoration-slate-400 hover:text-steel-100'
};

export function Button({
  tone = 'outline',
  className = '',
  ...props
}: ComponentProps<'button'> & { tone?: Tone }) {
  return (
    <button
      type="button"
      {...props}
      className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-control px-4 py-2 text-body font-semibold leading-tight disabled:opacity-50 ${TONES[tone]} ${className}`}
    />
  );
}

/** The tally lamp. Lit means a call is live. It is the only place the red lives besides the top bar and hero rule. */
export function Lamp({ on, size = 'md', className = '' }: { on: boolean; size?: 'sm' | 'md' | 'lg'; className?: string }) {
  const dim = size === 'lg' ? 'size-7' : size === 'md' ? 'size-4' : 'size-2.5';
  return on ? (
    <span
      aria-hidden="true"
      className={`hero-lamp inline-block shrink-0 rounded-lamp bg-tally shadow-[0_0_18px_2px_rgb(255_43_61/0.35)] ${dim} ${className}`}
    />
  ) : (
    <span aria-hidden="true" className={`inline-block shrink-0 rounded-lamp border-2 border-slate-400 ${dim} ${className}`} />
  );
}

export function SectionHead({ title, id, children, className = '' }: { title: string; id?: string; children?: ReactNode; className?: string }) {
  return (
    <div className={`mb-4 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 ${className}`}>
      <h2 id={id} className="text-strong font-semibold text-steel-100">
        {title}
      </h2>
      {children ? <div className="text-label text-steel-300">{children}</div> : null}
    </div>
  );
}

/** A failure, stated plainly. Weight and a heavy rule carry it; there is no error colour. */
export function Failure({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div role="alert" className="flex flex-wrap items-center gap-x-4 gap-y-2 border-l-4 border-steel-100 bg-ink-700 py-2 pl-3 pr-3">
      <p className="min-w-0 flex-1 font-bold text-steel-100">{children}</p>
      {action}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="py-3 text-body text-steel-300">{children}</p>;
}

export function Tag({ children, tone = 'plain', className = '' }: { children: ReactNode; tone?: 'plain' | 'sand' | 'inverse'; className?: string }) {
  const t =
    tone === 'sand'
      ? 'bg-sand-300 text-ink-900'
      : tone === 'inverse'
        ? 'bg-steel-100 text-ink-900'
        : 'border border-slate-400 text-steel-200';
  return <span className={`inline-flex items-center rounded-control px-2 py-0.5 text-label font-semibold leading-snug ${t} ${className}`}>{children}</span>;
}

/** Three notches and a word. Confidence is read, not decoded from a colour. */
export function ConfidenceMeter({ level }: { level: 'high' | 'medium' | 'low' }) {
  const filled = level === 'high' ? 3 : level === 'medium' ? 2 : 1;
  return (
    <span className="inline-flex items-center gap-2">
      <span aria-hidden="true" className="inline-flex items-end gap-0.5">
        {[1, 2, 3].map((n) => (
          <span key={n} className={`w-1.5 rounded-[1px] ${n <= filled ? 'bg-steel-100' : 'bg-slate-500'}`} style={{ height: 6 + n * 4 }} />
        ))}
      </span>
      <span className="text-body font-semibold text-steel-100">{level === 'high' ? 'High' : level === 'medium' ? 'Medium' : 'Low'}</span>
    </span>
  );
}

export function Market({ market }: { market: 'AU' | 'NZ' }) {
  return <span className="rounded-control border border-slate-400 px-1.5 text-label font-semibold text-steel-200">{market}</span>;
}

/**
 * Figures that change while someone is looking at them. Each run of digits is set
 * in tabular figures so it cannot jitter; the punctuation around it stays
 * proportional so "4.62" and "0:47" keep their natural rhythm.
 */
export function Fig({ children }: { children: string | number | null | undefined }) {
  const text = children === null || children === undefined ? '' : String(children);
  const parts = text.split(/(\d+)/);
  return (
    <>
      {parts.map((part, i) =>
        /^\d+$/.test(part) ? (
          <span key={i} className="tnum">
            {part}
          </span>
        ) : (
          part
        )
      )}
    </>
  );
}

export function VisuallyHidden({ children }: { children: ReactNode }) {
  return <span className="sr-only">{children}</span>;
}
