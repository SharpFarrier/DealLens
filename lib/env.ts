// Reads required environment variables and fails with a clear message when one is missing.
export function env(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) throw new Error(`Missing environment variable ${name}. Add it in Vercel > Settings > Environment Variables.`);
  return v.trim();
}

export const SUPABASE_URL = () => env('NEXT_PUBLIC_SUPABASE_URL');
export const SUPABASE_ANON_KEY = () => env('NEXT_PUBLIC_SUPABASE_ANON_KEY');
