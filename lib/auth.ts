import 'server-only';
import { NextResponse } from 'next/server';
import { supabaseAdmin, supabaseUser } from '@/lib/supabase/server';

// Same owner rule as DispatchLens: full access on any device.
export const OWNER_EMAIL = 'adityaramnani91581@gmail.com';

export interface Member { email: string; role: 'admin' | 'member'; userId: string }
export type AccessState = { kind: 'signed_out' } | { kind: 'not_approved'; email: string; status: string } | { kind: 'ok'; member: Member };

// The signed-in Google account and its DispatchLens approval. Checked on every request on the server,
// independently of the proxy; the database checks it again with row level security.
export async function accessState(): Promise<AccessState> {
  const sb = await supabaseUser();
  const { data, error } = await sb.auth.getUser();
  if (error || !data.user?.email) return { kind: 'signed_out' };
  const raw = data.user.email;
  const email = raw.toLowerCase();
  // Exact match (not ilike: "_" and "%" in an address would act as wildcards).
  const { data: rows } = await supabaseAdmin()
    .from('dispatch_user_access')
    .select('email, status')
    .in('email', [...new Set([raw, email])]);
  const row = (rows || [])[0];
  if (!row || row.status !== 'approved') return { kind: 'not_approved', email, status: row?.status || 'none' };
  return { kind: 'ok', member: { email, role: email === OWNER_EMAIL ? 'admin' : 'member', userId: data.user.id } };
}

export async function currentMember(): Promise<Member | null> {
  const s = await accessState();
  return s.kind === 'ok' ? s.member : null;
}

export function denied(status: 401 | 403, message: string) {
  return NextResponse.json({ error: message }, { status });
}

// Is the device that sent this request approved in DispatchLens's device list? The owner skips this.
export async function deviceApproved(req: Request, m: Member): Promise<boolean> {
  if (m.role === 'admin') return true;
  const id = req.headers.get('x-device-id')?.trim();
  if (!id) return false;
  const { data } = await supabaseAdmin().from('approved_devices').select('status').eq('device_id', id).maybeSingle();
  return data?.status === 'approved';
}

// For API routes: approved in DispatchLens AND on an approved device.
export async function requireAccess(req: Request): Promise<Member | NextResponse> {
  const m = await currentMember();
  if (!m) return denied(401, 'Sign in with a Google account approved in DispatchLens.');
  if (!(await deviceApproved(req, m))) return denied(403, "This device isn't approved yet. Approve it in DispatchLens > Users.");
  return m;
}

// Scheduled jobs: Vercel sends "Authorization: Bearer <CRON_SECRET>".
export function isCron(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.get('authorization') === `Bearer ${secret}`;
}
