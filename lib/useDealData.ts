'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { supabaseBrowser } from '@/lib/supabase/browser';
import { OUR_MERCHANT, type Item } from '@/lib/logic';
import { productToItem, toNum, type AvailRow, type FkAvailRow, type PlanSettingsRow, type PriceColumnRow, type ProductRow, type SyncRunRow } from '@/lib/data';
import type { Check, Checks, DayRow, Plat } from '@/lib/views';

export interface Settings {
  mode: 'sale' | 'normal'; column: string; disc: number; merchantId: string;
  columnBy: string | null; columnAt: string | null; dismissed: string[]; updatedBy: string | null; updatedAt: string | null;
}
export interface Config { auto_sync: boolean; auto_live_status: boolean }

export interface DealData {
  loading: boolean;
  error: string | null;
  items: Item[];
  settings: Settings;
  familyDisc: Record<string, number>;
  priceColumns: PriceColumnRow[];
  amz: Checks;
  fk: Checks;
  days: DayRow[];
  downSince: Record<string, string>;   // "amz:B0..." -> ISO time it went down
  lastSync: SyncRunRow | null;
  lastOkSync: SyncRunRow | null;
  config: Config;
}

const EMPTY: DealData = {
  loading: true, error: null, items: [],
  settings: { mode: 'sale', column: 'New Price', disc: 16, merchantId: OUR_MERCHANT, columnBy: null, columnAt: null, dismissed: [], updatedBy: null, updatedAt: null },
  familyDisc: {}, priceColumns: [], amz: {}, fk: {}, days: [], downSince: {}, lastSync: null, lastOkSync: null,
  config: { auto_sync: true, auto_live_status: false },
};

export type Table = 'products' | 'plan_settings' | 'family_discounts' | 'price_columns' | 'avail_checks' | 'fk_avail_checks' | 'days' | 'down_since' | 'sync_runs' | 'app_config';
const TABLES: Table[] = ['products', 'plan_settings', 'family_discounts', 'price_columns', 'avail_checks', 'fk_avail_checks', 'days', 'down_since', 'sync_runs', 'app_config'];

// Which data to reload when the database says a table changed.
const ON_PING: Record<string, Table[]> = {
  deallens_products: ['products', 'days'],
  deallens_plan_settings: ['plan_settings'],
  deallens_family_discounts: ['family_discounts'],
  deallens_price_columns: ['price_columns'],
  deallens_avail_checks: ['avail_checks', 'down_since'],
  deallens_fk_avail_checks: ['fk_avail_checks', 'down_since'],
  deallens_avail_history: ['days', 'down_since'],
  deallens_fk_avail_history: ['days', 'down_since'],
  deallens_sync_runs: ['sync_runs'],
  deallens_config: ['app_config'],
};

const toCheck = (r: AvailRow | FkAvailRow): Check => ({
  cls: r.cls, price: toNum(r.price), served: r.served, mid: 'mid' in r ? r.mid : null, avail: 'avail' in r ? r.avail : null, checkedAt: r.checked_at,
});

async function all<T>(q: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await q(from, from + 999);
    if (error) throw new Error(error.message);
    const rows = (data || []) as T[];
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}

