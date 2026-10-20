import 'server-only';
import { supabaseAdmin } from '@/lib/supabase/server';
import { readCatalogueSheet } from '@/lib/google';
import { parseCatalogue, diffCatalogue, catalogueChanges } from '@/lib/logic';
import { itemToProduct, productToItem, type ProductRow } from '@/lib/data';

export interface SyncResult { status: 'ok' | 'error' | 'skipped'; rows?: number; added?: number; removed?: number; changed?: number; error?: string }

// Pulls the catalogue tab and makes the products table match it exactly.
export async function runSync(trigger: 'manual' | 'cron' | 'auto', by: string | null): Promise<SyncResult> {
  const db = supabaseAdmin();

  // One sync at a time: skip if another started in the last 2 minutes and hasn't finished.
  const { data: running } = await db.from('deallens_sync_runs').select('id, started_at')
    .eq('status', 'running').gte('started_at', new Date(Date.now() - 120_000).toISOString()).limit(1);
  if (running && running.length) return { status: 'skipped' };

  const { data: run, error: runErr } = await db.from('deallens_sync_runs')
    .insert({ trigger, triggered_by: by }).select('id').single();
  if (runErr || !run) return { status: 'error', error: runErr?.message || 'Could not start a sync run.' };

  try {
    const values = await readCatalogueSheet();
    const items = parseCatalogue(values);
    if (items.length === 0) throw new Error('The sheet returned no product rows, so nothing was changed.');

    const { data: prevRows, error: prevErr } = await db.from('deallens_products').select('*');
    if (prevErr) throw new Error(prevErr.message);
    const prev = (prevRows as ProductRow[]).map(productToItem);
    const diff = diffCatalogue(prev, items);

    // Safety: refuse to wipe most of the catalogue because of a broken or half-loaded sheet.
    if (prev.length >= 20 && items.length < prev.length * 0.5) {
      throw new Error(`The sheet has ${items.length} products, down from ${prev.length}. Not syncing in case the sheet is broken. Check the sheet, then press Sync now again.`);
    }

    const now = new Date().toISOString();
    // Change memory: rows that are new or changed in this sync keep their old values and a timestamp;
    // everything else is cleared, so the highlight always means "changed in the latest sync".
    // The very first sync has nothing to compare with, so nothing is marked as new.
    const changes = prev.length ? catalogueChanges(prev, items) : [];
    const byKey = new Map(changes.map(c => [c.key, c]));
    const rows = items.map((it, i) => {
      const c = byKey.get(it.key);
      return {
        ...itemToProduct(it, i), synced_at: now,
        prev: c && c.kind === 'changed' ? c.prev : null,
        changed_at: c && c.kind !== 'removed' ? now : null,
        change_kind: c && c.kind !== 'removed' ? c.kind : null,
      };
    });
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await db.from('deallens_products').upsert(rows.slice(i, i + 500), { onConflict: 'key' });
      if (error) throw new Error(error.message);
    }
    const keep = new Set(items.map(i => i.key));
    const gone = prev.map(p => p.key).filter(k => !keep.has(k));
    for (let i = 0; i < gone.length; i += 200) {
      const { error } = await db.from('deallens_products').delete().in('key', gone.slice(i, i + 200));
      if (error) throw new Error(error.message);
    }

    const who = trigger === 'manual' || trigger === 'auto' ? by || 'sheet sync' : 'sheet sync';
    const log = changes.flatMap(c => c.kind === 'changed'
      ? c.changes.map(x => ({ at: now, source: 'sheet', item_key: c.key, ref: c.key, label: c.label, field: x.field, old_value: x.old, new_value: x.new, changed_by: who }))
      : [{ at: now, source: 'sheet', item_key: c.key, ref: c.key, label: c.label, field: c.kind === 'added' ? 'added' : 'removed',
           old_value: c.kind === 'added' ? null : 'in sheet', new_value: c.kind === 'added' ? 'in sheet' : null, changed_by: who }]);
    for (let i = 0; i < log.length; i += 500) {
      const { error } = await db.from('deallens_change_log').insert(log.slice(i, i + 500));
      if (error) throw new Error(error.message);
    }

    await db.from('deallens_sync_runs').update({
      status: 'ok', finished_at: new Date().toISOString(), row_count: items.length, ...diff,
    }).eq('id', run.id);
    return { status: 'ok', rows: items.length, ...diff };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await db.from('deallens_sync_runs').update({ status: 'error', finished_at: new Date().toISOString(), error: message }).eq('id', run.id);
    return { status: 'error', error: message };
  }
}
