'use client';
import { barTone, type Bar } from '@/lib/views';

export function RefreshIcon({ spin }: { spin?: boolean }) {
  return (
    <svg className={spin ? 'spin' : ''} width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 11a8.1 8.1 0 0 0-15.5-2M4 4v5h5" /><path d="M4 13a8.1 8.1 0 0 0 15.5 2M20 20v-5h-5" />
    </svg>
  );
}

export function ExtLink({ href }: { href: string }) {
  return (
    <a className="ext" href={href} target="_blank" rel="noreferrer" aria-label="Open listing" onClick={e => e.stopPropagation()}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 6H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6" /><path d="M11 13l9-9M15 4h5v5" />
      </svg>
    </a>
  );
}

// The one main button on every tab.
export function CheckAllButton({ busy, onClick }: { busy: { done: number; total: number } | null; onClick: () => void }) {
  return (
    <button className="btn primary" onClick={onClick} disabled={!!busy}>
      <RefreshIcon spin={!!busy} />
      {busy ? <span className="num-t">Checking {busy.done} / {busy.total}</span> : 'Check all'}
    </button>
  );
}

const dayLabel = (d: string) => {
  const today = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
  if (d === today) return 'Today';
  return new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
};
export function barText(name: string, b: Bar): string {
  if (b.down === null) return `${name} · ${dayLabel(b.day)} · not checked`;
  return `${name} · ${dayLabel(b.day)} · ${b.down === 0 ? `all ${b.checked} live` : `${b.down} of ${b.checked} down`}`;
}

// 30 days of status, one bar per day (Better Stack style).
export function Strip({ bars, amberUpTo, name, small, onHover }: {
  bars: Bar[]; amberUpTo: number; name: string; small?: boolean; onHover?: (t: string | null) => void;
}) {
  return (
    <div className={'strip' + (small ? ' sm' : '')} onMouseLeave={() => onHover?.(null)}>
      {bars.map(b => (
        <i key={b.day} className={'b-' + barTone(b, amberUpTo)} title={barText(name, b)} onMouseEnter={() => onHover?.(barText(name, b))} />
      ))}
    </div>
  );
}
