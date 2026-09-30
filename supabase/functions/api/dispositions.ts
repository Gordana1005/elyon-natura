// Call-outcome records (cancel / trash from /calls) — the product they carry.
//
// When an agent closes a customer who has no open order, /calls records a synthetic
// cancelled/trashed order holding "the customer's last product". The page used to look
// that up through GET /orders, which RLS scopes to the agent's own orders, so it found
// nothing and wrote the placeholder "No prior product on file" (1.021 of 1.022 agent
// cancels in the week to 30.09.2026). POST /orders now fills it on the server from
// public.last_sale_product (migration 20260943000200). Dependency-free for vitest.

/** Mirror of src/lib/utils.ts isSyntheticProductName and public.is_synthetic_product_name. */
export function isSyntheticProductName(name: string | null | undefined): boolean {
  const n = (name || "").trim();
  if (!n || n === "—") return true;
  return /^(Cancelled|Trashed|No prior product on file)/i.test(n);
}

/** A cancel/trash record with no items and a placeholder (or no) product → fill it server-side. */
export function needsServerProduct(o: { status: string; hasItems: boolean; productName?: string | null }): boolean {
  return (o.status === "cancelled" || o.status === "trashed") && !o.hasItems && isSyntheticProductName(o.productName);
}

export interface LastSaleProduct { product_id: string | null; product_name: string | null }

/** The row from last_sale_product → the values to write, or null to keep what the client sent. */
export function productFromLastSale(row: LastSaleProduct | null | undefined): { productId: string | null; productName: string } | null {
  const name = (row?.product_name || "").trim();
  if (!name || isSyntheticProductName(name)) return null;
  return { productId: row?.product_id ?? null, productName: name };
}
