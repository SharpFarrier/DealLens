import { NextResponse } from 'next/server';
import { isCron } from '@/lib/auth';
import { checkAmazon, checkFlipkart } from '@/lib/checks';
import { supabaseAdmin } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

// Scheduled Live status run (vercel.json). Off unless switched on in Settings. Checks Amazon ASINs, then
// Flipkart FSNs, each with half the time, the longest-unchecked first. Whatever doesn't fit in one run
// is first in line next time, so every listing gets checked within a day or two.
export async function GET(req: Request) {
  if (!isCron(req)) return NextResponse.json({ error: 'Not allowed' }, { status: 401 });
  const db = supabaseAdmin();
  const { data: cfg } = await db.from('deallens_config').select('value').eq('key', 'auto_live_status').maybeSingle();
  if (!cfg || cfg.value !== true) return NextResponse.json({ status: 'skipped', reason: 'Auto Live status is off' });

  const [{ data: prods }, { data: amzChecks }, { data: fkChecks }] = await Promise.all([
    db.from('deallens_products').select('asin, fsn, flipkart_link'),
    db.from('deallens_avail_checks').select('asin, checked_at'),
    db.from('deallens_fk_avail_checks').select('fsn, checked_at'),
  ]);
  const lastA = new Map((amzChecks || []).map(c => [c.asin as string, Date.parse(c.checked_at as string)]));
  const lastF = new Map((fkChecks || []).map(c => [c.fsn as string, Date.parse(c.checked_at as string)]));
  const asins = [...new Set((prods || []).map(p => p.asin as string).filter(Boolean))]
    .sort((a, b) => (lastA.get(a) ?? 0) - (lastA.get(b) ?? 0));
  const links = new Map<string, string>();
  (prods || []).forEach(p => { if (p.fsn && !links.has(p.fsn as string)) links.set(p.fsn as string, (p.flipkart_link as string) || ''); });
  const fsns = [...links.keys()].sort((a, b) => (lastF.get(a) ?? 0) - (lastF.get(b) ?? 0));

  const start = Date.now();
  const budget = (maxDuration - 20) * 1000;
  try {
    const a = await checkAmazon(asins, 'schedule', start + budget / 2);
    const f = await checkFlipkart(fsns.map(fsn => ({ fsn, url: links.get(fsn)! })), 'schedule', start + budget);
    return NextResponse.json({ status: 'ok', amazon: { checked: a.length, of: asins.length }, flipkart: { checked: f.length, of: fsns.length } });
  } catch (e) {
    return NextResponse.json({ status: 'error', error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
