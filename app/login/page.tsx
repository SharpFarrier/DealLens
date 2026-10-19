import LoginCard from '@/components/LoginCard';

export const dynamic = 'force-dynamic';

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string; email?: string }> }) {
  const sp = await searchParams;
  let error: string | null = null;
  if (sp.error === 'not_approved') {
    error = `${sp.email || 'That Google account'} isn't approved in DispatchLens yet. Ask an admin to approve it in DispatchLens > Users, then sign in again.`;
  } else if (sp.error) {
    error = "Google sign-in didn't complete. Try again.";
  }
  return <LoginCard error={error} />;
}
