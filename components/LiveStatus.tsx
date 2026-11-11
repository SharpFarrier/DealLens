'use client';
import { useMemo, useState } from 'react';
import type { DealData } from '@/lib/useDealData';
import {
  PLAT_NAME, bars, downFor, familyStatus, istDay, lastDays, summarizeStatus, whenLabel,
  type Plat, type StatusRow,
} from '@/lib/views';
import { CheckAllButton, ExtLink, Strip } from '@/components/ui';

const TIP = 'Last 30 days. Hover a bar for that day.';
const PAGE = 12;

export default function LiveStatus({ data, rows, busy, onCheckAll, onRecheck }: {
  data: DealData; rows: StatusRow[]; busy: { done: number; total: number } | null;
  onCheckAll: () => void; onRecheck: (rows: StatusRow[]) => void;
}) {
  const [tip, setTip] = useState<string | null>(null);
  const [plat, setPlat] = useState<'all' | Plat>('all');
  const [showAll, setShowAll] = useState(false);
  const [openFam, setOpenFam] = useState<string | null>(null);

  const sum = useMemo(() => summarizeStatus(rows), [rows]);
  const days = useMemo(() => lastDays(30), []);
  const ampBars = useMemo(() => bars(days, data.days, r => r.platform === 'amz'), [days, data.days]);
  const fkBars = useMemo(() => bars(days, data.days, r => r.platform === 'fk'), [days, data.days]);
  const fams = useMemo(() => familyStatus(rows), [rows]);

  const down = rows.filter(r => r.state === 'down');
  const problems = rows.filter(r => r.state !== 'live');
  const total = sum.amz.total + sum.fk.total;
  const live = sum.amz.live + sum.fk.live;
  const unchecked = sum.amz.unchecked + sum.fk.unchecked;

  // Change since yesterday, from the 30-day history.
  const yday = istDay(new Date(Date.now() - 86_400_000));
  const ydayRows = data.days.filter(d => d.day === yday);
  const ydayDown = ydayRows.length ? ydayRows.reduce((s, d) => s + d.down, 0) : null;
  const delta = ydayDown === null ? null : down.length - ydayDown;

  const lastChecked = useMemo(() => {
    let m = 0;
    for (const r of rows) if (r.check) m = Math.max(m, Date.parse(r.check.checkedAt));
    return m ? new Date(m).toISOString() : null;
  }, [rows]);

  const since = (r: StatusRow) => data.downSince[r.listing.platform + ':' + r.listing.id] || null;
  const list = down
    .filter(r => plat === 'all' || r.listing.platform === plat)
    .sort((a, b) => (Date.parse(since(a) || '') || Infinity) - (Date.parse(since(b) || '') || Infinity) || a.listing.label.localeCompare(b.listing.label));
  const shown = showAll ? list : list.slice(0, PAGE);
  const nA = down.filter(r => r.listing.platform === 'amz').length;

  const famBars = (f: string) => bars(days, data.days, r => r.family === f);

  return (
    <>
      <div className="ph">
        <div>
          <h1>Live status</h1>
          <div className="sub">
            Last checked {whenLabel(lastChecked)}
            {data.config.auto_live_status ? ' · checks itself every morning from 6:45 am' : ' · daily morning check is off (Settings)'}
          </div>
        </div>
        <div className="acts">
          {problems.length > 0 && (
            <button className="btn" onClick={() => onRecheck(problems)} disabled={!!busy}>Recheck problems ({problems.length})</button>
          )}
          <CheckAllButton busy={busy} onClick={onCheckAll} />
        </div>
      </div>

      <div className="card kpis">
        <div className="k">
          <div className="lbl">Listings live</div>
          <div className="num">{live} <span className="of">of {total}</span></div>
          <div className="meta">
            {down.length ? <b className="t-red" style={{ fontWeight: 600 }}>{down.length} down</b> : <span className="t-green">Nothing down</span>}
            {delta !== null && delta !== 0 && <> · {Math.abs(delta)} {delta > 0 ? 'more' : 'fewer'} than yesterday</>}
            {unchecked > 0 && <span className="faint"> · {unchecked} not checked</span>}
          </div>
        </div>
        {(['amz', 'fk'] as Plat[]).map(p => (
          <div className="k" key={p}>
            <div className="lbl">{PLAT_NAME[p]}</div>
            <div className="num">{sum[p].live} <span className="of">/ {sum[p].total}</span></div>
            <Strip bars={p === 'amz' ? ampBars : fkBars} amberUpTo={Math.max(1, Math.round(sum[p].total * 0.03))} name={PLAT_NAME[p]} onHover={setTip} />
          </div>
        ))}
      </div>
      <div className="tip">{tip || TIP}</div>

      <div className="sec" style={{ marginTop: 18 }}>
        <h2>Down now</h2>
        <div className="segs">
          <button className={plat === 'all' ? 'on' : ''} onClick={() => setPlat('all')}>All {down.length}</button>
          <button className={plat === 'amz' ? 'on' : ''} onClick={() => setPlat('amz')}>Amazon {nA}</button>
          <button className={plat === 'fk' ? 'on' : ''} onClick={() => setPlat('fk')}>Flipkart {down.length - nA}</button>
        </div>
      </div>
      <div className="card tbl">
        {list.length === 0 ? (
          <div className="empty"><b>{rows.some(r => r.check) ? 'Everything is live' : 'Not checked yet'}</b>
            {rows.some(r => r.check) ? 'Every listing in this view is live and buyable.' : 'Press Check all to check every listing.'}</div>
        ) : (
          <>
            <div className="tr th t-live"><span>Listing</span><span>Platform</span><span>Status</span><span className="r">Down for</span></div>
            {shown.map(r => (
              <div className="tr t-live" key={r.listing.platform + r.listing.id}>
                <span className="name">
                  <span className={'dot d-' + r.tone} />{r.listing.label}
                  <span className="sub2" style={{ paddingLeft: 17 }}>{r.listing.id}</span>
                </span>
                <span className="muted">{PLAT_NAME[r.listing.platform]}</span>
                <span>
                  <span className={'badge bg-' + r.tone}>{r.label}</span>
                  {r.check?.cls === 'variant' && r.check.served && <span className="sub2">Opens {r.check.served}</span>}
                </span>
                <span className="r muted">{downFor(since(r)) || '—'}<ExtLink href={r.listing.link} /></span>
              </div>
            ))}
            {list.length > PAGE && (
              <div className="more"><button className="btn link" onClick={() => setShowAll(s => !s)}>{showAll ? 'Show fewer' : `Show all ${list.length}`}</button></div>
            )}
          </>
        )}
      </div>

      <div className="sec">
        <h2>By family</h2>
        <span className="lbl">Last 30 days · live / total today</span>
      </div>
      <div className="card tbl">
        {fams.map(f => {
          const open = openFam === f.family;
          const famRows = rows.filter(r => r.listing.family === f.family)
            .sort((a, b) => (a.state === 'live' ? 1 : 0) - (b.state === 'live' ? 1 : 0) || a.listing.label.localeCompare(b.listing.label));
          return (
            <div key={f.family}>
              <div className="tr t-fam click" onClick={() => setOpenFam(open ? null : f.family)}>
                <span className="name" style={{ fontWeight: 600 }}><span className={'dot ' + (f.down ? 'd-red' : f.unchecked === f.total ? 'd-gray' : 'd-green')} />{f.family}</span>
                <Strip bars={famBars(f.family)} amberUpTo={1} name={f.family} small />
                <span className={'r num-t ' + (f.down ? 't-red' : 'muted')} style={{ fontWeight: f.down ? 600 : 400 }}>{f.live}/{f.total}</span>
              </div>
              {open && famRows.map(r => (
                <div className="tr t-famrow" key={r.listing.platform + r.listing.id}>
                  <span className="name">{r.listing.label}</span>
                  <span className="muted">{PLAT_NAME[r.listing.platform]}</span>
                  <span><span className={'badge bg-' + r.tone}>{r.label}</span></span>
                  <span className="r muted">{r.state === 'down' ? downFor(since(r)) : ''}<ExtLink href={r.listing.link} /></span>
                </div>
              ))}
            </div>
          );
        })}
        {fams.length === 0 && <div className="empty"><b>No listings yet</b>Sync the sheet to load your products.</div>}
      </div>
    </>
  );
}
