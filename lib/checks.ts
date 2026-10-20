import 'server-only';
import { supabaseAdmin } from '@/lib/supabase/server';
import { env } from '@/lib/env';
import { classifyAmz, classifyFk, statusChanges, RX_ASIN, RX_FSN, type AvailClass, type AvailRecord, type FkAvailRecord } from '@/lib/logic';

// SCRAPINGDOG_BASE is only for local testing against a fake server.
const SD = process.env.SCRAPINGDOG_BASE?.startsWith('http://localhost') ? process.env.SCRAPINGDOG_BASE : 'https://api.scrapingdog.com';

async function withTimeout(url: string, ms: number): Promise<Response> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { signal: ctl.signal, cache: 'no-store' });
  } finally {
    clearTimeout(t);
  }
}

// How many Scrapingdog requests may run at once. Plans cap concurrent requests and answer HTTP 429
// above the cap; set SCRAPINGDOG_CONCURRENCY in Vercel to match your plan.
const CONCURRENCY = Math.max(1, Math.min(10, Number(process.env.SCRAPINGDOG_CONCURRENCY) || 2));

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// One Scrapingdog call, retried on 429 (too many at once) and 5xx with growing waits,
// as long as there is time left before the deadline.
export async function sdFetch(url: string, deadline: number): Promise<Response> {
  let wait = 2000;
  for (let attempt = 0; ; attempt++) {
    const res = await withTimeout(url, Math.max(5_000, Math.min(25_000, deadline - Date.now())));
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= 3) return res;
    const ra = Number(res.headers.get('retry-after'));
    const pause = Number.isFinite(ra) && ra > 0 ? ra * 1000 : wait;
    if (Date.now() + pause + 8_000 > deadline) return res;
    await sleep(pause + Math.floor(Math.random() * 500));
    wait *= 2;
  }
}

const errText = (e: unknown) => (e instanceof Error ? (e.name === 'AbortError' ? 'Timed out' : e.message) : String(e));

async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>, deadline: number) {
  let i = 0;
  const run = async () => { while (i < items.length && Date.now() < deadline) { const x = items[i++]; await fn(x); } };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, run));
}

// ----- change memory -----
interface Prev { cls: AvailClass; price: number | null; served: string | null; mid: string | null; checked_at: string }

// Each id's latest real (non-error) check before this run, so old -> new skips "Couldn't check".
async function previousChecks(table: 'deallens_avail_history' | 'deallens_fk_avail_history', idCol: 'asin' | 'fsn', ids: string[]): Promise<Map<string, Prev>> {
  const map = new Map<string, Prev>();
  if (!ids.length) return map;
  const cols = idCol === 'asin' ? 'asin, cls, price, served, mid, checked_at' : 'fsn, cls, price, served, checked_at';
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await supabaseAdmin().from(table).select(cols)
      .in(idCol, ids.slice(i, i + 100)).neq('cls', 'error').order('checked_at', { ascending: false }).limit(2000);
    if (error) throw new Error(error.message);
    for (const r of (data || []) as unknown as Record<string, unknown>[]) {
      const id = r[idCol] as string;
      if (!map.has(id)) map.set(id, { cls: r.cls as AvailClass, price: r.price === null ? null : Number(r.price), served: (r.served as string) || null, mid: (r.mid as string) || null, checked_at: r.checked_at as string });
    }
  }
  return map;
}

async function catalogueIndex(col: 'asin' | 'fsn', ids: string[]): Promise<Map<string, { key: string; desc: string }>> {
  const map = new Map<string, { key: string; desc: string }>();
  if (!ids.length) return map;
  const { data } = await supabaseAdmin().from('deallens_products').select(`key, description, ${col}`).in(col, ids);
  for (const r of (data || []) as unknown as Record<string, string>[]) if (!map.has(r[col])) map.set(r[col], { key: r.key, desc: r.description });
  return map;
}

interface Checked { id: string; cls: AvailClass; price: number | null; served: string | null; mid: string | null; checked_at: string }

// Works out prev/changed for each fresh result and the change-log rows to add.
async function remember(platform: 'amz' | 'fk', out: Checked[], by: string) {
  const ids = out.map(r => r.id);
  const [prev, cat] = await Promise.all([
    previousChecks(platform === 'amz' ? 'deallens_avail_history' : 'deallens_fk_avail_history', platform === 'amz' ? 'asin' : 'fsn', ids),
    catalogueIndex(platform === 'amz' ? 'asin' : 'fsn', ids),
  ]);
  const extra = new Map<string, { prev_cls: string | null; prev_price: number | null; prev_served: string | null; prev_checked_at: string | null; changed: boolean }>();
  const log: Record<string, unknown>[] = [];
  for (const r of out) {
    const p = prev.get(r.id) || null;
    if (r.cls === 'error') { extra.set(r.id, { prev_cls: null, prev_price: null, prev_served: null, prev_checked_at: null, changed: false }); continue; }
    const ch = statusChanges(p, { cls: r.cls, price: r.price, served: r.served, mid: r.mid });
    extra.set(r.id, { prev_cls: p?.cls ?? null, prev_price: p?.price ?? null, prev_served: p?.served ?? null, prev_checked_at: p?.checked_at ?? null, changed: ch.length > 0 });
    const c = cat.get(r.id);
    for (const x of ch) {
      log.push({
        at: r.checked_at, source: x.field === 'price' ? `${platform}_price` : `${platform}_status`, item_key: c?.key ?? null, ref: r.id,
        label: c?.desc ?? r.id, field: x.field, old_value: x.old, new_value: x.new, changed_by: by,
      });
    }
  }
  return { extra, log, prev };
}

export interface AvailOut extends AvailRecord { asin: string; checked_at: string }

