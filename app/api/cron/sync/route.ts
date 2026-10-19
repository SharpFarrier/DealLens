import { NextResponse } from 'next/server';
import { isCron } from '@/lib/auth';
import { runSync } from '@/lib/sync';
import { supabaseAdmin } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Scheduled sheet sync (vercel.json). Respects the "Auto sync" switch on the Team page.
export async function GET(req: Request) {
  if (!isCron(req)) return NextResponse.json({ error: 'Not allowed' }, { status: 401 });
  const { data } = await supabaseAdmin().from('deallens_config').select('value').eq('key', 'auto_sync').maybeSingle();
  if (data && data.value === false) return NextResponse.json({ status: 'skipped', reason: 'Auto sync is off' });
  const result = await runSync('cron', null);
  return NextResponse.json(result, { status: result.status === 'error' ? 500 : 200 });
}
