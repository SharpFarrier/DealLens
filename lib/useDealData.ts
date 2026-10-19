'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { supabaseBrowser } from '@/lib/supabase/browser';
import { parseDealFile, type DealFile, type Item, type LiveMap, type Plan, type AvailRecord } from '@/lib/logic';
import {
  productToItem, toNum, type AvailRow, type FkAvailRow, type DealFileRow, type LivePriceRow, type PlanSettingsRow, type ProductRow, type SyncRunRow,
} from '@/lib/data';

export interface Settings { event: string; disc: number; tol: number; priceRef: 'deal' | 'catalogue' | 'off'; merchantId: string; updatedBy: string | null; updatedAt: string | null }
export interface DealFileState { row: DealFileRow; parsed: DealFile | null; error: string | null }
// For Flipkart rows, `asin` holds the FSN and `avail` the stock state Flipkart reported.
export interface AvailState extends AvailRecord { asin: string; checkedAt: string; checkedBy: string | null; avail?: string | null }
export interface Config { auto_sync: boolean; auto_live_status: boolean }

export interface DealData {
  loading: boolean;
  error: string | null;
  items: Item[];
  settings: Settings;
  plan: Plan;
  files: { amz: DealFileState | null; fk: DealFileState | null };
  live: LiveMap;
  avail: Record<string, AvailState>;
  fkAvail: Record<string, AvailState>;
  lastSync: SyncRunRow | null;
  lastOkSync: SyncRunRow | null;
  config: Config;
}

const EMPTY: DealData = {
  loading: true, error: null, items: [],
  settings: { event: '', disc: 16, tol: 1, priceRef: 'deal', merchantId: '', updatedBy: null, updatedAt: null },
  plan: { disc: 16, familyDisc: {}, override: {}, excluded: {} },
  files: { amz: null, fk: null },
  live: { amz: {}, fk: {} }, avail: {}, fkAvail: {}, lastSync: null, lastOkSync: null,
  config: { auto_sync: true, auto_live_status: false },
};

type Table = 'products' | 'plan_settings' | 'family_discounts' | 'sku_overrides' | 'sku_excluded' | 'deal_files' | 'live_prices' | 'avail_checks' | 'fk_avail_checks' | 'sync_runs' | 'app_config';
const TABLES: Table[] = ['products', 'plan_settings', 'family_discounts', 'sku_overrides', 'sku_excluded', 'deal_files', 'live_prices', 'avail_checks', 'fk_avail_checks', 'sync_runs', 'app_config'];

function fileState(row: DealFileRow): DealFileState {
  try {
    return { row, parsed: parseDealFile(row.aoa, row.platform, row.mapping), error: null };
  } catch (e) {
    return { row, parsed: null, error: e instanceof Error ? e.message : String(e) };
  }
}

