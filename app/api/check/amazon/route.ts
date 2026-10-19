import { NextResponse } from 'next/server';
import { requireAccess } from '@/lib/auth';
import { checkAmazon } from '@/lib/checks';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const MAX_PER_CALL = 12;

// The browser sends ASINs in small batches so each call finishes well inside the time limit.
export async function POST(req: Request) {
  const m = await requireAccess(req);
  if (m instanceof NextResponse) return m;
  const body = await req.json().catch(() => null);
  const asins: unknown = body?.asins;
  if (!Array.isArray(asins) || !asins.every(a => typeof a === 'string')) {
    return NextResponse.json({ error: 'Send { asins: string[] }' }, { status: 400 });
  }
  if (asins.length > MAX_PER_CALL) return NextResponse.json({ error: `At most ${MAX_PER_CALL} ASINs per call` }, { status: 400 });
  try {
    const results = await checkAmazon(asins as string[], m.email, Date.now() + 45_000);
    return NextResponse.json({ results });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
