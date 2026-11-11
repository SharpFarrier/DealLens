'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDealData } from '@/lib/useDealData';
import { apiFetch } from '@/lib/device';
import type { Member } from '@/lib/auth';
import { crossRows, isWrong, listings, priceRows, statusRows, whenLabel, type StatusRow } from '@/lib/views';
import LiveStatus from '@/components/LiveStatus';
import Pricing from '@/components/Pricing';
import CrossCheck from '@/components/CrossCheck';
import OwnerSettings from '@/components/OwnerSettings';
import { RefreshIcon } from '@/components/ui';

type Tab = 'live' | 'pricing' | 'cross';
const TABS: [Tab, string, string][] = [['live', 'Live status', 'Live'], ['pricing', 'Pricing check', 'Pricing'], ['cross', 'Amazon vs Flipkart', 'A vs F']];
// Small batches, one at a time: the server spreads each batch over SCRAPINGDOG_CONCURRENCY requests.
const BATCH = 6;
const initials = (email: string) => email.split('@')[0].replace(/[^a-z]/gi, '').slice(0, 2).toUpperCase() || '?';

export default function DealLensApp({ me }: { me: Member }) {
  const { data, reload, patchLocal } = useDealData();
  const [tab, setTabState] = useState<Tab>('live');
  const [busy, setBusy] = useState<{ done: number; total: number } | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [menu, setMenu] = useState(false);
  const [toastMsg, setToastMsg] = useState('');
  const toastT = useRef<ReturnType<typeof setTimeout> | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try { const t = localStorage.getItem('deallens:tab5'); if (t === 'live' || t === 'pricing' || t === 'cross') setTabState(t); } catch { /* storage blocked */ }
    const close = (e: MouseEvent) => { if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenu(false); };
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, []);
  const setTab = (t: Tab) => { setTabState(t); window.scrollTo({ top: 0 }); try { localStorage.setItem('deallens:tab5', t); } catch { /* storage blocked */ } };

  const toast = useCallback((m: string) => {
    setToastMsg(m);
    if (toastT.current) clearTimeout(toastT.current);
    toastT.current = setTimeout(() => setToastMsg(''), 3500);
  }, []);
  useEffect(() => { if (data.error) toast(data.error); }, [data.error, toast]);

  // ---------- sheet sync ----------
  const sync = useCallback(async (auto = false) => {
    setSyncing(true);
    try {
      const res = await apiFetch('/api/sync', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ auto }) });
      const j = await res.json().catch(() => ({}));
      if (!auto) {
        if (j.status === 'ok') toast(`Sheet synced · ${j.rows} products, ${j.added} added, ${j.changed} changed, ${j.removed} removed`);
        else if (j.status === 'skipped') toast('A sync is already running');
        else toast(j.error || 'Sync failed');
      }
    } catch {
      if (!auto) toast('Sync failed. Check your connection.');
    } finally {
      setSyncing(false);
      reload('sync_runs', 'products', 'price_columns');
    }
  }, [reload, toast]);

  // Keep the catalogue fresh: sync on open if the last one is over an hour old.
  const autoTried = useRef(false);
  useEffect(() => {
    if (data.loading || autoTried.current || !data.config.auto_sync) return;
    autoTried.current = true;
    const last = data.lastOkSync?.finished_at ? Date.parse(data.lastOkSync.finished_at) : 0;
    if (Date.now() - last > 60 * 60 * 1000) void sync(true);
  }, [data.loading, data.lastOkSync, data.config.auto_sync, sync]);

  // ---------- what each tab shows ----------
  const ls = useMemo(() => listings(data.items), [data.items]);
  const rows = useMemo(() => statusRows(ls, data.amz, data.fk, data.settings.merchantId), [ls, data.amz, data.fk, data.settings.merchantId]);
  const counts = useMemo(() => {
    const rule = { mode: data.settings.mode, column: data.settings.column, disc: data.settings.disc, familyDisc: data.familyDisc };
    const cross = crossRows(data.items, data.amz, data.fk, data.settings.merchantId).rows;
    return {
      live: rows.filter(r => r.state === 'down').length,
      pricing: priceRows(data.items, rule, data.amz, data.fk, data.settings.merchantId).filter(isWrong).length,
      cross: cross.filter(r => r.kind !== 'same').length,
    };
  }, [rows, data.items, data.amz, data.fk, data.settings, data.familyDisc]);

  // ---------- checks (server-side Scrapingdog, batched) ----------
  async function runChecks(target: StatusRow[] | null) {
    if (busy) return;
    const pick = target || rows;
    const asins = [...new Set(pick.filter(r => r.listing.platform === 'amz').map(r => r.listing.id))];
    const fsns = [...new Set(pick.filter(r => r.listing.platform === 'fk').map(r => r.listing.id))];
    const total = asins.length + fsns.length;
    if (!total) { toast('Nothing to check. Sync the sheet first.'); return; }
    let done = 0, failed = 0;
    setBusy({ done, total });
    const jobs: { endpoint: string; key: 'asins' | 'fsns'; ids: string[] }[] = [];
    for (let i = 0; i < asins.length; i += BATCH) jobs.push({ endpoint: '/api/check/amazon', key: 'asins', ids: asins.slice(i, i + BATCH) });
    for (let i = 0; i < fsns.length; i += BATCH) jobs.push({ endpoint: '/api/check/flipkart', key: 'fsns', ids: fsns.slice(i, i + BATCH) });
    let lastErr = '';
    for (const j of jobs) {
      try {
        const res = await apiFetch(j.endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ [j.key]: j.ids }) });
        if (!res.ok) { failed += j.ids.length; lastErr = (await res.json().catch(() => ({}))).error || `HTTP ${res.status}`; }
      } catch { failed += j.ids.length; lastErr = 'Connection lost'; }
      done += j.ids.length;
      setBusy({ done, total });
    }
    setBusy(null);
    reload('avail_checks', 'fk_avail_checks', 'days', 'down_since');
    toast(failed ? `${failed} of ${total} couldn't be checked (${lastErr}). Try again.` : `Checked ${total} listings`);
  }

  const last = data.lastSync, ok = data.lastOkSync;
  const syncBad = last?.status === 'error';
  const syncText = syncing || last?.status === 'running' ? 'Syncing sheet…'
    : syncBad ? `Sheet sync failed: ${last?.error || ''}`
      : ok?.finished_at ? `Sheet synced ${whenLabel(ok.finished_at)} · ${data.items.length} products` : 'Sheet not synced yet';

  return (
    <>
      <header className="topbar">
        <div className="topbar-in">
          <a href="/" className="brand">DealLens</a>
          <nav className="tabs">
            {TABS.map(([t, label, short]) => (
              <button key={t} className={'tab' + (tab === t ? ' on' : '')} onClick={() => setTab(t)}>
                <span className="long">{label}</span><span className="short">{short}</span>
                {!data.loading && <span className={'cnt' + (counts[t] ? '' : ' zero')}>{counts[t]}</span>}
              </button>
            ))}
          </nav>
          <div className="sp" />
          <span className={'syncinfo' + (syncBad ? ' bad' : '')} title={syncText}>
            <span className="txt" style={{ maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis' }}>{syncText}</span>
            <button className="iconbtn" onClick={() => sync(false)} disabled={syncing} aria-label="Sync the sheet now" title="Sync the sheet now"><RefreshIcon spin={syncing} /></button>
          </span>
          <div className="menu" ref={menuRef}>
            <button className="av" aria-label="Account" onClick={() => setMenu(o => !o)}>{initials(me.email)}</button>
            {menu && (
              <div className="pop">
                <div className="who">{me.email}<br />{me.role === 'admin' ? 'Owner' : 'DispatchLens user'}</div>
                {me.role === 'admin' && <button onClick={() => { setShowSettings(true); setMenu(false); }}>Settings</button>}
                <form action="/auth/signout" method="post"><button type="submit">Sign out</button></form>
              </div>
            )}
          </div>
        </div>
        {busy && <div className="topprog" style={{ width: `${(busy.done / busy.total) * 100}%` }} />}
      </header>

      <main className="page">
        {showSettings && me.role === 'admin' && (
          <div style={{ marginBottom: 22, marginTop: -8 }}>
            <OwnerSettings me={me} data={data} onToast={toast} reload={reload} onClose={() => setShowSettings(false)} />
          </div>
        )}
        {data.loading ? <div className="loading">Loading…</div>
          : tab === 'live' ? <LiveStatus data={data} rows={rows} busy={busy} onCheckAll={() => runChecks(null)} onRecheck={r => runChecks(r)} />
            : tab === 'pricing' ? <Pricing me={me} data={data} busy={busy} onCheckAll={() => runChecks(null)} toast={toast} patchLocal={patchLocal} />
              : <CrossCheck data={data} busy={busy} onCheckAll={() => runChecks(null)} />}
      </main>
      <div className={'toast' + (toastMsg ? ' on' : '')} role="status">{toastMsg}</div>
    </>
  );
}
