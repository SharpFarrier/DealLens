import 'server-only';
import { supabaseAdmin } from '@/lib/supabase/server';
import { env } from '@/lib/env';
import { classifyAmz, classifyFk, RX_ASIN, RX_FSN, type AvailRecord, type FkAvailRecord } from '@/lib/logic';

const SD = 'https://api.scrapingdog.com';

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
    const latest = out.map(r => ({ asin: r.asin, cls: r.cls, served: r.served, price: r.price, seller: r.seller, mid: r.mid, err: r.err, checked_by: by, checked_at: r.checked_at }));
    const hist = out.map(r => ({ asin: r.asin, cls: r.cls, served: r.served, price: r.price, mid: r.mid, err: r.err, checked_by: by, checked_at: r.checked_at }));
    const prices = out.filter(r => r.cls !== 'error').map(r => ({
      platform: 'amz', id: r.asin, price: r.cls === 'variant' ? null : r.price, err: null, checked_at: r.checked_at,
    }));
    const results = await Promise.all([
      db.from('deallens_avail_checks').upsert(latest, { onConflict: 'asin' }),
      db.from('deallens_avail_history').insert(hist),
      prices.length ? db.from('deallens_live_prices').upsert(prices, { onConflict: 'platform,id' }) : Promise.resolve({ error: null }),
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
    const latest = out.map(r => ({ fsn: r.fsn, cls: r.cls, served: r.served, price: r.price, avail: r.avail, err: r.err, checked_by: by, checked_at: r.checked_at }));
    const prices = out.filter(r => r.cls !== 'error').map(r => ({
      platform: 'fk', id: r.fsn, price: r.cls === 'variant' ? null : r.price, err: null, checked_at: r.checked_at,
    }));
    const results = await Promise.all([
      db.from('deallens_fk_avail_checks').upsert(latest, { onConflict: 'fsn' }),
      db.from('deallens_fk_avail_history').insert(latest),
      prices.length ? db.from('deallens_live_prices').upsert(prices, { onConflict: 'platform,id' }) : Promise.resolve({ error: null }),
    ]);
    const failed = results.find(r => r.error);
    if (failed?.error) throw new Error(failed.error.message);
  }
  return out;
}
