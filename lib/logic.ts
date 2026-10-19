// Pure DealLens logic shared by the browser and the server. No I/O in this file.

export const RX_ASIN = /^B0[A-Z0-9]{8}$/i;
export const RX_FSN = /^[A-Z0-9]{16}$/i;
export const OUR_MERCHANT = 'A1VWJRNH9VRGHD';

export type Cell = string | number | boolean | null | undefined;
export type Aoa = Cell[][];

export interface Item {
  key: string;
  family: string;
  desc: string;
  master: string;
  amzSku: string;
  asin: string;
  fkSku: string;
  fkLink: string;
  fsn: string;
  newPrice: number;
}

export interface DealMapping { id: number; sku: number; base: number; deal: number }
export interface DealRow { id: string; sku: string; base: number | null; deal: number | null }
export interface DealFile { headers: string[]; mapping: DealMapping; rows: DealRow[] }
export type Platform = 'amz' | 'fk';

export interface Plan {
  disc: number;
  familyDisc: Record<string, number>;
  override: Record<string, number>;
  excluded: Record<string, boolean>;
}

export interface LivePrice { price: number | null; err?: string | null; at?: string | number | null }
export interface LiveMap { amz: Record<string, LivePrice>; fk: Record<string, LivePrice> }

export type FlagTone = 'bad' | 'warn' | 'info';
export interface Flag { t: FlagTone; k: string; l: string }

export interface ResultItem extends Omit<Item, 'newPrice'> { newPrice: number | null }
export interface Result {
  item: ResultItem;
  excluded: boolean;
  planned: number | null;
  a: DealRow | null;
  f: DealRow | null;
  la: LivePrice | null;
  lf: LivePrice | null;
  flags: Flag[];
}

export function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).replace(/[^\d.\-]/g, '');
  if (!s || s === '-' || s === '.') return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}
export function clean(v: unknown): string { return String(v === null || v === undefined ? '' : v).trim(); }

function findCol(headers: string[], patterns: RegExp[], skip: number[] = []): number {
  for (const p of patterns) {
    const i = headers.findIndex((h, idx) => !skip.includes(idx) && p.test(clean(h)));
    if (i >= 0) return i;
  }
  return -1;
}
function findHeaderRow(aoa: Aoa, test: RegExp): number {
  for (let r = 0; r < Math.min(aoa.length, 15); r++) {
    if ((aoa[r] || []).some(c => test.test(clean(c)))) return r;
  }
  return -1;
}

export function parseCatalogue(aoa: Aoa): Item[] {
  const hr = findHeaderRow(aoa, /amazon\s*asin/i);
  if (hr < 0) throw new Error('No "Amazon Asin" column found in the catalogue.');
  const h = aoa[hr].map(clean);
  const c = {
    family: findCol(h, [/^product\s*name/i]),
    desc: findCol(h, [/product\s*desc/i]),
    master: findCol(h, [/master\s*sku/i]),
    amzSku: findCol(h, [/^amazon\s*sku/i]),
    asin: findCol(h, [/amazon\s*asin/i]),
    fkSku: findCol(h, [/^flipkart\s*sku/i]),
    fkLink: findCol(h, [/flipkart\s*link/i]),
    fsn: findCol(h, [/fsn/i]),
    newPrice: findCol(h, [/new\s*price/i]),
  };
  if (c.newPrice < 0) throw new Error('No "New Price" column found in the catalogue.');
  const items: Item[] = [];
  const seen: Record<string, number> = {};
  for (let r = hr + 1; r < aoa.length; r++) {
    const row = aoa[r] || [];
    const g = (k: keyof typeof c) => (c[k] >= 0 ? clean(row[c[k]]) : '');
    const desc = g('desc') || g('family');
    const newPrice = num(row[c.newPrice]);
    if (!desc || newPrice === null) continue;
    const asin = g('asin').toUpperCase();
    const fsn = g('fsn').toUpperCase();
    const base = {
      family: g('family') || desc.split('-')[0].trim(),
      desc,
      master: g('master'),
      amzSku: g('amzSku'),
      asin: RX_ASIN.test(asin) ? asin : '',
      fkSku: g('fkSku'),
      fkLink: /^https?:/i.test(g('fkLink')) ? g('fkLink') : '',
      fsn: RX_FSN.test(fsn) ? fsn : '',
      newPrice,
    };
    let key = base.asin || base.fsn || base.master || desc;
    if (seen[key]) key = key + '#' + (++seen[key]); else seen[key] = 1;
    items.push({ key, ...base });
  }
  return items;
}

