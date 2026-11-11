// The three tabs' numbers, against the real catalogue sheet.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseCatalogue, priceColumnStats, type Aoa } from '../lib/logic';
import {
  bars, barTone, countsOn, crossRows, describe, downFor, isWrong, listings, priceRows, ruleChanges, shouldBe,
  statusRows, summarizePrices, summarizeStatus, type Check, type Rule,
} from '../lib/views';

const F = process.env.FIXTURES || '/mnt/user-data/uploads';
const sheet: Aoa = fs.readFileSync(path.join(F, 'attachment.txt'), 'utf8').split(/\r?\n/).filter(l => l.length).map(l => {
  const c = l.split('\t'); while (c.length && c[c.length - 1] === '') c.pop(); return c;
});
const items = parseCatalogue(sheet);

// --- price columns: found automatically, dates and IDs ignored, a new column is picked up ---
assert.deepEqual(priceColumnStats(sheet).map(c => c.name), ['Launch Price', 'Old Price', 'New Price']);
const withNew: Aoa = sheet.map((r, i) => {
  const c = [...r]; while (c.length < 15) c.push('');
  return [...c, i === 0 ? 'Price 11 Nov' : i % 10 === 0 ? '' : '₹' + ((Number(String(c[12]).replace(/[^\d.]/g, '')) || 0) + 300).toLocaleString('en-IN') + '.00'];
});
const cols2 = priceColumnStats(withNew);
assert.deepEqual(cols2.map(c => c.name), ['Launch Price', 'Old Price', 'New Price', 'Price 11 Nov']);
assert.ok(cols2[3].filled < cols2[3].total, 'partly filled column reports how many are filled');
const items2 = parseCatalogue(withNew);
assert.equal(items2.length, 160);

// --- which listings count: ASIN / FSN present, minus "<platform> Pending" in Status ---
assert.equal(countsOn('Live on Amazon & Website / Flipkart Pending', 'fk'), false);
assert.equal(countsOn('Live on Amazon & Website / Flipkart Pending', 'amz'), true);
assert.equal(countsOn('', 'fk'), true);
const ls = listings(items);
const amzIds = new Set(items.filter(i => i.asin).map(i => i.asin));
const fkIds = new Set(items.filter(i => i.fsn && !/flipkart\s*pending/i.test(i.status || '')).map(i => i.fsn));
assert.equal(ls.filter(l => l.platform === 'amz').length, amzIds.size);
assert.equal(ls.filter(l => l.platform === 'fk').length, fkIds.size);
assert.ok(!ls.some(l => l.platform === 'fk' && l.label.startsWith('Lizon-White-Natural Ash')), 'Flipkart-pending Lizon is not counted on Flipkart');

// --- the pricing rule ---
const nova = { ...items[0], family: 'Nova', prices: { 'New Price': 9499 } };
const atlas = { ...items[0], family: 'Atlas', prices: { 'New Price': 7139 } };
const sale: Rule = { mode: 'sale', column: 'New Price', disc: 16, familyDisc: {} };
assert.equal(shouldBe(nova, sale).price, 7979);
assert.equal(shouldBe(atlas, sale).price, 5997, 'nearest rupee: 5996.76 -> 5997');
assert.equal(shouldBe(atlas, { ...sale, familyDisc: { Atlas: 20 } }).price, 5711);
assert.equal(shouldBe(atlas, { ...sale, familyDisc: { Atlas: 20 } }).own, true);
assert.equal(shouldBe(nova, { ...sale, mode: 'normal' }).price, 9499);
assert.equal(shouldBe(nova, { ...sale, column: 'Price 11 Nov' }).price, null, 'no value in the column: no planned price');

// --- statuses in plain words ---
const at = new Date().toISOString();
const chk = (cls: Check['cls'], price: number | null, mid: string | null = 'A1VWJRNH9VRGHD', avail: string | null = null): Check => ({ cls, price, served: null, mid, avail, checkedAt: at });
assert.equal(describe('fk', chk('unavailable', 2799, null, 'OutOfStock')).label, 'Sold out');
assert.equal(describe('amz', chk('unavailable', null)).label, 'Unavailable');
assert.equal(describe('amz', chk('live', 7979, 'AOTHERSELLER1')).label, 'Other seller');
assert.equal(describe('amz', chk('live', 7979, 'AOTHERSELLER1')).state, 'down');
assert.equal(describe('amz', chk('error', null)).state, 'unchecked', "couldn't check is neither live nor down");
assert.equal(describe('amz', null).state, 'unchecked');

