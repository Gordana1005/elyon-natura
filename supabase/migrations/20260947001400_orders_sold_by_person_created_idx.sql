-- Insights speed (owner 02.10.2026 — "Insights faster when we log in"; profiling the same evening).
-- insights_sale_rows' bookings dedupe (CTE bk, "same author ±1 day") filters orders on
-- (sold_by_person_id, created_at) — the existing index is (sold_by_person_id, sold_at), so each of its
-- ~350 probes walked ~9,9k rows per person (≈ 788 ms per call, the call runs 3× per Overview load).
-- Built while the floor was closed (a plain CREATE INDEX holds writes on orders for its few seconds).
CREATE INDEX IF NOT EXISTS idx_orders_sold_by_person_created
  ON public.orders (sold_by_person_id, created_at);
