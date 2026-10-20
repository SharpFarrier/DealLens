'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { supabaseBrowser } from '@/lib/supabase/browser';
import { useDealData, type AvailState, type DealData, type ProductChange } from '@/lib/useDealData';
import type { ChangeLogRow } from '@/lib/data';
import { readSpreadsheet } from '@/lib/xlsxClient';
import {
  buildResults, summarize, plannedFor, parseDealFile, guessDealMapping, availFlags, expectedPrice, num, dealFileChanges, availLabel,
  type Result, type Platform, type DealMapping, type Item, type AvailFlag, type DealRowChange,
} from '@/lib/logic';
import Header from '@/components/Header';
import OwnerSettings from '@/components/OwnerSettings';
import { apiFetch } from '@/lib/device';
import type { Member } from '@/lib/auth';

// ---------- formatting ----------
const inr = (v: number | null | undefined) => (v === null || v === undefined ? '—' : '₹' + (Math.round(v * 100) / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 }));
const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
const short = (email: string | null | undefined) => (email ? email.split('@')[0] : '');
function csvCell(v: unknown) { const s = String(v === null || v === undefined ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
function download(name: string, text: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['﻿' + text], { type: 'text/csv' }));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------- deal price filters ----------
type DealFilter = 'all' | 'matched' | 'off' | 'missing' | 'parity' | 'live' | 'base' | 'issues';
const FILTERS: [DealFilter, string, string, (r: Result) => boolean][] = [
  ['all', 'All SKUs', '', () => true],
  ['matched', 'All matched', 'ok', r => !r.flags.length && !r.excluded],
  ['off', 'Off plan', 'bad', r => r.flags.some(f => /-off$/.test(f.k))],
  ['missing', 'Deal missing', 'bad', r => r.flags.some(f => /-missing$/.test(f.k))],
  ['parity', 'Amazon ≠ Flipkart', 'warn', r => r.flags.some(f => f.k === 'parity')],
  ['live', 'Live ≠ set', 'bad', r => r.flags.some(f => f.k === 'live')],
  ['base', 'Base price differs', 'warn', r => r.flags.some(f => f.k === 'base')],
  ['issues', 'Any issue', 'info', r => r.flags.length > 0],
];

// ---------- live status filters ----------
type AvailFilter = 'all' | 'live' | 'variant' | 'unavailable' | 'nobuy' | 'error' | 'price' | 'seller' | 'unchecked' | 'issues';
const AF: [AvailFilter, string, string][] = [
  ['live', 'Live & buyable', 'ok'], ['variant', 'Other variant shown', 'bad'], ['unavailable', 'Unavailable', 'bad'],
  ['nobuy', 'No price / no Buy', 'warn'], ['error', "Couldn't check", ''],
];
const AF_CHIPS: [AvailFilter, string][] = [['price', 'Price ≠ expected'], ['seller', 'Other seller has Buy Box'], ['unchecked', 'Not checked yet'], ['issues', 'Any issue']];
type LvPlat = 'amz' | 'fk' | 'both';
interface AvailRowView { platform: Platform; id: string; item: Item; rec: AvailState | null; expected: number | null; flags: AvailFlag[] }

// Small batches, one at a time: the server spreads each batch over SCRAPINGDOG_CONCURRENCY requests.
const BATCH = 6;

export default function DealLensApp({ me }: { me: Member }) {
  const { data, patchLocal, reload } = useDealData();
  const sb = supabaseBrowser();
  type Tab = 'deal' | 'avail' | 'changes';
  const [tab, setTab] = useState<Tab>('deal');
  const [onlyChanged, setOnlyChanged] = useState(false);
  const [family, setFamily] = useState('All');
  const [filter, setFilter] = useState<DealFilter>('all');
  const [afilter, setAfilter] = useState<AvailFilter>('all');
  const [lvPlat, setLvPlatState] = useState<LvPlat>('amz');
  useEffect(() => {
    try { const v = localStorage.getItem('deallens:lvplat'); if (v === 'amz' || v === 'fk' || v === 'both') setLvPlatState(v); } catch { /* storage blocked */ }
  }, []);
  const setLvPlat = (v: LvPlat) => { setLvPlatState(v); try { localStorage.setItem('deallens:lvplat', v); } catch { /* storage blocked */ } };
  const [q, setQ] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [busy, setBusy] = useState<{ label: string; done: number; total: number } | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [toastMsg, setToastMsg] = useState('');
  const toastT = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    try { const t = localStorage.getItem('deallens:tab'); if (t === 'avail' || t === 'deal' || t === 'changes') setTab(t); } catch { /* storage blocked */ }
  }, []);
  const switchTab = (t: Tab) => { setTab(t); try { localStorage.setItem('deallens:tab', t); } catch { /* storage blocked */ } };

  const toast = useCallback((m: string) => {
    setToastMsg(m);
    if (toastT.current) clearTimeout(toastT.current);
    toastT.current = setTimeout(() => setToastMsg(''), 3200);
  }, []);
  useEffect(() => { if (data.error) toast(data.error); }, [data.error, toast]);

  const { items, settings, plan, files, live, avail, fkAvail, productChanges, changeLog } = data;
  const amz = files.amz?.parsed ?? null;
  const fk = files.fk?.parsed ?? null;

  // ---------- sync ----------
  const sync = useCallback(async (auto = false) => {
    setSyncing(true);
    try {
      const res = await apiFetch('/api/sync', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ auto }) });
      const j = await res.json().catch(() => ({}));
      if (!auto) {
        if (j.status === 'ok') toast(`Synced ${j.rows} products · ${j.added} added, ${j.changed} changed, ${j.removed} removed`);
        else if (j.status === 'skipped') toast('A sync is already running');
        else toast(j.error || 'Sync failed');
      }
    } catch {
      if (!auto) toast('Sync failed. Check your connection.');
    } finally {
      setSyncing(false);
      reload('sync_runs');
    }
  }, [reload, toast]);

  // Keep the catalogue fresh without anyone pressing a button: sync on open if the last one is over an hour old.
  const autoTried = useRef(false);
  useEffect(() => {
    if (data.loading || autoTried.current || !data.config.auto_sync) return;
    autoTried.current = true;
    const last = data.lastOkSync?.finished_at ? Date.parse(data.lastOkSync.finished_at) : 0;
    if (Date.now() - last > 60 * 60 * 1000) sync(true);
  }, [data.loading, data.lastOkSync, data.config.auto_sync, sync]);

  // ---------- plan writes (optimistic, realtime confirms) ----------
  const fail = (e: { message: string } | null) => { if (e) { toast(e.message); reload('plan_settings'); } };
  async function saveSettings(p: Partial<{ event: string; disc: number; tol: number; price_ref: string; merchant_id: string }>) {
    const { error } = await sb.from('deallens_plan_settings').update({ ...p, updated_by: me.email, updated_at: new Date().toISOString() }).eq('id', 1);
    fail(error);
  }
  async function setFamilyDisc(fam: string, v: number | null) {
    patchLocal(d => {
      const fd = { ...d.plan.familyDisc };
      if (v === null) delete fd[fam]; else fd[fam] = v;
      return { ...d, plan: { ...d.plan, familyDisc: fd } };
    });
    const { error } = v === null
      ? await sb.from('deallens_family_discounts').delete().eq('family', fam)
      : await sb.from('deallens_family_discounts').upsert({ family: fam, disc: v, updated_by: me.email, updated_at: new Date().toISOString() });
    if (error) { toast(error.message); reload('family_discounts'); }
  }
  async function setOverride(key: string, v: number | null) {
    patchLocal(d => {
      const o = { ...d.plan.override };
      if (v === null) delete o[key]; else o[key] = v;
      return { ...d, plan: { ...d.plan, override: o } };
    });
    const { error } = v === null
      ? await sb.from('deallens_sku_overrides').delete().eq('key', key)
      : await sb.from('deallens_sku_overrides').upsert({ key, price: v, updated_by: me.email, updated_at: new Date().toISOString() });
    if (error) { toast(error.message); reload('sku_overrides'); }
  }
  async function setExcluded(key: string, ex: boolean) {
    patchLocal(d => {
      const e = { ...d.plan.excluded };
      if (ex) e[key] = true; else delete e[key];
      return { ...d, plan: { ...d.plan, excluded: e } };
    });
    const { error } = ex
      ? await sb.from('deallens_sku_excluded').upsert({ key, updated_by: me.email, updated_at: new Date().toISOString() })
      : await sb.from('deallens_sku_excluded').delete().eq('key', key);
    if (error) { toast(error.message); reload('sku_excluded'); }
  }

  // ---------- deal files ----------
  async function uploadDeal(platform: Platform, file: File) {
    try {
      const aoa = await readSpreadsheet(file);
      const parsed = parseDealFile(aoa, platform);
      const old = files[platform];
      const now = new Date().toISOString();
      const { error } = await sb.from('deallens_deal_files').upsert({
        platform, filename: file.name, aoa, mapping: parsed.mapping, uploaded_by: me.email, uploaded_at: now,
        // Keep the file it replaces, so the changes can be shown.
        prev_aoa: old?.row.aoa ?? null, prev_mapping: old?.row.mapping ?? null, prev_filename: old?.row.filename ?? null,
        prev_uploaded_by: old?.row.uploaded_by ?? null, prev_uploaded_at: old?.row.uploaded_at ?? null,
      });
      if (error) throw new Error(error.message);
      const site = platform === 'amz' ? 'Amazon' : 'Flipkart';
      const diff = old?.parsed ? dealFileChanges(old.parsed, parsed, settings.tol) : [];
      const byId = new Map(items.map(i => [platform === 'amz' ? i.asin : i.fsn, i]));
      const fmt = (v: number | null) => (v === null ? null : inr(v));
      const logRows = [
        { at: now, source: 'deal_file', ref: platform, label: `${site} deal file`, field: 'file',
          old_value: old ? old.row.filename || 'previous file' : null,
          new_value: `${file.name}${old?.parsed ? ` · ${diff.length} row${diff.length === 1 ? '' : 's'} changed` : ''}`, changed_by: me.email },
        ...diff.slice(0, 400).map(d => {
          const it = byId.get(d.id);
          return { at: now, source: 'deal_file', item_key: it?.key ?? null, ref: d.id || d.sku, label: it?.desc ?? (d.sku || d.id),
            field: d.kind === 'changed' ? `${site} deal` : d.kind === 'added' ? `${site} deal added` : `${site} deal removed`,
            old_value: fmt(d.deal[0]), new_value: fmt(d.deal[1]), changed_by: me.email };
        }),
      ];
      const { error: logErr } = await sb.from('deallens_change_log').insert(logRows);
      if (logErr) toast(`File saved, but the change history couldn't be written: ${logErr.message}`);
      else toast(`${site} file loaded · ${parsed.rows.length} rows${old?.parsed ? ` · ${diff.length} changed` : ''}`);
      reload('deal_files'); reload('change_log');
    } catch (e) {
      toast(e instanceof Error ? e.message : `Could not read ${file.name}`);
    }
  }
  async function remapDeal(platform: Platform, k: keyof DealMapping, col: number) {
    const f = files[platform];
    if (!f) return;
    const mapping = { ...(f.parsed?.mapping ?? f.row.mapping ?? guessDealMapping([], platform)), [k]: col };
    const { error } = await sb.from('deallens_deal_files').update({ mapping }).eq('platform', platform);
    if (error) toast(error.message); else reload('deal_files');
  }
  async function clearDeal(platform: Platform) {
    if (!confirm(`Remove the ${platform === 'amz' ? 'Amazon' : 'Flipkart'} deal file for everyone?`)) return;
    const old = files[platform];
    const { error } = await sb.from('deallens_deal_files').delete().eq('platform', platform);
    if (error) { toast(error.message); return; }
    await sb.from('deallens_change_log').insert({ source: 'deal_file', ref: platform, label: `${platform === 'amz' ? 'Amazon' : 'Flipkart'} deal file`,
      field: 'file', old_value: old?.row.filename || 'file', new_value: 'removed', changed_by: me.email });
    reload('deal_files'); reload('change_log');
  }

  // ---------- deal results ----------
  const results = useMemo(() => buildResults(items, plan, amz, fk, live, settings.tol), [items, plan, amz, fk, live, settings.tol]);
  const summary = useMemo(() => summarize(results), [results]);

  // ---------- change memory: what differs from the previous check / sync / upload ----------
  const dealDiff = useMemo(() => ({
    amz: new Map(dealFileChanges(files.amz?.prevParsed ?? null, amz, settings.tol).map(d => [d.id, d])),
    fk: new Map(dealFileChanges(files.fk?.prevParsed ?? null, fk, settings.tol).map(d => [d.id, d])),
  }), [files, amz, fk, settings.tol]);
  const moved = (lv: { price: number | null; prevPrice?: number | null } | null | undefined) =>
    !!lv && lv.price !== null && lv.prevPrice !== null && lv.prevPrice !== undefined && Math.abs(lv.price - lv.prevPrice) > settings.tol;
  const dealChange = useCallback((r: Result): DealChangeView | null => {
    const it = r.item;
    const v: DealChangeView = {
      sheet: productChanges[it.key] || null,
      amz: (it.asin && dealDiff.amz.get(it.asin)) || null,
      fk: (it.fsn && dealDiff.fk.get(it.fsn)) || null,
      liveA: moved(r.la) ? r.la!.prevPrice! : null,
      liveF: moved(r.lf) ? r.lf!.prevPrice! : null,
    };
    return v.sheet || v.amz || v.fk || v.liveA !== null || v.liveF !== null ? v : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productChanges, dealDiff, settings.tol]);
  const statusFlip = (r: AvailState | undefined) => !!r && r.changed && !!r.prevCls && r.prevCls !== r.cls;
  const priceFlip = (r: AvailState | undefined) => !!r && r.changed && r.prevPrice !== null && r.price !== null && Math.abs(r.price - r.prevPrice) > settings.tol;
  const changeCounts = useMemo(() => {
    const all = [...Object.values(avail), ...Object.values(fkAvail)];
    const c = {
      status: all.filter(statusFlip).length,
      soldOut: all.filter(r => statusFlip(r) && r.cls === 'unavailable').length,
      price: all.filter(priceFlip).length,
      swap: all.filter(r => r.changed && r.cls === 'variant').length,
      sheet: Object.keys(productChanges).length,
      deal: dealDiff.amz.size + dealDiff.fk.size,
    };
    return { ...c, total: c.status + c.price + c.sheet + c.deal };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [avail, fkAvail, productChanges, dealDiff, settings.tol]);
  const families = useMemo(() => ['All', ...new Set(items.map(i => i.family))], [items]);
  const ql = q.trim().toLowerCase();
  const matchQ = (it: { desc: string; family: string; amzSku: string; fkSku: string; asin: string; fsn: string; master: string }, extra = '') =>
    !ql || [it.desc, it.family, it.amzSku, it.fkSku, it.asin, it.fsn, it.master, extra].join(' ').toLowerCase().includes(ql);
  const visibleDeal = useMemo(() => {
    const f = FILTERS.find(x => x[0] === filter) || FILTERS[0];
    return results.filter(r => (family === 'All' || r.item.family === family) && f[3](r) && matchQ(r.item) && (!onlyChanged || !!dealChange(r)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [results, family, filter, ql, onlyChanged, dealChange]);

  // ---------- live status rows (Amazon by ASIN, Flipkart by FSN) ----------
  const amzRows: AvailRowView[] = useMemo(() => {
    const seen = new Set<string>();
    return items.filter(it => it.asin && !seen.has(it.asin) && (seen.add(it.asin), true)).map(it => {
      const rec = avail[it.asin] || null;
      const expected = expectedPrice(it, settings.priceRef, amz, plan);
      return { platform: 'amz' as Platform, id: it.asin, item: it, rec, expected, flags: availFlags(rec, expected, settings.tol, settings.merchantId) };
    });
  }, [items, avail, settings.priceRef, settings.tol, settings.merchantId, amz, plan]);
  const fkRows: AvailRowView[] = useMemo(() => {
    const seen = new Set<string>();
    return items.filter(it => it.fsn && !seen.has(it.fsn) && (seen.add(it.fsn), true)).map(it => {
      const rec = fkAvail[it.fsn] || null;
      let expected: number | null = null;
      if (settings.priceRef === 'catalogue') expected = it.newPrice;
      else if (settings.priceRef === 'deal') {
        const d = fk?.rows.find(r => r.id === it.fsn);
        expected = d && d.deal !== null ? d.deal : plannedFor(it, plan);
      }
      return { platform: 'fk' as Platform, id: it.fsn, item: it, rec, expected, flags: availFlags(rec, expected, settings.tol, null) };
    });
  }, [items, fkAvail, settings.priceRef, settings.tol, fk, plan]);
  const availRows = lvPlat === 'amz' ? amzRows : lvPlat === 'fk' ? fkRows : [...amzRows, ...fkRows];
  const availMatch = (r: AvailRowView, f: AvailFilter) => {
    if (f === 'all') return true;
    if (f === 'unchecked') return !r.rec;
    if (f === 'price' || f === 'seller') return r.flags.includes(f);
    if (f === 'issues') return !!r.rec && (r.rec.cls !== 'live' || r.flags.length > 0);
    return !!r.rec && r.rec.cls === f;
  };
  const visibleAvail = useMemo(() => {
    const hit = availRows.filter(r => (family === 'All' || r.item.family === family) && availMatch(r, afilter) && matchQ(r.item, r.rec?.served || '') && (!onlyChanged || !!r.rec?.changed));
    if (lvPlat !== 'both') return hit;
    // Both: a product shows (with both of its platforms) when either platform matches the filter.
    const keys = new Set(hit.map(r => r.item.key));
    return availRows.filter(r => keys.has(r.item.key));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [availRows, family, afilter, ql, lvPlat, onlyChanged]);
  const productFor = (id: string | null, platform: Platform) =>
    id ? items.find(i => (platform === 'amz' ? i.asin : i.fsn) === id)?.desc || null : null;

  // ---------- checks (server-side Scrapingdog, batched) ----------
  async function runBatches(label: string, ids: string[], endpoint: string, key: 'asins' | 'fsns') {
    let done = 0, failed = 0;
    setBusy({ label, done, total: ids.length });
    const batches: string[][] = [];
    for (let i = 0; i < ids.length; i += BATCH) batches.push(ids.slice(i, i + BATCH));
    let next = 0;
    const worker = async () => {
      while (next < batches.length) {
        const b = batches[next++];
        try {
          const res = await apiFetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ [key]: b }) });
          const j = await res.json().catch(() => ({}));
          if (!res.ok) { failed += b.length; if (j.error) toast(j.error); }
        } catch { failed += b.length; }
        done += b.length;
        setBusy({ label, done, total: ids.length });
      }
    };
    await worker();
    setBusy(null);
    if (failed) toast(`${failed} of ${ids.length} couldn't be checked. Try again.`);
  }
  async function checkAvail(onlyFailed: boolean) {
    const rows = onlyFailed ? availRows.filter(r => r.rec?.cls === 'error') : visibleAvail;
    const asins = [...new Set(rows.filter(r => r.platform === 'amz').map(r => r.id))];
    const fsns = [...new Set(rows.filter(r => r.platform === 'fk').map(r => r.id))];
    const total = asins.length + fsns.length;
    if (!total) { toast('Nothing to check in this view'); return; }
    if (total > 60 && !confirm(`This uses about ${total} Scrapingdog credits. Continue?`)) return;
    if (asins.length) await runBatches('Amazon', asins, '/api/check/amazon', 'asins');
    if (fsns.length) await runBatches('Flipkart', fsns, '/api/check/flipkart', 'fsns');
    reload('avail_checks'); reload('fk_avail_checks'); reload('live_prices');
  }
  async function liveDealCheck() {
    const rows = visibleDeal.filter(r => !r.excluded && r.item.newPrice !== null);
    const asins = [...new Set(rows.map(r => r.item.asin).filter(Boolean))];
    const fsns = [...new Set(rows.map(r => r.item.fsn).filter(Boolean))];
    const total = asins.length + fsns.length;
    if (!total) { toast('Nothing to check in this view'); return; }
    if (total > 60 && !confirm(`This uses ${total} Scrapingdog credits. Continue?`)) return;
    if (asins.length) await runBatches('Amazon', asins, '/api/check/amazon', 'asins');
    if (fsns.length) await runBatches('Flipkart', fsns, '/api/check/flipkart', 'fsns');
    reload('live_prices'); reload('avail_checks'); reload('fk_avail_checks');
  }

  // ---------- exports ----------
  function exportDealCsv() {
    const rows = results.filter(r => r.flags.length);
    if (!rows.length) { toast('No issues to export'); return; }
    const head = ['Family', 'Product', 'ASIN', 'FSN', 'Catalogue price', 'Planned deal', 'Amazon set', 'Flipkart set', 'Amazon live', 'Flipkart live', 'Issues'];
    download(`DealLens-issues-${new Date().toISOString().slice(0, 10)}.csv`, [head.join(',')].concat(rows.map(r => [
      r.item.family, r.item.desc, r.item.asin, r.item.fsn, r.item.newPrice, r.planned, r.a?.deal ?? '', r.f?.deal ?? '',
      r.la?.price ?? '', r.lf?.price ?? '', r.flags.map(f => f.l).join('; '),
    ].map(csvCell).join(','))).join('\n'));
  }
  function exportAvailCsv() {
    const rows = availRows.filter(r => r.rec && (r.rec.cls !== 'live' || r.flags.length));
    if (!rows.length) { toast('No issues to export'); return; }
    const head = ['Platform', 'Family', 'Product', 'SKU', 'ID asked (ASIN/FSN)', 'ID shown', 'Product shown', 'Price shown', 'Expected price', 'Stock / Buy Box seller', 'Status', 'Flags', 'Checked at', 'Checked by'];
    download(`DealLens-live-status-${new Date().toISOString().slice(0, 10)}.csv`, [head.join(',')].concat(rows.map(r => {
      const rec = r.rec!;
      const fk = r.platform === 'fk';
      return [fk ? 'Flipkart' : 'Amazon', r.item.family, r.item.desc, fk ? r.item.fkSku : r.item.amzSku, r.id, rec.served || '', productFor(rec.served, r.platform) || '',
        rec.price ?? '', r.expected ?? '', fk ? rec.avail || '' : rec.seller || rec.mid || '', statusText(rec, r.platform),
        r.flags.map(f => (f === 'price' ? 'Price differs' : 'Other seller has Buy Box')).join('; '), when(rec.checkedAt), rec.checkedBy || ''].map(csvCell).join(',');
    })).join('\n'));
  }

  // ---------- render ----------
  if (data.loading) {
    return <div className="wrap"><Header me={me} data={data} syncing={syncing} onSync={() => sync(false)} /><div className="empty">Loading…</div></div>;
  }

  const dealCounts: Partial<Record<DealFilter, number>> = { all: summary.total, matched: summary.matched, off: summary.off, missing: summary.missing, parity: summary.parity, live: summary.live };
  const availCounts: Record<string, number> = { live: 0, variant: 0, unavailable: 0, nobuy: 0, error: 0 };
  availRows.forEach(r => { if (r.rec) availCounts[r.rec.cls]++; });
  const failedCount = availCounts.error;
  const lastAvail = [...(lvPlat !== 'fk' ? Object.values(avail) : []), ...(lvPlat !== 'amz' ? Object.values(fkAvail) : [])]
    .reduce<string | null>((m, r) => (!m || r.checkedAt > m ? r.checkedAt : m), null);
  const unitWord = lvPlat === 'amz' ? 'ASIN' : lvPlat === 'fk' ? 'FSN' : 'listing';

  return (
    <div className="wrap">
      <Header me={me} data={data} syncing={syncing} onSync={() => sync(false)} />

      <div className="top" style={{ marginBottom: 10 }}>
        <label className="fld">Sale <input key={'ev' + settings.event} defaultValue={settings.event} style={{ width: 130 }}
          onBlur={e => { const v = e.target.value.trim(); if (v !== settings.event) saveSettings({ event: v }); }} /></label>
        <label className="fld">Discount % <input key={'d' + settings.disc} className="n" type="number" min={0} max={89} step={0.5} defaultValue={settings.disc}
          onBlur={e => { const v = num(e.target.value); if (v !== null && v >= 0 && v < 90 && v !== settings.disc) saveSettings({ disc: v }); }} /></label>
        {settings.updatedBy && <span className="who-by">Plan last changed by {short(settings.updatedBy)} · {when(settings.updatedAt)}</span>}
        <div className="sp" />
        <button className="btn" onClick={() => setShowSettings(s => !s)}>Settings</button>
      </div>

      {showSettings && (
        <div className="settings open">
          <label className="fld">Match tolerance ₹ <input key={'t' + settings.tol} className="n" type="number" min={0} step={1} defaultValue={settings.tol}
            onBlur={e => { const v = num(e.target.value); if (v !== null && v >= 0 && v !== settings.tol) saveSettings({ tol: v }); }} /></label>
          <label className="fld">Your Amazon merchant ID <input key={'m' + settings.merchantId} defaultValue={settings.merchantId} style={{ width: 170, fontFamily: 'var(--mono)' }}
            onBlur={e => { const v = e.target.value.trim().toUpperCase(); if (v !== settings.merchantId) saveSettings({ merchant_id: v }); }} /></label>
          <span className="who-by">Scrapingdog key is stored on the server.</span>
        </div>
      )}
      {showSettings && me.role === 'admin' && <OwnerSettings me={me} data={data} onToast={toast} reload={reload} />}

      {changeCounts.total > 0 && (
        <div className="chbanner" role="status">
          <div className="t">
            <b>{changeCounts.total} change{changeCounts.total === 1 ? '' : 's'} in the latest checks</b>
            <span>{[
              changeCounts.status && `${changeCounts.status} live status${changeCounts.soldOut ? ` (${changeCounts.soldOut} went unavailable)` : ''}`,
              changeCounts.price && `${changeCounts.price} price${changeCounts.price === 1 ? '' : 's'} moved`,
              changeCounts.swap && `${changeCounts.swap} variant swap${changeCounts.swap === 1 ? '' : 's'}`,
              changeCounts.sheet && `${changeCounts.sheet} sheet edit${changeCounts.sheet === 1 ? '' : 's'}`,
              changeCounts.deal && `${changeCounts.deal} deal file row${changeCounts.deal === 1 ? '' : 's'}`,
            ].filter(Boolean).join(' · ')}</span>
          </div>
          {tab !== 'changes' && <button className={'btn' + (onlyChanged ? ' primary' : '')} onClick={() => setOnlyChanged(o => !o)}>{onlyChanged ? 'Showing only changed' : 'Show only changed'}</button>}
          {tab !== 'changes' && <button className="btn" onClick={() => switchTab('changes')}>See all changes</button>}
        </div>
      )}

      <div className="tabs">
        <button className={'tab' + (tab === 'deal' ? ' on' : '')} onClick={() => switchTab('deal')}>Deal prices</button>
        <button className={'tab' + (tab === 'avail' ? ' on' : '')} onClick={() => switchTab('avail')}>Live status</button>
        <button className={'tab' + (tab === 'changes' ? ' on' : '')} onClick={() => switchTab('changes')}>Changes</button>
      </div>

      {tab !== 'changes' && <div className="srcs2">
        {(['amz', 'fk'] as Platform[]).map(p => {
          const f = files[p];
          const name = p === 'amz' ? 'Amazon deal file' : 'Flipkart deal file';
          return (
            <div key={p} className="src"
              onDragOver={e => { e.preventDefault(); e.currentTarget.classList.add('drag'); }}
              onDragLeave={e => e.currentTarget.classList.remove('drag')}
              onDrop={e => { e.preventDefault(); e.currentTarget.classList.remove('drag'); const file = e.dataTransfer.files[0]; if (file) uploadDeal(p, file); }}>
              <h3>{name}</h3>
              <div className={'meta' + (f?.parsed ? ' ok' : '')}>
                {f ? (f.parsed ? `${f.parsed.rows.length} rows · ${f.row.filename || 'file'} · ${short(f.row.uploaded_by)} ${when(f.row.uploaded_at)}` : f.error)
                  : p === 'amz' ? 'ASIN, SKU, BAU price, deal price' : 'FSN, SKU, selling price, deal price'}
              </div>
              <div className="row" style={{ marginTop: 9 }}>
                <label className="btn">{f ? 'Replace file' : 'Upload file'}
                  <input type="file" accept=".xlsx,.xls,.csv,.tsv" hidden onChange={e => { const file = e.target.files?.[0]; if (file) uploadDeal(p, file); e.target.value = ''; }} />
                </label>
                {f && <button className="btn" onClick={() => clearDeal(p)}>Remove</button>}
              </div>
              {f?.parsed && (
                <details style={{ marginTop: 8, fontSize: 12 }}>
                  <summary style={{ cursor: 'pointer', color: 'var(--ink2)' }}>Columns</summary>
                  <div className="map">
                    {(['id', 'sku', 'base', 'deal'] as (keyof DealMapping)[]).map(k => (
                      <MapRow key={k} label={{ id: p === 'amz' ? 'ASIN' : 'FSN', sku: 'SKU', base: 'Base price', deal: 'Deal price' }[k]}
                        headers={f.parsed!.headers} value={f.parsed!.mapping[k]} onChange={v => remapDeal(p, k, v)} />
                    ))}
                  </div>
                </details>
              )}
            </div>
          );
        })}
      </div>}

      {tab === 'changes' ? (
        <ChangesView log={changeLog} items={items} />
      ) : !items.length ? (
        <div className="tablewrap"><div className="empty"><h2>No products yet</h2>The catalogue comes from the Google Sheet. Press Sync now at the top.</div></div>
      ) : tab === 'deal' ? (
        <>
          <div className="kpis">
            {FILTERS.slice(0, 6).map(([k, l, cls]) => (
              <button key={k} className={`kpi ${cls}${filter === k ? ' on' : ''}`} onClick={() => setFilter(filter === k && k !== 'all' ? 'all' : k)}>
                <div className="l">{l}</div><div className="v">{dealCounts[k] || 0}</div>
              </button>
            ))}
          </div>
          <Bar families={families} family={family} setFamily={setFamily} q={q} setQ={setQ}
            chips={FILTERS.slice(6).map(([k, l]) => ({ k, l, on: filter === k, click: () => setFilter(filter === k ? 'all' : k) }))}
            placeholder="Search name, SKU, ASIN, FSN" />
          {family !== 'All' && (
            <div className="famset on">Discount % for <b>{family}</b>
              <input key={family + (plan.familyDisc[family] ?? '')} type="number" min={0} max={89} step={0.5} placeholder={String(settings.disc)}
                defaultValue={plan.familyDisc[family] ?? ''}
                onBlur={e => { const v = num(e.target.value); if (v === null) { if (plan.familyDisc[family] !== undefined) setFamilyDisc(family, null); } else if (v >= 0 && v < 90 && v !== plan.familyDisc[family]) setFamilyDisc(family, v); }} />
              <button className="btn" style={{ height: 28 }} onClick={() => setFamilyDisc(family, null)}>Use sale default</button>
            </div>
          )}
          <DealTable rows={visibleDeal} plan={plan} tol={settings.tol} hasFiles={!!(amz || fk)} changeOf={dealChange}
            onExclude={setExcluded}
            onOverride={(it, v) => {
              const auto = plannedFor(it, { ...plan, override: {} });
              setOverride(it.key, v === null || v === auto ? null : v);
            }} />
          <div className="foot">
            <span>{busy ? `${busy.label} ${busy.done}/${busy.total}` : 'Live prices fill in once the sale is live. Live check covers only the rows shown.'}</span>
            <span className="row">
              {busy && <span className="prog" style={{ display: 'block' }}><i style={{ width: `${(busy.done / busy.total) * 100}%` }} /></span>}
              <button className="btn" disabled={!!busy} onClick={liveDealCheck}>Live check ({visibleDeal.length})</button>
              <button className="btn" onClick={exportDealCsv}>Export issues CSV</button>
            </span>
          </div>
        </>
      ) : (
        <>
          <div className="row" style={{ marginBottom: 12 }}>
            <span className="seg" role="tablist" aria-label="Platform">
              {([['amz', `Amazon · ${amzRows.length}`], ['fk', `Flipkart · ${fkRows.length}`], ['both', 'Both']] as [LvPlat, string][]).map(([k, l]) => (
                <button key={k} role="tab" aria-selected={lvPlat === k} className={lvPlat === k ? 'on' : ''} onClick={() => setLvPlat(k)}>{l}</button>
              ))}
            </span>
            {lvPlat === 'both' && <span className="who-by">Counts add up both platforms.</span>}
          </div>
          <div className="kpis k5">
            {AF.map(([k, l, cls]) => (
              <button key={k} className={`kpi ${cls}${afilter === k ? ' on' : ''}`} onClick={() => setAfilter(afilter === k ? 'all' : k)}>
                <div className="l">{l}</div><div className="v">{availCounts[k]}</div>
              </button>
            ))}
          </div>
          <Bar families={['All', ...new Set(availRows.map(r => r.item.family))]} family={family} setFamily={setFamily} q={q} setQ={setQ}
            chips={AF_CHIPS.filter(([k]) => !(lvPlat === 'fk' && k === 'seller')).map(([k, l]) => ({ k, l, on: afilter === k, click: () => setAfilter(afilter === k ? 'all' : k) }))}
            placeholder={lvPlat === 'fk' ? 'Search name, SKU, FSN' : lvPlat === 'amz' ? 'Search name, SKU, ASIN' : 'Search name, SKU, ASIN, FSN'} />
          {lvPlat === 'both'
            ? <BothTable rows={visibleAvail} productFor={productFor} priceRef={settings.priceRef} />
            : <AvailTable rows={visibleAvail} platform={lvPlat} productFor={productFor} priceRef={settings.priceRef} />}
          <div className="foot">
            <span>{busy ? `${busy.label} ${busy.done}/${busy.total}` : lastAvail ? `Last checked ${when(lastAvail)}. Checks only the rows shown.` : 'Opens each listing the way a shopper would and checks that the page shows that exact ASIN or FSN, in stock, with a price.'}</span>
            <span className="row">
              <label className="fld">Compare price to
                <select className="ref" value={settings.priceRef} onChange={e => saveSettings({ price_ref: e.target.value })}>
                  <option value="deal">Deal price</option>
                  <option value="catalogue">Catalogue New Price</option>
                  <option value="off">Don&apos;t compare</option>
                </select>
              </label>
              {busy && <span className="prog" style={{ display: 'block' }}><i style={{ width: `${(busy.done / busy.total) * 100}%` }} /></span>}
              {failedCount > 0 && <button className="btn" disabled={!!busy} onClick={() => checkAvail(true)}>Retry failed ({failedCount})</button>}
              <button className="btn primary" disabled={!!busy || !visibleAvail.length} onClick={() => checkAvail(false)}>
                Check {visibleAvail.length} {unitWord}{visibleAvail.length === 1 ? '' : 's'}
              </button>
              <button className="btn" onClick={exportAvailCsv}>Export issues CSV</button>
            </span>
          </div>
        </>
      )}
      <div className={'toast' + (toastMsg ? ' on' : '')} role="status">{toastMsg}</div>
    </div>
  );
}

