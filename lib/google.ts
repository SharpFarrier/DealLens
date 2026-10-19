import 'server-only';
import { createPrivateKey, createSign } from 'node:crypto';
import { env } from '@/lib/env';
import type { Aoa } from '@/lib/logic';

let cached: { token: string; exp: number } | null = null;

const b64url = (s: string | Buffer) => Buffer.from(s).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

// Accepts the service-account key however it was pasted into Vercel: just the private_key value,
// with or without the surrounding quotes or trailing comma, with literal "\n", doubled "\\n",
// real line breaks, spaces instead of line breaks, Windows line endings, only the base64 body,
// or the whole downloaded JSON file. Rebuilds a clean PEM and checks it before use.
export function normalizePrivateKey(input: string): string {
  let v = (input || '').trim();
  // The whole JSON key file pasted in.
  if (v.startsWith('{')) {
    try { const j = JSON.parse(v); if (typeof j.private_key === 'string') v = j.private_key.trim(); } catch { /* not JSON; carry on */ }
  }
  // Wrapping quotes / trailing comma, possibly more than once.
  for (let i = 0; i < 3; i++) v = v.replace(/,\s*$/, '').replace(/^["'`]+|["'`]+$/g, '').trim();
  // Escaped line breaks in any form, then Windows line endings.
  v = v.replace(/\\+r\\+n|\\+n|\\+r/g, '\n').replace(/\r\n?/g, '\n');
  const m = v.match(/-----BEGIN ((?:RSA )?PRIVATE KEY)-----([\s\S]*?)-----END \1-----/);
  const label = m ? m[1] : 'PRIVATE KEY';
  const body = (m ? m[2] : v).replace(/[^A-Za-z0-9+/=]/g, '');
  if (body.length < 200) throw new Error('GOOGLE_PRIVATE_KEY looks empty or cut short. Paste the private_key value from the JSON key file again.');
  const lines = body.match(/.{1,64}/g) || [];
  const pem = `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
  try {
    createPrivateKey(pem);
  } catch {
    throw new Error('GOOGLE_PRIVATE_KEY is not a valid key even after cleaning it up. Create a new JSON key for the service account and paste its private_key, or paste the whole JSON file into GOOGLE_SERVICE_ACCOUNT_JSON instead.');
  }
  return pem;
}

// Email + key either from GOOGLE_SERVICE_ACCOUNT_JSON (the whole file) or the two separate variables.
export function serviceAccount(): { email: string; key: string } {
  const json = process.env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim();
  if (json) {
    let j: { client_email?: string; private_key?: string };
    try { j = JSON.parse(json); } catch { throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON. Paste the whole downloaded key file.'); }
    if (!j.client_email || !j.private_key) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is missing client_email or private_key.');
    return { email: j.client_email.trim(), key: normalizePrivateKey(j.private_key) };
  }
  return { email: env('GOOGLE_SERVICE_ACCOUNT_EMAIL'), key: normalizePrivateKey(env('GOOGLE_PRIVATE_KEY')) };
}

// Service-account sign-in (OAuth 2 JWT bearer flow), read-only access to Sheets.
async function accessToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cached && cached.exp - 60 > now) return cached.token;
  const { email, key } = serviceAccount();
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: email,
    scope: 'https://www.googleapis.com/auth/spreadsheets.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }));
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  const assertion = `${header}.${claims}.${b64url(signer.sign(key))}`;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    throw new Error(`Google sign-in for the sheet failed (${res.status}): ${json.error_description || json.error || 'no token'}. Check that the service account email and key belong together.`);
  }
  cached = { token: json.access_token, exp: now + (json.expires_in || 3600) };
  return cached.token;
}

const safeEmail = () => { try { return serviceAccount().email; } catch { return 'service account'; } };

// All cell values of the catalogue tab, formatted as shown in the sheet.
export async function readCatalogueSheet(): Promise<Aoa> {
  const id = env('SHEET_ID');
  const range = process.env.SHEET_RANGE?.trim() || 'Sheet1';
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(id)}/values/${encodeURIComponent(range)}?valueRenderOption=FORMATTED_VALUE&majorDimension=ROWS`;
  const res = await fetch(url, { headers: { authorization: `Bearer ${await accessToken()}` }, cache: 'no-store' });
  const json = await res.json().catch(() => ({}));
  if (res.status === 403 || res.status === 404) {
    throw new Error(`The sheet isn't shared with the service account (${safeEmail()}), or SHEET_ID/SHEET_RANGE is wrong (${res.status}).`);
  }
  if (!res.ok) throw new Error(`Reading the sheet failed (${res.status}): ${json?.error?.message || 'unknown error'}`);
  return (json.values || []) as Aoa;
}
