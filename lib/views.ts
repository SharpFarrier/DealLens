// What the three tabs show, worked out from the synced sheet and the latest checks.
// Pure functions (no I/O) so they can be tested against the real sheet.
import { OUR_MERCHANT, type AvailClass, type Item } from '@/lib/logic';

export type Plat = 'amz' | 'fk';
export const PLAT_NAME: Record<Plat, string> = { amz: 'Amazon', fk: 'Flipkart' };

export interface Check { cls: AvailClass; price: number | null; served: string | null; mid: string | null; avail?: string | null; checkedAt: string }
export type Checks = Record<string, Check>;

// A listing counts on a platform when the sheet has its ASIN / FSN, unless the sheet's Status
// says that platform is pending (e.g. "Live on Amazon & Website / Flipkart Pending").
// Same rule as deallens_counts_on() in the database.
export function countsOn(status: string | undefined, p: Plat): boolean {
  return !new RegExp((p === 'amz' ? 'amazon' : 'flipkart') + '\\s*pending', 'i').test(status || '');
}

export interface Listing { platform: Plat; id: string; family: string; label: string; link: string }
export function listings(items: Item[]): Listing[] {
  const out: Listing[] = [];
  const seen = new Set<string>();
  for (const it of items) {
    if (it.asin && countsOn(it.status, 'amz') && !seen.has('amz:' + it.asin)) {
      seen.add('amz:' + it.asin);
      out.push({ platform: 'amz', id: it.asin, family: it.family, label: it.desc, link: `https://www.amazon.in/dp/${it.asin}` });
    }
    if (it.fsn && countsOn(it.status, 'fk') && !seen.has('fk:' + it.fsn)) {
      seen.add('fk:' + it.fsn);
      out.push({ platform: 'fk', id: it.fsn, family: it.family, label: it.desc, link: it.fkLink || `https://www.flipkart.com/search?q=${it.fsn}` });
    }
  }
  return out;
}

// ----- Live status -----
export type State = 'live' | 'down' | 'unchecked';
export type Tone = 'red' | 'amber' | 'gray' | 'green';
export interface StatusRow { listing: Listing; check: Check | null; state: State; label: string; tone: Tone }

// Plain-words status for one listing. A live Amazon page whose Buy Box is held by another seller counts as down.
export function describe(p: Plat, c: Check | null, merchantId = OUR_MERCHANT): { state: State; label: string; tone: Tone } {
  if (!c) return { state: 'unchecked', label: 'Not checked yet', tone: 'gray' };
  switch (c.cls) {
    case 'error': return { state: 'unchecked', label: "Couldn't check", tone: 'gray' };
    case 'variant': return { state: 'down', label: 'Wrong variant', tone: 'amber' };
    case 'unavailable': return { state: 'down', label: p === 'fk' ? 'Sold out' : 'Unavailable', tone: 'red' };
    case 'nobuy': return { state: 'down', label: p === 'fk' && /preorder|presale/i.test(c.avail || '') ? 'Pre-order only' : 'No Buy button', tone: 'red' };
    case 'live':
      if (p === 'amz' && c.mid && merchantId && c.mid !== merchantId.toUpperCase()) return { state: 'down', label: 'Other seller', tone: 'red' };
      return { state: 'live', label: 'Live', tone: 'green' };
  }
}

export function statusRows(ls: Listing[], amz: Checks, fk: Checks, merchantId?: string): StatusRow[] {
  return ls.map(l => {
    const check = (l.platform === 'amz' ? amz : fk)[l.id] || null;
    return { listing: l, check, ...describe(l.platform, check, merchantId) };
  });
}

export interface PlatSummary { total: number; live: number; down: number; unchecked: number }
export function summarizeStatus(rows: StatusRow[]): Record<Plat, PlatSummary> {
  const s: Record<Plat, PlatSummary> = { amz: { total: 0, live: 0, down: 0, unchecked: 0 }, fk: { total: 0, live: 0, down: 0, unchecked: 0 } };
  for (const r of rows) { const x = s[r.listing.platform]; x.total++; x[r.state]++; }
  return s;
}