// ---------- pieces ----------
function MapRow({ label, headers, value, onChange }: { label: string; headers: string[]; value: number; onChange: (v: number) => void }) {
  return (
    <>
      <span>{label}</span>
      <select value={value} onChange={e => onChange(parseInt(e.target.value, 10))}>
        <option value={-1}>—</option>
        {headers.map((h, i) => <option key={i} value={i}>{h || `Column ${i + 1}`}</option>)}
      </select>
    </>
  );
}

function Bar({ families, family, setFamily, chips, q, setQ, placeholder }: {
  families: string[]; family: string; setFamily: (f: string) => void; q: string; setQ: (q: string) => void; placeholder: string;
  chips: { k: string; l: string; on: boolean; click: () => void }[];
}) {
  return (
    <div className="bar">
      {families.map(f => <button key={f} className={'chip' + (family === f ? ' on' : '')} onClick={() => setFamily(f)}>{f}</button>)}
      <span style={{ width: 10 }} />
      {chips.map(c => <button key={c.k} className={'chip' + (c.on ? ' on' : '')} onClick={c.click}>{c.l}</button>)}
      <input className="search" placeholder={placeholder} value={q} onChange={e => setQ(e.target.value)} />
    </div>
  );
}

function priceCell(rec: Result['a'], planned: number | null, listed: boolean, excluded: boolean, tol: number) {
  if (!listed) return <span className="p d">not listed</span>;
  if (!rec) return <span className="p x">no deal</span>;
  if (rec.deal === null) return <span className="p x">blank</span>;
  const off = planned !== null && !excluded && Math.abs(rec.deal - planned) > tol;
  return <><span className={'p' + (off ? ' x' : '')}>{inr(rec.deal)}</span>{rec.base !== null && <span className="sub">base {inr(rec.base)}</span>}</>;
}
function liveCell(lv: Result['la']) {
  if (!lv) return '—';
  if (lv.err) return <span title={lv.err}>err</span>;
  return lv.price === null ? '?' : inr(lv.price);
}

