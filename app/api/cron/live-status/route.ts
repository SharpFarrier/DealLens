import { NextResponse } from 'next/server';
import { isCron } from '@/lib/auth';
import { checkAmazon, checkFlipkart } from '@/lib/checks';
import { supabaseAdmin } from '@/lib/supabase/server';
import { countsOn } from '@/lib/views';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

// India midnight today, as an ISO time.
function todayStartIst(): string {
  const ist = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
  return new Date(`${ist}T00:00:00+05:30`).toISOString();
}

// The morning Live status run, in chunks. Each call checks listings that haven't been checked since
// `since` (default: India midnight today), stalest first, for up to `budget` seconds, and says how many
// are left. The GitHub morning job keeps calling until nothing is left, then calls once more with
// retry=errors to retry anything that couldn't be checked. Vercel's own daily cron calls it too, as a
// backup; when the morning job has already finished there is nothing left and it costs no credits.
// Off unless "Daily Live status check" is switched on in Settings.
export async function GET(req: Request) {
  if (!isCron(req)) return NextResponse.json({ error: 'Not allowed' }, { status: 401 });
  const url = new URL(req.url);
  const budget = Math.max(20, Math.min(250, Number(url.searchParams.get('budget')) || 250)) * 1000;
  const retryErrors = url.searchParams.get('retry') === 'errors';
  const sinceParam = url.searchParams.get('since');
  const since = sinceParam && !Number.isNaN(Date.parse(sinceParam)) ? new Date(sinceParam).toISOString() : todayStartIst();

  const db = supabaseAdmin();
  const { data: cfg, error: cfgErr } = await db.from('deallens_config').select('value').eq('key', 'auto_live_status').maybeSingle();
  if (cfgErr) return NextResponse.json({ status: 'error', error: cfgErr.message }, { status: 500 });
  if (!cfg || cfg.value !== true) return NextResponse.json({ status: 'skipped', reason: 'Daily Live status check is off in Settings', remaining: 0 });

  const [{ data: prods, error: e1 }, { data: amzChecks, error: e2 }, { data: fkChecks, error: e3 }] = await Promise.all([
    db.from('deallens_products').select('asin, fsn, flipkart_link, sheet_status').range(0, 4999),
    db.from('deallens_avail_checks').select('asin, cls, checked_at').range(0, 4999),
    db.from('deallens_fk_avail_checks').select('fsn, cls, checked_at').range(0, 4999),
  ]);
  const err = e1 || e2 || e3;
  if (err) return NextResponse.json({ status: 'error', error: err.message }, { status: 500 });

  type Cur = { cls: string; at: number };
  const curA = new Map((amzChecks || []).map(c => [c.asin as string, { cls: c.cls as string, at: Date.parse(c.checked_at as string) }]));
  const curF = new Map((fkChecks || []).map(c => [c.fsn as string, { cls: c.cls as string, at: Date.parse(c.checked_at as string) }]));
  const cut = Date.parse(since);
  const due = (c: Cur | undefined) => (retryErrors ? !!c && c.cls === 'error' && c.at < cut : !c || c.at < cut);
  const stalest = (m: Map<string, Cur>) => (a: string, b: string) => (m.get(a)?.at ?? 0) - (m.get(b)?.at ?? 0);

  const asins = [...new Set((prods || []).filter(p => p.asin && countsOn(p.sheet_status as string, 'amz')).map(p => p.asin as string))]
    .filter(a => due(curA.get(a))).sort(stalest(curA));
  const links = new Map<string, string>();
  (prods || []).forEach(p => { if (p.fsn && countsOn(p.sheet_status as string, 'fk') && !links.has(p.fsn as string)) links.set(p.fsn as string, (p.flipkart_link as string) || ''); });
  const fsns = [...links.keys()].filter(f => due(curF.get(f))).sort(stalest(curF));

  // Stop starting new requests 30 s before the budget ends, so saving always fits.
  const stopAt = Date.now() + budget - 30_000;
  try {
    const a = asins.length ? await checkAmazon(asins, 'schedule', stopAt) : [];
    const f = fsns.length && Date.now() < stopAt ? await checkFlipkart(fsns.map(fsn => ({ fsn, url: links.get(fsn)! })), 'schedule', stopAt) : [];
    const errors = [...a, ...f].filter(r => r.cls === 'error').length;
    return NextResponse.json({
      status: 'ok', mode: retryErrors ? 'retry errors' : 'due', since,
      checked: a.length + f.length, errors,
      remaining: asins.length - a.length + fsns.length - f.length,
      amazon: { checked: a.length, due: asins.length }, flipkart: { checked: f.length, due: fsns.length },
    });
  } catch (e) {
    return NextResponse.json({ status: 'error', error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
