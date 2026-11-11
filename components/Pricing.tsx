'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { supabaseBrowser } from '@/lib/supabase/browser';
import type { DealData } from '@/lib/useDealData';
import type { Member } from '@/lib/auth';
import type { Item } from '@/lib/logic';
import {
  inr, isHigh, isLow, isWrong, priceRows, ruleChanges, summarizePrices, whenLabel, worstGap,
  type PriceCell, type Rule,
} from '@/lib/views';
import { CheckAllButton } from '@/components/ui';

type Filter = 'wrong' | 'high' | 'low';
const PAGE = 15;
const MIN = 60_000;

function Cell({ c }: { c: PriceCell | null }) {
  if (!c) return <span className="r faint">—</span>;
  if (c.state !== 'live' || c.price === null) return <span className="r faint" style={{ fontSize: 12.5 }}>{c.label}</span>;
  if (!c.diff) return <span className="r muted num-t">{inr(c.price)}</span>;
  const hi = c.diff > 0;
  return (
    <span className={'r num-t pr-off ' + (hi ? 't-red' : 't-amber')}>
      {inr(c.price)}<span className="d">{hi ? '+' : '−'}{inr(Math.abs(c.diff))} {hi ? 'too high' : 'too low'}</span>
    </span>
  );
}

// A % box that saves shortly after you stop typing, and never jumps while you type.
function PctInput({ value, onSave, label, className }: { value: number; onSave: (v: number) => void; label: string; className?: string }) {
  const [text, setText] = useState(String(value));
  const focused = useRef(false);
  const t = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => { if (!focused.current) setText(String(value)); }, [value]);
  const valid = (s: string) => { const n = Number(s); return s.trim() !== '' && Number.isFinite(n) && n >= 0 && n < 90 ? n : null; };
  return (
    <input className={className} inputMode="decimal" value={text} aria-label={label}
      onFocus={() => { focused.current = true; }}
      onChange={e => {
        const s = e.target.value; setText(s);
        const v = valid(s);
        if (t.current) clearTimeout(t.current);
        if (v !== null && v !== value) t.current = setTimeout(() => onSave(v), 700);
      }}
      onBlur={() => { focused.current = false; const v = valid(text); if (v === null) setText(String(value)); else if (v !== value) { if (t.current) clearTimeout(t.current); onSave(v); } }} />
  );
}

