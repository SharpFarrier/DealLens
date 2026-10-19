import { redirect } from 'next/navigation';
import { accessState } from '@/lib/auth';
import DealLensApp from '@/components/DealLensApp';
import DeviceGate from '@/components/DeviceGate';

export const dynamic = 'force-dynamic';

export default async function Home() {
  const s = await accessState();
  if (s.kind === 'signed_out') redirect('/login');
  if (s.kind === 'not_approved') redirect(`/login?error=not_approved&email=${encodeURIComponent(s.email)}`);
  const me = s.member;
  return (
    <DeviceGate email={me.email} isOwner={me.role === 'admin'}>
      <DealLensApp me={me} />
    </DeviceGate>
  );
}