export interface FamilyStatus { family: string; total: number; live: number; down: number; unchecked: number }
export function familyStatus(rows: StatusRow[]): FamilyStatus[] {
  const m = new Map<string, FamilyStatus>();
  for (const r of rows) {
    const f = m.get(r.listing.family) || { family: r.listing.family, total: 0, live: 0, down: 0, unchecked: 0 };
    f.total++; f[r.state]++;
    m.set(r.listing.family, f);
  }
  return [...m.values()].sort((a, b) => b.down - a.down || a.family.localeCompare(b.family));
}

// ----- 30-day bars -----
export interface DayRow { day: string; platform: Plat; family: string; checked: number; down: number }
export interface Bar { day: string; checked: number; down: number | null }   // down null: no check that day

export function istDay(d: Date): string {
  return new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 10);
}
export function lastDays(n: number, now = new Date()): string[] {
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) out.push(istDay(new Date(now.getTime() - i * 86_400_000)));
  return out;
}
export function bars(days: string[], rows: DayRow[], pick: (r: DayRow) => boolean): Bar[] {
  const by = new Map<string, { checked: number; down: number }>();
  for (const r of rows) if (pick(r)) {
    const x = by.get(r.day) || { checked: 0, down: 0 };
    x.checked += r.checked; x.down += r.down;
    by.set(r.day, x);
  }
  return days.map(d => { const x = by.get(d); return { day: d, checked: x?.checked || 0, down: x ? x.down : null }; });
}
// Colour of one day's bar: green all live, amber a few down, red more. Gray: no check that day.
export function barTone(b: Bar, amberUpTo: number): Tone {
  if (b.down === null) return 'gray';
  if (b.down === 0) return 'green';
  return b.down <= amberUpTo ? 'amber' : 'red';
}

// ----- Pricing -----
export interface Rule { mode: 'sale' | 'normal'; column: string; disc: number; familyDisc: Record<string, number> }

// What a product should sell at: exactly the selling price column on a normal day, or that minus the
// sale % (the family's own % if it has one), rounded to the nearest rupee.
export function shouldBe(it: Item, r: Rule): { price: number | null; pct: number | null; own: boolean; base: number | null } {
  const base = it.prices?.[r.column] ?? null;
  if (base === null || !Number.isFinite(base)) return { price: null, pct: null, own: false, base: null };
  if (r.mode === 'normal') return { price: base, pct: null, own: false, base };
  const own = Object.prototype.hasOwnProperty.call(r.familyDisc, it.family);
  const pct = own ? r.familyDisc[it.family] : r.disc;
  return { price: Math.round((base * (100 - pct)) / 100), pct, own, base };
}

export interface PriceCell { price: number | null; diff: number | null; state: State; label: string }
export interface PriceRow { item: Item; expected: number | null; pct: number | null; own: boolean; amz: PriceCell | null; fk: PriceCell | null }

function priceCell(p: Plat, id: string, status: string | undefined, checks: Checks, expected: number | null, merchantId?: string): PriceCell | null {
  if (!id || !countsOn(status, p)) return null;
  const c = checks[id] || null;
  const d = describe(p, c, merchantId);
  if (d.state !== 'live' || !c || c.price === null) return { price: null, diff: null, state: d.state === 'live' ? 'unchecked' : d.state, label: d.label };
  return { price: c.price, diff: expected === null ? null : Math.round((c.price - expected) * 100) / 100, state: 'live', label: 'Live' };
}

export function priceRows(items: Item[], r: Rule, amz: Checks, fk: Checks, merchantId?: string): PriceRow[] {
  return items.filter(it => it.asin || it.fsn).map(it => {
    const s = shouldBe(it, r);
    return {
      item: it, expected: s.price, pct: s.pct, own: s.own,
      amz: priceCell('amz', it.asin, it.status, amz, s.price, merchantId),
      fk: priceCell('fk', it.fsn, it.status, fk, s.price, merchantId),
    };
  });
}