export function guessDealMapping(headers: string[], platform: Platform): DealMapping {
  const h = headers.map(clean);
  const id = findCol(h, platform === 'amz' ? [/asin/i] : [/fsn/i]);
  const sku = findCol(h, [/sku/i], [id]);
  const base = findCol(h, [/bau/i, /selling\s*price/i, /list\s*price/i, /^price$/i, /mrp/i], [id, sku]);
  const deal = findCol(h, [/after/i, /deal/i, /discount/i, /sale\s*price/i, /event/i], [id, sku, base]);
  return { id, sku, base, deal };
}

export function parseDealFile(aoa: Aoa, platform: Platform, mapping?: DealMapping | null): DealFile {
  const hr = findHeaderRow(aoa, platform === 'amz' ? /asin/i : /fsn/i);
  if (hr < 0) throw new Error(platform === 'amz' ? 'No ASIN column found in this file.' : 'No FSN column found in this file.');
  const headers = aoa[hr].map(clean);
  const m = mapping || guessDealMapping(headers, platform);
  const rows: DealRow[] = [];
  for (let r = hr + 1; r < aoa.length; r++) {
    const row = aoa[r] || [];
    const id = m.id >= 0 ? clean(row[m.id]).toUpperCase() : '';
    const sku = m.sku >= 0 ? clean(row[m.sku]) : '';
    if (!id && !sku) continue;
    rows.push({
      id,
      sku,
      base: m.base >= 0 ? num(row[m.base]) : null,
      deal: m.deal >= 0 ? num(row[m.deal]) : null,
    });
  }
  return { headers, mapping: m, rows };
}

export function plannedFor(item: { key: string; family: string; newPrice: number }, plan: Plan): number {
  if (plan.override && plan.override[item.key] !== undefined) return plan.override[item.key];
  const d = plan.familyDisc && plan.familyDisc[item.family] !== undefined ? plan.familyDisc[item.family] : plan.disc;
  return Math.round(item.newPrice * (1 - d / 100));
}

const inrInt = (v: number) => '₹' + Math.round(v).toLocaleString('en-IN');

