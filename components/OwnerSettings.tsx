'use client';
import { supabaseBrowser } from '@/lib/supabase/browser';
import type { DealData, Table } from '@/lib/useDealData';
import type { Member } from '@/lib/auth';
import { whenLabel } from '@/lib/views';

// Owner-only: schedules and the last sheet sync. People and devices are managed in DispatchLens > Users.
export default function OwnerSettings({ me, data, onToast, reload, onClose }: {
  me: Member; data: DealData; onToast: (m: string) => void; reload: (...t: Table[]) => void; onClose: () => void;
}) {
  const sb = supabaseBrowser();
  const sync = data.lastSync;

  async function setConfig(key: 'auto_sync' | 'auto_live_status', value: boolean) {
    const { error } = await sb.from('deallens_config').update({ value, updated_by: me.email, updated_at: new Date().toISOString() }).eq('key', key);
    if (error) onToast(error.message); else reload('app_config');
  }
  const listings = new Set(data.items.map(i => i.asin).filter(Boolean)).size + new Set(data.items.map(i => i.fsn).filter(Boolean)).size;

  return (
    <div className="card settings">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h3>Settings</h3>
        <button className="btn sm" onClick={onClose}>Done</button>
      </div>
      <div className="grid2">
        <span className="k2">Catalogue source</span><span>Honey Touch Master Database · Sheet1 (read-only)</span>
        <span className="k2">Last sync</span>
        <span>{sync ? `${sync.status === 'ok' ? 'OK' : sync.status === 'error' ? 'Failed' : 'Running'} · ${whenLabel(sync.started_at)}${sync.status === 'ok' ? ` · ${sync.row_count} products, ${sync.added} added, ${sync.changed} changed, ${sync.removed} removed` : ''}${sync.error ? ` · ${sync.error}` : ''}` : 'Never'}</span>
        <span className="k2">Auto sync</span>
        <label className="switch"><input type="checkbox" checked={data.config.auto_sync} onChange={e => setConfig('auto_sync', e.target.checked)} />
          Daily at 8:00 am, and when someone opens DealLens over an hour after the last sync</label>
        <span className="k2">Daily Live status check</span>
        <label className="switch"><input type="checkbox" checked={data.config.auto_live_status} onChange={e => setConfig('auto_live_status', e.target.checked)} />
          Every listing at 9:00 am (about {listings} Scrapingdog requests a day). Needed for the 30-day bars to fill in every day.</label>
        <span className="k2">People and devices</span><span>Managed in DispatchLens &gt; Users (approve the person, then their “DealLens · …” device)</span>
      </div>
    </div>
  );
}