export default function Pricing({ me, data, busy, onCheckAll, toast, patchLocal }: {
  me: Member; data: DealData; busy: { done: number; total: number } | null; onCheckAll: () => void;
  toast: (m: string) => void; patchLocal: (fn: (d: DealData) => DealData) => void;
}) {
  const sb = supabaseBrowser();
  const { settings, familyDisc, items, priceColumns } = data;
  const rule: Rule = useMemo(() => ({ mode: settings.mode, column: settings.column, disc: settings.disc, familyDisc }), [settings, familyDisc]);
  const [filter, setFilter] = useState<Filter>('wrong');
  const [showAll, setShowAll] = useState(false);
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState(settings.column);
  const [adding, setAdding] = useState(false);

  // ---------- writes (optimistic; realtime confirms for everyone) ----------
  const stamp = () => ({ updated_by: me.email, updated_at: new Date().toISOString() });
  async function savePlan(p: Partial<{ mode: 'sale' | 'normal'; disc: number; price_column: string; price_column_by: string; price_column_at: string; dismissed_columns: string[] }>) {
    patchLocal(d => ({
      ...d, settings: {
        ...d.settings,
        ...(p.mode ? { mode: p.mode } : {}), ...(p.disc !== undefined ? { disc: p.disc } : {}),
        ...(p.price_column ? { column: p.price_column, columnBy: me.email, columnAt: new Date().toISOString() } : {}),
        ...(p.dismissed_columns ? { dismissed: p.dismissed_columns } : {}),
      },
    }));
    const { error } = await sb.from('deallens_plan_settings').update({ ...p, ...stamp() }).eq('id', 1);
    if (error) toast(error.message);
  }
  async function setFam(family: string, v: number | null) {
    patchLocal(d => {
      const fd = { ...d.familyDisc };
      if (v === null) delete fd[family]; else fd[family] = v;
      return { ...d, familyDisc: fd };
    });
    const { error } = v === null
      ? await sb.from('deallens_family_discounts').delete().eq('family', family)
      : await sb.from('deallens_family_discounts').upsert({ family, disc: v, ...stamp() });
    if (error) toast(error.message);
  }


  // ---------- columns ----------
  const present = priceColumns.filter(c => c.present);
  const firstSeen = priceColumns.length ? Math.min(...priceColumns.map(c => Date.parse(c.first_seen))) : 0;
  const isOriginal = (iso: string) => Date.parse(iso) - firstSeen < MIN;
  const newCol = present
    .filter(c => !isOriginal(c.first_seen) && c.name !== settings.column && !settings.dismissed.includes(c.name))
    .sort((a, b) => Date.parse(b.first_seen) - Date.parse(a.first_seen))[0] || null;
  const columnMissing = priceColumns.length > 0 && !present.some(c => c.name === settings.column);

  const openPicker = (name?: string) => { setSel(name || settings.column); setOpen(true); };
  const selRule: Rule = { ...rule, column: sel };
  const changes = useMemo(() => (open ? ruleChanges(items, rule, selRule) : []), [open, items, rule, sel]); // eslint-disable-line react-hooks/exhaustive-deps
  const raised = changes.filter(c => c.from !== null && c.to !== null);
  const selMissing = items.filter(it => (it.asin || it.fsn) && it.prices?.[sel] === undefined).length;

  async function switchColumn() {
    if (sel === settings.column) { setOpen(false); return; }
    await savePlan({ price_column: sel, price_column_by: me.email, price_column_at: new Date().toISOString() });
    setOpen(false);
    toast(`Now checking against ${sel}`);
  }

  // ---------- results ----------
  const rows = useMemo(() => priceRows(items, rule, data.amz, data.fk, settings.merchantId), [items, rule, data.amz, data.fk, settings.merchantId]);
  const sum = useMemo(() => summarizePrices(rows), [rows]);
  const pick = filter === 'wrong' ? isWrong : filter === 'high' ? isHigh : isLow;
  const list = rows.filter(pick).sort((a, b) => worstGap(b) - worstGap(a) || a.item.desc.localeCompare(b.item.desc));
  const shown = showAll ? list : list.slice(0, PAGE);
  const families = [...new Set(items.map(i => i.family))].sort();
  const sample: Item | undefined = items.find(i => i.prices?.[settings.column] !== undefined);
  const sampleBase = sample?.prices?.[settings.column];
  const lastChecked = (() => {
    let m = 0;
    for (const c of [...Object.values(data.amz), ...Object.values(data.fk)]) m = Math.max(m, Date.parse(c.checkedAt));
    return m ? new Date(m).toISOString() : null;
  })();

  return (
    <>
      <div className="ph">
        <div>
          <h1>Pricing check</h1>
          <div className="sub">Live prices from the check {whenLabel(lastChecked)}</div>
        </div>
        <div className="acts"><CheckAllButton busy={busy} onClick={onCheckAll} /></div>
      </div>

      {newCol && !open && (
        <div className="banner">
          <span>New selling price column in the sheet: <b>{newCol.name}</b>, filled for {newCol.filled} of {newCol.total} products</span>
          <span style={{ display: 'flex', gap: 6 }}>
            <button className="btn" onClick={() => openPicker(newCol.name)}>Review and use it</button>
            <button className="btn ghost" onClick={() => savePlan({ dismissed_columns: [...settings.dismissed, newCol.name] })}>Not now</button>
          </span>
        </div>
      )}

      <div className="card" style={{ marginTop: 18 }}>
        <div className="rule">
          <div className="segs">
            <button className={settings.mode === 'sale' ? 'on' : ''} onClick={() => settings.mode !== 'sale' && savePlan({ mode: 'sale' })}>Sale</button>
            <button className={settings.mode === 'normal' ? 'on' : ''} onClick={() => settings.mode !== 'normal' && savePlan({ mode: 'normal' })}>Normal day</button>
          </div>
          <span className="lbl" style={{ marginLeft: 4 }}>Price should be</span>
          <button className={'picker' + (open ? ' open' : '')} onClick={() => (open ? setOpen(false) : openPicker())}>
            {settings.column}
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
          </button>
          {settings.mode === 'sale' ? (
            <>
              <span className="lbl">minus</span>
              <PctInput className="pct" value={settings.disc} label="Sale discount %" onSave={v => void savePlan({ disc: v })} />
              <span className="lbl">%</span>
            </>
          ) : <span className="lbl">exactly</span>}
        </div>

        {settings.mode === 'sale' && !open && (
          <div className="famrow">
            <span className="lbl">Different % for</span>
            {Object.entries(familyDisc).sort().map(([f, v]) => (
              <span className="chip" key={f}>
                {f}
                <PctInput value={v} label={`${f} discount %`} onSave={n => void setFam(f, n)} />%
                <button onClick={() => setFam(f, null)} aria-label={`Use the sale % for ${f}`}>×</button>
              </span>
            ))}
            {adding ? (
              <select autoFocus defaultValue="" onBlur={() => setAdding(false)}
                onChange={e => { if (e.target.value) void setFam(e.target.value, settings.disc); setAdding(false); }}>
                <option value="">Pick a family</option>
                {families.filter(f => !(f in familyDisc)).map(f => <option key={f}>{f}</option>)}
              </select>
            ) : <button className="btn link" onClick={() => setAdding(true)}>+ Add family</button>}
          </div>
        )}

        {!open && (
          <div className="example" style={{ paddingTop: settings.mode === 'sale' ? 10 : 0, borderTop: settings.mode === 'sale' ? '1px solid var(--line)' : 0 }}>
            {columnMissing ? <span className="t-red">“{settings.column}” isn&apos;t in the sheet any more. Pick another column.</span>
              : settings.mode === 'sale' && sampleBase !== undefined
                ? <>Example: {settings.column} {inr(sampleBase)} minus {settings.disc}% = {inr(Math.round(sampleBase * (100 - settings.disc) / 100))}. Rounded to the nearest rupee, checked to the exact rupee.</>
                : <>Each listing should sell at exactly its {settings.column}, to the rupee.</>}
            {settings.columnBy && settings.columnAt && <span className="faint"> · Column set by {settings.columnBy.split('@')[0]} {whenLabel(settings.columnAt)}</span>}
          </div>
        )}

        {open && (
          <div className="panel">
            <div className="tr th t-cols"><span /><span>Selling price column in the sheet</span><span>Filled</span><span>First seen</span></div>
            {present.map(c => (
              <div key={c.name} className="tr t-cols click" onClick={() => setSel(c.name)} style={sel === c.name ? { background: 'var(--soft)' } : undefined}>
                <span className={'radio' + (sel === c.name ? ' on' : '')} />
                <span className="name" style={{ fontWeight: sel === c.name ? 600 : 400 }}>
                  {c.name}
                  {!isOriginal(c.first_seen) && Date.now() - Date.parse(c.first_seen) < 7 * 86_400_000 && <span className="tag">New</span>}
                  {c.name === settings.column && <span className="faint" style={{ fontSize: 12, marginLeft: 7 }}>in use</span>}
                </span>
                <span className={c.filled < c.total ? 't-amber' : 'muted'}>{c.filled} of {c.total}</span>
                <span className="muted">{isOriginal(c.first_seen) ? 'Original column' : whenLabel(c.first_seen)}</span>
              </div>
            ))}
            {present.length === 0 && <div className="empty">No price columns yet. Sync the sheet first.</div>}
            {sel !== settings.column && (
              <>
                <div className="tr" style={{ fontWeight: 600, fontSize: 13 }}>
                  {raised.length ? `What changes: ${raised.length} products get a new planned price` : 'Planned prices stay the same for every product'}
                </div>
                {raised.slice(0, 6).map(c => {
                  const d = (c.to as number) - (c.from as number);
                  return (
                    <div className="tr t-prev" key={c.item.key}>
                      <span className="name">{c.item.desc}</span>
                      <span className="r muted num-t">{inr(c.from)}</span>
                      <span className="faint" style={{ textAlign: 'center' }}>→</span>
                      <span className="r num-t" style={{ fontWeight: 600 }}>{inr(c.to)} <span className={d > 0 ? 't-green' : 't-red'} style={{ fontWeight: 500, fontSize: 12 }}>({d > 0 ? '+' : '−'}{inr(Math.abs(d))})</span></span>
                    </div>
                  );
                })}
                {raised.length > 6 && <div className="tr faint" style={{ fontSize: 12.5 }}>and {raised.length - 6} more</div>}
              </>
            )}
            <div className="panelfoot">
              <span className="lbl" style={{ fontSize: 12.5 }}>
                {sel !== settings.column && selMissing > 0 ? `${selMissing} products have no value in ${sel}. They'll show as "No price in sheet", not as wrong.` : 'Everyone checks against the column you choose.'}
              </span>
              <span style={{ display: 'flex', gap: 8 }}>
                <button className="btn" onClick={() => setOpen(false)}>Cancel</button>
                <button className="btn primary" onClick={switchColumn}>{sel === settings.column ? 'Close' : `Switch to ${sel}`}</button>
              </span>
            </div>
          </div>
        )}
      </div>

      <div className="card kpis">
        <div className={'k click' + (filter === 'wrong' ? ' on' : '')} onClick={() => setFilter('wrong')}>
          <div className="lbl">Price correct</div>
          <div className="num">{sum.correct} <span className="of">of {sum.priced}</span></div>
          <div className="meta">{sum.priced ? `${Math.round((sum.correct / sum.priced) * 100)}% of live listings` : 'Press Check all to fetch live prices'}</div>
        </div>
        <div className={'k click' + (filter === 'high' ? ' on' : '')} onClick={() => setFilter('high')}>
          <div className="lbl">Too high</div>
          <div className={'num' + (sum.high ? ' t-red' : '')}>{sum.high}</div>
          <div className="meta">Customers pay more than planned</div>
        </div>
        <div className={'k click' + (filter === 'low' ? ' on' : '')} onClick={() => setFilter('low')}>
          <div className="lbl">Too low</div>
          <div className={'num' + (sum.low ? ' t-amber' : '')}>{sum.low}</div>
          <div className="meta">Selling below the planned price</div>
        </div>
      </div>

      <div className="sec">
        <h2>{filter === 'wrong' ? 'Wrong prices' : filter === 'high' ? 'Too high' : 'Too low'} · {list.length}</h2>
        <span className="note">
          {sum.notLive > 0 && `${sum.notLive} listings that aren't live or couldn't be checked aren't priced`}
          {sum.notLive > 0 && sum.noPrice > 0 && ' · '}
          {sum.noPrice > 0 && `${sum.noPrice} products have no ${settings.column}`}
        </span>
      </div>
      <div className="card tbl">
        {list.length === 0 ? (
          <div className="empty"><b>{sum.priced ? 'Every live price matches' : 'No live prices yet'}</b>
            {sum.priced ? `All ${sum.priced} live listings sell at exactly the planned price.` : 'Press Check all to fetch live prices from Amazon and Flipkart.'}</div>
        ) : (
          <>
            <div className="tr th t-price"><span>Product</span><span className="r">Should be</span><span className="r">Amazon</span><span className="r">Flipkart</span></div>
            {shown.map(r => (
              <div className="tr t-price" key={r.item.key}>
                <span className="name">
                  <span className={'dot ' + (isHigh(r) ? 'd-red' : 'd-amber')} />{r.item.desc}
                  {r.own && <span className="tag">{r.pct}%</span>}
                </span>
                <span className="r num-t" style={{ fontWeight: 600 }}>{inr(r.expected)}</span>
                <Cell c={r.amz} />
                <Cell c={r.fk} />
              </div>
            ))}
            {list.length > PAGE && <div className="more"><button className="btn link" onClick={() => setShowAll(s => !s)}>{showAll ? 'Show fewer' : `Show all ${list.length}`}</button></div>}
          </>
        )}
      </div>
    </>
  );
}