// Loads everything for the signed-in team and keeps it live: any change anyone makes
// (or a sync/check on the server) reloads just the table that changed.
export function useDealData() {
  const [data, setData] = useState<DealData>(EMPTY);
  const pending = useRef<Set<Table>>(new Set());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async (tables: Table[]) => {
    const sb = supabaseBrowser();
    const patch: Partial<DealData> = {};
    const errors: string[] = [];
    const run = async (t: Table) => {
      switch (t) {
        case 'products': {
          const all: ProductRow[] = [];
          for (let from = 0; ; from += 1000) {
            const { data: rows, error } = await sb.from('deallens_products').select('*').order('sort_order').range(from, from + 999);
            if (error) { errors.push(error.message); return; }
            all.push(...(rows as ProductRow[]));
            if (!rows || rows.length < 1000) break;
          }
          patch.items = all.map(productToItem);
          return;
        }
        case 'plan_settings': {
          const { data: r, error } = await sb.from('deallens_plan_settings').select('*').eq('id', 1).maybeSingle();
          if (error) { errors.push(error.message); return; }
          const p = r as PlanSettingsRow | null;
          if (p) patch.settings = {
            event: p.event, disc: Number(p.disc), tol: Number(p.tol), priceRef: p.price_ref, merchantId: p.merchant_id,
            updatedBy: p.updated_by, updatedAt: p.updated_at,
          };
          return;
        }
        case 'family_discounts': case 'sku_overrides': case 'sku_excluded': {
          const { data: rows, error } = await sb.from('deallens_' + t).select('*');
          if (error) { errors.push(error.message); return; }
          (patch as Record<string, unknown>)['_' + t] = rows;
          return;
        }
        case 'deal_files': {
          const { data: rows, error } = await sb.from('deallens_deal_files').select('*');
          if (error) { errors.push(error.message); return; }
          const files: DealData['files'] = { amz: null, fk: null };
          (rows as DealFileRow[]).forEach(r => { files[r.platform] = fileState(r); });
          patch.files = files;
          return;
        }
        case 'live_prices': {
          const { data: rows, error } = await sb.from('deallens_live_prices').select('*');
          if (error) { errors.push(error.message); return; }
          const live: LiveMap = { amz: {}, fk: {} };
          (rows as LivePriceRow[]).forEach(r => { live[r.platform][r.id] = { price: toNum(r.price), err: r.err, at: r.checked_at }; });
          patch.live = live;
          return;
        }
        case 'avail_checks': {
          const { data: rows, error } = await sb.from('deallens_avail_checks').select('*');
          if (error) { errors.push(error.message); return; }
          const avail: Record<string, AvailState> = {};
          (rows as AvailRow[]).forEach(r => {
            avail[r.asin] = { asin: r.asin, cls: r.cls, served: r.served, price: toNum(r.price), seller: r.seller, mid: r.mid, err: r.err, checkedAt: r.checked_at, checkedBy: r.checked_by };
          });
          patch.avail = avail;
          return;
        }
        case 'fk_avail_checks': {
          const { data: rows, error } = await sb.from('deallens_fk_avail_checks').select('*');
          if (error) { errors.push(error.message); return; }
          const fkAvail: Record<string, AvailState> = {};
          (rows as FkAvailRow[]).forEach(r => {
            fkAvail[r.fsn] = { asin: r.fsn, cls: r.cls, served: r.served, price: toNum(r.price), seller: null, mid: null, err: r.err, avail: r.avail, checkedAt: r.checked_at, checkedBy: r.checked_by };
          });
          patch.fkAvail = fkAvail;
          return;
        }
        case 'sync_runs': {
          const [{ data: last }, { data: ok }] = await Promise.all([
            sb.from('deallens_sync_runs').select('*').order('started_at', { ascending: false }).limit(1),
            sb.from('deallens_sync_runs').select('*').eq('status', 'ok').order('started_at', { ascending: false }).limit(1),
          ]);
          patch.lastSync = (last?.[0] as SyncRunRow) || null;
          patch.lastOkSync = (ok?.[0] as SyncRunRow) || null;
          return;
        }
        case 'app_config': {
          const { data: rows, error } = await sb.from('deallens_config').select('key, value');
          if (error) { errors.push(error.message); return; }
          const c: Config = { auto_sync: true, auto_live_status: false };
          (rows || []).forEach((r: { key: string; value: unknown }) => { if (r.key in c) (c as unknown as Record<string, boolean>)[r.key] = r.value === true; });
          patch.config = c;
          return;
        }
      }
    };
    await Promise.all(tables.map(run));
    setData(prev => {
      const next: DealData = { ...prev, ...patch, loading: false, error: errors.length ? errors[0] : null };
      const p = patch as Record<string, unknown>;
      if (p._family_discounts || p._sku_overrides || p._sku_excluded || patch.settings) {
        next.plan = {
          disc: next.settings.disc,
          familyDisc: p._family_discounts
            ? Object.fromEntries((p._family_discounts as { family: string; disc: number | string }[]).map(r => [r.family, Number(r.disc)]))
            : prev.plan.familyDisc,
          override: p._sku_overrides
            ? Object.fromEntries((p._sku_overrides as { key: string; price: number | string }[]).map(r => [r.key, Number(r.price)]))
            : prev.plan.override,
          excluded: p._sku_excluded
            ? Object.fromEntries((p._sku_excluded as { key: string }[]).map(r => [r.key, true]))
            : prev.plan.excluded,
        };
      }
      delete (next as unknown as Record<string, unknown>)._family_discounts;
      delete (next as unknown as Record<string, unknown>)._sku_overrides;
      delete (next as unknown as Record<string, unknown>)._sku_excluded;
      return next;
    });
  }, []);

  const reload = useCallback((t: Table) => {
    pending.current.add(t);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const list = [...pending.current];
      pending.current.clear();
      load(list);
    }, 250);
  }, [load]);

  useEffect(() => {
    load(TABLES);
    const sb = supabaseBrowser();
    // Live updates: the database stamps deallens_changes whenever a DealLens table changes; we then
    // refetch just that table through the normal, device-checked path.
    const ch = sb.channel('deallens-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'deallens_changes' }, payload => {
        const tbl = String((payload.new as { tbl?: string } | null)?.tbl || '');
        const logical = (tbl === 'deallens_config' ? 'app_config' : tbl.replace(/^deallens_/, '')) as Table;
        if (TABLES.includes(logical)) reload(logical);
      })
      .subscribe();
    // Catch up after the laptop sleeps or the tab was in the background.
    const onVis = () => { if (document.visibilityState === 'visible') load(TABLES); };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      sb.removeChannel(ch);
    };
  }, [load, reload]);

  // Apply a local change right away (optimistic), before realtime confirms it.
  const patchLocal = useCallback((fn: (d: DealData) => DealData) => setData(fn), []);

  return { data, reload: (t: Table) => load([t]), reloadAll: () => load(TABLES), patchLocal };
}
