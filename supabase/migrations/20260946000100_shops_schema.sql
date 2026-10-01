-- ============================================================================
-- Shops (Продавници) 1/3 — the tables and the writers of the collabBox shops reader
-- (owner, Mile, 02.10.2026; contract docs/SHOPS.md, JSON in src/lib/shopsTypes.ts)
-- ============================================================================
-- The 22 shops of НАТУРА ТЕРАПИ СТОРЕС ДООЕЛ run their tills on collabBox. The edge function
-- collabbox-shops (READ-ONLY against collabBox, its own allow-list) reads, and these writers store:
--
--   shops                  the 22 active shops: collabBox warehouse code, internal magid, name, city and
--                          the Sigma delivery object of client 000001 (seeded below; verified against the
--                          warehouse list of the 01.10 probe — every name matches "NNN Продавница <name>")
--   shop_articles          one row per collabBox article seen: name, group, the VAT % of the article
--                          (infollc "ДДВ на артикл", nightly — the ex-VAT figures use it)
--   shop_sales_lines       10022 fiscal receipts and 10010 retail returns, one row per line, by
--                          (doc_number, line_no); 10018 (the daily report) is NEVER added to them
--   shop_docs / shop_doc_lines   the goods documents: 10042 Natura's invoice into 001 Централен (with
--                          Natura's own number — the Sigma join key; its twin 10016 is never read),
--                          10014 001 → shop (signed), 10015 / 10061 transfers, 10044 returns to Natura,
--                          10040 bundle assembly, 10062 damaged, 10011 count lists, 10005 count differences
--   shop_stock_takes / shop_stock_snapshots   the nightly infollc stock per shop (non-zero rows only;
--                          a take row marks every snapshot, so an empty shop is still "known")
--   shop_stock_periods     lnp opening / bought / sold / closing per shop and month (the backfill)
--   shop_day_controls      receipts total vs the 10018 daily report and the trade book (cash / card)
--   shops_reader_runs      the run log (one run at a time — 409)
--   shops_backfill_log     what the night backfill has done (resumable)
--
-- RULES (law for every reader of these tables):
--   * Loyalty ПОЕН-* lines are kept and flagged (is_point): never units, never sales, never product stock.
--   * A goods line with a near-zero cost and a huge price (1 × ПОЕН-350, cost 3,67, price −6.883.979 —
--     Бисер 30.09; −9.629.166 Аеродром 09.09) is a TRADE-BOOK CORRECTION after a count, not goods:
--     is_correction, never units / stock / goods value; shops_health lists it.
--   * 10005 count difference: a POSITIVE value is a SHORTAGE (stock down), a negative one a SURPLUS —
--     shops_doc_delta() signs it by the value, whatever column collabBox put the quantity in.
--   * Values are as collabBox shows them: WITH VAT (cost and sale). Ex-VAT figures divide each line by
--     its article's VAT (shop_articles → products.vat_rate by sku → 5 %, counted as unclassified).
--   * No customer data: a retail line's customer is always "Непознат Купувач"; named_customer only
--     counts the rare receipt that carried another komitent. Cashiers are staff (kept).
--
-- Every table: RLS on, no policy (deny-all), REVOKE from PUBLIC / anon / authenticated; the api and the
-- edge function use service_role; supabase_read_only_user may SELECT (scripts/shops/verify-shops.mjs).
-- Writers: SECURITY DEFINER, service_role only, idempotent (a document's lines are replaced as a whole).
--
-- Nothing reads collabBox until app_settings.shops_reader.enabled (migration 20260946000300).
-- Rollback: DROP the tables below (CASCADE) and the shops_* functions; nothing else depends on them.
-- ============================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';

DO $dep$
BEGIN
  IF to_regclass('public.app_settings') IS NULL OR to_regclass('public.products') IS NULL THEN
    RAISE EXCEPTION '20260946000100: app_settings / products missing — wrong database?';
  END IF;
END
$dep$;

-- ── 1. shops ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.shops (
  code             text PRIMARY KEY CONSTRAINT shops_code_check CHECK (code ~ '^[0-9]{3}$'),
  name             text NOT NULL,
  city             text NOT NULL,
  sigma_object     text CONSTRAINT shops_sigma_object_check CHECK (sigma_object IS NULL OR sigma_object ~ '^[0-9]{1,3}$'),
  collabbox_magid  integer NOT NULL UNIQUE,
  collabbox_name   text NOT NULL,
  active           boolean NOT NULL DEFAULT true,
  sort             integer NOT NULL DEFAULT 0,
  note             text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.shops IS
  'The shops of НАТУРА ТЕРАПИ СТОРЕС ДООЕЛ (collabBox warehouses 003–029): code = the collabBox warehouse code, collabbox_magid = the internal id of the magid / rightMagIds filters, collabbox_name = the warehouse title ("003 Продавница Карпош" — the trade book sums by it), sigma_object = the Sigma delivery object of client 000001 (Natura''s invoices to the shop). Seeded by 20260946000100 (TWIN: SHOP_MAGIDS in supabase/functions/collabbox-shops/shops.ts). Warehouses 001 Централен, 002 Call Centar and 014 Оштетена роба are not shops.';

INSERT INTO public.shops (code, name, city, sigma_object, collabbox_magid, collabbox_name, sort) VALUES
  ('003', 'Карпош',        'Скопје',    '17',  4, '003 Продавница Карпош',        3),
  ('004', 'Бисер',         'Скопје',    '03',  6, '004 Продавница Бисер',         4),
  ('005', 'ГТЦ',           'Скопје',    '04',  7, '005 Продавница ГТЦ',           5),
  ('006', 'Струмица',      'Струмица',  '19',  8, '006 Продавница Струмица',      6),
  ('007', 'Битола',        'Битола',    '10',  9, '007 Продавница Битола',        7),
  ('008', 'Тетово',        'Тетово',    '15', 10, '008 Продавница Тетово',        8),
  ('009', 'Штип',          'Штип',      '18', 11, '009 Продавница Штип',          9),
  ('010', 'Куманово',      'Куманово',  '20', 12, '010 Продавница Куманово',     10),
  ('011', 'Прилеп',        'Прилеп',    '11', 13, '011 Продавница Прилеп',       11),
  ('012', 'Кавадарци',     'Кавадарци', '08', 14, '012 Продавница Кавадарци',    12),
  ('013', 'Велес',         'Велес',     '07', 15, '013 Продавница Велес',        13),
  ('015', 'Охрид',         'Охрид',     '12', 17, '015 Продавница Охрид',        15),
  ('016', 'Струга',        'Струга',    '13', 18, '016 Продавница Струга',       16),
  ('017', 'Гевгелија',     'Гевгелија', '09', 19, '017 Продавница Гевгелија',    17),
  ('020', 'Аеродром',      'Скопје',    '02', 37, '020 Продавница Аеродром',     20),
  ('021', 'Џон Кенеди',    'Скопје',    '05', 38, '021 Продавница Џон Кенеди',   21),
  ('023', 'Кочани',        'Кочани',    '14', 40, '023 Продавница Кочани',       23),
  ('024', 'Кичево',        'Кичево',    '21', 41, '024 Продавница Кичево',       24),
  ('026', 'Ѓорче Петров',  'Скопје',    '22', 43, '026 Продавница Ѓорче Петров', 26),
  ('027', 'Драчево',       'Скопје',    '23', 44, '027 Продавница Драчево',      27),
  ('028', 'Лимак',         'Скопје',    '24', 45, '028 Продавница Лимак',        28),
  ('029', 'Сити Мол',      'Скопје',    '25', 46, '029 Продавница Сити Мол',     29)
ON CONFLICT (code) DO NOTHING;

-- ── 2. articles ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.shop_articles (
  article_code   text PRIMARY KEY,
  article_id     text,
  name           text NOT NULL,
  group_name     text,
  unit           text,
  vat_rate       numeric(5,4) CONSTRAINT shop_articles_vat_check CHECK (vat_rate IS NULL OR (vat_rate >= 0 AND vat_rate < 1)),
  vat_seen_at    timestamptz,
  is_point       boolean NOT NULL DEFAULT false,
  last_avg_cost_mkd  numeric(14,4),
  last_retail_mkd    numeric(14,4),
  first_seen_at  timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.shop_articles IS
  'Every collabBox article the shops reader has seen (code = collabBox Шифра = the Sigma item code for Natura''s goods): name, article group, unit and the VAT % of the article from the nightly infollc ("ДДВ на артикл", 0.05 / 0.18 / 0) — the ex-VAT shop figures divide by it. is_point = a loyalty ПОЕН-* voucher (never a product). Migration 20260946000100.';

-- ── 3. receipts and retail returns ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.shop_sales_lines (
  doc_number           text NOT NULL,
  line_no              integer NOT NULL CONSTRAINT shop_sales_lines_line_check CHECK (line_no > 0),
  doc_type             text NOT NULL CONSTRAINT shop_sales_lines_type_check CHECK (doc_type IN ('10022', '10010')),
  shop_code            text NOT NULL REFERENCES public.shops(code),
  sold_at              timestamptz NOT NULL,
  article_code         text NOT NULL,
  article_id           text,
  article_name         text NOT NULL,
  article_group        text,
  qty                  numeric(14,3) NOT NULL,
  unit_cost_mkd        numeric(14,4),
  unit_price_mkd       numeric(14,4),
  cost_value_mkd       numeric(14,2),
  sale_value_mkd       numeric(14,2),
  vat_rate             numeric(5,4),
  cashier              text,
  is_return            boolean NOT NULL DEFAULT false,
  is_point             boolean NOT NULL DEFAULT false,
  named_customer       boolean NOT NULL DEFAULT false,
  collabbox_object_id  text,
  run_id               uuid,
  read_at              timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (doc_number, line_no)
);
CREATE INDEX IF NOT EXISTS idx_shop_sales_lines_shop_at ON public.shop_sales_lines (shop_code, sold_at);
CREATE INDEX IF NOT EXISTS idx_shop_sales_lines_at ON public.shop_sales_lines (sold_at);
CREATE INDEX IF NOT EXISTS idx_shop_sales_lines_article ON public.shop_sales_lines (article_code, sold_at);
COMMENT ON TABLE public.shop_sales_lines IS
  'The shops'' sales from collabBox: 10022 Фискална Сметка (a sale) and 10010 Повратница од малопродажба (a retail return, is_return), one row per line. qty is positive (is_return says the way); cost / sale values are WITH VAT exactly as collabBox shows them; unit_cost = the shop''s purchase price (= Natura''s invoice price, with VAT). is_point = a loyalty ПОЕН-* line (kept, never units or sales). A re-read replaces a document''s lines as a whole (shops_ingest_sales). 10018 Дневен Финансиски Извештај is the control, never a sale. Migration 20260946000100.';

-- ── 4. goods documents ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.shop_docs (
  doc_number           text PRIMARY KEY,
  doc_type             text NOT NULL,
  wh_code              text,
  doc_at               timestamptz NOT NULL,
  amount_mkd           numeric(16,2),
  natura_doc           text,
  natura_doc_key       text,
  author               text,
  collabbox_doc_id     text,
  collabbox_object_id  text,
  header_seen          boolean NOT NULL DEFAULT false,
  vanished_at          timestamptz,
  first_seen_at        timestamptz NOT NULL DEFAULT now(),
  read_at              timestamptz NOT NULL DEFAULT now(),
  run_id               uuid
);
CREATE INDEX IF NOT EXISTS idx_shop_docs_type_at ON public.shop_docs (doc_type, doc_at);
CREATE INDEX IF NOT EXISTS idx_shop_docs_natura ON public.shop_docs (natura_doc_key) WHERE natura_doc_key IS NOT NULL;
COMMENT ON TABLE public.shop_docs IS
  'collabBox goods documents of the shops company: 10042 Влезна Фактура (Natura''s invoice into 001 Централен; natura_doc = Natura''s own number as typed, natura_doc_key its normalised form — the join to Sigma), 10014 Приемен лист во трговија (001 ↔ shop, signed), 10015 / 10061 transfers, 10044 Повратница до добавувач (return to Natura, natura_doc = Natura''s return number), 10040 bundle assembly, 10062 damaged goods, 10011 count list (not a movement), 10005 count difference. Never 10016 (the twin of 10042), 10008 (price change), 10009, 10066, orders. vanished_at = no longer in collabBox at a full re-read. header_seen = false for a stub made from lines alone. Migration 20260946000100.';

CREATE TABLE IF NOT EXISTS public.shop_doc_lines (
  doc_number       text NOT NULL REFERENCES public.shop_docs(doc_number) ON DELETE CASCADE,
  line_no          integer NOT NULL CONSTRAINT shop_doc_lines_line_check CHECK (line_no > 0),
  doc_type         text NOT NULL,
  doc_at           timestamptz NOT NULL,
  wh_in            text,
  wh_out           text,
  article_code     text NOT NULL,
  article_id       text,
  article_name     text NOT NULL,
  article_group    text,
  qty_in           numeric(14,3) NOT NULL DEFAULT 0,
  qty_out          numeric(14,3) NOT NULL DEFAULT 0,
  unit_cost_mkd    numeric(14,4),
  unit_price_mkd   numeric(16,4),
  cost_value_mkd   numeric(16,2),
  sale_value_mkd   numeric(16,2),
  vat_rate         numeric(5,4),
  is_point         boolean NOT NULL DEFAULT false,
  is_correction    boolean NOT NULL DEFAULT false,
  run_id           uuid,
  read_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (doc_number, line_no)
);
CREATE INDEX IF NOT EXISTS idx_shop_doc_lines_in ON public.shop_doc_lines (wh_in, doc_at);
CREATE INDEX IF NOT EXISTS idx_shop_doc_lines_out ON public.shop_doc_lines (wh_out, doc_at);
CREATE INDEX IF NOT EXISTS idx_shop_doc_lines_article ON public.shop_doc_lines (article_code);
COMMENT ON TABLE public.shop_doc_lines IS
  'Lines of shop_docs as collabBox reports them: in / out warehouse codes and quantities (a 10014 line has both: + into the shop, − out of 001; a negative quantity is the way back). Values WITH VAT. is_point = ПОЕН-* voucher (stock of vouchers, never product units). is_correction = a TRADE-BOOK CORRECTION (near-zero cost, huge price — 1 × ПОЕН-350 at −6.883.979 ден): never units, stock or goods value. The units a line moves for a warehouse: shops_doc_delta(). Migration 20260946000100.';

-- ── 5. stock ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.shop_stock_takes (
  taken_at   timestamptz NOT NULL,
  shop_code  text NOT NULL REFERENCES public.shops(code),
  source     text NOT NULL CONSTRAINT shop_stock_takes_source_check CHECK (source IN ('infollc', 'lnp')),
  as_of      date NOT NULL,
  articles   integer NOT NULL DEFAULT 0,
  units      numeric(14,3) NOT NULL DEFAULT 0,
  run_id     uuid,
  PRIMARY KEY (taken_at, shop_code)
);
CREATE INDEX IF NOT EXISTS idx_shop_stock_takes_shop ON public.shop_stock_takes (shop_code, taken_at);
COMMENT ON TABLE public.shop_stock_takes IS
  'One row per stock snapshot of a shop: infollc = the nightly read (taken_at = the moment it was read, as_of = its "До датум"), lnp = a closed month''s closing stock (taken_at = the last instant of as_of). The snapshot rows are shop_stock_snapshots at the same taken_at (non-zero rows only). Migration 20260946000100.';

CREATE TABLE IF NOT EXISTS public.shop_stock_snapshots (
  taken_at          timestamptz NOT NULL,
  shop_code         text NOT NULL,
  article_code      text NOT NULL,
  qty               numeric(14,3) NOT NULL,
  reserved          numeric(14,3) NOT NULL DEFAULT 0,
  available         numeric(14,3),
  avg_cost_mkd      numeric(14,4),
  retail_price_mkd  numeric(14,4),
  value_mkd         numeric(16,4),
  vat_rate          numeric(5,4),
  source            text NOT NULL DEFAULT 'infollc',
  run_id            uuid,
  PRIMARY KEY (taken_at, shop_code, article_code),
  FOREIGN KEY (taken_at, shop_code) REFERENCES public.shop_stock_takes(taken_at, shop_code) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_shop_stock_snapshots_shop ON public.shop_stock_snapshots (shop_code, taken_at);
COMMENT ON TABLE public.shop_stock_snapshots IS
  'Stock of a shop per article at a take (collabBox infollc: avg cost WITHOUT VAT, reserved, available, value at avg cost, retail price WITH VAT; lnp: closing quantity and averages). Only rows with stock or a reservation are kept (a missing row = 0). Stock at any moment = the latest take ≤ the moment + the signed lines after it (shops_stock_at). Pruned to 62 days of nightly takes plus the last take of each month (shops_snapshots_prune). Migration 20260946000100.';

CREATE TABLE IF NOT EXISTS public.shop_stock_periods (
  shop_code           text NOT NULL REFERENCES public.shops(code),
  period_from         date NOT NULL,
  period_to           date NOT NULL,
  article_code        text NOT NULL,
  opening_qty         numeric(14,3) NOT NULL DEFAULT 0,
  in_purchase         numeric(14,3) NOT NULL DEFAULT 0,
  in_transfer         numeric(14,3) NOT NULL DEFAULT 0,
  out_sales           numeric(14,3) NOT NULL DEFAULT 0,
  out_transfer        numeric(14,3) NOT NULL DEFAULT 0,
  closing_qty         numeric(14,3) NOT NULL DEFAULT 0,
  opening_value_mkd   numeric(16,2),
  closing_value_mkd   numeric(16,2),
  avg_cost_mkd        numeric(14,4),
  closing_retail_mkd  numeric(16,2),
  run_id              uuid,
  read_at             timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_code, period_from, period_to, article_code)
);
COMMENT ON TABLE public.shop_stock_periods IS
  'collabBox lnp (Лагер / набавено / продадено) per shop and period: opening, in from purchase, in by transfer, out by sale (includes components used by 10040 bundle assembly), out by transfer, closing; values WITHOUT VAT, closing_retail = the closing at retail prices. Filled month by month by the night backfill (2025–2026). Migration 20260946000100.';

-- ── 6. controls, runs, backfill ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.shop_day_controls (
  day                 date NOT NULL,
  shop_code           text NOT NULL REFERENCES public.shops(code),
  receipts            integer,
  receipts_total_mkd  numeric(14,2),
  report_total_mkd    numeric(14,2),
  report_doc          text,
  tk_total_mkd        numeric(14,2),
  cash_mkd            numeric(14,2),
  card_mkd            numeric(14,2),
  diff_mkd            numeric(14,2),
  tolerance_mkd       numeric(14,2),
  ok                  boolean,
  checked_at          timestamptz,
  run_id              uuid,
  PRIMARY KEY (day, shop_code)
);
COMMENT ON TABLE public.shop_day_controls IS
  'Per shop and Skopje day: the receipts read (10022 lines, ПОЕН included — the till total includes them — minus 10010 returns) against the 10018 Дневен Финансиски Извештај (report_total, rounded to the denar per receipt) and the trade book (tkreport: all payments = tk_total, cash only → cash, card = all − cash). ok = |receipts − report| ≤ max(1, 0,5 × receipts) and the same against the trade book when read; NULL = not checked yet. Migration 20260946000100.';

CREATE TABLE IF NOT EXISTS public.shops_reader_runs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mode              text NOT NULL CONSTRAINT shops_reader_runs_mode_check CHECK (mode IN ('sales', 'docs', 'nightly', 'backfill', 'manual')),
  trigger_kind      text NOT NULL DEFAULT 'manual' CONSTRAINT shops_reader_runs_trigger_check CHECK (trigger_kind IN ('cron', 'manual')),
  status            text NOT NULL DEFAULT 'running' CONSTRAINT shops_reader_runs_status_check CHECK (status IN ('running', 'ok', 'partial', 'failed')),
  window_from       date,
  window_to         date,
  requests          integer NOT NULL DEFAULT 0,
  requests_by_kind  jsonb,
  stats             jsonb,
  error             text,
  warning           text,
  started_at        timestamptz NOT NULL DEFAULT now(),
  finished_at       timestamptz,
  duration_ms       integer
);
CREATE INDEX IF NOT EXISTS idx_shops_reader_runs_started ON public.shops_reader_runs (started_at DESC);
CREATE INDEX IF NOT EXISTS idx_shops_reader_runs_running ON public.shops_reader_runs (status) WHERE status = 'running';
COMMENT ON TABLE public.shops_reader_runs IS
  'The collabbox-shops run log. One run at a time (a ''running'' row younger than 20 minutes → the next invocation answers 409; older → marked failed). requests = collabBox requests sent (by kind in requests_by_kind). Migration 20260946000100.';

CREATE TABLE IF NOT EXISTS public.shops_backfill_log (
  kind     text NOT NULL CONSTRAINT shops_backfill_log_kind_check CHECK (kind IN ('sales_day', 'close_day', 'controls_month', 'docs_week', 'lnp_month')),
  key      text NOT NULL,
  ok       boolean NOT NULL DEFAULT true,
  stats    jsonb,
  run_id   uuid,
  done_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, key)
);
COMMENT ON TABLE public.shops_backfill_log IS
  'What the collabbox-shops night backfill has read: sales_day YYYY-MM-DD, close_day (yesterday re-read + controls), controls_month YYYY-MM (the 10018 reports), docs_week <monday>, lnp_month <shop>|YYYY-MM. A key here is never read again by the backfill (delete it to re-read). Migration 20260946000100.';

-- ── 7. RLS and grants: deny-all, service_role only ──────────────────────────
DO $rls$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['shops', 'shop_articles', 'shop_sales_lines', 'shop_docs', 'shop_doc_lines', 'shop_stock_takes',
                           'shop_stock_snapshots', 'shop_stock_periods', 'shop_day_controls', 'shops_reader_runs', 'shops_backfill_log'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', t);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_read_only_user') THEN
      EXECUTE format('GRANT SELECT ON public.%I TO supabase_read_only_user', t);
    END IF;
  END LOOP;
END
$rls$;

-- ── 8. helpers ──────────────────────────────────────────────────────────────
-- Skopje wall clock "YYYY-MM-DDTHH:MI:SS" (as collabBox shows it) → the instant.
CREATE OR REPLACE FUNCTION public.shops_skopje_ts(p_local text)
RETURNS timestamptz
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = public, pg_temp
AS $fn$
  SELECT CASE WHEN p_local ~ '^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?)?$'
              THEN (replace(p_local, 'T', ' ')::timestamp AT TIME ZONE 'Europe/Skopje') END
$fn$;

-- Natura's own document number as typed in collabBox / as Sigma writes it → its key:
-- '04-01101' / '04-001104' → '04-1101' / '04-1104'; a bare number → its digits without leading zeros.
CREATE OR REPLACE FUNCTION public.shops_natura_doc_key(p_raw text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = public, pg_temp
AS $fn$
  SELECT CASE
    WHEN btrim(coalesce(p_raw, '')) ~ '^\d{1,3}\s*[-/ ]\s*\d{1,7}$'
      THEN lpad(ltrim(substring(btrim(p_raw) FROM '^(\d{1,3})'), '0'), 2, '0') || '-'
           || coalesce(nullif(ltrim(substring(btrim(p_raw) FROM '(\d{1,7})$'), '0'), ''), '0')
    WHEN btrim(coalesce(p_raw, '')) ~ '^\d{1,7}$'
      THEN coalesce(nullif(ltrim(btrim(p_raw), '0'), ''), '0')
  END
$fn$;

CREATE OR REPLACE FUNCTION public.shops_is_point(p_code text, p_name text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = public, pg_temp
AS $fn$
  SELECT coalesce(btrim(p_code), '') ~* '^поен' OR coalesce(btrim(p_name), '') ~* '^поен'
$fn$;

-- The units a goods line moves for warehouse p_wh: + into it, − out of it. 10005 (count difference)
-- by its VALUE: positive = shortage (stock down), negative = surplus (owner investigation 02.10.2026).
-- 10011 (the count list), corrections and unknown types move nothing.
CREATE OR REPLACE FUNCTION public.shops_doc_delta(p_type text, p_wh text, p_wh_in text, p_wh_out text,
                                                  p_qty_in numeric, p_qty_out numeric, p_value numeric, p_correction boolean)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = public, pg_temp
AS $fn$
  SELECT CASE
    WHEN coalesce(p_correction, false) OR p_wh IS NULL THEN 0
    WHEN p_type NOT IN ('10042', '10014', '10015', '10061', '10044', '10040', '10062', '10005') THEN 0
    WHEN p_wh IS DISTINCT FROM p_wh_in AND p_wh IS DISTINCT FROM p_wh_out THEN 0
    WHEN p_type = '10005' THEN
      -sign(coalesce(nullif(p_value, 0), nullif(coalesce(p_qty_out, 0) - coalesce(p_qty_in, 0), 0), 0))
        * greatest(abs(coalesce(p_qty_in, 0)), abs(coalesce(p_qty_out, 0)))
    ELSE (CASE WHEN p_wh_in = p_wh THEN coalesce(p_qty_in, 0) ELSE 0 END)
       - (CASE WHEN p_wh_out = p_wh THEN coalesce(p_qty_out, 0) ELSE 0 END)
  END
$fn$;

-- The checks of one shop-day against its controls.
CREATE OR REPLACE FUNCTION public.shops_control_recompute(p_day date)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE v_n integer;
BEGIN
  WITH r AS (
    SELECT l.shop_code,
           count(DISTINCT l.doc_number) FILTER (WHERE l.doc_type = '10022') AS receipts,
           round(sum(CASE WHEN l.is_return THEN -1 ELSE 1 END * coalesce(l.sale_value_mkd, 0)), 2) AS total
      FROM public.shop_sales_lines l
     WHERE l.sold_at >= (p_day::timestamp AT TIME ZONE 'Europe/Skopje')
       AND l.sold_at <  ((p_day + 1)::timestamp AT TIME ZONE 'Europe/Skopje')
     GROUP BY l.shop_code
  ), x AS (
    SELECT s.code, coalesce(r.receipts, 0) AS receipts, coalesce(r.total, 0) AS total,
           greatest(1, 0.5 * coalesce(r.receipts, 0)) AS tol
      FROM public.shops s LEFT JOIN r ON r.shop_code = s.code
  ), u AS (
    UPDATE public.shop_day_controls c
       SET receipts = x.receipts,
           receipts_total_mkd = x.total,
           tolerance_mkd = x.tol,
           diff_mkd = round(x.total - coalesce(c.report_total_mkd, c.tk_total_mkd), 2),
           ok = CASE WHEN c.report_total_mkd IS NULL AND c.tk_total_mkd IS NULL THEN NULL
                     ELSE (c.report_total_mkd IS NULL OR abs(x.total - c.report_total_mkd) <= x.tol)
                      AND (c.tk_total_mkd IS NULL OR abs(x.total - c.tk_total_mkd) <= x.tol) END,
           checked_at = now()
      FROM x
     WHERE c.day = p_day AND c.shop_code = x.code
    RETURNING 1
  )
  SELECT count(*) INTO v_n FROM u;
  RETURN v_n;
END
$fn$;

-- ── 9. the writers ──────────────────────────────────────────────────────────
-- Receipts / returns. p_days = the Skopje days read IN FULL for p_types: a document of those days and
-- types that the read no longer shows is removed (collabBox deleted it) — never on an empty read, and
-- never when more than half of a day would go (listed as suspicious instead).
CREATE OR REPLACE FUNCTION public.shops_ingest_sales(p_run uuid, p_lines jsonb, p_days date[] DEFAULT NULL,
                                                     p_types text[] DEFAULT ARRAY['10022', '10010'], p_dry boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_rows int := 0; v_bad int := 0; v_docs int := 0; v_written int := 0; v_trimmed int := 0;
  v_vanished int := 0; v_susp jsonb := '[]'::jsonb; v_day date; v_db int; v_gone text[]; v_seen int;
  v_days date[];
BEGIN
  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' THEN
    RAISE EXCEPTION 'shops_ingest_sales: p_lines must be a JSON array';
  END IF;
  CREATE TEMP TABLE IF NOT EXISTS _shops_sales_in (LIKE public.shop_sales_lines INCLUDING DEFAULTS) ON COMMIT DROP;
  TRUNCATE _shops_sales_in;
  INSERT INTO _shops_sales_in (doc_number, line_no, doc_type, shop_code, sold_at, article_code, article_id, article_name,
                               article_group, qty, unit_cost_mkd, unit_price_mkd, cost_value_mkd, sale_value_mkd, vat_rate,
                               cashier, is_return, is_point, named_customer, collabbox_object_id, run_id, read_at)
  SELECT btrim(x.doc_number), x.line_no, x.doc_type, x.shop_code, public.shops_skopje_ts(x.sold_at), btrim(x.article_code),
         nullif(btrim(x.article_id), ''), coalesce(nullif(btrim(x.article_name), ''), btrim(x.article_code)), nullif(btrim(x.article_group), ''),
         abs(x.qty), x.unit_cost_mkd, x.unit_price_mkd, x.cost_value_mkd, x.sale_value_mkd,
         CASE WHEN x.vat_rate >= 0 AND x.vat_rate < 1 THEN x.vat_rate END,
         nullif(btrim(x.cashier), ''), coalesce(x.is_return, x.doc_type = '10010'),
         public.shops_is_point(x.article_code, x.article_name), coalesce(x.named_customer, false),
         nullif(btrim(x.collabbox_object_id), ''), p_run, now()
    FROM jsonb_to_recordset(p_lines) AS x(doc_number text, line_no int, doc_type text, shop_code text, sold_at text,
           article_code text, article_id text, article_name text, article_group text, qty numeric, unit_cost_mkd numeric,
           unit_price_mkd numeric, cost_value_mkd numeric, sale_value_mkd numeric, vat_rate numeric, cashier text,
           is_return boolean, is_point boolean, named_customer boolean, collabbox_object_id text)
   WHERE nullif(btrim(x.doc_number), '') IS NOT NULL AND x.line_no > 0 AND x.doc_type IN ('10022', '10010')
     AND x.doc_type = ANY (p_types)
     AND EXISTS (SELECT 1 FROM public.shops s WHERE s.code = x.shop_code)
     AND public.shops_skopje_ts(x.sold_at) IS NOT NULL
     AND nullif(btrim(x.article_code), '') IS NOT NULL AND x.qty IS NOT NULL;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  v_bad := jsonb_array_length(p_lines) - v_rows;
  SELECT count(DISTINCT doc_number) INTO v_docs FROM _shops_sales_in;

  IF NOT p_dry THEN
    -- a document's lines as a whole: drop line numbers the read no longer has, upsert the rest
    DELETE FROM public.shop_sales_lines l
     USING (SELECT doc_number, max(line_no) AS n FROM _shops_sales_in GROUP BY doc_number) m
     WHERE l.doc_number = m.doc_number AND l.line_no > m.n;
    GET DIAGNOSTICS v_trimmed = ROW_COUNT;
    INSERT INTO public.shop_sales_lines AS t
    SELECT * FROM _shops_sales_in
    ON CONFLICT (doc_number, line_no) DO UPDATE SET
      doc_type = EXCLUDED.doc_type, shop_code = EXCLUDED.shop_code, sold_at = EXCLUDED.sold_at,
      article_code = EXCLUDED.article_code, article_id = EXCLUDED.article_id, article_name = EXCLUDED.article_name,
      article_group = EXCLUDED.article_group, qty = EXCLUDED.qty, unit_cost_mkd = EXCLUDED.unit_cost_mkd,
      unit_price_mkd = EXCLUDED.unit_price_mkd, cost_value_mkd = EXCLUDED.cost_value_mkd, sale_value_mkd = EXCLUDED.sale_value_mkd,
      vat_rate = coalesce(EXCLUDED.vat_rate, t.vat_rate), cashier = EXCLUDED.cashier, is_return = EXCLUDED.is_return,
      is_point = EXCLUDED.is_point, named_customer = EXCLUDED.named_customer, collabbox_object_id = EXCLUDED.collabbox_object_id,
      run_id = EXCLUDED.run_id, read_at = EXCLUDED.read_at;
    GET DIAGNOSTICS v_written = ROW_COUNT;
    -- the articles seen (name / group; the VAT comes from the stock read)
    INSERT INTO public.shop_articles AS a (article_code, article_id, name, group_name, is_point)
    SELECT DISTINCT ON (article_code) article_code, article_id, article_name, article_group, is_point
      FROM _shops_sales_in ORDER BY article_code, sold_at DESC
    ON CONFLICT (article_code) DO UPDATE SET
      article_id = coalesce(EXCLUDED.article_id, a.article_id), name = EXCLUDED.name,
      group_name = coalesce(a.group_name, EXCLUDED.group_name), is_point = EXCLUDED.is_point, last_seen_at = now();
  END IF;

  -- documents deleted in collabBox, per day read in full
  FOREACH v_day IN ARRAY coalesce(p_days, ARRAY[]::date[]) LOOP
    SELECT count(DISTINCT doc_number) INTO v_seen FROM _shops_sales_in
     WHERE sold_at >= (v_day::timestamp AT TIME ZONE 'Europe/Skopje') AND sold_at < ((v_day + 1)::timestamp AT TIME ZONE 'Europe/Skopje');
    SELECT count(DISTINCT doc_number), array_agg(DISTINCT doc_number) FILTER (WHERE NOT EXISTS (SELECT 1 FROM _shops_sales_in i WHERE i.doc_number = l.doc_number))
      INTO v_db, v_gone
      FROM public.shop_sales_lines l
     WHERE l.doc_type = ANY (p_types)
       AND l.sold_at >= (v_day::timestamp AT TIME ZONE 'Europe/Skopje') AND l.sold_at < ((v_day + 1)::timestamp AT TIME ZONE 'Europe/Skopje');
    IF coalesce(cardinality(v_gone), 0) = 0 THEN CONTINUE; END IF;
    IF v_seen = 0 OR cardinality(v_gone) > greatest(5, v_db / 2) THEN
      v_susp := v_susp || jsonb_build_object('day', v_day, 'in_db', v_db, 'read', v_seen, 'would_remove', cardinality(v_gone));
      CONTINUE;
    END IF;
    v_vanished := v_vanished + cardinality(v_gone);
    IF NOT p_dry THEN
      DELETE FROM public.shop_sales_lines WHERE doc_number = ANY (v_gone);
    END IF;
  END LOOP;

  -- the controls of the days touched
  IF NOT p_dry THEN
    SELECT array_agg(DISTINCT (sold_at AT TIME ZONE 'Europe/Skopje')::date) INTO v_days FROM _shops_sales_in;
    v_days := coalesce(v_days, ARRAY[]::date[]) || coalesce(p_days, ARRAY[]::date[]);
    FOREACH v_day IN ARRAY (SELECT coalesce(array_agg(DISTINCT d), ARRAY[]::date[]) FROM unnest(v_days) d) LOOP
      PERFORM public.shops_control_recompute(v_day);
    END LOOP;
  END IF;

  RETURN jsonb_build_object('rows', v_rows, 'rejected', v_bad, 'documents', v_docs, 'written', v_written,
                            'trimmed', v_trimmed, 'vanished_documents', v_vanished, 'suspicious_days', v_susp, 'dry', p_dry);
END
$fn$;

-- Goods documents. p_headers: [{doc_number, doc_type, doc_at, amount_mkd, natura_doc, author, collabbox_doc_id,
-- collabbox_object_id}]; p_lines: DocLineRow[] or NULL (lines not read → lines untouched). p_from / p_to /
-- p_types: the window read in full (vanished_at for what it no longer shows — same guard as the sales).
CREATE OR REPLACE FUNCTION public.shops_ingest_docs(p_run uuid, p_headers jsonb, p_lines jsonb, p_from date, p_to date,
                                                    p_types text[], p_dry boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_h int := 0; v_l int := 0; v_stub int := 0; v_trim int := 0; v_vanished int := 0; v_db int; v_gone text[];
  v_corr int := 0; v_susp jsonb := 'null'::jsonb;
  v_lo timestamptz := (p_from::timestamp AT TIME ZONE 'Europe/Skopje');
  v_hi timestamptz := ((p_to + 1)::timestamp AT TIME ZONE 'Europe/Skopje');
BEGIN
  IF p_headers IS NULL OR jsonb_typeof(p_headers) <> 'array' THEN
    RAISE EXCEPTION 'shops_ingest_docs: p_headers must be a JSON array';
  END IF;
  CREATE TEMP TABLE IF NOT EXISTS _shops_docs_in (LIKE public.shop_docs INCLUDING DEFAULTS) ON COMMIT DROP;
  CREATE TEMP TABLE IF NOT EXISTS _shops_doc_lines_in (LIKE public.shop_doc_lines INCLUDING DEFAULTS) ON COMMIT DROP;
  TRUNCATE _shops_docs_in; TRUNCATE _shops_doc_lines_in;

  INSERT INTO _shops_docs_in (doc_number, doc_type, wh_code, doc_at, amount_mkd, natura_doc, natura_doc_key, author,
                              collabbox_doc_id, collabbox_object_id, header_seen, run_id)
  SELECT DISTINCT ON (btrim(x.doc_number)) btrim(x.doc_number), x.doc_type, substring(btrim(x.doc_number) FROM '^(\d{3})-'),
         public.shops_skopje_ts(x.doc_at), x.amount_mkd, nullif(btrim(x.natura_doc), ''), public.shops_natura_doc_key(x.natura_doc),
         nullif(btrim(x.author), ''), nullif(btrim(x.collabbox_doc_id), ''), nullif(btrim(x.collabbox_object_id), ''), true, p_run
    FROM jsonb_to_recordset(p_headers) AS x(doc_number text, doc_type text, doc_at text, amount_mkd numeric, natura_doc text,
           author text, collabbox_doc_id text, collabbox_object_id text)
   WHERE nullif(btrim(x.doc_number), '') IS NOT NULL AND x.doc_type = ANY (p_types) AND public.shops_skopje_ts(x.doc_at) IS NOT NULL
   ORDER BY btrim(x.doc_number);
  GET DIAGNOSTICS v_h = ROW_COUNT;

  IF p_lines IS NOT NULL THEN
    INSERT INTO _shops_doc_lines_in (doc_number, line_no, doc_type, doc_at, wh_in, wh_out, article_code, article_id, article_name,
                                     article_group, qty_in, qty_out, unit_cost_mkd, unit_price_mkd, cost_value_mkd, sale_value_mkd,
                                     vat_rate, is_point, is_correction, run_id)
    SELECT btrim(x.doc_number), x.line_no, x.doc_type, public.shops_skopje_ts(x.doc_at), nullif(x.wh_in, ''), nullif(x.wh_out, ''),
           btrim(x.article_code), nullif(btrim(x.article_id), ''), coalesce(nullif(btrim(x.article_name), ''), btrim(x.article_code)),
           nullif(btrim(x.article_group), ''), coalesce(x.qty_in, 0), coalesce(x.qty_out, 0), x.unit_cost_mkd, x.unit_price_mkd,
           x.cost_value_mkd, x.sale_value_mkd, CASE WHEN x.vat_rate >= 0 AND x.vat_rate < 1 THEN x.vat_rate END,
           public.shops_is_point(x.article_code, x.article_name),
           -- a trade-book correction: a voucher priced like goods, or one unit with a huge price and no cost
           (public.shops_is_point(x.article_code, x.article_name) AND abs(coalesce(x.unit_price_mkd, 0)) > 100)
             OR (abs(coalesce(x.sale_value_mkd, 0)) >= 100000 AND abs(coalesce(x.cost_value_mkd, 0)) < 100
                 AND greatest(abs(coalesce(x.qty_in, 0)), abs(coalesce(x.qty_out, 0))) <= 1),
           p_run
      FROM jsonb_to_recordset(p_lines) AS x(doc_number text, line_no int, doc_type text, doc_at text, wh_in text, wh_out text,
             article_code text, article_id text, article_name text, article_group text, qty_in numeric, qty_out numeric,
             unit_cost_mkd numeric, unit_price_mkd numeric, cost_value_mkd numeric, sale_value_mkd numeric, vat_rate numeric)
     WHERE nullif(btrim(x.doc_number), '') IS NOT NULL AND x.line_no > 0 AND x.doc_type = ANY (p_types)
       AND public.shops_skopje_ts(x.doc_at) IS NOT NULL AND nullif(btrim(x.article_code), '') IS NOT NULL
       -- the price-list documents of 0,00 (17.148 automatic 10014 in a year) move nothing
       AND (coalesce(x.qty_in, 0) <> 0 OR coalesce(x.qty_out, 0) <> 0 OR coalesce(x.sale_value_mkd, 0) <> 0);
    GET DIAGNOSTICS v_l = ROW_COUNT;
    SELECT count(*) INTO v_corr FROM _shops_doc_lines_in WHERE is_correction;
    -- a line whose header was not in this read (and is not stored yet): a stub header from the line
    INSERT INTO _shops_docs_in (doc_number, doc_type, wh_code, doc_at, header_seen, run_id)
    SELECT DISTINCT ON (l.doc_number) l.doc_number, l.doc_type, substring(l.doc_number FROM '^(\d{3})-'), l.doc_at, false, p_run
      FROM _shops_doc_lines_in l
     WHERE NOT EXISTS (SELECT 1 FROM _shops_docs_in d WHERE d.doc_number = l.doc_number)
     ORDER BY l.doc_number, l.doc_at;
    GET DIAGNOSTICS v_stub = ROW_COUNT;
  END IF;

  IF NOT p_dry THEN
    INSERT INTO public.shop_docs AS t (doc_number, doc_type, wh_code, doc_at, amount_mkd, natura_doc, natura_doc_key, author,
                                       collabbox_doc_id, collabbox_object_id, header_seen, vanished_at, read_at, run_id)
    SELECT doc_number, doc_type, wh_code, doc_at, amount_mkd, natura_doc, natura_doc_key, author, collabbox_doc_id,
           collabbox_object_id, header_seen, NULL, now(), run_id
      FROM _shops_docs_in
    ON CONFLICT (doc_number) DO UPDATE SET
      doc_type = EXCLUDED.doc_type, wh_code = EXCLUDED.wh_code,
      doc_at = CASE WHEN EXCLUDED.header_seen OR NOT t.header_seen THEN EXCLUDED.doc_at ELSE t.doc_at END,
      amount_mkd = CASE WHEN EXCLUDED.header_seen THEN EXCLUDED.amount_mkd ELSE t.amount_mkd END,
      natura_doc = CASE WHEN EXCLUDED.header_seen THEN EXCLUDED.natura_doc ELSE t.natura_doc END,
      natura_doc_key = CASE WHEN EXCLUDED.header_seen THEN EXCLUDED.natura_doc_key ELSE t.natura_doc_key END,
      author = coalesce(EXCLUDED.author, t.author), collabbox_doc_id = coalesce(EXCLUDED.collabbox_doc_id, t.collabbox_doc_id),
      collabbox_object_id = coalesce(EXCLUDED.collabbox_object_id, t.collabbox_object_id),
      header_seen = t.header_seen OR EXCLUDED.header_seen, vanished_at = NULL, read_at = now(), run_id = EXCLUDED.run_id;
    IF p_lines IS NOT NULL THEN
      -- documents read with their lines: replace them as a whole (a header with no line left keeps none)
      DELETE FROM public.shop_doc_lines l
       WHERE l.doc_number IN (SELECT doc_number FROM _shops_docs_in)
         AND NOT EXISTS (SELECT 1 FROM _shops_doc_lines_in i WHERE i.doc_number = l.doc_number AND i.line_no = l.line_no);
      GET DIAGNOSTICS v_trim = ROW_COUNT;
      INSERT INTO public.shop_doc_lines AS t
      SELECT doc_number, line_no, doc_type, doc_at, wh_in, wh_out, article_code, article_id, article_name, article_group,
             qty_in, qty_out, unit_cost_mkd, unit_price_mkd, cost_value_mkd, sale_value_mkd, vat_rate, is_point, is_correction,
             run_id, now()
        FROM _shops_doc_lines_in
      ON CONFLICT (doc_number, line_no) DO UPDATE SET
        doc_type = EXCLUDED.doc_type, doc_at = EXCLUDED.doc_at, wh_in = EXCLUDED.wh_in, wh_out = EXCLUDED.wh_out,
        article_code = EXCLUDED.article_code, article_id = EXCLUDED.article_id, article_name = EXCLUDED.article_name,
        article_group = EXCLUDED.article_group, qty_in = EXCLUDED.qty_in, qty_out = EXCLUDED.qty_out,
        unit_cost_mkd = EXCLUDED.unit_cost_mkd, unit_price_mkd = EXCLUDED.unit_price_mkd, cost_value_mkd = EXCLUDED.cost_value_mkd,
        sale_value_mkd = EXCLUDED.sale_value_mkd, vat_rate = coalesce(EXCLUDED.vat_rate, t.vat_rate), is_point = EXCLUDED.is_point,
        is_correction = EXCLUDED.is_correction, run_id = EXCLUDED.run_id, read_at = now();
      INSERT INTO public.shop_articles AS a (article_code, article_id, name, group_name, is_point)
      SELECT DISTINCT ON (article_code) article_code, article_id, article_name, article_group, is_point
        FROM _shops_doc_lines_in ORDER BY article_code, doc_at DESC
      ON CONFLICT (article_code) DO UPDATE SET
        article_id = coalesce(EXCLUDED.article_id, a.article_id), name = EXCLUDED.name,
        group_name = coalesce(a.group_name, EXCLUDED.group_name), last_seen_at = now();
    END IF;
  END IF;

  -- documents deleted in collabBox inside the window read in full (only with a non-empty header read)
  IF v_h > 0 THEN
    SELECT count(*), array_agg(d.doc_number) FILTER (WHERE NOT EXISTS (SELECT 1 FROM _shops_docs_in i WHERE i.doc_number = d.doc_number AND i.header_seen))
      INTO v_db, v_gone
      FROM public.shop_docs d
     WHERE d.doc_type = ANY (p_types) AND d.doc_at >= v_lo AND d.doc_at < v_hi AND d.vanished_at IS NULL AND d.header_seen;
    IF coalesce(cardinality(v_gone), 0) > 0 THEN
      IF cardinality(v_gone) > greatest(5, v_db / 2) THEN
        v_susp := jsonb_build_object('in_db', v_db, 'read', v_h, 'would_mark', cardinality(v_gone));
      ELSE
        v_vanished := cardinality(v_gone);
        IF NOT p_dry THEN
          UPDATE public.shop_docs SET vanished_at = now() WHERE doc_number = ANY (v_gone);
        END IF;
      END IF;
    END IF;
  END IF;

  RETURN jsonb_build_object('headers', v_h, 'lines', v_l, 'stub_headers', v_stub, 'lines_removed', v_trim,
                            'corrections', v_corr, 'vanished', v_vanished, 'suspicious', v_susp, 'dry', p_dry);
END
$fn$;

-- The nightly stock of ONE shop (infollc). p_rows: [{article_code, article_id, article_name, group, unit, avg_cost,
-- qty, reserved, available, value, retail_price, vat_rate}] — every article listed (zero rows feed the VAT and
-- names; only non-zero rows are stored as snapshot rows).
CREATE OR REPLACE FUNCTION public.shops_ingest_stock(p_run uuid, p_shop text, p_taken_at timestamptz, p_as_of date,
                                                     p_rows jsonb, p_dry boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE v_rows int; v_kept int; v_units numeric; v_vat int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.shops WHERE code = p_shop) THEN RAISE EXCEPTION 'shops_ingest_stock: unknown shop %', p_shop; END IF;
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN RAISE EXCEPTION 'shops_ingest_stock: p_rows must be a JSON array'; END IF;
  CREATE TEMP TABLE IF NOT EXISTS _shops_stock_in (
    article_code text, article_id text, article_name text, grp text, unit text, avg_cost numeric, qty numeric,
    reserved numeric, available numeric, val numeric, retail numeric, vat numeric) ON COMMIT DROP;
  TRUNCATE _shops_stock_in;
  INSERT INTO _shops_stock_in
  SELECT DISTINCT ON (btrim(x.article_code)) btrim(x.article_code), nullif(btrim(x.article_id), ''),
         coalesce(nullif(btrim(x.article_name), ''), btrim(x.article_code)), nullif(btrim(x."group"), ''), nullif(btrim(x.unit), ''),
         x.avg_cost, coalesce(x.qty, 0), coalesce(x.reserved, 0), x.available, x.value, x.retail_price,
         CASE WHEN x.vat_rate >= 0 AND x.vat_rate < 1 THEN x.vat_rate END
    FROM jsonb_to_recordset(p_rows) AS x(article_code text, article_id text, article_name text, "group" text, unit text,
           avg_cost numeric, qty numeric, reserved numeric, available numeric, value numeric, retail_price numeric, vat_rate numeric)
   WHERE nullif(btrim(x.article_code), '') IS NOT NULL
   ORDER BY btrim(x.article_code), coalesce(x.qty, 0) DESC;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  SELECT count(*) FILTER (WHERE qty <> 0 OR reserved <> 0), coalesce(sum(qty) FILTER (WHERE NOT public.shops_is_point(article_code, article_name)), 0),
         count(*) FILTER (WHERE vat IS NOT NULL)
    INTO v_kept, v_units, v_vat FROM _shops_stock_in;
  IF NOT p_dry THEN
    INSERT INTO public.shop_articles AS a (article_code, article_id, name, group_name, unit, vat_rate, vat_seen_at, is_point)
    SELECT article_code, article_id, article_name, grp, unit, vat, CASE WHEN vat IS NOT NULL THEN p_taken_at END,
           public.shops_is_point(article_code, article_name)
      FROM _shops_stock_in
    ON CONFLICT (article_code) DO UPDATE SET
      article_id = coalesce(EXCLUDED.article_id, a.article_id), name = EXCLUDED.name,
      group_name = coalesce(EXCLUDED.group_name, a.group_name), unit = coalesce(EXCLUDED.unit, a.unit),
      vat_rate = CASE WHEN EXCLUDED.vat_rate IS NOT NULL AND (a.vat_seen_at IS NULL OR a.vat_seen_at <= EXCLUDED.vat_seen_at)
                      THEN EXCLUDED.vat_rate ELSE a.vat_rate END,
      vat_seen_at = CASE WHEN EXCLUDED.vat_rate IS NOT NULL AND (a.vat_seen_at IS NULL OR a.vat_seen_at <= EXCLUDED.vat_seen_at)
                         THEN EXCLUDED.vat_seen_at ELSE a.vat_seen_at END,
      is_point = EXCLUDED.is_point, last_seen_at = now();
    INSERT INTO public.shop_stock_takes AS t (taken_at, shop_code, source, as_of, articles, units, run_id)
    VALUES (p_taken_at, p_shop, 'infollc', p_as_of, v_kept, v_units, p_run)
    ON CONFLICT (taken_at, shop_code) DO UPDATE SET source = 'infollc', as_of = EXCLUDED.as_of, articles = EXCLUDED.articles,
      units = EXCLUDED.units, run_id = EXCLUDED.run_id;
    DELETE FROM public.shop_stock_snapshots WHERE taken_at = p_taken_at AND shop_code = p_shop;
    INSERT INTO public.shop_stock_snapshots (taken_at, shop_code, article_code, qty, reserved, available, avg_cost_mkd,
                                             retail_price_mkd, value_mkd, vat_rate, source, run_id)
    SELECT p_taken_at, p_shop, article_code, qty, reserved, available, avg_cost, retail, val, vat, 'infollc', p_run
      FROM _shops_stock_in WHERE qty <> 0 OR reserved <> 0;
  END IF;
  RETURN jsonb_build_object('shop', p_shop, 'articles', v_rows, 'kept', v_kept, 'units', v_units, 'with_vat', v_vat, 'dry', p_dry);
END
$fn$;

-- One closed period of ONE shop (lnp). Also a take 'lnp' at the end of p_to (its closing stock), so the
-- stock of any past moment has a basis.
CREATE OR REPLACE FUNCTION public.shops_ingest_periods(p_run uuid, p_shop text, p_from date, p_to date, p_rows jsonb,
                                                       p_dry boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE v_rows int; v_units numeric; v_take timestamptz := ((p_to + 1)::timestamp AT TIME ZONE 'Europe/Skopje') - interval '1 millisecond';
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.shops WHERE code = p_shop) THEN RAISE EXCEPTION 'shops_ingest_periods: unknown shop %', p_shop; END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_from > p_to THEN RAISE EXCEPTION 'shops_ingest_periods: bad period'; END IF;
  CREATE TEMP TABLE IF NOT EXISTS _shops_period_in (
    article_code text, article_name text, grp text, opening_qty numeric, opening_value numeric, in_purchase numeric,
    in_transfer numeric, out_sales numeric, out_transfer numeric, closing_qty numeric, closing_value numeric,
    avg_cost numeric, closing_retail numeric) ON COMMIT DROP;
  TRUNCATE _shops_period_in;
  INSERT INTO _shops_period_in
  SELECT btrim(x.article_code), coalesce(nullif(btrim(x.article_name), ''), btrim(x.article_code)), nullif(btrim(x.subgroup), ''),
         coalesce(sum(x.opening_qty), 0), sum(x.opening_value), coalesce(sum(x.in_purchase), 0), coalesce(sum(x.in_transfer), 0),
         coalesce(sum(x.out_sales), 0), coalesce(sum(x.out_transfer), 0), coalesce(sum(x.closing_qty), 0), sum(x.closing_value),
         max(x.avg_cost), sum(x.closing_retail)
    FROM jsonb_to_recordset(p_rows) AS x(article_code text, article_name text, subgroup text, opening_qty numeric, opening_value numeric,
           in_purchase numeric, in_transfer numeric, out_sales numeric, out_transfer numeric, closing_qty numeric,
           closing_value numeric, avg_cost numeric, closing_retail numeric)
   WHERE nullif(btrim(x.article_code), '') IS NOT NULL
   GROUP BY 1, 2, 3;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  SELECT coalesce(sum(closing_qty) FILTER (WHERE NOT public.shops_is_point(article_code, article_name)), 0) INTO v_units FROM _shops_period_in;
  IF NOT p_dry THEN
    DELETE FROM public.shop_stock_periods WHERE shop_code = p_shop AND period_from = p_from AND period_to = p_to;
    INSERT INTO public.shop_stock_periods (shop_code, period_from, period_to, article_code, opening_qty, in_purchase, in_transfer,
                                           out_sales, out_transfer, closing_qty, opening_value_mkd, closing_value_mkd, avg_cost_mkd,
                                           closing_retail_mkd, run_id)
    SELECT p_shop, p_from, p_to, article_code, opening_qty, in_purchase, in_transfer, out_sales, out_transfer, closing_qty,
           opening_value, closing_value, avg_cost, closing_retail, p_run
      FROM _shops_period_in;
    INSERT INTO public.shop_articles AS a (article_code, name, group_name, is_point)
    SELECT article_code, article_name, grp, public.shops_is_point(article_code, article_name) FROM _shops_period_in
    ON CONFLICT (article_code) DO UPDATE SET group_name = coalesce(a.group_name, EXCLUDED.group_name), last_seen_at = now();
    -- the closing stock as a take, unless a nightly read already exists at that very instant
    IF p_to < (now() AT TIME ZONE 'Europe/Skopje')::date
       AND NOT EXISTS (SELECT 1 FROM public.shop_stock_takes WHERE taken_at = v_take AND shop_code = p_shop AND source = 'infollc') THEN
      INSERT INTO public.shop_stock_takes AS t (taken_at, shop_code, source, as_of, articles, units, run_id)
      VALUES (v_take, p_shop, 'lnp', p_to, (SELECT count(*) FROM _shops_period_in WHERE closing_qty <> 0), v_units, p_run)
      ON CONFLICT (taken_at, shop_code) DO UPDATE SET articles = EXCLUDED.articles, units = EXCLUDED.units, run_id = EXCLUDED.run_id;
      DELETE FROM public.shop_stock_snapshots WHERE taken_at = v_take AND shop_code = p_shop;
      INSERT INTO public.shop_stock_snapshots (taken_at, shop_code, article_code, qty, reserved, available, avg_cost_mkd,
                                               retail_price_mkd, value_mkd, source, run_id)
      SELECT v_take, p_shop, article_code, closing_qty, 0, closing_qty, avg_cost,
             CASE WHEN closing_qty <> 0 THEN round(closing_retail / closing_qty, 4) END, closing_value, 'lnp', p_run
        FROM _shops_period_in WHERE closing_qty <> 0;
    END IF;
  END IF;
  RETURN jsonb_build_object('shop', p_shop, 'from', p_from, 'to', p_to, 'articles', v_rows, 'closing_units', v_units, 'dry', p_dry);
END
$fn$;

-- The day's controls: p_rows = [{shop_code, report_total_mkd, report_doc, tk_total_mkd, cash_mkd, card_mkd}].
-- A value the read did not have (NULL) keeps the stored one.
CREATE OR REPLACE FUNCTION public.shops_ingest_controls(p_run uuid, p_day date, p_rows jsonb, p_dry boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE v_rows int; v_checked int := 0; v_bad int;
BEGIN
  IF p_day IS NULL OR p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN RAISE EXCEPTION 'shops_ingest_controls: p_day and a JSON array'; END IF;
  SELECT count(*) INTO v_rows FROM jsonb_array_elements(p_rows) e WHERE EXISTS (SELECT 1 FROM public.shops s WHERE s.code = e->>'shop_code');
  IF NOT p_dry THEN
    INSERT INTO public.shop_day_controls AS c (day, shop_code, report_total_mkd, report_doc, tk_total_mkd, cash_mkd, card_mkd, run_id)
    SELECT p_day, x.shop_code, x.report_total_mkd, nullif(btrim(x.report_doc), ''), x.tk_total_mkd, x.cash_mkd, x.card_mkd, p_run
      FROM jsonb_to_recordset(p_rows) AS x(shop_code text, report_total_mkd numeric, report_doc text, tk_total_mkd numeric,
             cash_mkd numeric, card_mkd numeric)
     WHERE EXISTS (SELECT 1 FROM public.shops s WHERE s.code = x.shop_code)
    ON CONFLICT (day, shop_code) DO UPDATE SET
      report_total_mkd = coalesce(EXCLUDED.report_total_mkd, c.report_total_mkd), report_doc = coalesce(EXCLUDED.report_doc, c.report_doc),
      tk_total_mkd = coalesce(EXCLUDED.tk_total_mkd, c.tk_total_mkd), cash_mkd = coalesce(EXCLUDED.cash_mkd, c.cash_mkd),
      card_mkd = coalesce(EXCLUDED.card_mkd, c.card_mkd), run_id = EXCLUDED.run_id;
    v_checked := public.shops_control_recompute(p_day);
  END IF;
  SELECT count(*) INTO v_bad FROM public.shop_day_controls WHERE day = p_day AND ok = false;
  RETURN jsonb_build_object('day', p_day, 'rows', v_rows, 'checked', v_checked, 'mismatches', v_bad, 'dry', p_dry);
END
$fn$;

-- Keeps 62 days of nightly takes, then only the last take of each shop and month (and every lnp take).
CREATE OR REPLACE FUNCTION public.shops_snapshots_prune(p_keep_days integer DEFAULT 62)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE v_n int;
BEGIN
  WITH keep AS (
    SELECT DISTINCT ON (shop_code, date_trunc('month', taken_at AT TIME ZONE 'Europe/Skopje')) taken_at, shop_code
      FROM public.shop_stock_takes WHERE source = 'infollc'
     ORDER BY shop_code, date_trunc('month', taken_at AT TIME ZONE 'Europe/Skopje'), taken_at DESC
  ), d AS (
    DELETE FROM public.shop_stock_takes t
     WHERE t.source = 'infollc' AND t.taken_at < now() - make_interval(days => greatest(p_keep_days, 14))
       AND NOT EXISTS (SELECT 1 FROM keep k WHERE k.taken_at = t.taken_at AND k.shop_code = t.shop_code)
    RETURNING 1
  )
  SELECT count(*) INTO v_n FROM d;
  RETURN jsonb_build_object('takes_removed', v_n);
END
$fn$;

-- ── 10. grants ──────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.shops_control_recompute(date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.shops_ingest_sales(uuid, jsonb, date[], text[], boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.shops_ingest_docs(uuid, jsonb, jsonb, date, date, text[], boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.shops_ingest_stock(uuid, text, timestamptz, date, jsonb, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.shops_ingest_periods(uuid, text, date, date, jsonb, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.shops_ingest_controls(uuid, date, jsonb, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.shops_snapshots_prune(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.shops_control_recompute(date) TO service_role;
GRANT EXECUTE ON FUNCTION public.shops_ingest_sales(uuid, jsonb, date[], text[], boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.shops_ingest_docs(uuid, jsonb, jsonb, date, date, text[], boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.shops_ingest_stock(uuid, text, timestamptz, date, jsonb, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.shops_ingest_periods(uuid, text, date, date, jsonb, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.shops_ingest_controls(uuid, date, jsonb, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.shops_snapshots_prune(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.shops_skopje_ts(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.shops_natura_doc_key(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.shops_is_point(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.shops_doc_delta(text, text, text, text, numeric, numeric, numeric, boolean) TO service_role;
DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_read_only_user') THEN
    GRANT EXECUTE ON FUNCTION public.shops_skopje_ts(text) TO supabase_read_only_user;
    GRANT EXECUTE ON FUNCTION public.shops_natura_doc_key(text) TO supabase_read_only_user;
    GRANT EXECUTE ON FUNCTION public.shops_is_point(text, text) TO supabase_read_only_user;
    GRANT EXECUTE ON FUNCTION public.shops_doc_delta(text, text, text, text, numeric, numeric, numeric, boolean) TO supabase_read_only_user;
  END IF;
END
$grant$;

COMMENT ON FUNCTION public.shops_ingest_sales(uuid, jsonb, date[], text[], boolean) IS
  'collabbox-shops writer: 10022 / 10010 lines (SalesLineRow, shops.ts) → shop_sales_lines, a document''s lines replaced as a whole; documents of p_days × p_types the read no longer shows are removed (never on an empty read or > half a day — listed as suspicious_days); shop_articles names; the controls of the touched days recomputed. Idempotent. service_role only. Migration 20260946000100.';
COMMENT ON FUNCTION public.shops_ingest_docs(uuid, jsonb, jsonb, date, date, text[], boolean) IS
  'collabbox-shops writer: goods-document headers (+ Natura''s number) and lines (DocLineRow) → shop_docs / shop_doc_lines (replaced per document; trade-book corrections flagged; 0,00 price-list lines skipped); documents of the window no longer in collabBox → vanished_at (guarded). service_role only. Migration 20260946000100.';
COMMENT ON FUNCTION public.shops_ingest_stock(uuid, text, timestamptz, date, jsonb, boolean) IS
  'collabbox-shops writer: one shop''s infollc stock → shop_stock_takes + shop_stock_snapshots (non-zero rows) + shop_articles (name, group, the VAT % of every listed article). service_role only. Migration 20260946000100.';
COMMENT ON FUNCTION public.shops_ingest_periods(uuid, text, date, date, jsonb, boolean) IS
  'collabbox-shops writer: one shop''s lnp period → shop_stock_periods; a closed period''s closing stock also becomes an ''lnp'' take at the last instant of p_to. service_role only. Migration 20260946000100.';
COMMENT ON FUNCTION public.shops_ingest_controls(uuid, date, jsonb, boolean) IS
  'collabbox-shops writer: the 10018 daily reports and the trade book per shop for a day → shop_day_controls, then shops_control_recompute(day). service_role only. Migration 20260946000100.';
COMMENT ON FUNCTION public.shops_doc_delta(text, text, text, text, numeric, numeric, numeric, boolean) IS
  'The units a shop goods line moves for warehouse p_wh: + into it, − out of it; 10005 count differences by their value (positive = shortage = down); 10011 count lists, trade-book corrections and other types: 0. Migration 20260946000100.';

COMMIT;

NOTIFY pgrst, 'reload schema';