export function buildResults(items: Item[], plan: Plan, amz: DealFile | null, fk: DealFile | null, live: LiveMap | null, tol = 1): Result[] {
  const lv: LiveMap = live || { amz: {}, fk: {} };
  const idx = (file: DealFile | null) => {
    const byId = new Map<string, number>(), bySku = new Map<string, number>(), used = new Set<number>();
    if (file) file.rows.forEach((r, i) => {
      if (r.id && !byId.has(r.id)) byId.set(r.id, i);
      if (r.sku && !bySku.has(r.sku.toUpperCase())) bySku.set(r.sku.toUpperCase(), i);
    });
    return { byId, bySku, used };
  };
  const A = idx(amz), F = idx(fk);
  const look = (file: DealFile | null, ix: ReturnType<typeof idx>, id: string, sku: string): DealRow | null => {
    if (!file) return null;
    let i = id ? ix.byId.get(id) : undefined;
    if (i === undefined && sku) i = ix.bySku.get(sku.toUpperCase());
    if (i === undefined) return null;
    ix.used.add(i);
    return file.rows[i];
  };
  const out: Result[] = [];
  for (const it of items) {
    const excluded = !!(plan.excluded && plan.excluded[it.key]);
    const planned = plannedFor(it, plan);
    const a = it.asin ? look(amz, A, it.asin, it.amzSku) : null;
    const f = it.fsn ? look(fk, F, it.fsn, it.fkSku) : null;
    const la = it.asin ? lv.amz[it.asin] || null : null;
    const lf = it.fsn ? lv.fk[it.fsn] || null : null;
    const flags: Flag[] = [];
    const side = (name: string, code: string, file: DealFile | null, rec: DealRow | null, listed: boolean, catSku: string) => {
      if (!file || !listed) return;
      if (!rec) { if (!excluded) flags.push({ t: 'bad', k: code + '-missing', l: name + ' deal missing' }); return; }
      if (rec.deal === null) { if (!excluded) flags.push({ t: 'bad', k: code + '-missing', l: name + ' deal price blank' }); }
      else if (!excluded && Math.abs(rec.deal - planned) > tol) {
        const diff = Math.round(rec.deal - planned);
        flags.push({ t: 'bad', k: code + '-off', l: name + ' off plan ' + (diff > 0 ? '+' : '−') + '₹' + Math.abs(diff).toLocaleString('en-IN') });
      }
      else if (excluded && rec.base !== null && rec.deal < rec.base - tol) {
        flags.push({ t: 'warn', k: code + '-unplanned', l: name + ' has a deal, SKU excluded' });
      }
      if (rec.base !== null && Math.abs(rec.base - it.newPrice) > tol) {
        flags.push({ t: 'warn', k: 'base', l: name + ' base ' + inrInt(rec.base) + ' ≠ catalogue' });
      }
      if (catSku && rec.sku && rec.sku.toUpperCase() !== catSku.toUpperCase()) {
        flags.push({ t: 'info', k: 'sku', l: name + ' SKU differs' });
      }
    };
    side('Amazon', 'amz', amz, a, !!it.asin, it.amzSku);
    side('Flipkart', 'fk', fk, f, !!it.fsn, it.fkSku);
    if (a && f && a.deal !== null && f.deal !== null && Math.abs(a.deal - f.deal) > tol) {
      flags.push({ t: 'warn', k: 'parity', l: 'Parity gap ' + inrInt(Math.abs(a.deal - f.deal)) });
    }
    const liveCheck = (name: string, p: LivePrice | null, rec: DealRow | null) => {
      if (!p || p.price === null || p.price === undefined) return;
      const target = rec && rec.deal !== null ? rec.deal : planned;
      if (Math.abs(p.price - target) > tol) {
        flags.push({ t: 'bad', k: 'live', l: name + ' live ' + inrInt(p.price) + ' ≠ set' });
      }
    };
    liveCheck('Amazon', la, a);
    liveCheck('Flipkart', lf, f);
    out.push({ item: it, excluded, planned, a, f, la, lf, flags });
  }
  const extras: Result[] = [];
  const addExtras = (file: DealFile | null, ix: ReturnType<typeof idx>, name: 'Amazon' | 'Flipkart') => {
    if (!file) return;
    file.rows.forEach((r, i) => {
      if (ix.used.has(i)) return;
      extras.push({
        item: {
          key: name + ':' + (r.id || r.sku), family: '—', desc: r.sku || r.id, master: '',
          amzSku: name === 'Amazon' ? r.sku : '', fkSku: name === 'Flipkart' ? r.sku : '',
          asin: name === 'Amazon' ? r.id : '', fsn: name === 'Flipkart' ? r.id : '', fkLink: '', newPrice: null,
        },
        excluded: false, planned: null,
        a: name === 'Amazon' ? r : null, f: name === 'Flipkart' ? r : null, la: null, lf: null,
        flags: [{ t: 'info', k: 'extra', l: 'In ' + name + ' file, not in catalogue' }],
      });
    });
  };
  addExtras(amz, A, 'Amazon');
  addExtras(fk, F, 'Flipkart');
  return out.concat(extras);
}

export interface Summary { total: number; matched: number; off: number; missing: number; parity: number; base: number; live: number; other: number }
export function summarize(results: Result[]): Summary {
  const s: Summary = { total: 0, matched: 0, off: 0, missing: 0, parity: 0, base: 0, live: 0, other: 0 };
  for (const r of results) {
    s.total++;
    const ks = r.flags.map(f => f.k);
    if (!r.flags.length) { if (!r.excluded) s.matched++; continue; }
    if (ks.some(k => /-off$/.test(k))) s.off++;
    if (ks.some(k => /-missing$/.test(k))) s.missing++;
    if (ks.includes('parity')) s.parity++;
    if (ks.includes('base')) s.base++;
    if (ks.includes('live')) s.live++;
    if (ks.some(k => k === 'extra' || k === 'sku' || /-unplanned$/.test(k))) s.other++;
  }
  return s;
}

