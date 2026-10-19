import { NextResponse } from 'next/server';
import { supabaseUser } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const sb = await supabaseUser();
  await sb.auth.signOut();
  return NextResponse.redirect(new URL('/login', new URL(req.url).origin), { status: 303 });
}