// Loads everything for the signed-in team and keeps it live: any change anyone makes
// (or a sync/check on the server) reloads just what changed.
export function useDealData() {
  const [data, setData] = useState<DealData>(EMPTY);
  const pending = useRef<Set<Table>>(new Set());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async (tables: Table[]) => {
    const sb = supabaseBrowser();
    const patch: Partial<DealData> = {};
    const errors: string[] = [];
    const run = async (t: Table) => {
      try {
        switch (t) {
          case 'products': {
            const rows = await all<ProductRow>((a, b) => sb.from('deallens_products').select('*').order('sort_order').range(a, b));
            patch.items = rows.map(productToItem);
            return;
          }
          case 'plan_settings': {
            const { data: r, error } = await sb.from('deallens_plan_settings').select('*').eq('id', 1).maybeSingle();
            if (error) throw new Error(error.message);
            const p = r as PlanSettingsRow | null;
            if (p) patch.settings = {
              mode: p.mode === 'normal' ? 'normal' : 'sale', column: p.price_column || 'New Price', disc: Number(p.disc),
              merchantId: p.merchant_id || OUR_MERCHANT, columnBy: p.price_column_by || null, columnAt: p.price_column_at || null,
              dismissed: p.dismissed_columns || [], updatedBy: p.updated_by, updatedAt: p.updated_at,
            };
            return;
          }
          case 'family_discounts': {
            const { data: rows, error } = await sb.from('deallens_family_discounts').select('family, disc');
            if (error) throw new Error(error.message);
            patch.familyDisc = Object.fromEntries((rows || []).map((r: { family: string; disc: number | string }) => [r.family, Number(r.disc)]));
            return;
          }
          case 'price_columns': {
            const { data: rows, error } = await sb.from('deallens_price_columns').select('*').order('position');
            if (error) throw new Error(error.message);
            patch.priceColumns = (rows || []) as PriceColumnRow[];
            return;
          }
          case 'avail_checks': {
            const rows = await all<AvailRow>((a, b) => sb.from('deallens_avail_checks').select('*').range(a, b));
            patch.amz = Object.fromEntries(rows.map(r => [r.asin, toCheck(r)]));
            return;
          }
          case 'fk_avail_checks': {
            const rows = await all<FkAvailRow>((a, b) => sb.from('deallens_fk_avail_checks').select('*').range(a, b));
            patch.fk = Object.fromEntries(rows.map(r => [r.fsn, toCheck(r)]));
            return;
          }
          case 'days': {
            const { data: rows, error } = await sb.rpc('deallens_status_days', { p_days: 30 });
            if (error) throw new Error(error.message);
            patch.days = ((rows || []) as { day: string; platform: Plat; family: string; checked: number; down: number }[])
              .map(r => ({ day: String(r.day).slice(0, 10), platform: r.platform, family: r.family, checked: Number(r.checked), down: Number(r.down) }));
            return;
          }
          case 'down_since': {
            const { data: rows, error } = await sb.rpc('deallens_down_since');
            if (error) throw new Error(error.message);
            patch.downSince = Object.fromEntries(((rows || []) as { platform: Plat; id: string; since: string }[]).map(r => [r.platform + ':' + r.id, r.since]));
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
            if (error) throw new Error(error.message);
            const c: Config = { auto_sync: true, auto_live_status: false };
            (rows || []).forEach((r: { key: string; value: unknown }) => { if (r.key in c) (c as unknown as Record<string, boolean>)[r.key] = r.value === true; });
            patch.config = c;
            return;
          }
        }
      } catch (e) {
        errors.push(e instanceof Error ? e.message : String(e));
      }
    };
    await Promise.all(tables.map(run));
    setData(prev => ({ ...prev, ...patch, loading: false, error: errors.length ? errors[0] : null }));
  }, []);

  const reload = useCallback((...ts: Table[]) => {
    ts.forEach(t => pending.current.add(t));
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const list = [...pending.current];
      pending.current.clear();
      void load(list);
    }, 400);
  }, [load]);

  useEffect(() => {
    void load(TABLES);
    const sb = supabaseBrowser();
    // The database stamps deallens_changes whenever a DealLens table changes; we then refetch
    // just that data through the normal, device-checked path.
    const ch = sb.channel('deallens-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'deallens_changes' }, payload => {
        const tbl = String((payload.new as { tbl?: string } | null)?.tbl || '');
        const ts = ON_PING[tbl];
        if (ts) reload(...ts);
      })
      .subscribe();
    // Catch up after the laptop sleeps or the tab was in the background.
    const onVis = () => { if (document.visibilityState === 'visible') void load(TABLES); };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      void sb.removeChannel(ch);
    };
  }, [load, reload]);

  const patchLocal = useCallback((fn: (d: DealData) => DealData) => setData(fn), []);
  return { data, reload, reloadAll: () => load(TABLES), patchLocal };
}
