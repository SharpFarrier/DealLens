import { NextResponse } from 'next/server';
import { requireAccess } from '@/lib/auth';
import { checkFlipkart } from '@/lib/checks';
import { supabaseAdmin } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const MAX_PER_CALL = 12;

// Flipkart Live status + live price check. Product page links come from the synced catalogue, never from the request.
export async function POST(req: Request) {
  const m = await requireAccess(req);
  if (m instanceof NextResponse) return m;
  const body = await req.json().catch(() => null);
  const fsns: unknown = body?.fsns;
  if (!Array.isArray(fsns) || !fsns.every(a => typeof a === 'string')) {
    return NextResponse.json({ error: 'Send { fsns: string[] }' }, { status: 400 });
  }
  if (fsns.length > MAX_PER_CALL) return NextResponse.json({ error: `At most ${MAX_PER_CALL} FSNs per call` }, { status: 400 });
  const wanted = (fsns as string[]).map(f => f.trim().toUpperCase());
  const { data, error } = await supabaseAdmin().from('deallens_products').select('fsn, flipkart_link').in('fsn', wanted);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const links = new Map((data || []).map(r => [r.fsn as string, (r.flipkart_link as string) || '']));
  try {
    const results = await checkFlipkart(wanted.filter(f => links.has(f)).map(fsn => ({ fsn, url: links.get(fsn)! })), m.email, Date.now() + 45_000);
    return NextResponse.json({ results });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
