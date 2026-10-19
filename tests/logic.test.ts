// Runs the shared logic against the real files from this sale.
// Usage: npm test  (expects the sample files under tests/fixtures or the paths below)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as XLSX from 'xlsx';
import {
  parseCatalogue, parseDealFile, buildResults, summarize, classifyAmz, availFlags,
  expectedPrice, diffCatalogue, plannedFor, type Aoa, type Plan,
} from '../lib/logic';

const F = process.env.FIXTURES || '/mnt/user-data/uploads';
const readXlsx = (f: string): Aoa => {
  const wb = XLSX.read(fs.readFileSync(path.join(F, f)), { type: 'buffer' });
  return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: '' }) as Aoa;
};

// The Sheets API returns rows with trailing empty cells removed; simulate that.
const tsv = fs.readFileSync(path.join(F, 'attachment.txt'), 'utf8');
const sheetValues: Aoa = tsv.split(/\r?\n/).filter(l => l.length).map(l => {
  const cells = l.split('\t');
  while (cells.length && cells[cells.length - 1] === '') cells.pop();
  return cells;
});

const items = parseCatalogue(sheetValues);
assert.equal(items.length, 160, 'catalogue rows');
assert.equal(new Set(items.map(i => i.key)).size, 160, 'keys unique');
assert.equal(items.filter(i => i.asin).length, 159);
const duke = items.find(i => i.desc === 'Duke-White-Natural Ash')!;
assert.equal(duke.fkSku, 'SWB-D-WH-NH-DU-4', 'stray line break in the sheet cell is trimmed');

const plan: Plan = { disc: 16, familyDisc: {}, override: {}, excluded: {} };
const amz = parseDealFile(readXlsx('GIF_Deal__1___1_.xlsx'), 'amz');
const fk = parseDealFile(readXlsx('Flipkart_Big_Billion_Days_Sale__2_.xlsx'), 'fk');
assert.equal(amz.rows.length, 149);
assert.equal(fk.rows.length, 136);
const s = summarize(buildResults(items, plan, amz, fk, null, 1));
// Same numbers the single-file DealLens gave on these files.
assert.deepEqual(s, { total: 160, matched: 146, off: 2, missing: 13, parity: 1, base: 1, live: 0, other: 0 });

// Plan edits behave.
const nova = items.find(i => i.asin === 'B0C6F83BXZ')!;
assert.equal(plannedFor({ ...nova, newPrice: 9499 }, plan), 7979);
assert.equal(plannedFor(nova, { ...plan, familyDisc: { Nova: 20 } }), Math.round(nova.newPrice * 0.8));
assert.equal(plannedFor(nova, { ...plan, override: { [nova.key]: 7000 } }), 7000);

// Live status classifier, on the shapes of the three real Scrapingdog responses (19 Oct).
const real = {
  B0C6F83BXZ: { extracted_price: 7979, unqualified_buy_box: false, sold_by: 'Sabi Wabi Ventures Pvt Ltd', merchant_id: 'A1VWJRNH9VRGHD',
    purchase_options: { single_offer: { extracted_price: 7979 } }, product_information: { ASIN: 'B0C6F83BXZ' },
    customization_options: { size: [{ is_selected: true, asin: 'B0C6F83BXZ' }, { is_selected: false, asin: 'B0DCCCLMMV' }] },
    variant_combinations: [{ asin: 'B0GRJ8VZ4B', is_selected: false }, { asin: 'B0C6F83BXZ', is_selected: true }] },
  B0FCMT97BF: { unqualified_buy_box: false, product_information: { ASIN: 'B0FCMT97BF' } },
};
const live = classifyAmz('B0C6F83BXZ', real.B0C6F83BXZ);
assert.equal(live.cls, 'live'); assert.equal(live.price, 7979);
assert.equal(classifyAmz('B0FCMT97BF', real.B0FCMT97BF).cls, 'unavailable');
const swapped = { ...real.B0C6F83BXZ, product_information: { ASIN: 'B0DCCCLMMV' } };
const sw = classifyAmz('B0C6F83BXZ', swapped);
assert.equal(sw.cls, 'variant'); assert.equal(sw.served, 'B0DCCCLMMV');
assert.equal(classifyAmz('B0C6F83BXZ', { ...real.B0C6F83BXZ, unqualified_buy_box: true }).cls, 'nobuy');
assert.equal(classifyAmz('B0C6F83BXZ', null).cls, 'error');
assert.equal(classifyAmz('B0C6F83BXZ', { product_information: { ASIN: 'B0C6F83BXZ' }, price: '₹7,979.00 with 70 percent savings', sold_by: 'X' }).price, null);
assert.deepEqual(availFlags(live, 7979, 1, 'A1VWJRNH9VRGHD'), []);
assert.deepEqual(availFlags(live, 8819, 1, 'A1VWJRNH9VRGHD'), ['price']);
assert.deepEqual(availFlags({ ...live, mid: 'AOTHER' }, 7979, 1, 'a1vwjrnh9vrghd'), ['seller']);
assert.equal(expectedPrice(nova, 'deal', amz, plan), 7979.16);
assert.equal(expectedPrice(nova, 'catalogue', amz, plan), nova.newPrice);
assert.equal(expectedPrice(nova, 'off', amz, plan), null);

// Sync diff.
const changedPrice = items.map(i => (i.key === nova.key ? { ...i, newPrice: 9499 } : i));
assert.deepEqual(diffCatalogue(items, changedPrice), { added: 0, removed: 0, changed: nova.newPrice === 9499 ? 0 : 1 });
assert.deepEqual(diffCatalogue(items.slice(1), items), { added: 1, removed: 0, changed: 0 });

console.log('logic tests passed:', s);
