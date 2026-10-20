// Change-memory diffs, including on the real catalogue and deal files.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as XLSX from 'xlsx';
const L = await import('../lib/logic.ts');
const F = process.env.FIXTURES || '/mnt/user-data/uploads';

// Live status
const live = { cls: 'live' as const, price: 7979, served: 'B0C6F83BXZ', mid: 'A1VWJRNH9VRGHD' };
assert.deepEqual(L.statusChanges(live, { ...live }), []);
assert.deepEqual(L.statusChanges(live, { ...live, price: 7979.5 }), [], 'within tolerance');
assert.deepEqual(L.statusChanges(live, { ...live, price: 8819 }), [{ field: 'price', old: '₹7,979', new: '₹8,819' }]);
assert.deepEqual(L.statusChanges(live, { cls: 'unavailable', price: null, served: 'B0C6F83BXZ', mid: null }), [{ field: 'status', old: 'Live & buyable', new: 'Unavailable' }]);
assert.deepEqual(L.statusChanges(live, { cls: 'error', price: null, served: null }), [], 'errors are not changes');
assert.deepEqual(L.statusChanges({ cls: 'error', price: null, served: null }, live), []);
assert.deepEqual(L.statusChanges(null, live), [], 'first check has nothing to compare with');
const v1 = { cls: 'variant' as const, price: 22199, served: 'B0F93J6XCD' };
assert.deepEqual(L.statusChanges(v1, { ...v1, served: 'B0F93HTD7K', price: 18000 }), [{ field: 'shown', old: 'B0F93J6XCD', new: 'B0F93HTD7K' }], 'variant prices are not compared');
assert.deepEqual(L.statusChanges(live, { ...live, mid: 'AOTHER' }), [{ field: 'seller', old: 'A1VWJRNH9VRGHD', new: 'AOTHER' }]);

// Sheet, on the real catalogue
const cat = fs.readFileSync(`${F}/attachment.txt`, 'utf8').split(/\r?\n/).filter(Boolean).map(l => l.split('\t'));
const items = L.parseCatalogue(cat);
assert.deepEqual(L.catalogueChanges(items, items), []);
const nova = items.find(i => i.asin === 'B0C6F83BXZ')!;
const next = items.filter(i => i.desc !== 'Eva-Black-SC').map(i => (i.key === nova.key ? { ...i, newPrice: 9499 } : i));
next.push({ ...items[0], key: 'NEWKEY', desc: 'New SKU', asin: '', fsn: '' });
const cc = L.catalogueChanges(items, next);
assert.equal(cc.length, 3);
const c1 = cc.find(c => c.key === nova.key)!;
assert.equal(c1.kind, 'changed'); assert.deepEqual(c1.changes, [{ field: 'New Price', old: '₹10,499', new: '₹9,499' }]); assert.equal(c1.prev!.newPrice, 10499);
assert.equal(cc.find(c => c.key === 'NEWKEY')!.kind, 'added');
assert.equal(cc.find(c => c.label === 'Eva-Black-SC')!.kind, 'removed');

// Deal files, on the real Amazon GIF file
const wb = XLSX.read(fs.readFileSync(`${F}/GIF_Deal__1___1_.xlsx`), { type: 'buffer' });
const aoa = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: '' }) as L.Aoa;
const a1 = L.parseDealFile(aoa, 'amz');
assert.deepEqual(L.dealFileChanges(a1, a1), []);
const aoa2 = aoa.map(r => [...r]);
const i = aoa2.findIndex(r => r[1] === 'B0C6F83BXZ'); aoa2[i][5] = 7900;
const j = aoa2.findIndex(r => r[1] === 'B09HMSHSJ7'); aoa2.splice(j, 1);
const a2 = L.parseDealFile(aoa2, 'amz');
const dc = L.dealFileChanges(a1, a2);
assert.equal(dc.length, 2);
assert.deepEqual(dc.find(d => d.id === 'B0C6F83BXZ'), { id: 'B0C6F83BXZ', sku: 'HT-DBM-EL-4x6', kind: 'changed', deal: [7979.16, 7900], base: [9499, 9499] });
assert.equal(dc.find(d => d.id === 'B09HMSHSJ7')!.kind, 'removed');
assert.deepEqual(L.dealFileChanges(null, a1), []);
console.log('change-memory tests passed');