interface DealChangeView { sheet: ProductChange | null; amz: DealRowChange | null; fk: DealRowChange | null; liveA: number | null; liveF: number | null }

const Old = ({ v }: { v: React.ReactNode }) => <span className="old">{v}</span>;

function DealTable({ rows, plan, tol, hasFiles, changeOf, onExclude, onOverride }: {
  rows: Result[]; plan: DealData['plan']; tol: number; hasFiles: boolean; changeOf: (r: Result) => DealChangeView | null;
  onExclude: (key: string, ex: boolean) => void; onOverride: (it: Item, v: number | null) => void;
}) {
  if (!rows.length) return <div className="tablewrap"><div className="empty">No SKUs match this view.</div></div>;
  return (
    <div className="tablewrap">
      <table>
        <thead><tr><th className="l" style={{ width: 34 }} /><th className="l">Product</th><th>Catalogue</th><th>Planned deal</th><th>Amazon set</th><th>Flipkart set</th><th>Live A / F</th><th>Status</th></tr></thead>
        <tbody>
          {rows.map(r => {
            const it = r.item, isExtra = it.newPrice === null;
            const ov = plan.override[it.key] !== undefined;
            const ch = changeOf(r);
            const sheetPrev = ch?.sheet?.kind === 'changed' ? ch.sheet.prev : null;
            const dealOld = (d: DealRowChange | null) => (d && d.kind === 'changed' && d.deal[0] !== d.deal[1] ? <span className="sub"><Old v={inr(d.deal[0])} /> before</span> : null);
            return (
              <tr key={it.key} className={(r.excluded ? 'ex' : '') + (ch ? ' chg' : '')}>
                <td className="l">{!isExtra && <input type="checkbox" checked={!r.excluded} title="Include in sale" onChange={e => onExclude(it.key, !e.target.checked)} />}</td>
                <td className="l"><span className="desc">{it.desc}</span>
                  {ch && <span className="b new">{ch.sheet?.kind === 'added' ? 'new SKU' : 'changed'}</span>}
                  <span className="sub">{[it.asin, it.fsn].filter(Boolean).join(' · ') || it.amzSku || it.fkSku}</span>
                  {sheetPrev && Object.keys(sheetPrev).filter(k => k !== 'newPrice').length > 0 && (
                    <span className="sub">Sheet: {Object.entries(sheetPrev).filter(([k]) => k !== 'newPrice').map(([k, v]) => `${k} was ${String(v || '—')}`).join(', ')}</span>
                  )}</td>
                <td>{sheetPrev && sheetPrev.newPrice !== undefined && <span className="sub"><Old v={inr(sheetPrev.newPrice as number)} /></span>}
                  <span className={'p' + (sheetPrev && sheetPrev.newPrice !== undefined ? '' : ' d')}>{inr(it.newPrice)}</span></td>
                <td>{isExtra ? '—' : (
                  <input key={it.key + ':' + r.planned} className={'pin' + (ov ? ' ov' : '')} defaultValue={r.planned ?? ''}
                    title={ov ? 'Manual price. Clear to use the discount %.' : 'From discount %'}
                    onBlur={e => { const v = num(e.target.value); if (v !== r.planned || (v === null && ov)) onOverride(it as Item, v); }} />
                )}</td>
                <td>{priceCell(r.a, r.planned, isExtra ? !!r.a : !!it.asin, r.excluded, tol)}{dealOld(ch?.amz ?? null)}</td>
                <td>{priceCell(r.f, r.planned, isExtra ? !!r.f : !!it.fsn, r.excluded, tol)}{dealOld(ch?.fk ?? null)}</td>
                <td><span className="p">{liveCell(r.la)} / {liveCell(r.lf)}</span>
                  {ch && (ch.liveA !== null || ch.liveF !== null) && (
                    <span className="sub">was <Old v={ch.liveA !== null ? inr(ch.liveA) : '—'} /> / <Old v={ch.liveF !== null ? inr(ch.liveF) : '—'} /></span>
                  )}</td>
                <td>{r.flags.length
                  ? r.flags.map((f, i) => <span key={i} className={'b ' + f.t}>{f.l}</span>)
                  : r.excluded ? <span className="b mut">Not in sale</span>
                    : hasFiles ? <span className="b ok">Matched</span> : <span className="b mut">No deal files yet</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function statusText(rec: AvailState, platform: Platform): string {
  if (rec.cls === 'live') return 'Live & buyable';
  if (rec.cls === 'variant') return 'Other variant shown';
  if (rec.cls === 'unavailable') return platform === 'fk' ? (rec.avail && /discontinued/i.test(rec.avail) ? 'Discontinued' : 'Sold out') : 'Unavailable, no offer';
  if (rec.cls === 'nobuy') {
    if (platform === 'fk' && rec.avail && /preorder|presale/i.test(rec.avail)) return 'Coming soon / pre-order';
    return rec.price === null ? 'Page live, no price' : platform === 'fk' ? 'Not buyable' : 'Page live, no Buy Box';
  }
  return "Couldn't check" + (rec.err ? `: ${rec.err}` : '');
}

function StatusCell({ r, productFor, priceRef, compact }: {
  r: AvailRowView; productFor: (id: string | null, p: Platform) => string | null; priceRef: string; compact?: boolean;
}) {
  const rec = r.rec;
  const B = ({ t, children }: { t: string; children: React.ReactNode }) => <span className={'b ' + t}>{children}</span>;
  let status: React.ReactNode;
  if (!rec) status = <B t="mut">Not checked</B>;
  else if (rec.cls === 'live') status = <B t="ok">Live &amp; buyable</B>;
  else if (rec.cls === 'variant') { const p = productFor(rec.served, r.platform); status = <B t="bad">Other variant shown{p ? `: ${p}` : ''}</B>; }
  else if (rec.cls === 'unavailable') status = <B t="bad">{statusText(rec, r.platform)}</B>;
  else if (rec.cls === 'nobuy') status = <B t="warn">{statusText(rec, r.platform)}</B>;
  else status = <span className="b mut" title={rec.err || ''}>{statusText(rec, r.platform)}</span>;
  const flipped = !!rec && rec.changed && !!rec.prevCls && rec.prevCls !== rec.cls;
  return (
    <>
      {flipped && <><Old v={availLabel(rec!.prevCls)} /> <span className="arrow">→</span> </>}
      {status}
      {r.flags.includes('price') && <B t="warn">Price ≠ {priceRef === 'catalogue' ? 'catalogue' : 'deal'} {inr(r.expected)}</B>}
      {r.flags.includes('seller') && <B t="warn">Buy Box: {rec?.seller || rec?.mid}</B>}
      {rec && !compact && <span className="sub">{when(rec.checkedAt)}{rec.checkedBy ? ` · ${rec.checkedBy === 'schedule' ? 'daily check' : short(rec.checkedBy)}` : ''}</span>}
    </>
  );
}

function AvailTable({ rows, platform, productFor, priceRef }: {
  rows: AvailRowView[]; platform: Platform; productFor: (id: string | null, p: Platform) => string | null; priceRef: string;
}) {
  const site = platform === 'fk' ? 'Flipkart' : 'Amazon';
  if (!rows.length) return <div className="tablewrap"><div className="empty">No {platform === 'fk' ? 'FSNs' : 'ASINs'} match this view.</div></div>;
  return (
    <div className="tablewrap">
      <table>
        <thead><tr><th className="l">Product</th><th className="l">Asked for</th><th className="l">{site} showed</th><th>Price shown</th><th className="l">Status</th></tr></thead>
        <tbody>
          {rows.map(r => {
            const it = r.item, rec = r.rec;
            const swapped = rec?.cls === 'variant';
            return (
              <tr key={r.platform + r.id} className={rec?.changed ? 'chg' : ''}>
                <td className="l"><span className="desc">{it.desc}</span>{rec?.changed && <span className="b new">changed</span>}<span className="sub">{platform === 'fk' ? it.fkSku : it.amzSku}</span></td>
                <td className="l"><span className="p">{r.id}</span></td>
                <td className="l"><span className={'p' + (swapped ? ' swap' : rec ? '' : ' d')}>{rec?.served || '—'}</span>
                  {rec?.changed && rec.prevServed && rec.prevServed !== rec.served && <span className="sub">was <Old v={rec.prevServed} /></span>}</td>
                <td>
                  {rec?.changed && rec.prevPrice !== null && rec.price !== null && rec.prevPrice !== rec.price && <span className="sub"><Old v={inr(rec.prevPrice)} /></span>}
                  <span className={'p' + (swapped || !rec || rec.price === null ? ' d' : r.flags.includes('price') ? ' x' : '')}>{rec && rec.price !== null ? inr(rec.price) : '—'}</span>
                  {r.expected !== null && <span className="sub">exp {inr(r.expected)}</span>}
                </td>
                <td className="l"><StatusCell r={r} productFor={productFor} priceRef={priceRef} /></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// One row per product, Amazon and Flipkart side by side.
function BothTable({ rows, productFor, priceRef }: {
  rows: AvailRowView[]; productFor: (id: string | null, p: Platform) => string | null; priceRef: string;
}) {
  const byKey = new Map<string, { item: Item; amz?: AvailRowView; fk?: AvailRowView }>();
  rows.forEach(r => {
    const g = byKey.get(r.item.key) || { item: r.item };
    if (r.platform === 'amz') g.amz = r; else g.fk = r;
    byKey.set(r.item.key, g);
  });
  const groups = [...byKey.values()];
  if (!groups.length) return <div className="tablewrap"><div className="empty">No listings match this view.</div></div>;
  const cell = (r?: AvailRowView) => {
    if (!r) return <span className="p d">—</span>;
    const rec = r.rec;
    return (
      <>
        {rec?.changed && rec.prevPrice !== null && rec.price !== null && rec.prevPrice !== rec.price && <Old v={inr(rec.prevPrice)} />}{' '}
        <span className={'p' + (!rec || rec.price === null || rec.cls === 'variant' ? ' d' : r.flags.includes('price') ? ' x' : '')} style={{ marginRight: 6 }}>
          {rec && rec.price !== null ? inr(rec.price) : '—'}
        </span>
        <StatusCell r={r} productFor={productFor} priceRef={priceRef} compact />
      </>
    );
  };
  return (
    <div className="tablewrap">
      <table>
        <thead><tr><th className="l">Product</th><th className="l">Amazon</th><th className="l">Flipkart</th></tr></thead>
        <tbody>
          {groups.map(g => (
            <tr key={g.item.key} className={g.amz?.rec?.changed || g.fk?.rec?.changed ? 'chg' : ''}>
              <td className="l"><span className="desc">{g.item.desc}</span>{(g.amz?.rec?.changed || g.fk?.rec?.changed) && <span className="b new">changed</span>}<span className="sub">{[g.item.asin, g.item.fsn].filter(Boolean).join(' · ')}</span></td>
              <td className="l">{cell(g.amz)}</td>
              <td className="l">{cell(g.fk)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------- Changes tab: the full history, newest first ----------
const SRC: Record<string, [string, string]> = {
  amz_status: ['Live status', 'Amazon'], fk_status: ['Live status', 'Flipkart'],
  amz_price: ['Prices', 'Amazon'], fk_price: ['Prices', 'Flipkart'],
  sheet: ['Sheet', 'Sheet'], deal_file: ['Deal files', 'Deal file'], plan: ['Plan edits', 'Plan'],
};
const GROUPS = ['All', 'Live status', 'Prices', 'Sheet', 'Deal files', 'Plan edits'];
const FIELD: Record<string, string> = {
  status: 'Status', shown: 'Variant shown', seller: 'Buy Box seller', price: 'Price', discount: 'Discount', family_discount: 'Family discount',
  override: 'Planned deal', in_sale: 'In sale', event: 'Sale name', tolerance: 'Tolerance', price_ref: 'Compare price to', merchant_id: 'Merchant ID',
  file: 'File', added: 'Added to sheet', removed: 'Removed from sheet',
};

function ChangesView({ log, items }: { log: ChangeLogRow[]; items: Item[] }) {
  const [group, setGroup] = useState('All');
  const [q, setQ] = useState('');
  const byKey = useMemo(() => new Map(items.map(i => [i.key, i])), [items]);
  const ql = q.trim().toLowerCase();
  const rows = log.filter(r => {
    if (group !== 'All' && SRC[r.source]?.[0] !== group) return false;
    if (!ql) return true;
    const it = r.item_key ? byKey.get(r.item_key) : undefined;
    return [r.label, r.ref, r.field, r.old_value, r.new_value, r.changed_by, it?.desc, it?.family].join(' ').toLowerCase().includes(ql);
  });
  const who = (b: string | null) => (!b ? '' : b === 'schedule' ? 'daily check' : b.includes('@') ? short(b) : b);
  return (
    <>
      <div className="bar">
        {GROUPS.map(g => <button key={g} className={'chip' + (group === g ? ' on' : '')} onClick={() => setGroup(g)}>{g}</button>)}
        <input className="search" placeholder="Search product, SKU, ASIN, FSN, person" value={q} onChange={e => setQ(e.target.value)} />
      </div>
      {!rows.length ? (
        <div className="tablewrap"><div className="empty"><h2>No changes recorded yet</h2>Changes appear here after the next check, sheet sync, deal file upload or plan edit.</div></div>
      ) : (
        <div className="tablewrap">
          <table>
            <thead><tr><th className="l">When</th><th className="l">Where</th><th className="l">What</th><th className="l">Change</th><th className="l">By</th></tr></thead>
            <tbody>
              {rows.map(r => {
                const it = r.item_key ? byKey.get(r.item_key) : undefined;
                const label = r.label && r.label !== r.ref ? r.label : it?.desc || r.label || r.ref || '';
                const bad = /unavailable|sold out|removed|other variant/i.test(r.new_value || '');
                return (
                  <tr key={r.id}>
                    <td className="l"><span className="p d">{when(r.at)}</span></td>
                    <td className="l"><span className="b mut">{SRC[r.source]?.[1] || r.source}</span></td>
                    <td className="l"><span className="desc">{label}</span>{r.ref && r.ref !== label && <span className="sub">{r.ref}</span>}</td>
                    <td className="l"><span style={{ color: 'var(--ink2)' }}>{FIELD[r.field || ''] || r.field}</span>{' '}
                      {r.field !== 'added' && r.field !== 'removed' && <>
                        {r.old_value !== null && <><Old v={r.old_value} /> <span className="arrow">→</span> </>}
                        <span className={bad ? 'p x' : 'p'}>{r.new_value ?? '—'}</span>
                      </>}</td>
                    <td className="l"><span className="who-by">{who(r.changed_by)}</span></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <div className="foot"><span>{log.length >= 500 ? 'Showing the latest 500 changes. Older ones are kept in the database.' : `${log.length} change${log.length === 1 ? '' : 's'} recorded.`}</span></div>
    </>
  );
}
