import { NextResponse } from 'next/server';
import { isCron } from '@/lib/auth';
import { checkAmazon } from '@/lib/checks';
import { supabaseAdmin } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

// Scheduled Live status run (vercel.json). Off unless switched on in Team. Checks the ASINs whose
// last check is oldest first, and stops 20 seconds before the time limit; the rest wait for the next run.
export async function GET(req: Request) {
  if (!isCron(req)) return NextResponse.json({ error: 'Not allowed' }, { status: 401 });
  const db = supabaseAdmin();
  const { data: cfg } = await db.from('deallens_config').select('value').eq('key', 'auto_live_status').maybeSingle();
  if (!cfg || cfg.value !== true) return NextResponse.json({ status: 'skipped', reason: 'Auto Live status is off' });

  const [{ data: prods }, { data: checks }] = await Promise.all([
    db.from('deallens_products').select('asin').not('asin', 'is', null),
    db.from('deallens_avail_checks').select('asin, checked_at'),
  ]);
  const last = new Map((checks || []).map(c => [c.asin as string, Date.parse(c.checked_at as string)]));
  const asins = [...new Set((prods || []).map(p => p.asin as string))]
    .sort((a, b) => (last.get(a) ?? 0) - (last.get(b) ?? 0));
  const budgetMs = (maxDuration - 20) * 1000;
  try {
    const results = await checkAmazon(asins, 'schedule', Date.now() + budgetMs);
    return NextResponse.json({ status: 'ok', checked: results.length, of: asins.length });
  } catch (e) {
    return NextResponse.json({ status: 'error', error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