export function extractFkPrice(html: string): number | null {
  const blocks = html.match(/<script[^>]*application\/ld\+json[^>]*>[\s\S]*?<\/script>/gi) || [];
  for (const b of blocks) {
    try {
      const json = JSON.parse(b.replace(/^<script[^>]*>/i, '').replace(/<\/script>$/i, ''));
      const list = Array.isArray(json) ? json : [json];
      for (const j of list) {
        const offers = j && j.offers;
        const o = Array.isArray(offers) ? offers[0] : offers;
        const p = o && num(o.price);
        if (p) return p;
      }
    } catch { /* not JSON, try the next block */ }
  }
  const pats = [/"finalPrice"\s*:\s*\{[^{}]*?"value"\s*:\s*(\d+(?:\.\d+)?)/, /"sellingPrice"\s*:\s*\{[^{}]*?"value"\s*:\s*(\d+(?:\.\d+)?)/];
  for (const p of pats) { const m = html.match(p); if (m) return parseFloat(m[1]); }
  return null;
}

// ----- Live status (exact-ASIN buyability) -----

export type AvailClass = 'live' | 'variant' | 'unavailable' | 'nobuy' | 'error';
export interface AvailRecord {
  cls: AvailClass;
  served: string | null;
  price: number | null;
  seller: string | null;
  mid: string | null;
  err: string | null;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
// Every signal in a Scrapingdog /amazon/product response that says which ASIN the page is showing.
export function servedCandidates(d: any): string[] {
  const out: string[] = [];
  const add = (a: unknown) => { const s = String(a || '').trim().toUpperCase(); if (RX_ASIN.test(s) && !out.includes(s)) out.push(s); };
  if (!d || typeof d !== 'object') return out;
  const vc: any[] = Array.isArray(d.variant_combinations) ? d.variant_combinations : [];
  vc.forEach(v => { if (v && v.is_selected) add(v.asin); });
  const co = d.customization_options;
  if (co && typeof co === 'object') {
    Object.values(co).forEach((arr: any) => { if (Array.isArray(arr)) arr.forEach((o: any) => { if (o && o.is_selected) add(o.asin); }); });
  }
  const pi = d.product_information;
  if (pi && typeof pi === 'object') add(pi.ASIN || pi.asin);
  return out;
}

export function classifyAmz(asin: string, d: any): AvailRecord {
  const want = String(asin || '').trim().toUpperCase();
  if (!d || typeof d !== 'object') return { cls: 'error', err: 'Empty response', served: null, price: null, seller: null, mid: null };
  const cands = servedCandidates(d);
  const other = cands.find(a => a !== want) || null;
  const so = d.purchase_options && typeof d.purchase_options === 'object' ? d.purchase_options.single_offer : null;
  let price = num(d.extracted_price);
  if (price === null && so) price = num(so.extracted_price);
  if (price !== null && price <= 0) price = null;
  const seller: string | null = d.sold_by || d.merchant_info || null;
  const mid = d.merchant_id ? String(d.merchant_id).trim().toUpperCase() : null;
  const base = { served: other || (cands.length ? cands[0] : null), price, seller, mid, err: null };
  if (other) return { cls: 'variant', ...base };
  const anyOffer = price !== null || !!seller || !!mid || !!so;
  let cls: AvailClass;
  if (!anyOffer) cls = 'unavailable';
  else if (d.unqualified_buy_box === true || price === null || (!seller && !mid && !so)) cls = 'nobuy';
  else cls = 'live';
  return { cls, ...base };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export type AvailFlag = 'seller' | 'price';
export function availFlags(rec: AvailRecord | null, expected: number | null | undefined, tol = 1, merchantId?: string | null): AvailFlag[] {
  const f: AvailFlag[] = [];
  if (!rec || rec.cls !== 'live') return f;
  if (merchantId && rec.mid && rec.mid !== String(merchantId).trim().toUpperCase()) f.push('seller');
  if (expected !== null && expected !== undefined && rec.price !== null && Math.abs(rec.price - expected) > tol) f.push('price');
  return f;
}

export function expectedPrice(it: Item, ref: 'deal' | 'catalogue' | 'off', amz: DealFile | null, plan: Plan): number | null {
  if (ref === 'off') return null;
  if (ref === 'catalogue') return it.newPrice;
  if (amz && it.asin) {
    const rec = amz.rows.find(r => r.id === it.asin);
    if (rec && rec.deal !== null) return rec.deal;
  }
  return plannedFor(it, plan);
}

// Compare a fresh sheet pull with what's stored, for the sync log.
export function diffCatalogue(prev: Item[], next: Item[]): { added: number; removed: number; changed: number } {
  const p = new Map(prev.map(i => [i.key, i]));
  const n = new Map(next.map(i => [i.key, i]));
  let added = 0, removed = 0, changed = 0;
  for (const [k, v] of n) {
    const o = p.get(k);
    if (!o) added++;
    else if (JSON.stringify({ ...o, key: k }) !== JSON.stringify({ ...v, key: k })) changed++;
  }
  for (const k of p.keys()) if (!n.has(k)) removed++;
  return { added, removed, changed };
}

// ----- Flipkart Live status (exact-FSN buyability) -----
// Flipkart product pages carry a JSON-LD Product block: sku = the FSN the page is showing,
// offers.price, offers.availability (schema.org InStock / OutOfStock / PreOrder ...).
// Checked against real pages on 19 Oct 2026 (Nova 4x6 in stock, Eva out of stock, Atlas 3x6 in stock).
export interface FkAvailRecord extends AvailRecord { avail: string | null }

/* eslint-disable @typescript-eslint/no-explicit-any */
function fkProducts(html: string): any[] {
  const out: any[] = [];
  const blocks = html.match(/<script[^>]*application\/ld\+json[^>]*>[\s\S]*?<\/script>/gi) || [];
  for (const b of blocks) {
    try {
      const j = JSON.parse(b.replace(/^<script[^>]*>/i, '').replace(/<\/script>$/i, ''));
      const list = Array.isArray(j) ? j : j && Array.isArray(j['@graph']) ? j['@graph'] : [j];
      for (const x of list) if (x && x['@type'] === 'Product') out.push(x);
    } catch { /* skip */ }
  }
  return out;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export function classifyFk(fsn: string, html: string | null | undefined): FkAvailRecord {
  const want = String(fsn || '').trim().toUpperCase();
  const base = { served: null, price: null, seller: null, mid: null, avail: null };
  if (!html || typeof html !== 'string') return { cls: 'error', err: 'Empty response', ...base };
  const products = fkProducts(html);
  const p = products.find(x => String(x.sku || '').toUpperCase() === want) || products[0] || null;
  let served = p && RX_FSN.test(String(p.sku || '')) ? String(p.sku).toUpperCase() : null;
  if (!served) {
    const m = html.match(/"productId"\s*:\s*"([A-Z0-9]{16})"/);
    served = m ? m[1] : null;
  }
  if (!p && !served) return { cls: 'error', err: "Page didn't look like a Flipkart product page", ...base };
  const offer = p ? (Array.isArray(p.offers) ? p.offers[0] : p.offers) : null;
  let price = offer ? num(offer.price) : null;
  if (price !== null && price <= 0) price = null;
  const avail = offer && offer.availability ? String(offer.availability).replace(/^https?:\/\/schema\.org\//i, '') : null;
  const rec = { served, price, seller: null, mid: null, avail, err: null };
  if (served && served !== want) return { cls: 'variant', ...rec };
  const a = (avail || '').toLowerCase();
  if (/outofstock|soldout|discontinued/.test(a)) return { cls: 'unavailable', ...rec };
  if (!offer || price === null || /preorder|presale|backorder|limitedavailability/.test(a)) return { cls: 'nobuy', ...rec };
  if (a && !/instock|onlineonly/.test(a)) return { cls: 'nobuy', ...rec };
  return { cls: 'live', ...rec };
}