// Checks ASINs on Amazon, saves the latest status, history, and live price. Stops starting new
// requests once the deadline passes; anything not reached is left for the next run.
export async function checkAmazon(asins: string[], by: string, deadline: number): Promise<AvailOut[]> {
  const key = env('SCRAPINGDOG_API_KEY');
  const list = [...new Set(asins.map(a => a.trim().toUpperCase()).filter(a => RX_ASIN.test(a)))];
  const out: AvailOut[] = [];
  await pool(list, CONCURRENCY, async asin => {
    let rec: AvailRecord;
    try {
      const res = await sdFetch(`${SD}/amazon/product?api_key=${encodeURIComponent(key)}&asin=${asin}&domain=in`, deadline);
      if (!res.ok) throw new Error(res.status === 429 ? 'Scrapingdog busy (HTTP 429), retry' : `HTTP ${res.status}`);
      rec = classifyAmz(asin, await res.json());
    } catch (e) {
      rec = { cls: 'error', err: errText(e), served: null, price: null, seller: null, mid: null };
    }
    out.push({ asin, ...rec, checked_at: new Date().toISOString() });
  }, deadline);

  if (out.length) {
    const db = supabaseAdmin();
    const mem = await remember('amz', out.map(r => ({ id: r.asin, cls: r.cls, price: r.price, served: r.served, mid: r.mid, checked_at: r.checked_at })), by);
    const latest = out.map(r => ({ asin: r.asin, cls: r.cls, served: r.served, price: r.price, seller: r.seller, mid: r.mid, err: r.err, checked_by: by, checked_at: r.checked_at, ...mem.extra.get(r.asin) }));
    const hist = out.map(r => ({ asin: r.asin, cls: r.cls, served: r.served, price: r.price, mid: r.mid, err: r.err, checked_by: by, checked_at: r.checked_at }));
    const prices = out.filter(r => r.cls !== 'error').map(r => {
      const p = mem.prev.get(r.asin);
      return { platform: 'amz', id: r.asin, price: r.cls === 'variant' ? null : r.price, err: null, checked_at: r.checked_at,
        prev_price: p && p.cls !== 'variant' ? p.price : null, prev_checked_at: p?.checked_at ?? null };
    });
    const results = await Promise.all([
      db.from('deallens_avail_checks').upsert(latest, { onConflict: 'asin' }),
      db.from('deallens_avail_history').insert(hist),
      prices.length ? db.from('deallens_live_prices').upsert(prices, { onConflict: 'platform,id' }) : Promise.resolve({ error: null }),
      mem.log.length ? db.from('deallens_change_log').insert(mem.log) : Promise.resolve({ error: null }),
    ]);
    const failed = results.find(r => r.error);
    if (failed?.error) throw new Error(failed.error.message);
  }
  return out;
}

export interface FkOut extends FkAvailRecord { fsn: string; checked_at: string }

// Checks FSNs on flipkart.com (exact FSN, in stock, price), saves the latest status, history and live price.
export async function checkFlipkart(targets: { fsn: string; url: string }[], by: string, deadline: number): Promise<FkOut[]> {
  const key = env('SCRAPINGDOG_API_KEY');
  const list = targets.filter(t => RX_FSN.test(t.fsn));
  const out: FkOut[] = [];
  await pool(list, CONCURRENCY, async t => {
    let rec: FkAvailRecord;
    try {
      const url = t.url && /^https:\/\/(www\.)?flipkart\.com\//i.test(t.url) ? t.url : `https://www.flipkart.com/product/p/itm?pid=${t.fsn}`;
      const res = await sdFetch(`${SD}/scrape?api_key=${encodeURIComponent(key)}&url=${encodeURIComponent(url)}&dynamic=false`, deadline);
      if (!res.ok) throw new Error(res.status === 429 ? 'Scrapingdog busy (HTTP 429), retry' : `HTTP ${res.status}`);
      rec = classifyFk(t.fsn, await res.text());
    } catch (e) {
      rec = { cls: 'error', err: errText(e), served: null, price: null, seller: null, mid: null, avail: null };
    }
    out.push({ fsn: t.fsn, ...rec, checked_at: new Date().toISOString() });
  }, deadline);
  if (out.length) {
    const db = supabaseAdmin();
    const mem = await remember('fk', out.map(r => ({ id: r.fsn, cls: r.cls, price: r.price, served: r.served, mid: null, checked_at: r.checked_at })), by);
    const hist = out.map(r => ({ fsn: r.fsn, cls: r.cls, served: r.served, price: r.price, avail: r.avail, err: r.err, checked_by: by, checked_at: r.checked_at }));
    const latest = out.map(r => ({ ...hist.find(h => h.fsn === r.fsn)!, ...mem.extra.get(r.fsn) }));
    const prices = out.filter(r => r.cls !== 'error').map(r => {
      const p = mem.prev.get(r.fsn);
      return { platform: 'fk', id: r.fsn, price: r.cls === 'variant' ? null : r.price, err: null, checked_at: r.checked_at,
        prev_price: p && p.cls !== 'variant' ? p.price : null, prev_checked_at: p?.checked_at ?? null };
    });
    const results = await Promise.all([
      db.from('deallens_fk_avail_checks').upsert(latest, { onConflict: 'fsn' }),
      db.from('deallens_fk_avail_history').insert(hist),
      prices.length ? db.from('deallens_live_prices').upsert(prices, { onConflict: 'platform,id' }) : Promise.resolve({ error: null }),
      mem.log.length ? db.from('deallens_change_log').insert(mem.log) : Promise.resolve({ error: null }),
    ]);
    const failed = results.find(r => r.error);
    if (failed?.error) throw new Error(failed.error.message);
  }
  return out;
}
