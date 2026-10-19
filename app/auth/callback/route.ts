import { NextResponse } from 'next/server';
import { supabaseAdmin, supabaseUser } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

// Google sends people back here after they pick an account.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const toLogin = (q: string) => NextResponse.redirect(new URL(`/login?${q}`, url.origin));
  if (!code) return toLogin('error=missing_code');

  const sb = await supabaseUser();
  const { data, error } = await sb.auth.exchangeCodeForSession(code);
  const user = data?.user;
  const email = user?.email?.toLowerCase();
  if (error || !user || !email) return toLogin('error=sign_in_failed');

  // Same access list as DispatchLens. A first-time account gets a pending row there, exactly as
  // signing in to DispatchLens would, so it shows up in DispatchLens > Users for approval.
  const db = supabaseAdmin();
  // Exact match (not ilike: "_" and "%" in an address would act as wildcards).
  const { data: rows } = await db.from('dispatch_user_access').select('email, status, user_id').in('email', [...new Set([user.email!, email])]);
  const row = (rows || [])[0];
  if (!row) {
    await db.from('dispatch_user_access').insert({ email: user.email, user_id: user.id, status: 'pending' });
  } else if (!row.user_id) {
    await db.from('dispatch_user_access').update({ user_id: user.id }).eq('email', row.email);
  }
  if (!row || row.status !== 'approved') {
    await sb.auth.signOut();
    return toLogin(`error=not_approved&email=${encodeURIComponent(email)}`);
  }
  return NextResponse.redirect(new URL('/', url.origin));
}