// --- Live status numbers, with every listing checked: 3 down, 1 couldn't check ---
const amz: Record<string, Check> = {}, fk: Record<string, Check> = {};
for (const it of items) {
  const s = shouldBe(it, sale).price;
  if (it.asin) amz[it.asin] = chk('live', s);
  if (it.fsn) fk[it.fsn] = chk('live', s, null, 'InStock');
}
const [a1, a2] = [...amzIds];
const [f1, f2] = [...fkIds];
amz[a1] = chk('variant', 100); amz[a2] = chk('error', null); fk[f1] = chk('unavailable', null, null, 'OutOfStock'); fk[f2] = chk('nobuy', null, null, 'PreOrder');
const sr = statusRows(ls, amz, fk);
const ss = summarizeStatus(sr);
assert.deepEqual(ss.amz, { total: amzIds.size, live: amzIds.size - 2, down: 1, unchecked: 1 });
assert.deepEqual(ss.fk, { total: fkIds.size, live: fkIds.size - 2, down: 2, unchecked: 0 });
assert.equal(sr.find(r => r.listing.id === f2)!.label, 'Pre-order only');

// --- Pricing numbers: everything at plan except two deliberate errors ---
const nb = items.find(i => i.asin && i.fsn && i.asin !== a1 && i.asin !== a2 && i.fsn !== f1 && i.fsn !== f2 && countsOn(i.status, 'fk'))!;
const plan = shouldBe(nb, sale).price!;
fk[nb.fsn] = chk('live', plan + 840, null, 'InStock');
amz[nb.asin] = chk('live', plan - 2);
const pr = priceRows(items, sale, amz, fk);
const ps = summarizePrices(pr);
assert.equal(ps.high, 1);
assert.equal(ps.low, 1);
assert.equal(ps.noPrice, 0);
assert.equal(pr.filter(isWrong).length, 1, 'one product, wrong on both sides');
const row = pr.find(r => r.item.key === nb.key)!;
assert.equal(row.fk!.diff, 840);
assert.equal(row.amz!.diff, -2);
assert.equal(ps.notLive, 4, "variant, sold out, pre-order and couldn't-check are not priced");

// --- Switching the selling price column: preview of what changes ---
const ch = ruleChanges(items2, sale, { ...sale, column: 'Price 11 Nov' });
assert.ok(ch.length > 100);
const c0 = ch.find(c => c.from !== null && c.to !== null)!;
assert.equal(c0.to! - c0.from!, Math.round(((c0.item.prices!['New Price'] + 300) * 84) / 100) - Math.round((c0.item.prices!['New Price'] * 84) / 100));

// --- Amazon vs Flipkart ---
const soldOut = items.filter(i => i.asin && i.fsn && countsOn(i.status, 'fk') && amz[i.asin].cls === 'live' && i.key !== nb.key)[3];
fk[soldOut.fsn] = chk('unavailable', null, null, 'OutOfStock');
const cr = crossRows(items, amz, fk);
assert.equal(cr.rows.find(r => r.item.key === nb.key)!.kind, 'diff');
assert.equal(cr.rows.find(r => r.item.key === nb.key)!.gap, 842, 'Flipkart is ₹842 dearer');
assert.ok(cr.rows.some(r => r.kind === 'one'), 'sold out on Flipkart, live on Amazon');
assert.ok(cr.singlePlatform >= 4, 'Flipkart-pending and Amazon-only products are left out');

// --- 30-day bars ---
const b = bars(['2026-11-10', '2026-11-11'], [
  { day: '2026-11-11', platform: 'amz', family: 'Nova', checked: 30, down: 1 },
  { day: '2026-11-11', platform: 'fk', family: 'Nova', checked: 30, down: 2 },
], r => r.family === 'Nova');
assert.deepEqual(b, [{ day: '2026-11-10', checked: 0, down: null }, { day: '2026-11-11', checked: 60, down: 3 }]);
assert.equal(barTone(b[0], 1), 'gray');
assert.equal(barTone(b[1], 1), 'red');
assert.equal(barTone(b[1], 3), 'amber');
assert.equal(downFor(new Date(Date.now() - 3.2 * 86_400_000).toISOString()), '3 days');
assert.equal(downFor(new Date(Date.now() - 3_600_000).toISOString()), 'Today');

console.log('views tests passed:', { listings: ls.length, amazon: ss.amz, flipkart: ss.fk, pricing: ps, cross: { rows: cr.rows.length, single: cr.singlePlatform } });
