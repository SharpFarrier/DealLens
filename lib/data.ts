// Row shapes shared by the server and the browser, and their mapping to logic types.
import type { DealMapping, Item, Aoa, AvailClass } from '@/lib/logic';

export interface ProductRow {
  key: string; sort_order: number; family: string; description: string; master_sku: string | null;
  amazon_sku: string | null; asin: string | null; flipkart_sku: string | null; flipkart_link: string | null;
  fsn: string | null; new_price: number | string; synced_at?: string;
}
export interface PlanSettingsRow {
  id: number; event: string; disc: number | string; tol: number | string;
  price_ref: 'deal' | 'catalogue' | 'off'; merchant_id: string; updated_by: string | null; updated_at: string;
}
export interface DealFileRow { platform: 'amz' | 'fk'; filename: string | null; aoa: Aoa; mapping: DealMapping; uploaded_by: string | null; uploaded_at: string }
export interface LivePriceRow { platform: 'amz' | 'fk'; id: string; price: number | string | null; err: string | null; checked_at: string }
export interface AvailRow { asin: string; cls: AvailClass; served: string | null; price: number | string | null; seller: string | null; mid: string | null; err: string | null; checked_by: string | null; checked_at: string }
export interface SyncRunRow { id: number; trigger: string; triggered_by: string | null; started_at: string; finished_at: string | null; status: 'running' | 'ok' | 'error'; row_count: number | null; added: number | null; removed: number | null; changed: number | null; error: string | null }
export interface MemberRow { email: string; role: 'admin' | 'member'; added_by: string | null; created_at: string; last_seen: string | null }

const n = (v: number | string | null | undefined): number | null => (v === null || v === undefined || v === '' ? null : Number(v));

export function productToItem(r: ProductRow): Item {
  return {
    key: r.key,
    family: r.family,
    desc: r.description,
    master: r.master_sku || '',
    amzSku: r.amazon_sku || '',
    asin: r.asin || '',
    fkSku: r.flipkart_sku || '',
    fkLink: r.flipkart_link || '',
    fsn: r.fsn || '',
    newPrice: Number(r.new_price),
  };
}

export function itemToProduct(it: Item, sortOrder: number): Omit<ProductRow, 'synced_at'> {
  return {
    key: it.key,
    sort_order: sortOrder,
    family: it.family,
    description: it.desc,
    master_sku: it.master || null,
    amazon_sku: it.amzSku || null,
    asin: it.asin || null,
    flipkart_sku: it.fkSku || null,
    flipkart_link: it.fkLink || null,
    fsn: it.fsn || null,
    new_price: it.newPrice,
  };
}

export const toNum = n;
