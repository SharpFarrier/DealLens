'use client';
import { useMemo, useState } from 'react';
import type { DealData } from '@/lib/useDealData';
import { crossRows, inr, whenLabel, type CrossKind, type CrossRow, type PriceCell } from '@/lib/views';
import { CheckAllButton } from '@/components/ui';

const PAGE = 15;

function Side({ c }: { c: PriceCell }) {
  if (c.state === 'live') return <span className="r num-t"><span className="dot d-green" />{inr(c.price)}</span>;
  return <span className="r t-red" style={{ fontSize: 13 }}><span className="dot d-red" />{c.label}</span>;
}

function Gap({ r }: { r: CrossRow }) {
  if (r.kind === 'same') return <span className="r muted">Same</span>;
  if (r.kind === 'one') return <span className="r"><span className="badge bg-amber">Only on {r.amz.state === 'live' ? 'Amazon' : 'Flipkart'}</span></span>;
  return <span className="r"><span className="badge bg-red num-t">{r.gap > 0 ? 'Flipkart' : 'Amazon'} +{inr(Math.abs(r.gap))}</span></span>;
}

export default function CrossCheck({ data, busy, onCheckAll }: { data: DealData; busy: { done: number; total: number } | null; onCheckAll: () => void }) {
  const [kind, setKind] = useState<CrossKind>('diff');
  const [showAll, setShowAll] = useState(false);
  const res = useMemo(() => crossRows(data.items, data.amz, data.fk, data.settings.merchantId), [data.items, data.amz, data.fk, data.settings.merchantId]);
  const count = (k: CrossKind) => res.rows.filter(r => r.kind === k).length;
  const same = count('same'), diff = count('diff'), one = count('one');
  const compared = same + diff + one;
  const biggest = Math.max(0, ...res.rows.filter(r => r.kind === 'diff').map(r => Math.abs(r.gap)));
  const list = res.rows.filter(r => r.kind === kind).sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap) || a.item.desc.localeCompare(b.item.desc));
  const shown = showAll ? list : list.slice(0, PAGE);
  const lastChecked = (() => {
    let m = 0;
    for (const c of [...Object.values(data.amz), ...Object.values(data.fk)]) m = Math.max(m, Date.parse(c.checkedAt));
    return m ? new Date(m).toISOString() : null;
  })();
  const notes = [
    res.singlePlatform ? `${res.singlePlatform} products are only on one platform in the sheet` : '',
    res.bothDown ? `${res.bothDown} are down on both (see Live status)` : '',
    res.unchecked ? `${res.unchecked} not checked yet` : '',
  ].filter(Boolean).join(' · ');

  return (
    <>
      <div className="ph">
        <div>
          <h1>Amazon vs Flipkart</h1>
          <div className="sub">Same product, both storefronts · check {whenLabel(lastChecked)}</div>
        </div>
        <div className="acts"><CheckAllButton busy={busy} onClick={onCheckAll} /></div>
      </div>

      <div className="card kpis">
        <div className={'k click' + (kind === 'same' ? ' on' : '')} onClick={() => setKind('same')}>
          <div className="lbl">Same price, both live</div>
          <div className="num">{same} <span className="of">of {compared}</span></div>
          <div className="meta">{compared ? `${Math.round((same / compared) * 100)}% matched` : 'Press Check all to compare'}</div>
        </div>
        <div className={'k click' + (kind === 'diff' ? ' on' : '')} onClick={() => setKind('diff')}>
          <div className="lbl">Price differs</div>
          <div className={'num' + (diff ? ' t-red' : '')}>{diff}</div>
          <div className="meta">{diff ? `Biggest gap ${inr(biggest)}` : 'Exact to the rupee'}</div>
        </div>
        <div className={'k click' + (kind === 'one' ? ' on' : '')} onClick={() => setKind('one')}>
          <div className="lbl">Live on one only</div>
          <div className={'num' + (one ? ' t-amber' : '')}>{one}</div>
          <div className="meta">Lost sales on the other</div>
        </div>
      </div>

      <div className="sec">
        <h2>{kind === 'same' ? 'Same on both' : kind === 'diff' ? 'Price differs' : 'Live on one only'} · {list.length}</h2>
        <span className="note">{notes}</span>
      </div>
      <div className="card tbl">
        {list.length === 0 ? (
          <div className="empty"><b>{compared ? (kind === 'same' ? 'No matching products' : 'Nothing here') : 'Nothing to compare yet'}</b>
            {compared ? (kind === 'diff' ? 'Every product live on both sells at the same price.' : kind === 'one' ? 'Every product is live on both or neither.' : '') : 'Press Check all to fetch both storefronts.'}</div>
        ) : (
          <>
            <div className="tr th t-cross"><span>Product</span><span className="r">Amazon</span><span className="r">Flipkart</span><span className="r">Difference</span></div>
            {shown.map(r => (
              <div className="tr t-cross" key={r.item.key}>
                <span className="name">{r.item.desc}</span>
                <Side c={r.amz} />
                <Side c={r.fk} />
                <Gap r={r} />
              </div>
            ))}
            {list.length > PAGE && <div className="more"><button className="btn link" onClick={() => setShowAll(s => !s)}>{showAll ? 'Show fewer' : `Show all ${list.length}`}</button></div>}
          </>
        )}
      </div>
    </>
  );
}
