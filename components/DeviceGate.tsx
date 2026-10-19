'use client';
import { useCallback, useEffect, useState } from 'react';
import { supabaseBrowser } from '@/lib/supabase/browser';
import { deviceId, shortCode } from '@/lib/device';

type Status = 'checking' | 'approved' | 'pending' | 'denied' | 'revoked' | 'error';

function browserName(ua: string): string {
  const os = /Android/i.test(ua) ? 'Android' : /iPhone|iPad/i.test(ua) ? 'iOS' : /Mac OS/i.test(ua) ? 'Mac' : /Windows/i.test(ua) ? 'Windows' : /Linux/i.test(ua) ? 'Linux' : 'Device';
  const br = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : /Firefox\//.test(ua) ? 'Firefox' : 'browser';
  return `${os} ${br}`;
}

// Uses DispatchLens's approved_devices list. A new device registers a pending request labelled
// "DealLens · …", which appears in DispatchLens > Users > devices for approval.
export default function DeviceGate({ email, isOwner, children }: { email: string; isOwner: boolean; children: React.ReactNode }) {
  const [status, setStatus] = useState<Status>(isOwner ? 'approved' : 'checking');
  const [id] = useState(() => (typeof window === 'undefined' ? '' : deviceId()));
  const code = id ? shortCode(id) : '';
  const [busy, setBusy] = useState(false);

  const check = useCallback(async () => {
    if (isOwner) { setStatus('approved'); return; }
    const sb = supabaseBrowser();
    try {
      const { data, error } = await sb.from('approved_devices').select('status').eq('device_id', id).maybeSingle();
      if (error) { setStatus('error'); return; }
      if (!data) {
        const ua = navigator.userAgent;
        await sb.from('approved_devices').insert({
          device_id: id, code, status: 'pending', requested_by: email, user_agent: ua,
          label: `DealLens · ${browserName(ua)}`, requested_at: new Date().toISOString(),
        });
        setStatus('pending');
        return;
      }
      if (data.status === 'approved') {
        void sb.from('approved_devices').update({ last_seen_at: new Date().toISOString() }).eq('device_id', id);
        setStatus('approved');
      } else setStatus(data.status === 'denied' ? 'denied' : data.status === 'revoked' ? 'revoked' : 'pending');
    } catch {
      setStatus('error');
    }
  }, [id, code, email, isOwner]);

  useEffect(() => { if (id) void check(); }, [check, id]);

  if (status === 'approved') return <>{children}</>;
  if (status === 'checking') return <main className="login"><div className="empty">Checking this device…</div></main>;

  const denied = status === 'denied' || status === 'revoked';
  const title = status === 'revoked' ? 'This device was revoked' : status === 'denied' ? 'This device was denied'
    : status === 'error' ? "Couldn't check this device" : "This device isn't approved yet";
  const body = status === 'error' ? 'Retry, or ask an admin.'
    : denied ? 'An admin removed access for this device in DispatchLens. Ask them if this is a mistake.'
      : 'DealLens only opens on devices approved in DispatchLens. Ask an admin to approve this code in DispatchLens > Users.';

  return (
    <main className="login">
      <div className="card">
        <span className="brand">DealLens</span>
        <h3 style={{ margin: '14px 0 6px', fontFamily: 'var(--head)' }}>{title}</h3>
        <p>{body}</p>
        {!denied && status !== 'error' && (
          <div style={{ background: 'var(--bg)', border: '1px solid var(--line)', borderRadius: 10, padding: 14, marginBottom: 16 }}>
            <div style={{ fontSize: 12, color: 'var(--ink2)', marginBottom: 6 }}>Device code</div>
            <div style={{ fontSize: 24, fontWeight: 600, fontFamily: 'var(--mono)', letterSpacing: '0.08em' }}>{code}</div>
            <div className="note" style={{ marginTop: 6 }}>Shows in DispatchLens as “DealLens · {typeof navigator !== 'undefined' ? browserName(navigator.userAgent) : 'browser'}”</div>
          </div>
        )}
        <button className="btn primary gbtn" disabled={busy} onClick={async () => { setBusy(true); await check(); setBusy(false); }}>
          {busy ? 'Checking…' : 'I’ve been approved, check again'}
        </button>
        <div className="note">Signed in as {email} · <form action="/auth/signout" method="post" style={{ display: 'inline' }}>
          <button type="submit" style={{ background: 'none', border: 0, color: 'var(--accent)', cursor: 'pointer', padding: 0, fontSize: 12, textDecoration: 'underline' }}>Sign out</button>
        </form></div>
      </div>
    </main>
  );
}
