import type { OrderStatus } from '@/types';

/** One row of GET /orders (orders.* + order_items + the api's enrichment). */
export interface ApiOrder {
  id: string;
  display_id: string;
  product_name: string;
  price: number;
  quantity: number;
  status: OrderStatus;
  customer_name: string;
  customer_phone: string;
  customer_city: string;
  customer_address: string;
  postal_code?: string;
  assigned_agent_name: string | null;
  assigned_agent_id: string | null;
  last_action_by?: string | null;
  confirmed_by_name?: string | null;
  /** GET /orders enrichment (order_departments, 20260942001500): who SOLD it and its department. */
  seller_name?: string | null;
  department?: string | null;
  /** GET /orders enrichment (order_operators, 20260943002000): who produced the CURRENT status —
   *  the "Оператор" column. basis = sale | history | assigned | altercpa; auto = an automatic rule set it. */
  operator_name?: string | null;
  operator_basis?: string | null;
  operator_auto?: boolean | null;
  confirmed_by_agent_id?: string | null;
  confirmed_at?: string | null;
  sold_at?: string | null;
  cancelled_at?: string | null;
  trashed_at?: string | null;
  created_at: string;
  source_type?: string;
  source_lead_id?: string | null;
  // AlterCPA linkage (GET /orders selects *; these power the CPA push button)
  external_source?: string | null;
  external_order_id?: string | null;
  // CPA provenance — the server omits all four for anyone below manager, so
  // treat absent as "not allowed to see" rather than "no attribution".
  cpa_webmaster_id?: string | null;
  cpa_offer_id?: string | null;
  cpa_offer_name?: string | null;
  cpa_stream_id?: string | null;
  ship_after_date?: string | null;
  // Reason pairs — orderReasonText() composes the CPA push comment from these
  cancellation_reason?: string | null;
  cancellation_reason_notes?: string | null;
  trash_reason?: string | null;
  trash_reason_notes?: string | null;
  return_reason?: string | null;
  return_reason_notes?: string | null;
  duplicated_from?: string | null;
  duplicated_from_display?: string | null;
  notes?: string | null;
  delivery_type?: string | null;
  home_courier?: string | null;
  courier_office_name?: string | null;
  courier_office_city?: string | null;
  courier_office_code?: string | null;
  // The MEX parcel (mex-reconcile / the collabBox reader): MEX is the proof.
  mex_tracking_id?: string | null;
  mex_status_id?: number | null;
  mex_account?: string | null;
  mex_cod_mkd?: number | null;
  mex_last_update_at?: string | null;
  is_owned?: boolean;
  order_items?: ApiOrderItem[];
}

/** order_items as GET /orders embeds them. */
export interface ApiOrderItem {
  id?: string;
  product_id?: string | null;
  product_name?: string | null;
  quantity?: number | null;
  price_per_unit?: number | null;
  total_price?: number | null;
}
