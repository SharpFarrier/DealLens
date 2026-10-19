import { NextResponse } from 'next/server';
import { requireAccess } from '@/lib/auth';
import { runSync } from '@/lib/sync';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// "Sync now" button, and the automatic sync the app starts when the last one is over an hour old.
export async function POST(req: Request) {
  const m = await requireAccess(req);
  if (m instanceof NextResponse) return m;
  const body = await req.json().catch(() => ({}));
  const trigger = body?.auto ? 'auto' : 'manual';
  const result = await runSync(trigger, m.email);
  return NextResponse.json(result, { status: result.status === 'error' ? 500 : 200 });
}
