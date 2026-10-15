/**
 * The list behind an origin tile on the Teleshop Out / Affiliate Out card (owner 15.10.2026: "кога ќе
 * кликнеме да ги покажува сите нарачки — ЦРМ + collab"). The SQL function insights_origin_orders
 * (migration 20261016170000) returns EXACTLY the rows the tile adds up — CRM orders, collabBox
 * documents still waiting for their parcel, MEX parcels with no order, web orders — and decides who
 * may see it and whether value_mkd is there (revenue viewers / a dept_admin's own departments).
 */
import { supabase } from '@/integrations/supabase/client';

export type OriginKey = 'bio_natural' | 'natura' | 'new';
export type OriginRowKind = 'order' | 'booking' | 'mex' | 'web';

export interface OriginOrderRow {
  kind: OriginRowKind | string;
  sale_day: string;
  bucket: string;
  /** Absent for a reader without money. */
  value_mkd?: number;
  display_id?: string;
  order_id?: string;
  tracking_id?: string;
  customer?: string;
  phone?: string;
  seller?: string;
  products?: string;
  /** The first trace that decided the origin: lead | order | parcel | doc | web. */
  first_src?: string;
  first_day?: string;
}

export interface OriginOrders {
  meta: { from: string; to: string; source: string; origin: OriginKey; money: boolean; count: number; truncated: boolean };
  rows: OriginOrderRow[];
}

type Rpc = (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>;

export async function apiGetOriginOrders(p: { from: string; to: string; source: string; origin: OriginKey }): Promise<OriginOrders> {
  const rpc = supabase.rpc.bind(supabase) as unknown as Rpc;
  const { data, error } = await rpc('insights_origin_orders', {
    p_from: p.from, p_to: p.to, p_source: p.source, p_origin: p.origin,
  });
  if (error) throw new Error(error.message);
  return data as OriginOrders;
}
