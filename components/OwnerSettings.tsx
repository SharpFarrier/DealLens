'use client';
import { supabaseBrowser } from '@/lib/supabase/browser';
import type { DealData } from '@/lib/useDealData';
import type { Member } from '@/lib/auth';

const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');

// Owner-only: schedules, last sync details, and moving the plan from the old single page.
// People and devices are managed in DispatchLens > Users.
export default function OwnerSettings({ me, data, onToast, reload }: {
  me: Member; data: DealData; onToast: (m: string) => void; reload: (t: 'app_config') => void;
}) {
  const sb = supabaseBrowser();
  const sync = data.lastSync;

  async function setConfig(key: 'auto_sync' | 'auto_live_status', value: boolean) {
    const { error } = await sb.from('deallens_config').update({ value, updated_by: me.email, updated_at: new Date().toISOString() }).eq('key', key);
    if (error) onToast(error.message); else reload('app_config');
  }

  async function importPlan(file: File) {
    try {
      const j = JSON.parse(await file.text());
      const p = j?.plan;
      if (!p || typeof p !== 'object') throw new Error("That file isn't a DealLens plan export.");
      const stamp = { updated_by: me.email, updated_at: new Date().toISOString() };
      const settings: Record<string, unknown> = { ...stamp };
      if (typeof p.event === 'string') settings.event = p.event;
      if (typeof p.disc === 'number' && p.disc >= 0 && p.disc < 90) settings.disc = p.disc;
      const fam = Object.entries(p.familyDisc || {}).filter(([, v]) => typeof v === 'number' && (v as number) >= 0 && (v as number) < 90);
      const ov = Object.entries(p.override || {}).filter(([, v]) => typeof v === 'number' && (v as number) > 0);
      const ex = Object.entries(p.excluded || {}).filter(([, v]) => v === true);
      const res = await Promise.all([
        sb.from('deallens_plan_settings').update(settings).eq('id', 1),
        fam.length ? sb.from('deallens_family_discounts').upsert(fam.map(([family, disc]) => ({ family, disc, ...stamp }))) : Promise.resolve({ error: null }),
        ov.length ? sb.from('deallens_sku_overrides').upsert(ov.map(([key, price]) => ({ key, price, ...stamp }))) : Promise.resolve({ error: null }),
        ex.length ? sb.from('deallens_sku_excluded').upsert(ex.map(([key]) => ({ key, ...stamp }))) : Promise.resolve({ error: null }),
      ]);
      const err = res.find(r => r.error)?.error;
      if (err) throw new Error(err.message);
      onToast(`Plan imported: ${fam.length} family discounts, ${ov.length} overrides, ${ex.length} excluded`);
    } catch (e) {
      onToast(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <h3>Owner settings</h3>
      <div className="grid2">
        <span className="k">Catalogue source</span><span>Honey Touch Master Database · Sheet1 (read-only)</span>
        <span className="k">Last sync</span>
        <span>{sync ? `${sync.status === 'ok' ? 'OK' : sync.status === 'error' ? 'Failed' : 'Running'} · ${when(sync.started_at)}${sync.status === 'ok' ? ` · ${sync.row_count} products, ${sync.added} added, ${sync.changed} changed, ${sync.removed} removed` : ''}${sync.error ? ` · ${sync.error}` : ''}` : 'Never'}</span>
        <span className="k">Auto sync</span>
        <label className="switch"><input type="checkbox" checked={data.config.auto_sync} onChange={e => setConfig('auto_sync', e.target.checked)} />
          Daily at 8:00 am, and when someone opens DealLens over an hour after the last sync</label>
        <span className="k">Auto Live status check</span>
        <label className="switch"><input type="checkbox" checked={data.config.auto_live_status} onChange={e => setConfig('auto_live_status', e.target.checked)} />
          Daily at 9:00 am, Amazon ASINs and Flipkart FSNs (up to about {new Set(data.items.map(i => i.asin).filter(Boolean)).size + new Set(data.items.map(i => i.fsn).filter(Boolean)).size} Scrapingdog requests a day; anything not reached goes first next day)</label>
        <span className="k">People and devices</span><span>Managed in DispatchLens &gt; Users (approve the person, then their “DealLens · …” device)</span>
        <span className="k">Old single-page plan</span>
        <span className="row">
          <label className="btn">Import plan file<input type="file" accept=".json" hidden onChange={e => { const f = e.target.files?.[0]; if (f) importPlan(f); e.target.value = ''; }} /></label>
          <span className="who-by">From the old page: Settings, then Export plan</span>
        </span>
      </div>
    </div>
  );
}
