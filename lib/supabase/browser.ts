'use client';
import { createBrowserClient } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';
import { deviceId } from '@/lib/device';

// Every database request carries this browser's device id; the deallens_* policies check it.
let client: SupabaseClient | null = null;
export function supabaseBrowser(): SupabaseClient {
  if (!client) {
    client = createBrowserClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
      global: { headers: { 'x-device-id': deviceId() } },
    });
  }
  return client;
}
