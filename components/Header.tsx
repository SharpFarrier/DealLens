'use client';
import { useEffect, useRef, useState } from 'react';
import type { DealData } from '@/lib/useDealData';
import type { Member } from '@/lib/auth';

const time = (iso: string) => new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const initials = (email: string) => email.split('@')[0].replace(/[^a-z]/gi, '').slice(0, 2).toUpperCase() || '?';

export default function Header({ me, data, syncing, onSync }: {
  me: Member; data?: DealData; syncing?: boolean; onSync?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, []);

  let pill: React.ReactNode = null;
  if (data) {
    const last = data.lastSync, ok = data.lastOkSync;
    if (syncing || last?.status === 'running') pill = <span className="sync busy">Syncing sheet…</span>;
    else if (last?.status === 'error') pill = <span className="sync bad" title={last.error || ''}>Sheet sync failed: {last.error}</span>;
    else if (ok?.finished_at) pill = <span className="sync">Sheet synced {time(ok.finished_at)} · {data.items.length} products</span>;
    else pill = <span className="sync mut">Not synced yet</span>;
  }

  return (
    <div className="hdr">
      <a href="/" className="brand" style={{ color: 'inherit', textDecoration: 'none' }}>DealLens<small>{data?.settings.event || ''}</small></a>
      <div className="sp" />
      {pill}
      {onSync && <button className="btn" style={{ height: 30, fontSize: 12.5 }} onClick={onSync} disabled={syncing}>Sync now</button>}
      <div className="menu" ref={ref}>
        <button className="av" aria-label="Account" onClick={() => setOpen(o => !o)}>{initials(me.email)}</button>
        {open && (
          <div className="pop">
            <div className="who">{me.email}<br />{me.role === 'admin' ? 'Owner' : 'DispatchLens user'}</div>
            <form action="/auth/signout" method="post"><button className="btn" type="submit">Sign out</button></form>
          </div>
        )}
      </div>
    </div>
  );
}