export interface PriceSummary { correct: number; high: number; low: number; priced: number; notLive: number; noPrice: number }
export function summarizePrices(rows: PriceRow[]): PriceSummary {
  const s: PriceSummary = { correct: 0, high: 0, low: 0, priced: 0, notLive: 0, noPrice: 0 };
  for (const r of rows) {
    if (r.expected === null) { s.noPrice++; continue; }
    for (const c of [r.amz, r.fk]) {
      if (!c) continue;
      if (c.state !== 'live' || c.diff === null) { s.notLive++; continue; }
      s.priced++;
      if (c.diff === 0) s.correct++; else if (c.diff > 0) s.high++; else s.low++;
    }
  }
  return s;
}
export const isWrong = (r: PriceRow) => [r.amz, r.fk].some(c => c && c.diff !== null && c.diff !== 0);
export const isHigh = (r: PriceRow) => [r.amz, r.fk].some(c => c && c.diff !== null && c.diff > 0);
export const isLow = (r: PriceRow) => [r.amz, r.fk].some(c => c && c.diff !== null && c.diff < 0);
export const worstGap = (r: PriceRow) => Math.max(0, ...[r.amz, r.fk].map(c => (c && c.diff !== null ? Math.abs(c.diff) : 0)));

// What switching the rule (e.g. to a new selling price column) would do to each product's planned price.
export interface RuleChange { item: Item; from: number | null; to: number | null }
export function ruleChanges(items: Item[], a: Rule, b: Rule): RuleChange[] {
  return items.filter(it => it.asin || it.fsn)
    .map(it => ({ item: it, from: shouldBe(it, a).price, to: shouldBe(it, b).price }))
    .filter(c => c.from !== c.to);
}

// ----- Amazon vs Flipkart -----
export type CrossKind = 'same' | 'diff' | 'one';
export interface CrossRow { item: Item; amz: PriceCell; fk: PriceCell; kind: CrossKind; gap: number }
export function crossRows(items: Item[], amz: Checks, fk: Checks, merchantId?: string): { rows: CrossRow[]; singlePlatform: number; bothDown: number; unchecked: number } {
  const rows: CrossRow[] = [];
  let singlePlatform = 0, bothDown = 0, unchecked = 0;
  const seen = new Set<string>();
  for (const it of items) {
    const onA = !!it.asin && countsOn(it.status, 'amz'), onF = !!it.fsn && countsOn(it.status, 'fk');
    if (!onA && !onF) continue;
    if (!onA || !onF) { singlePlatform++; continue; }
    const k = it.asin + '|' + it.fsn;
    if (seen.has(k)) continue;
    seen.add(k);
    const a = priceCell('amz', it.asin, it.status, amz, null, merchantId)!;
    const f = priceCell('fk', it.fsn, it.status, fk, null, merchantId)!;
    if (a.state === 'unchecked' || f.state === 'unchecked') { unchecked++; continue; }
    const la = a.state === 'live', lf = f.state === 'live';
    if (!la && !lf) { bothDown++; continue; }
    if (la !== lf) { rows.push({ item: it, amz: a, fk: f, kind: 'one', gap: 0 }); continue; }
    const gap = Math.round(((f.price as number) - (a.price as number)) * 100) / 100;
    rows.push({ item: it, amz: a, fk: f, kind: gap === 0 ? 'same' : 'diff', gap });
  }
  return { rows, singlePlatform, bothDown, unchecked };
}

// ----- formatting -----
export const inr = (v: number | null | undefined) =>
  v === null || v === undefined ? '' : '₹' + (Math.round(v * 100) / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 });

export function downFor(since: string | null | undefined, now = Date.now()): string {
  if (!since) return '';
  const days = Math.floor((now - Date.parse(since)) / 86_400_000);
  if (days < 1) return 'Today';
  return days === 1 ? '1 day' : `${days} days`;
}

export function whenLabel(iso: string | null | undefined, now = new Date()): string {
  if (!iso) return 'never';
  const d = new Date(iso);
  const t = d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' });
  if (istDay(d) === istDay(now)) return `today at ${t}`;
  if (istDay(d) === istDay(new Date(now.getTime() - 86_400_000))) return `yesterday at ${t}`;
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' }) + ` at ${t}`;
}
