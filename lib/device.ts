'use client';

// Same scheme as DispatchLens's DeviceGate: a random per-browser token, plus a short code that is only
// a label for the admin to match. DealLens runs on its own web address, so each browser gets its own
// DealLens device id and needs approving once, separately from DispatchLens.
const KEY = 'deallens_device_id';
let cached: string | null = null;

export function deviceId(): string {
  if (cached) return cached;
  try {
    let id = localStorage.getItem(KEY);
    if (!id) {
      id = crypto.randomUUID?.() || Date.now().toString(36) + Math.random().toString(36).slice(2);
      localStorage.setItem(KEY, id);
    }
    cached = id;
  } catch {
    cached = 'volatile-' + Math.random().toString(36).slice(2); // storage blocked: will stay pending
  }
  return cached;
}

export function shortCode(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  let n = h;
  for (let i = 0; i < 8; i++) { s += alphabet[n % alphabet.length]; n = Math.floor(n / alphabet.length) + (i + 1) * 7; }
  return s.slice(0, 4) + '-' + s.slice(4, 8);
}

// fetch() for DealLens's own API routes, carrying the device id.
export function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('x-device-id', deviceId());
  return fetch(path, { ...init, headers });
}
