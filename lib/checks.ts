import 'server-only';
import { supabaseAdmin } from '@/lib/supabase/server';
import { env } from '@/lib/env';
import { classifyAmz, extractFkPrice, RX_ASIN, RX_FSN, type AvailRecord } from '@/lib/logic';

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
  await pool(list, 4, async asin => {
    let rec: AvailRecord;
    try {
      const res = await withTimeout(`${SD}/amazon/product?api_key=${encodeURIComponent(key)}&asin=${asin}&domain=in`, 25_000);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
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

export interface FkOut { fsn: string; price: number | null; err: string | null; checked_at: string }

export async function checkFlipkart(targets: { fsn: string; url: string }[], deadline: number): Promise<FkOut[]> {
  const key = env('SCRAPINGDOG_API_KEY');
  const list = targets.filter(t => RX_FSN.test(t.fsn));
  const out: FkOut[] = [];
  await pool(list, 4, async t => {
    try {
      const url = t.url && /^https:\/\/(www\.)?flipkart\.com\//i.test(t.url) ? t.url : `https://www.flipkart.com/product/p/itm?pid=${t.fsn}`;
      const res = await withTimeout(`${SD}/scrape?api_key=${encodeURIComponent(key)}&url=${encodeURIComponent(url)}&dynamic=false`, 25_000);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      out.push({ fsn: t.fsn, price: extractFkPrice(await res.text()), err: null, checked_at: new Date().toISOString() });
    } catch (e) {
      out.push({ fsn: t.fsn, price: null, err: errText(e), checked_at: new Date().toISOString() });
    }
  }, deadline);
  if (out.length) {
    const { error } = await supabaseAdmin().from('deallens_live_prices').upsert(
      out.map(r => ({ platform: 'fk', id: r.fsn, price: r.price, err: r.err, checked_at: r.checked_at })),
      { onConflict: 'platform,id' },
    );
    if (error) throw new Error(error.message);
  }
  return out;
}
