import 'server-only';
import { createSign } from 'node:crypto';
import { env } from '@/lib/env';
import type { Aoa } from '@/lib/logic';

let cached: { token: string; exp: number } | null = null;

const b64url = (s: string | Buffer) => Buffer.from(s).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

// Service-account sign-in (OAuth 2 JWT bearer flow), read-only access to Sheets.
async function accessToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cached && cached.exp - 60 > now) return cached.token;
  const email = env('GOOGLE_SERVICE_ACCOUNT_EMAIL');
  const key = env('GOOGLE_PRIVATE_KEY').replace(/\\n/g, '\n');
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
    throw new Error(`Google sign-in for the sheet failed (${res.status}): ${json.error_description || json.error || 'no token'}. Check GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_PRIVATE_KEY.`);
  }
  cached = { token: json.access_token, exp: now + (json.expires_in || 3600) };
  return cached.token;
}

// All cell values of the catalogue tab, formatted as shown in the sheet.
export async function readCatalogueSheet(): Promise<Aoa> {
  const id = env('SHEET_ID');
  const range = process.env.SHEET_RANGE?.trim() || 'Sheet1';
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(id)}/values/${encodeURIComponent(range)}?valueRenderOption=FORMATTED_VALUE&majorDimension=ROWS`;
  const res = await fetch(url, { headers: { authorization: `Bearer ${await accessToken()}` }, cache: 'no-store' });
  const json = await res.json().catch(() => ({}));
  if (res.status === 403 || res.status === 404) {
    throw new Error(`The sheet isn't shared with ${process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL}, or SHEET_ID/SHEET_RANGE is wrong (${res.status}).`);
  }
  if (!res.ok) throw new Error(`Reading the sheet failed (${res.status}): ${json?.error?.message || 'unknown error'}`);
  return (json.values || []) as Aoa;
}
