-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 20260945000650 — Stock v2: the Sigma ingest (owner decisions 01.10.2026; contract docs/STOCK-V2.md §"Sigma ingest")
--
-- New goods are entered in SIGMA (production receipts and transfers into Главен магацин 04, purchases, sales to the
-- shops, exports, Labs, B2B, write-offs). They reach the CRM as a SigmaBatch (src/lib/stockV2Types.ts): first as
-- a CSV export (docs/stock/build_sigma_stock.py → exports/stock/sigma-batch-since-2209.json), later from the
-- office connector (tools/sigma-connector) through POST /api/stock/sigma/ingest (HMAC). Both send the SAME shape;
-- the shared field list is tools/sigma-connector/sigma-fields.json.
--
-- What leaves in a parcel is NOT taken from Sigma (the monthly MEX invoice is late and hand-typed) — so the MEX
-- invoices (client 000217), АД Астра (000549) and the 04↔08 transfers are excluded HERE, server-side, by rules
-- (stock_sigma_rules) and by the document type (stock_sigma_doc_types.include). The staging keeps every document
-- it is sent, with its reason; nothing is ever deleted, a document that disappears from Sigma is `vanished`.
--
-- This migration adds (the tables are created DARK by 20260945000100_stock_v2_schema.sql):
--   1. stock_sigma_doc_types seed — every Sigma document type of DocType.csv (30.09.2026): direction, ledger kind,
--      include (only the posted stock layer moves stock; work / invoice layers and service documents never do).
--   2. stock_sigma_rules seed — 000217, 000549, transfers between Ф00001-04 and Ф00001-08 (idempotent).
--   3. helpers: stock_sigma_company_name(), stock_sigma_norm_lines(), stock_sigma_rule_matches(),
--      stock_sigma_doc_exclusion(), stock_sigma_docs_reclassify(), stock_sigma_line_kind().
--   4. stock_sigma_ingest(p_batch jsonb) — the writer (whitelist, idempotent batch id, versions, vanish, items,
--      balances, costs_follow, apply on ingest).
--   5. stock_sigma_rule_set(p_row jsonb, p_actor uuid) — the audited rule writer (owners, through the api).
--   6. stock_sigma_effective_lines(p_from date) — the included Sigma lines as warehouse moves (the quantities
--      stock_v2_desired() books, with the refined kind label).
--   7. stock_sigma_status() — GET stock/v2/sigma/status.
--   8. trg_stock_sigma_rules_reclassify / trg_stock_sigma_doc_types_reclassify — excluded_reason follows every
--      rule / type change, whoever writes it (this writer or stock_v2_config_set of 0400).
--
-- LINE SEMANTICS (sigma-fields.json `sign_rule`, proven against StockObject on 9.126 keys): a document line is
-- {item_code, qty, side}. side 'out' = the From object (company_from-object_from), effect −qty; side 'in' = the
-- To object, effect +qty. qty keeps Sigma's sign, so a customer return (ПМ4, side out, qty < 0) ADDS stock, a
-- production input (ММ2, side in, qty < 0) REMOVES it, and a transfer carries both sides with the same qty.
--
-- Times: Sigma stamps local server time (Europe/Skopje); a document's event time is its date at 12:00 Skopje.
-- Safety: every function is SECURITY DEFINER, search_path = public, EXECUTE for service_role only (the status
-- report also for supabase_read_only_user). Writes set the transaction-local GUC elyon.stock_write = 'on'.
-- The connector has no human actor (audit_log.actor_id is NOT NULL): stock_sigma_batches IS its audit record.
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 0. drift guard: the contract's staging columns must exist ───────────────────────────────────────────────
DO $guard$
DECLARE
  v_missing text;
BEGIN
  SELECT string_agg(v.t || '.' || v.c, ', ' ORDER BY v.t, v.c) INTO v_missing
    FROM (VALUES
      ('stock_sigma_batches', 'batch_id'), ('stock_sigma_batches', 'source'), ('stock_sigma_batches', 'mode'),
      ('stock_sigma_batches', 'exported_at'), ('stock_sigma_batches', 'window_from'), ('stock_sigma_batches', 'window_to'),
      ('stock_sigma_batches', 'counts'), ('stock_sigma_batches', 'result'), ('stock_sigma_batches', 'received_at'),
      ('stock_sigma_docs', 'doc_key'), ('stock_sigma_docs', 'wyear'), ('stock_sigma_docs', 'doc_type'),
      ('stock_sigma_docs', 'doc_no'), ('stock_sigma_docs', 'doc_date'), ('stock_sigma_docs', 'posted_at'),
      ('stock_sigma_docs', 'created_at_sigma'), ('stock_sigma_docs', 'created_by'), ('stock_sigma_docs', 'last_change_by'),
      ('stock_sigma_docs', 'status'), ('stock_sigma_docs', 'company_from'), ('stock_sigma_docs', 'object_from'),
      ('stock_sigma_docs', 'company_to'), ('stock_sigma_docs', 'object_to'), ('stock_sigma_docs', 'client_code'),
      ('stock_sigma_docs', 'client_name'), ('stock_sigma_docs', 'lines'), ('stock_sigma_docs', 'content_hash'),
      ('stock_sigma_docs', 'versions'), ('stock_sigma_docs', 'first_seen_at'), ('stock_sigma_docs', 'last_seen_at'),
      ('stock_sigma_docs', 'last_changed_at'), ('stock_sigma_docs', 'vanished_at'), ('stock_sigma_docs', 'excluded_reason'),
      ('stock_sigma_doc_versions', 'doc_key'), ('stock_sigma_doc_versions', 'version'), ('stock_sigma_doc_versions', 'doc_date'),
      ('stock_sigma_doc_versions', 'content_hash'), ('stock_sigma_doc_versions', 'lines'), ('stock_sigma_doc_versions', 'seen_at'),
      ('stock_sigma_doc_types', 'doc_type'), ('stock_sigma_doc_types', 'name'), ('stock_sigma_doc_types', 'direction'),
      ('stock_sigma_doc_types', 'ledger_kind'), ('stock_sigma_doc_types', 'include'),
      ('stock_sigma_rules', 'id'), ('stock_sigma_rules', 'match'), ('stock_sigma_rules', 'action'),
      ('stock_sigma_rules', 'reason'), ('stock_sigma_rules', 'active'), ('stock_sigma_rules', 'set_by'), ('stock_sigma_rules', 'set_at'),
      ('stock_sigma_balances', 'taken_at'), ('stock_sigma_balances', 'company'), ('stock_sigma_balances', 'object'),
      ('stock_sigma_balances', 'item_code'), ('stock_sigma_balances', 'wyear'), ('stock_sigma_balances', 'qty'),
      ('stock_sigma_balances', 'calc_buy_price'),
      ('stock_sigma_drafts', 'doc_key'), ('stock_sigma_drafts', 'doc_date'), ('stock_sigma_drafts', 'object_from'),
      ('stock_sigma_drafts', 'object_to'), ('stock_sigma_drafts', 'lines'), ('stock_sigma_drafts', 'seen_at'),
      ('stock_articles', 'code'), ('stock_articles', 'name'), ('stock_articles', 'unit'), ('stock_articles', 'sigma_class'),
      ('stock_articles', 'brand'), ('stock_articles', 'is_set'), ('stock_articles', 'active'), ('stock_articles', 'source'),
      ('stock_articles', 'last_seen_export'),
      ('stock_article_costs', 'article_code'), ('stock_article_costs', 'cost_mkd'), ('stock_article_costs', 'valid_from'),
      ('stock_article_costs', 'source'), ('stock_article_costs', 'basis'), ('stock_article_costs', 'source_ref'),
      ('stock_article_costs', 'flags'), ('stock_article_costs', 'recorded_at'),
      ('stock_warehouses', 'id'), ('stock_warehouses', 'code'), ('stock_warehouses', 'role'), ('stock_warehouses', 'sigma_moves_from'),
      ('stock_warehouse_keys', 'system'), ('stock_warehouse_keys', 'key'), ('stock_warehouse_keys', 'warehouse_id')
    ) AS v(t, c)
   WHERE NOT EXISTS (SELECT 1 FROM information_schema.columns ic
                      WHERE ic.table_schema = 'public' AND ic.table_name = v.t AND ic.column_name = v.c);
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION '20260945000650 needs the Stock v2 schema (20260945000100) — missing: %', v_missing;
  END IF;
  IF to_regprocedure('public.stock_v2_sigma_object(text,text)') IS NULL THEN
    RAISE EXCEPTION '20260945000650 needs stock_v2_sigma_object() of 20260945000300';
  END IF;
END
$guard$;

-- ── 1. document types (Sigma DocType.csv, export of 30.09.2026) ─────────────────────────────────────────────
-- direction: DocType.TransferDoc = 1 → transfer; InOut I… → in; O… → out.
-- ledger_kind (stock_sigma_doc_types_kind_check of 20260945000100; stock_v2_desired() of 0300 reads it):
--   transfer types → transfer_out (the engine moves a transfer by direction: transfer_out / transfer_in)
--   ММ2 / МН2      → production_in (the output, qty > 0); its inputs (qty < 0) are production_use
--   ПМ1 ПМ2 ПМ9    → b2b_out; НМ4 (return to supplier) → b2b_out; П09 ПМ100 → shop_out; ПМ15 → export_out
--   ПМ4 ПМ11       → b2b_return_in; ПМ101 → shop_return_in; НМ1 НМ2 НМ5 НМ9 Н01 Н08 НМ8 (surplus) → receipt
--   ПМ12 ПМ14 ПМ8 (shortage) → writeoff
-- stock_sigma_line_kind() refines a line further: the client 000001 НАТУРА ТЕРАПИ СТОРЕС (the shops company) makes
-- a b2b sale / return a shop_out / shop_return_in, a transfer INTO a write-off warehouse (Ф00001-11) is "writeoff"
-- on the From side, and an ММ2 input is production_use. (The kinds only label a move; the quantities and
-- warehouses are the same either way.)
-- include: only the POSTED stock layer (InventoryHead: НМ*, ТМ*, ММ2, ПМ*) moves stock. Work documents (ПН*, НН*,
-- ТН*, МН2 — drafts are "најавено"), invoices (ПФ*, НФ*, МФ*), service documents (ПМ6, НН10, НН6) and the 2021
-- opening (НМ0) never do; their ledger_kind is kept for display.
INSERT INTO public.stock_sigma_doc_types (doc_type, name, direction, ledger_kind, include) VALUES
  ('НН0', 'Почетна состојба', 'in', NULL, false),
  ('НМ0', 'Почетна состојба', 'in', 'receipt', false),
  ('ПН5', 'Профактура', 'out', NULL, false),
  ('ТН1', 'Пренос', 'transfer', 'transfer_out', false),
  ('ТМ1', 'Пренос', 'transfer', 'transfer_out', true),
  ('НН1', 'Набавка од доб. по фактура', 'in', 'receipt', false),
  ('НМ1', 'Набавка од доб. по фактура', 'in', 'receipt', true),
  ('НФ1', 'Набавка од доб. по фактура', 'in', NULL, false),
  ('НФ1*', 'Набавка од доб. по фактура', 'in', NULL, false),
  ('НН2', 'Набавка од доб. по испратница', 'in', 'receipt', false),
  ('НМ2', 'Набавка од доб. по испратница', 'in', 'receipt', true),
  ('НФ2', 'Набавка од доб.по испратница', 'in', NULL, false),
  ('НФ2*', 'Набавка од доб.по испратница', 'in', NULL, false),
  ('НН3', 'Групна вл. фактура', 'in', NULL, false),
  ('НФ3', 'Групна вл. фактура', 'in', NULL, false),
  ('НН4', 'Поврат кон добавувач', 'in', 'b2b_out', false),
  ('НН5', 'Прием од увоз', 'in', 'receipt', false),
  ('НМ4', 'Поврат кон добавувач', 'in', 'b2b_out', true),
  ('НФ4', 'Поврат кон добавувач', 'in', NULL, false),
  ('НМ5', 'Прием од увоз', 'in', 'receipt', true),
  ('НФ5', 'Прием од увоз', 'in', NULL, false),
  ('ПН3', 'Фактура од Испратница', 'out', NULL, false),
  ('П09', 'Испратница од продавница', 'out', 'shop_out', true),
  ('Н01', 'Прием од добавува по фактура', 'in', 'receipt', true),
  ('ПН4', 'Повратница', 'out', 'b2b_return_in', false),
  ('ПФ4', 'Повратница', 'out', NULL, false),
  ('Н08', 'Прием од добавува по испратница', 'in', 'receipt', true),
  ('ПН6', 'Фактура за услуги', 'out', NULL, false),
  ('НН6', 'Зависни трошоци од увоз', 'in', NULL, false),
  ('ПН1', 'Излезна Фактура', 'out', 'b2b_out', false),
  ('ПМ1', 'Излезна фактруа', 'out', 'b2b_out', true),
  ('ПФ1', 'Фактура', 'out', NULL, false),
  ('НФ3*', 'Групна вл. фактура', 'in', NULL, false),
  ('НФ4*', 'Поврат кон добавувач', 'in', NULL, false),
  ('ТМ2', 'Преносница помеѓу објекти', 'transfer', 'transfer_out', true),
  ('НФ9', 'Приемница', 'in', NULL, false),
  ('ПФ7', 'Авансна фактура', 'out', NULL, false),
  ('ПН11', 'Сторно испратница', 'out', 'b2b_return_in', false),
  ('ПН7', 'Авансна фактура', 'out', NULL, false),
  ('НФ0', 'Почетна состојба', 'in', NULL, false),
  ('НН9', 'Приемница', 'in', 'receipt', false),
  ('НМ9', 'Приемница', 'in', 'receipt', true),
  ('ПМ11', 'Сторно испратница', 'out', 'b2b_return_in', true),
  ('ПН12', 'Сопствени Потреби', 'out', 'writeoff', false),
  ('ПН2', 'Испратница', 'out', 'b2b_out', false),
  ('ПМ2', 'Испратница', 'out', 'b2b_out', true),
  ('ПМ6', 'Фактура за услуги', 'out', NULL, false),
  ('ТН2', 'Преносница помеѓу објекти', 'transfer', 'transfer_out', false),
  ('ПМ12', 'Сопствени Потреби', 'out', 'writeoff', true),
  ('ПФ12', 'Сопствени Потреби', 'out', NULL, false),
  ('ПН13', 'Одобрение', 'out', NULL, false),
  ('ПФ13', 'Одобрение', 'out', NULL, false),
  ('ПН14', 'Расход', 'out', 'writeoff', false),
  ('ПФ14', 'Расход', 'out', NULL, false),
  ('НФ5*', 'Увозна калкулација', 'in', NULL, false),
  ('НФ6', 'Зависни трошоци од увоз', 'in', NULL, false),
  ('ПФ6', 'Фактура за услуги', 'out', NULL, false),
  ('ПН8', 'Кусок', 'out', 'writeoff', false),
  ('ПМ8', 'Кусок', 'out', 'writeoff', true),
  ('ПМ4', 'Повратница', 'out', 'b2b_return_in', true),
  ('ПН9', 'Преносница', 'out', 'b2b_out', false),
  ('ПМ9', 'Преносница', 'out', 'b2b_out', true),
  ('ПФ9', 'Преносница', 'out', NULL, false),
  ('ПФ3', 'Фактура', 'out', NULL, false),
  ('ПМФ', 'Промет од фискални', 'out', NULL, false),
  ('НН7', 'Набавка на услуги', 'in', NULL, false),
  ('НФ7', 'Набавка на услуги', 'in', NULL, false),
  ('НН8', 'Вишок', 'in', 'receipt', false),
  ('НМ8', 'Вишок', 'in', 'receipt', true),
  ('ПМ14', 'Расход', 'out', 'writeoff', true),
  ('ПН100', 'Фискална сметка', 'out', 'shop_out', false),
  ('ПФ100', 'Фискална сметка', 'out', NULL, false),
  ('ПМ100', 'Фискална сметка', 'out', 'shop_out', true),
  ('ПН101', 'Сторно фисклана сметка', 'out', 'shop_return_in', false),
  ('ПМ101', 'Сторно фисклана сметка', 'out', 'shop_return_in', true),
  ('ПФ101', 'Сторно фисклана сметка', 'out', NULL, false),
  ('МН2', 'Производство/Препакување', 'in', 'production_in', false),
  ('ММ2', 'Производство/Препакување', 'in', 'production_in', true),
  ('МФ2', 'Производство/Препакување', 'in', NULL, false),
  ('МФ2*', 'Производство калкулација', 'in', NULL, false),
  ('ПН15', 'Извозна фактура', 'out', 'export_out', false),
  ('ПМ15', 'Извозна испратница', 'out', 'export_out', true),
  ('ПФ15', 'Извозна фактура', 'out', NULL, false),
  ('НН10', 'Фактура за Трошок', 'in', NULL, false),
  ('НФ10', 'Фактура за Трошок', 'in', NULL, false)
ON CONFLICT (doc_type) DO UPDATE
   SET name = EXCLUDED.name, direction = EXCLUDED.direction, ledger_kind = EXCLUDED.ledger_kind, include = EXCLUDED.include;

-- ── 2. default rules (idempotent — 20260945000100 may already have seeded them) ─────────────────────────────
INSERT INTO public.stock_sigma_rules (match, action, reason, active, set_by, set_at)
SELECT v.m, 'exclude', v.r, true, NULL, now()
  FROM (VALUES
    ('{"client_code": "000217"}'::jsonb,
     'MEX COD invoice (000217 МЕКС ПОШТА) — what leaves in a parcel is taken from MEX + collabBox'),
    ('{"client_code": "000549"}'::jsonb,
     'АД Астра (000549) — the BioNatural paper resale; its parcels are deducted from MEX'),
    ('{"objects": ["Ф00001-04", "Ф00001-08"]}'::jsonb,
     'transfer 04↔08 — Sigma 08 is under review (owner, 01.10.2026)')
  ) AS v(m, r)
 WHERE NOT EXISTS (SELECT 1 FROM public.stock_sigma_rules x WHERE x.match = v.m);

-- ── 3. helpers ──────────────────────────────────────────────────────────────────────────────────────────────

-- client_name only when the name looks like a company (sigma-fields.json client_name_rule — the same test as
-- build_sigma_stock.py and the connector): a company word as a whole word, or one word, or 4+ words, or a digit /
-- . * - & " ( ). Otherwise NULL: a person's name is never stored.
CREATE OR REPLACE FUNCTION public.stock_sigma_company_name(p_name text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $fn$
  WITH n AS (SELECT nullif(btrim(p_name), '') AS n),
       w AS (SELECT array_remove(regexp_split_to_array(upper(n.n), '[^[:alpha:]]+'), '') AS words FROM n)
  SELECT CASE
           WHEN n.n IS NULL THEN NULL
           WHEN w.words && ARRAY['ДОО','ДООЕЛ','ЕООД','ООД','ЗУР','ПЗУ','ЈЗУ','ДТТУ','ДПТУ','ТП','АД','АПТЕКА','ФАРМ','МАРКЕТ',
                                 'МАРКЕТИ','ТРЕЈД','КОМЕРЦ','ПРОМ','ГРУП','СЕРВИС','ЕКСПРЕС','ПОШТА','ЛОГИСТИК','НАТУРА',
                                 'ТЕРАПИ','ЛАБАРАТОРИИ','ЛАБОРАТОРИИ','АСТРА','НУТРИТИОН','ИНТЕРНО','КУПУВАЧ','ВРАБОТЕНИ',
                                 'РЕПРЕЗЕНТАЦИЈА','ПРОГРАМА','ПОРТАЛ','СТОРЕС','БАНКА','ДРОГЕРИЕ','DOO','DOOEL','EOOD','SHPK',
                                 'LLC','LTD','GMBH','IKE','SRL','SA','AG','AD','NATURA','THERAPY','NUTRITION','PHARM','PHARMA',
                                 'MARKET','TRADE','GROUP','BRANCH','COMPANY','FOOD','COSMETICS','LAB','BIO','WOLT','EXPRESS',
                                 'CUBE']::text[] THEN n.n
           WHEN n.n ~ '[0-9.*&"()-]' THEN n.n
           WHEN cardinality(w.words) = 1 OR cardinality(w.words) >= 4 THEN n.n
           ELSE NULL
         END
    FROM n, w
$fn$;

-- jsonb string or array of strings → text[]
CREATE OR REPLACE FUNCTION public.stock_sigma_jtext(p jsonb)
RETURNS text[]
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $fn$
  SELECT CASE jsonb_typeof(p)
           WHEN 'string' THEN ARRAY[p #>> '{}']
           WHEN 'array' THEN ARRAY(SELECT jsonb_array_elements_text(p))
           ELSE ARRAY[]::text[]
         END
$fn$;

-- Document lines → [{item_code, qty, side}] summed per (item_code, side), sorted, zero sums dropped, qty 3
-- decimals. NULL when the input is not a valid line list (the document is then rejected).
CREATE OR REPLACE FUNCTION public.stock_sigma_norm_lines(p_lines jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_out jsonb;
BEGIN
  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) > 5000 THEN
    RETURN NULL;
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_lines) e
              WHERE jsonb_typeof(e) <> 'object'
                 OR coalesce(btrim(e->>'item_code'), '') !~ '^[^[:space:]]{1,20}$'
                 OR coalesce(e->>'side', '') NOT IN ('in', 'out')
                 OR jsonb_typeof(e->'qty') <> 'number'
                 OR abs((e->>'qty')::numeric) >= 1e9) THEN
    RETURN NULL;
  END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('item_code', x.item_code, 'qty', x.qty, 'side', x.side)
                            ORDER BY x.item_code, x.side), '[]'::jsonb)
    INTO v_out
    FROM (SELECT btrim(e->>'item_code') AS item_code, e->>'side' AS side, round(sum((e->>'qty')::numeric), 3) AS qty
            FROM jsonb_array_elements(p_lines) e
           GROUP BY 1, 2) x
   WHERE x.qty <> 0;
  RETURN v_out;
END
$fn$;

-- Does a rule's match hold for a document? EXACTLY the language of stock_v2_sigma_excluded() (20260945000300):
-- client_code, doc_type, doc_key (a string — an array is accepted too), objects (an array: the document runs
-- between two DIFFERENT listed objects, either way); a match with none of these keys matches nothing.
CREATE OR REPLACE FUNCTION public.stock_sigma_rule_matches(p_match jsonb, p_doc public.stock_sigma_docs)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $fn$
  WITH o AS (SELECT public.stock_v2_sigma_object(p_doc.company_from, p_doc.object_from) AS f,
                    public.stock_v2_sigma_object(p_doc.company_to, p_doc.object_to) AS t)
  SELECT jsonb_typeof(p_match) = 'object'
     AND (p_match ? 'client_code' OR p_match ? 'doc_type' OR p_match ? 'doc_key' OR p_match ? 'objects')
     AND (NOT (p_match ? 'client_code') OR p_doc.client_code = ANY (public.stock_sigma_jtext(p_match->'client_code')))
     AND (NOT (p_match ? 'doc_type') OR p_doc.doc_type = ANY (public.stock_sigma_jtext(p_match->'doc_type')))
     AND (NOT (p_match ? 'doc_key') OR p_doc.doc_key = ANY (public.stock_sigma_jtext(p_match->'doc_key')))
     AND (NOT (p_match ? 'objects') OR (
            jsonb_typeof(p_match->'objects') = 'array' AND o.f IS NOT NULL AND o.t IS NOT NULL AND o.f <> o.t
        AND (p_match->'objects') ? o.f AND (p_match->'objects') ? o.t))
    FROM o
$fn$;

-- Why a document is excluded (NULL = included): an active `include` rule wins; else the first active `exclude`
-- rule (by id); else its type does not move stock. The date rule (before the opening) is the engine's — it
-- depends on the warehouse (stock_warehouses.sigma_moves_from).
CREATE OR REPLACE FUNCTION public.stock_sigma_doc_exclusion(p_doc public.stock_sigma_docs)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $fn$
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM public.stock_sigma_rules r
                  WHERE r.active AND r.action = 'include' AND public.stock_sigma_rule_matches(r.match, p_doc)) THEN NULL
    ELSE coalesce(
      (SELECT 'rule ' || r.id || ': ' || r.reason FROM public.stock_sigma_rules r
        WHERE r.active AND r.action = 'exclude' AND public.stock_sigma_rule_matches(r.match, p_doc)
        ORDER BY r.id LIMIT 1),
      (SELECT CASE WHEN t.doc_type IS NULL THEN 'doc_type ' || p_doc.doc_type || ': unknown type'
                   WHEN NOT t.include THEN 'doc_type ' || p_doc.doc_type || ': ' || coalesce(t.name, '') || ' — does not move stock'
              END
         FROM (SELECT 1) one LEFT JOIN public.stock_sigma_doc_types t ON t.doc_type = p_doc.doc_type))
  END
$fn$;

-- Re-decide excluded_reason (the given documents, or all). Returns how many changed.
CREATE OR REPLACE FUNCTION public.stock_sigma_docs_reclassify(p_keys text[] DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_n integer;
BEGIN
  PERFORM set_config('elyon.stock_write', 'on', true);
  WITH x AS (
    SELECT d.doc_key, public.stock_sigma_doc_exclusion(d) AS reason
      FROM public.stock_sigma_docs d
     WHERE p_keys IS NULL OR d.doc_key = ANY (p_keys)
  )
  UPDATE public.stock_sigma_docs d
     SET excluded_reason = x.reason
    FROM x
   WHERE d.doc_key = x.doc_key AND d.excluded_reason IS DISTINCT FROM x.reason;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END
$fn$;

-- The stock_moves kind of ONE Sigma line (see §1). p_to_key = company_to-object_to.
CREATE OR REPLACE FUNCTION public.stock_sigma_line_kind(p_doc_type text, p_client_code text, p_to_key text,
                                                        p_side text, p_qty numeric)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $fn$
  WITH t AS (SELECT direction, ledger_kind FROM public.stock_sigma_doc_types WHERE doc_type = p_doc_type),
       wo AS (SELECT coalesce((SELECT w.role = 'writeoff'
                                 FROM public.stock_warehouse_keys k JOIN public.stock_warehouses w ON w.id = k.warehouse_id
                                WHERE k.system = 'sigma' AND k.key = p_to_key LIMIT 1), p_to_key = 'Ф00001-11') AS into_writeoff)
  SELECT CASE
           WHEN t.direction = 'transfer' THEN CASE WHEN p_side = 'out' AND wo.into_writeoff THEN 'writeoff'
                                                    WHEN p_side = 'out' THEN 'transfer_out' ELSE 'transfer_in' END
           WHEN t.ledger_kind = 'production_in' THEN CASE WHEN p_qty >= 0 THEN 'production_in' ELSE 'production_use' END
           WHEN t.ledger_kind = 'b2b_out' AND p_client_code = '000001' AND p_doc_type <> 'НМ4' THEN 'shop_out'
           WHEN t.ledger_kind = 'b2b_return_in' AND p_client_code = '000001' THEN 'shop_return_in'
           ELSE t.ledger_kind
         END
    FROM t, wo
$fn$;

-- ── 4. the writer ───────────────────────────────────────────────────────────────────────────────────────────
-- stock_sigma_ingest(p_batch) — one SigmaBatch (csv or connector). Returns the result that is also stored in
-- stock_sigma_batches.result:
--   * a batch id already seen → {status: duplicate} (nothing is written twice);
--   * source 'connector' while app_settings.stock_v2.sigma.ingest is off → {status: disabled}, nothing stored
--     (a CSV batch — the lead's manual load — is always staged: staging is dark and moves no stock);
--   * docs: whitelisted fields only (sigma-fields.json doc_fields; any other key is dropped and named in
--     `dropped_fields`, a non-company client_name is blanked); a new document → version 1; a known one gets a new
--     version when its date or content (objects, client, lines) changed; a vanished one that comes back reappears;
--     an invalid one is rejected (named in `rejected`, the rest of the batch goes on);
--   * drafts: the FULL list of open drafts in the window (stored drafts in the window that are not in it are
--     removed; a draft whose posted twin arrived is removed);
--   * snapshot (mode 'snapshot', a window, optional chunk {run_id, index, total}): once every chunk of the run is
--     in, a stored document dated in the window that no chunk carried is marked vanished (a version is added);
--   * items → stock_articles as source 'sigma' (new codes inserted; a known article only gets last_seen_export
--     and blank unit / class / brand filled — a name an owner edited is never overwritten);
--   * balances → stock_sigma_balances at balances_taken_at; with stock_v2.sigma.costs_follow on, a change of more
--     than 0.5 % in 04's CalcBuyPrice (qty-weighted over the buckets in stock) adds a cost row dated at the
--     snapshot — never over an article whose latest cost an owner set;
--   * with stock_v2.enabled AND stock_v2.sigma.apply_on_ingest → stock_v2_apply('sigma_ingest').
CREATE OR REPLACE FUNCTION public.stock_sigma_ingest(p_batch jsonb)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  c_batch_fields constant text[] := ARRAY['batch_id','source','mode','exported_at','window','docs','drafts','items',
                                          'balances','balances_taken_at','chunk'];
  c_doc_fields constant text[] := ARRAY['doc_key','wyear','doc_type','doc_no','doc_date','posted_at','created_at_sigma',
                                        'created_by','last_change_by','status','company_from','object_from','company_to',
                                        'object_to','client_code','client_name','lines'];
  v_now timestamptz := clock_timestamp();   -- not now(): two batches in one transaction stay ordered
  v_id text := btrim(p_batch->>'batch_id');
  v_source text := p_batch->>'source';
  v_mode text := p_batch->>'mode';
  v_exported timestamptz;
  v_taken timestamptz;
  v_wfrom date;
  v_wto date;
  v_settings jsonb;
  v_chunk_run text := nullif(btrim(p_batch #>> '{chunk,run_id}'), '');
  v_chunk_idx int;
  v_chunk_total int;
  v_run_start timestamptz;
  v_counts jsonb;
  v_result jsonb;
  v_dropped text[] := ARRAY[]::text[];
  v_rejected jsonb := '[]'::jsonb;
  v_touched text[] := ARRAY[]::text[];
  v_draft_keys text[] := ARRAY[]::text[];
  r record;
  d jsonb;
  cur public.stock_sigma_docs%ROWTYPE;
  v_key text; v_wyear text; v_type text; v_no text; v_date date; v_lines jsonb; v_hash text;
  v_changed boolean;
  v_client_name text;
  v_err text;
  n_docs_in int := 0; n_ins int := 0; n_chg int := 0; n_same int := 0; n_back int := 0; n_names_blanked int := 0;
  n_drafts_in int := 0; n_drafts_up int := 0; n_drafts_del int := 0;
  n_items_in int := 0; n_items_new int := 0; n_items_seen int := 0;
  n_bal_in int := 0; n_bal int := 0;
  n_vanished int := 0;
  v_vanish text := 'n/a';
  v_costs jsonb := '"off"'::jsonb;
  v_apply jsonb := '"skipped"'::jsonb;
  v_excluded jsonb;
BEGIN
  -- ── validate the envelope ──
  IF p_batch IS NULL OR jsonb_typeof(p_batch) <> 'object' THEN
    RAISE EXCEPTION 'the batch must be a JSON object' USING ERRCODE = '22023';
  END IF;
  IF v_id IS NULL OR v_id = '' OR length(v_id) > 200 THEN
    RAISE EXCEPTION 'batch_id is required (1–200 characters)' USING ERRCODE = '22023';
  END IF;
  IF v_source IS NULL OR v_source NOT IN ('csv', 'connector') THEN
    RAISE EXCEPTION 'source must be csv or connector' USING ERRCODE = '22023';
  END IF;
  IF v_mode IS NULL OR v_mode NOT IN ('delta', 'snapshot', 'items', 'balances') THEN
    RAISE EXCEPTION 'mode must be delta, snapshot, items or balances' USING ERRCODE = '22023';
  END IF;
  BEGIN
    v_exported := (p_batch->>'exported_at')::timestamptz;
    v_taken := coalesce((p_batch->>'balances_taken_at')::timestamptz, v_exported);
    IF p_batch ? 'window' THEN
      v_wfrom := (p_batch #>> '{window,from}')::date;
      v_wto := (p_batch #>> '{window,to}')::date;
    END IF;
    IF v_chunk_run IS NOT NULL THEN
      v_chunk_idx := (p_batch #>> '{chunk,index}')::int;
      v_chunk_total := (p_batch #>> '{chunk,total}')::int;
    END IF;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'exported_at / balances_taken_at / window / chunk are not valid: %', SQLERRM USING ERRCODE = '22023';
  END;
  IF v_exported IS NULL THEN
    RAISE EXCEPTION 'exported_at is required' USING ERRCODE = '22023';
  END IF;
  IF v_mode = 'snapshot' AND (v_wfrom IS NULL OR v_wto IS NULL OR v_wto < v_wfrom) THEN
    RAISE EXCEPTION 'a snapshot needs window {from, to}' USING ERRCODE = '22023';
  END IF;
  IF v_chunk_run IS NOT NULL AND (v_chunk_idx IS NULL OR v_chunk_total IS NULL OR v_chunk_idx < 1
                                  OR v_chunk_idx > v_chunk_total OR v_chunk_total > 10000) THEN
    RAISE EXCEPTION 'chunk needs run_id, index (1..total) and total' USING ERRCODE = '22023';
  END IF;
  IF (p_batch ? 'docs' AND jsonb_typeof(p_batch->'docs') <> 'array')
     OR (p_batch ? 'drafts' AND jsonb_typeof(p_batch->'drafts') <> 'array')
     OR (p_batch ? 'items' AND jsonb_typeof(p_batch->'items') <> 'array')
     OR (p_batch ? 'balances' AND jsonb_typeof(p_batch->'balances') <> 'array') THEN
    RAISE EXCEPTION 'docs, drafts, items and balances must be arrays' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(coalesce(p_batch->'docs', '[]')) > 5000 OR jsonb_array_length(coalesce(p_batch->'drafts', '[]')) > 5000
     OR jsonb_array_length(coalesce(p_batch->'items', '[]')) > 20000
     OR jsonb_array_length(coalesce(p_batch->'balances', '[]')) > 50000 THEN
    RAISE EXCEPTION 'batch too large (docs/drafts ≤ 5000, items ≤ 20000, balances ≤ 50000)' USING ERRCODE = '22023';
  END IF;

  -- one ingest at a time; a batch id is written once
  PERFORM pg_advisory_xact_lock(hashtext('stock_sigma_ingest'));
  IF EXISTS (SELECT 1 FROM public.stock_sigma_batches b WHERE b.batch_id = v_id) THEN
    RETURN jsonb_build_object('status', 'duplicate', 'batch_id', v_id,
                              'received_at', (SELECT b.received_at FROM public.stock_sigma_batches b WHERE b.batch_id = v_id));
  END IF;

  v_settings := coalesce((SELECT s.value FROM public.app_settings s WHERE s.key = 'stock_v2'), '{}'::jsonb);
  IF v_source = 'connector' AND NOT coalesce((v_settings #>> '{sigma,ingest}')::boolean, false) THEN
    RETURN jsonb_build_object('status', 'disabled', 'batch_id', v_id,
                              'reason', 'app_settings.stock_v2.sigma.ingest is off — nothing stored');
  END IF;

  PERFORM set_config('elyon.stock_write', 'on', true);
  SELECT coalesce(array_agg(k ORDER BY k), ARRAY[]::text[]) INTO v_dropped
    FROM jsonb_object_keys(p_batch) k WHERE k <> ALL (c_batch_fields);

  -- ── docs ──
  FOR r IN SELECT e.value AS j, e.ordinality AS ord FROM jsonb_array_elements(coalesce(p_batch->'docs', '[]')) WITH ORDINALITY e LOOP
    n_docs_in := n_docs_in + 1;
    d := r.j;
    v_err := NULL;
    IF jsonb_typeof(d) <> 'object' THEN
      v_rejected := v_rejected || jsonb_build_object('index', r.ord, 'reason', 'not an object');
      CONTINUE;
    END IF;
    v_dropped := v_dropped || ARRAY(SELECT k FROM jsonb_object_keys(d) k WHERE k <> ALL (c_doc_fields));
    v_wyear := btrim(d->>'wyear'); v_type := btrim(d->>'doc_type'); v_no := btrim(d->>'doc_no'); v_key := btrim(d->>'doc_key');
    IF coalesce(v_wyear, '') = '' OR coalesce(v_type, '') = '' OR coalesce(v_no, '') = ''
       OR v_key IS DISTINCT FROM v_wyear || '|' || v_type || '|' || v_no OR length(v_key) > 80 THEN
      v_err := 'doc_key must be <wyear>|<doc_type>|<doc_no>';
    END IF;
    IF v_err IS NULL THEN
      BEGIN
        v_date := (d->>'doc_date')::date;
        IF v_date IS NULL THEN v_err := 'doc_date is required'; END IF;
        PERFORM (d->>'posted_at')::timestamptz, (d->>'created_at_sigma')::timestamptz;
      EXCEPTION WHEN others THEN
        v_err := 'doc_date / posted_at / created_at_sigma are not valid';
      END;
    END IF;
    IF v_err IS NULL THEN
      v_lines := public.stock_sigma_norm_lines(d->'lines');
      IF v_lines IS NULL THEN v_err := 'lines must be [{item_code, qty, side: in|out}]'; END IF;
    END IF;
    IF v_err IS NOT NULL THEN
      v_rejected := v_rejected || jsonb_build_object('index', r.ord, 'doc_key', left(v_key, 80), 'reason', v_err);
      CONTINUE;
    END IF;
    v_client_name := public.stock_sigma_company_name(d->>'client_name');
    IF v_client_name IS NULL AND nullif(btrim(d->>'client_name'), '') IS NOT NULL THEN
      n_names_blanked := n_names_blanked + 1;
    END IF;
    v_hash := md5(jsonb_build_array(nullif(btrim(d->>'company_from'), ''), nullif(btrim(d->>'object_from'), ''),
                                    nullif(btrim(d->>'company_to'), ''), nullif(btrim(d->>'object_to'), ''),
                                    nullif(btrim(d->>'client_code'), ''), v_lines)::text);

    SELECT * INTO cur FROM public.stock_sigma_docs s WHERE s.doc_key = v_key FOR UPDATE;
    IF NOT FOUND THEN
      INSERT INTO public.stock_sigma_docs AS s (
        doc_key, wyear, doc_type, doc_no, doc_date, posted_at, created_at_sigma, created_by, last_change_by, status,
        company_from, object_from, company_to, object_to, client_code, client_name, lines, content_hash, versions,
        first_seen_at, last_seen_at, last_changed_at, vanished_at, excluded_reason)
      VALUES (
        v_key, v_wyear, v_type, v_no, v_date, (d->>'posted_at')::timestamptz, (d->>'created_at_sigma')::timestamptz,
        left(nullif(btrim(d->>'created_by'), ''), 60), left(nullif(btrim(d->>'last_change_by'), ''), 60),
        left(nullif(btrim(d->>'status'), ''), 20),
        nullif(btrim(d->>'company_from'), ''), nullif(btrim(d->>'object_from'), ''),
        nullif(btrim(d->>'company_to'), ''), nullif(btrim(d->>'object_to'), ''),
        nullif(btrim(d->>'client_code'), ''), left(v_client_name, 200), v_lines, v_hash, 1,
        v_now, v_now, v_now, NULL, NULL);
      INSERT INTO public.stock_sigma_doc_versions (doc_key, version, doc_date, content_hash, lines, seen_at)
      VALUES (v_key, 1, v_date, v_hash, v_lines, v_now);
      n_ins := n_ins + 1;
    ELSE
      v_changed := cur.doc_date IS DISTINCT FROM v_date OR cur.content_hash IS DISTINCT FROM v_hash;
      IF cur.vanished_at IS NOT NULL THEN
        n_back := n_back + 1;
      END IF;
      UPDATE public.stock_sigma_docs s
         SET doc_date = v_date,
             posted_at = (d->>'posted_at')::timestamptz,
             created_at_sigma = coalesce((d->>'created_at_sigma')::timestamptz, s.created_at_sigma),
             created_by = coalesce(left(nullif(btrim(d->>'created_by'), ''), 60), s.created_by),
             last_change_by = coalesce(left(nullif(btrim(d->>'last_change_by'), ''), 60), s.last_change_by),
             status = coalesce(left(nullif(btrim(d->>'status'), ''), 20), s.status),
             company_from = nullif(btrim(d->>'company_from'), ''), object_from = nullif(btrim(d->>'object_from'), ''),
             company_to = nullif(btrim(d->>'company_to'), ''), object_to = nullif(btrim(d->>'object_to'), ''),
             client_code = nullif(btrim(d->>'client_code'), ''), client_name = left(v_client_name, 200),
             lines = v_lines,
             content_hash = v_hash,
             versions = s.versions + CASE WHEN v_changed THEN 1 ELSE 0 END,
             last_seen_at = v_now,
             last_changed_at = CASE WHEN v_changed THEN v_now ELSE s.last_changed_at END,
             vanished_at = NULL
       WHERE s.doc_key = v_key;
      IF v_changed THEN
        INSERT INTO public.stock_sigma_doc_versions (doc_key, version, doc_date, content_hash, lines, seen_at)
        VALUES (v_key, cur.versions + 1, v_date, v_hash, v_lines, v_now);
        n_chg := n_chg + 1;
      ELSE
        n_same := n_same + 1;
      END IF;
    END IF;
    v_touched := v_touched || v_key;
  END LOOP;
  PERFORM public.stock_sigma_docs_reclassify(v_touched);

  -- ── snapshot: what the run did not carry has vanished ──
  IF v_mode = 'snapshot' THEN
    IF v_chunk_run IS NULL THEN
      v_run_start := v_now;
    ELSIF v_chunk_idx = v_chunk_total
          AND (SELECT count(DISTINCT (b.counts->>'chunk_index')) FROM public.stock_sigma_batches b
                WHERE b.counts->>'chunk_run' = v_chunk_run AND (b.counts->>'chunk_index')::int < v_chunk_total) = v_chunk_total - 1 THEN
      v_run_start := least(v_now, (SELECT min(b.received_at) FROM public.stock_sigma_batches b WHERE b.counts->>'chunk_run' = v_chunk_run));
    END IF;
    IF v_run_start IS NULL THEN
      v_vanish := 'waiting for the last chunk';
    ELSE
      WITH gone AS (
        UPDATE public.stock_sigma_docs s
           SET vanished_at = v_now, versions = s.versions + 1, last_changed_at = v_now, content_hash = 'vanished'
         WHERE s.vanished_at IS NULL AND s.doc_date BETWEEN v_wfrom AND v_wto AND s.last_seen_at < v_run_start
        RETURNING s.doc_key, s.versions, s.doc_date
      ), ver AS (
        INSERT INTO public.stock_sigma_doc_versions (doc_key, version, doc_date, content_hash, lines, seen_at)
        SELECT gone.doc_key, gone.versions, gone.doc_date, 'vanished', '[]'::jsonb, v_now FROM gone
        RETURNING 1
      )
      SELECT count(*) INTO n_vanished FROM ver;
      v_vanish := 'done';
    END IF;
  END IF;

  -- ── drafts: the full list of open drafts in the window ──
  IF p_batch ? 'drafts' THEN
    FOR r IN SELECT e.value AS j, e.ordinality AS ord FROM jsonb_array_elements(p_batch->'drafts') WITH ORDINALITY e LOOP
      n_drafts_in := n_drafts_in + 1;
      d := r.j;
      IF jsonb_typeof(d) <> 'object' THEN CONTINUE; END IF;
      v_dropped := v_dropped || ARRAY(SELECT k FROM jsonb_object_keys(d) k WHERE k <> ALL (c_doc_fields));
      v_key := btrim(d->>'doc_key');
      v_lines := public.stock_sigma_norm_lines(d->'lines');
      BEGIN
        v_date := (d->>'doc_date')::date;
      EXCEPTION WHEN others THEN v_date := NULL;
      END;
      IF coalesce(v_key, '') = '' OR length(v_key) > 80 OR v_key !~ '^[^|]+\|[^|]+\|[^|]+$' OR v_lines IS NULL THEN
        v_rejected := v_rejected || jsonb_build_object('draft_index', r.ord, 'doc_key', left(v_key, 80), 'reason', 'invalid draft');
        CONTINUE;
      END IF;
      INSERT INTO public.stock_sigma_drafts AS s (doc_key, doc_date, object_from, object_to, lines, seen_at)
      VALUES (v_key, v_date,
              nullif(concat_ws('-', nullif(btrim(d->>'company_from'), ''), nullif(btrim(d->>'object_from'), '')), ''),
              nullif(concat_ws('-', nullif(btrim(d->>'company_to'), ''), nullif(btrim(d->>'object_to'), '')), ''),
              v_lines, v_now)
      ON CONFLICT (doc_key) DO UPDATE
         SET doc_date = EXCLUDED.doc_date, object_from = EXCLUDED.object_from, object_to = EXCLUDED.object_to,
             lines = EXCLUDED.lines, seen_at = EXCLUDED.seen_at;
      v_draft_keys := v_draft_keys || v_key;
      n_drafts_up := n_drafts_up + 1;
    END LOOP;
    DELETE FROM public.stock_sigma_drafts s
     WHERE s.doc_key <> ALL (v_draft_keys)
       AND (v_wfrom IS NULL OR s.doc_date IS NULL OR s.doc_date BETWEEN v_wfrom AND coalesce(v_wto, 'infinity'::date));
    GET DIAGNOSTICS n_drafts_del = ROW_COUNT;
  END IF;
  -- a draft whose posted twin is staged is no longer "најавено" (ПН1 04-00123 → ПМ1 04-00123; МН2 → ММ2)
  WITH twin AS (
    DELETE FROM public.stock_sigma_drafts s
     WHERE EXISTS (SELECT 1 FROM public.stock_sigma_docs x
                    WHERE x.vanished_at IS NULL
                      AND x.doc_key = split_part(s.doc_key, '|', 1) || '|'
                                      || CASE WHEN split_part(s.doc_key, '|', 2) = 'МН2' THEN 'ММ2'
                                              ELSE overlay(split_part(s.doc_key, '|', 2) PLACING 'М' FROM 2 FOR 1) END
                                      || '|' || split_part(s.doc_key, '|', 3))
    RETURNING 1)
  SELECT n_drafts_del + count(*) INTO n_drafts_del FROM twin;

  -- ── items → stock_articles (source 'sigma'); never clobber what an owner edited ──
  IF p_batch ? 'items' THEN
    n_items_in := jsonb_array_length(p_batch->'items');
    WITH x AS (
      SELECT DISTINCT ON (btrim(i.code)) btrim(i.code) AS code, left(btrim(i.name), 200) AS name,
             left(nullif(btrim(i.unit), ''), 20) AS unit, left(nullif(btrim(i.sigma_class), ''), 40) AS sigma_class,
             left(nullif(btrim(i.brand), ''), 80) AS brand, coalesce(i.active, true) AS active
        FROM jsonb_to_recordset(p_batch->'items') AS i(code text, name text, unit text, sigma_class text, brand text, active boolean)
       WHERE btrim(i.code) ~ '^[0-9]{6}$' AND coalesce(btrim(i.name), '') <> ''
       ORDER BY btrim(i.code)
    ), up AS (
      INSERT INTO public.stock_articles AS a (code, name, unit, sigma_class, brand, is_set, active, source, last_seen_export,
                                              created_at, updated_at)
      SELECT x.code, x.name, coalesce(x.unit, 'КОМ'), x.sigma_class, x.brand,
             x.name ~* '(^|[^0-9])[1-5][[:space:]]*\+[[:space:]]*[1-5]([^0-9]|$)|(^|[^[:alpha:]])(сет|set|гратис)([^[:alpha:]]|$)',
             x.active, 'sigma', v_exported, v_now, v_now
        FROM x
      ON CONFLICT (code) DO UPDATE
         SET last_seen_export = greatest(a.last_seen_export, EXCLUDED.last_seen_export),
             unit = coalesce(a.unit, EXCLUDED.unit),
             sigma_class = coalesce(a.sigma_class, EXCLUDED.sigma_class),
             brand = coalesce(a.brand, EXCLUDED.brand)
      RETURNING (xmax = 0) AS inserted
    )
    SELECT count(*) FILTER (WHERE inserted), count(*) FILTER (WHERE NOT inserted) INTO n_items_new, n_items_seen FROM up;
  END IF;

  -- ── balances → stock_sigma_balances ──
  IF p_batch ? 'balances' THEN
    n_bal_in := jsonb_array_length(p_batch->'balances');
    IF v_taken IS NULL THEN
      RAISE EXCEPTION 'balances need balances_taken_at (or exported_at)' USING ERRCODE = '22023';
    END IF;
    WITH x AS (
      SELECT DISTINCT ON (btrim(b.company), coalesce(btrim(b.object), ''), btrim(b.item_code), btrim(b.wyear))
             btrim(b.company) AS company, coalesce(btrim(b.object), '') AS object, btrim(b.item_code) AS item_code,
             btrim(b.wyear) AS wyear, round(coalesce(b.qty, 0), 3) AS qty, round(b.calc_buy_price, 6) AS calc_buy_price
        FROM jsonb_to_recordset(p_batch->'balances')
             AS b(company text, object text, item_code text, wyear text, qty numeric, calc_buy_price numeric)
       WHERE coalesce(btrim(b.company), '') <> '' AND coalesce(btrim(b.item_code), '') <> '' AND coalesce(btrim(b.wyear), '') <> ''
       ORDER BY btrim(b.company), coalesce(btrim(b.object), ''), btrim(b.item_code), btrim(b.wyear)
    ), up AS (
      INSERT INTO public.stock_sigma_balances AS s (taken_at, company, object, item_code, wyear, qty, calc_buy_price)
      SELECT v_taken, x.company, x.object, x.item_code, x.wyear, x.qty, x.calc_buy_price FROM x
      ON CONFLICT (taken_at, company, object, item_code, wyear) DO UPDATE
         SET qty = EXCLUDED.qty, calc_buy_price = EXCLUDED.calc_buy_price
      RETURNING 1
    )
    SELECT count(*) INTO n_bal FROM up;

    -- costs_follow: a change > 0.5 % in 04's CalcBuyPrice adds a cost row at the snapshot
    IF coalesce((v_settings #>> '{sigma,costs_follow}')::boolean, false) THEN
      WITH b04 AS (
        SELECT s.item_code, s.wyear, s.qty, s.calc_buy_price
          FROM public.stock_sigma_balances s
         WHERE s.taken_at = v_taken AND s.company = 'Ф00001' AND s.object = '04'
           AND s.item_code IN (SELECT btrim(b.item_code) FROM jsonb_to_recordset(p_batch->'balances') AS b(company text, object text, item_code text)
                                WHERE btrim(b.company) = 'Ф00001' AND btrim(b.object) = '04')
      ), cost AS (
        SELECT b04.item_code,
               CASE WHEN count(*) FILTER (WHERE b04.qty > 0 AND b04.calc_buy_price > 0) >= 2
                      THEN sum(b04.qty * b04.calc_buy_price) FILTER (WHERE b04.qty > 0 AND b04.calc_buy_price > 0)
                           / sum(b04.qty) FILTER (WHERE b04.qty > 0 AND b04.calc_buy_price > 0)
                    WHEN count(*) FILTER (WHERE b04.qty > 0 AND b04.calc_buy_price > 0) = 1
                      THEN max(b04.calc_buy_price) FILTER (WHERE b04.qty > 0 AND b04.calc_buy_price > 0)
               END AS cost_mkd,
               CASE WHEN count(*) FILTER (WHERE b04.qty > 0 AND b04.calc_buy_price > 0) >= 2 THEN '04_calcbuy_qtyweighted'
                    ELSE '04_calcbuy_single' END AS basis
          FROM b04 GROUP BY b04.item_code
      ), last_cost AS (
        SELECT DISTINCT ON (c.article_code) c.article_code, c.cost_mkd, c.source
          FROM public.stock_article_costs c
         WHERE c.valid_from <= v_taken
         ORDER BY c.article_code, c.valid_from DESC, (c.source = 'owner') DESC, c.recorded_at DESC
      ), cand AS (
        SELECT cost.item_code, round(cost.cost_mkd, 4) AS cost_mkd, cost.basis, last_cost.cost_mkd AS prev, last_cost.source AS prev_source
          FROM cost
          JOIN public.stock_articles a ON a.code = cost.item_code
          LEFT JOIN last_cost ON last_cost.article_code = cost.item_code
         WHERE cost.cost_mkd IS NOT NULL AND cost.cost_mkd > 0
      ), ins AS (
        INSERT INTO public.stock_article_costs (article_code, cost_mkd, valid_from, source, basis, source_ref, flags, recorded_by, recorded_at)
        SELECT cand.item_code, cand.cost_mkd, v_taken, 'sigma_calcbuyprice', cand.basis,
               'Ф00001-04 StockObject ' || to_char(v_taken AT TIME ZONE 'Europe/Skopje', 'YYYY-MM-DD HH24:MI') || ' (batch ' || v_id || ')',
               CASE WHEN cand.prev IS NULL THEN ARRAY['costs_follow', 'first_cost'] ELSE ARRAY['costs_follow'] END,
               NULL, v_now
          FROM cand
         WHERE coalesce(cand.prev_source, '') <> 'owner'
           AND (cand.prev IS NULL OR abs(cand.cost_mkd - cand.prev) > 0.005 * cand.prev)
        ON CONFLICT (article_code, valid_from, source) DO NOTHING
        RETURNING 1
      )
      SELECT jsonb_build_object(
               'checked', (SELECT count(*) FROM cand),
               'added', (SELECT count(*) FROM ins),
               'skipped_owner', (SELECT count(*) FROM cand WHERE cand.prev_source = 'owner'))
        INTO v_costs;
    END IF;
  END IF;

  -- ── the record ──
  SELECT coalesce(jsonb_object_agg(x.reason, x.n), '{}'::jsonb) INTO v_excluded
    FROM (SELECT coalesce(s.excluded_reason, 'included') AS reason, count(*) AS n
            FROM public.stock_sigma_docs s WHERE s.doc_key = ANY (v_touched) GROUP BY 1) x;
  v_counts := jsonb_build_object('docs', n_docs_in, 'drafts', n_drafts_in, 'items', n_items_in, 'balances', n_bal_in)
              || CASE WHEN v_chunk_run IS NOT NULL
                      THEN jsonb_build_object('chunk_run', v_chunk_run, 'chunk_index', v_chunk_idx, 'chunk_total', v_chunk_total)
                      ELSE '{}'::jsonb END;

  -- stock_v2_apply runs only with the switch on (it is created by 20260945000300; dynamic call = no hard dependency)
  IF coalesce((v_settings ->> 'enabled')::boolean, false)
     AND coalesce((v_settings #>> '{sigma,apply_on_ingest}')::boolean, true)
     AND to_regprocedure('public.stock_v2_apply(text,boolean)') IS NOT NULL THEN
    EXECUTE 'SELECT public.stock_v2_apply($1, false)' INTO v_apply USING 'sigma_ingest';
  END IF;

  v_result := jsonb_build_object(
    'status', 'ok', 'batch_id', v_id, 'source', v_source, 'mode', v_mode,
    'docs', jsonb_build_object('received', n_docs_in, 'inserted', n_ins, 'changed', n_chg, 'unchanged', n_same,
                               'reappeared', n_back, 'rejected', jsonb_array_length(v_rejected) - 0, 'client_names_blanked', n_names_blanked),
    'excluded', v_excluded,
    'snapshot', jsonb_build_object('vanished', n_vanished, 'state', v_vanish),
    'drafts', jsonb_build_object('received', n_drafts_in, 'stored', n_drafts_up, 'removed', n_drafts_del),
    'items', jsonb_build_object('received', n_items_in, 'inserted', n_items_new, 'seen', n_items_seen,
                               'skipped', n_items_in - n_items_new - n_items_seen),
    'balances', jsonb_build_object('received', n_bal_in, 'stored', n_bal, 'taken_at', v_taken),
    'costs_follow', v_costs,
    'dropped_fields', to_jsonb(ARRAY(SELECT DISTINCT u FROM unnest(v_dropped) u ORDER BY u)),
    'rejected', (SELECT coalesce(jsonb_agg(x.value), '[]'::jsonb)
                   FROM (SELECT value FROM jsonb_array_elements(v_rejected) LIMIT 50) x),
    'apply', v_apply);
  INSERT INTO public.stock_sigma_batches (batch_id, source, mode, exported_at, window_from, window_to, counts, result, received_at)
  VALUES (v_id, v_source, v_mode, v_exported, v_wfrom, v_wto, v_counts, v_result, v_now);
  RETURN v_result;
END
$fn$;

COMMENT ON FUNCTION public.stock_sigma_ingest(jsonb) IS
  'Stock v2: the ONLY writer of the Sigma staging (stock_sigma_docs / _doc_versions / _drafts / _balances / _batches) and of Sigma-sourced stock_articles rows. Takes one SigmaBatch (src/lib/stockV2Types.ts; fields in tools/sigma-connector/sigma-fields.json): whitelist, idempotent batch_id, versions on date/content change, snapshot → vanished, items, balances, costs_follow, stock_v2_apply when enabled. Migration 20260945000650.';

-- ── 5. the rule writer (owners, through PUT stock/v2/config) ────────────────────────────────────────────────
-- p_row = {id?, match, action: exclude|include, reason, active?}. Inserts (no id) or updates (id); one audit_log
-- row stock.sigma_rule_set; every staged document is re-decided (trg_stock_sigma_rules_reclassify — the same
-- happens when PUT stock/v2/config writes rules through stock_v2_config_set). Returns {id, created, rule, excluded_now}.
CREATE OR REPLACE FUNCTION public.stock_sigma_rule_set(p_row jsonb, p_actor uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_id bigint;
  v_match jsonb := p_row->'match';
  v_action text := p_row->>'action';
  v_reason text := nullif(btrim(p_row->>'reason'), '');
  v_active boolean := coalesce((p_row->>'active')::boolean, true);
  v_prev jsonb;
  v_email text;
  v_bad text;
  v_n integer;
BEGIN
  IF p_actor IS NULL THEN
    RAISE EXCEPTION 'actor is required' USING ERRCODE = '22023';
  END IF;
  IF p_row IS NULL OR jsonb_typeof(p_row) <> 'object' THEN
    RAISE EXCEPTION 'the rule must be a JSON object' USING ERRCODE = '22023';
  END IF;
  IF v_action IS NULL OR v_action NOT IN ('exclude', 'include') THEN
    RAISE EXCEPTION 'action must be exclude or include' USING ERRCODE = '22023';
  END IF;
  IF v_reason IS NULL OR length(v_reason) > 300 THEN
    RAISE EXCEPTION 'reason is required (max 300 characters)' USING ERRCODE = '22023';
  END IF;
  IF v_match IS NULL OR jsonb_typeof(v_match) <> 'object' OR v_match = '{}'::jsonb THEN
    RAISE EXCEPTION 'match must be a non-empty object' USING ERRCODE = '22023';
  END IF;
  SELECT string_agg(k, ', ') INTO v_bad FROM jsonb_object_keys(v_match) k
   WHERE k NOT IN ('client_code', 'doc_type', 'doc_key', 'objects');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'unknown match key(s): % (client_code, doc_type, doc_key, objects)', v_bad USING ERRCODE = '22023';
  END IF;
  -- the engine's rule language (stock_v2_sigma_excluded, 20260945000300): one string per key, objects = an array
  IF EXISTS (SELECT 1 FROM jsonb_each(v_match) e
              WHERE e.key <> 'objects' AND NOT (jsonb_typeof(e.value) = 'string' AND btrim(e.value #>> '{}') <> '')) THEN
    RAISE EXCEPTION 'client_code / doc_type / doc_key must each be one non-empty string' USING ERRCODE = '22023';
  END IF;
  IF v_match ? 'objects' AND NOT (jsonb_typeof(v_match->'objects') = 'array' AND jsonb_array_length(v_match->'objects') >= 2
                                  AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_match->'objects') x
                                                   WHERE jsonb_typeof(x) <> 'string' OR btrim(x #>> '{}') = '')) THEN
    RAISE EXCEPTION 'objects must be an array of 2+ object keys (e.g. ["Ф00001-04","Ф00001-08"])' USING ERRCODE = '22023';
  END IF;

  SELECT u.email INTO v_email FROM auth.users u WHERE u.id = p_actor;
  PERFORM set_config('elyon.stock_write', 'on', true);
  IF p_row ? 'id' AND p_row->>'id' IS NOT NULL THEN
    v_id := (p_row->>'id')::bigint;
    SELECT to_jsonb(r) INTO v_prev FROM public.stock_sigma_rules r WHERE r.id = v_id FOR UPDATE;
    IF v_prev IS NULL THEN
      RAISE EXCEPTION 'no Sigma rule %', v_id USING ERRCODE = 'P0002';
    END IF;
    UPDATE public.stock_sigma_rules
       SET match = v_match, action = v_action, reason = v_reason, active = v_active, set_by = p_actor, set_at = now()
     WHERE id = v_id;
  ELSE
    INSERT INTO public.stock_sigma_rules (match, action, reason, active, set_by, set_at)
    VALUES (v_match, v_action, v_reason, v_active, p_actor, now())
    RETURNING id INTO v_id;
  END IF;
  SELECT count(*) INTO v_n FROM public.stock_sigma_docs d WHERE d.vanished_at IS NULL AND d.excluded_reason IS NOT NULL;

  INSERT INTO audit_log (actor_id, actor_email, action, target_type, target_id, target_name, payload)
  VALUES (p_actor, v_email, 'stock.sigma_rule_set', 'stock_sigma_rules', v_id::text, left(v_reason, 120),
          jsonb_build_object('rule', jsonb_build_object('id', v_id, 'match', v_match, 'action', v_action,
                                                        'reason', v_reason, 'active', v_active),
                             'previous', v_prev, 'excluded_now', v_n));
  RETURN jsonb_build_object('id', v_id, 'created', v_prev IS NULL, 'excluded_now', v_n,
                            'rule', jsonb_build_object('id', v_id, 'match', v_match, 'action', v_action,
                                                       'reason', v_reason, 'active', v_active));
END
$fn$;

COMMENT ON FUNCTION public.stock_sigma_rule_set(jsonb, uuid) IS
  'Stock v2: the audited writer of stock_sigma_rules ({id?, match {client_code|doc_type|doc_key: string, objects: [keys]}, action exclude|include, reason, active}) — the rule language of stock_v2_sigma_excluded(); the reclassify trigger re-decides excluded_reason on every staged Sigma document. Owners only (the api checks). Migration 20260945000650.';

-- ── 6. the included Sigma lines as warehouse moves (read by the engine; preview-safe, writes nothing) ───────
-- One row per staged line that lands in a TRACKED CRM warehouse: not vanished, not excluded, the line's object
-- mapped through stock_warehouse_keys (system sigma), the warehouse taking Sigma moves from sigma_moves_from (doc
-- date ≥ that day in Skopje, or ≥ p_from), the item a stock article. qty is the signed effect on that warehouse.
-- The same quantities stock_v2_desired() (0300) books; kind is the refined stock_sigma_line_kind() label.
CREATE OR REPLACE FUNCTION public.stock_sigma_effective_lines(p_from date DEFAULT NULL)
RETURNS TABLE (doc_key text, doc_type text, doc_date date, event_at timestamptz, warehouse_id bigint,
               warehouse_code text, article_code text, qty numeric, kind text, versions integer, client_code text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  SELECT d.doc_key, d.doc_type, d.doc_date,
         ((d.doc_date::timestamp + interval '12 hours') AT TIME ZONE 'Europe/Skopje') AS event_at,
         w.id::bigint, w.code, l.item_code,
         CASE l.side WHEN 'out' THEN -l.qty ELSE l.qty END,
         public.stock_sigma_line_kind(d.doc_type, d.client_code, public.stock_v2_sigma_object(d.company_to, d.object_to), l.side, l.qty),
         d.versions, d.client_code
    FROM public.stock_sigma_docs d
    CROSS JOIN LATERAL jsonb_to_recordset(d.lines) AS l(item_code text, qty numeric, side text)
    JOIN public.stock_warehouse_keys k
      ON k.system = 'sigma'
     AND k.key = CASE l.side WHEN 'out' THEN public.stock_v2_sigma_object(d.company_from, d.object_from)
                             ELSE public.stock_v2_sigma_object(d.company_to, d.object_to) END
    JOIN public.stock_warehouses w ON w.id = k.warehouse_id
    JOIN public.stock_articles a ON a.code = l.item_code
   WHERE d.vanished_at IS NULL
     AND d.excluded_reason IS NULL
     AND w.tracked
     AND w.sigma_moves_from IS NOT NULL
     AND d.doc_date >= greatest((w.sigma_moves_from AT TIME ZONE 'Europe/Skopje')::date, coalesce(p_from, '-infinity'::date))
$fn$;

COMMENT ON FUNCTION public.stock_sigma_effective_lines(date) IS
  'Stock v2: the staged Sigma lines that move CRM stock — signed qty per (document, warehouse, article), event at the document date 12:00 Skopje, kind from stock_sigma_line_kind(). Not vanished, not excluded, warehouse mapped (stock_warehouse_keys sigma) with doc_date ≥ its sigma_moves_from, item a stock article. Migration 20260945000650.';

-- ── 7. status (GET stock/v2/sigma/status) ───────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.stock_sigma_status()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  SELECT jsonb_build_object(
    'settings', coalesce((SELECT s.value -> 'sigma' FROM public.app_settings s WHERE s.key = 'stock_v2'), '{}'::jsonb),
    'last_batch_at', (SELECT max(b.received_at) FROM public.stock_sigma_batches b),
    'connector_last_seen', (SELECT max(b.received_at) FROM public.stock_sigma_batches b WHERE b.source = 'connector'),
    'last_csv_at', (SELECT max(b.received_at) FROM public.stock_sigma_batches b WHERE b.source = 'csv'),
    'batches_24h', (SELECT count(*) FROM public.stock_sigma_batches b WHERE b.received_at > now() - interval '24 hours'),
    'docs_staged', (SELECT count(*) FROM public.stock_sigma_docs d WHERE d.vanished_at IS NULL),
    'docs_included', (SELECT count(*) FROM public.stock_sigma_docs d WHERE d.vanished_at IS NULL AND d.excluded_reason IS NULL),
    'docs_excluded', (SELECT count(*) FROM public.stock_sigma_docs d WHERE d.vanished_at IS NULL AND d.excluded_reason IS NOT NULL),
    'docs_vanished', (SELECT count(*) FROM public.stock_sigma_docs d WHERE d.vanished_at IS NOT NULL),
    'docs_versions_gt1', (SELECT count(*) FROM public.stock_sigma_docs d WHERE d.versions > 1),
    'drafts', (SELECT count(*) FROM public.stock_sigma_drafts),
    'last_balances_at', (SELECT max(b.taken_at) FROM public.stock_sigma_balances b),
    'newest_doc_date', (SELECT max(d.doc_date) FROM public.stock_sigma_docs d WHERE d.vanished_at IS NULL),
    'excluded_by_reason', (SELECT coalesce(jsonb_object_agg(x.r, x.n), '{}'::jsonb)
                             FROM (SELECT d.excluded_reason AS r, count(*) AS n FROM public.stock_sigma_docs d
                                    WHERE d.vanished_at IS NULL AND d.excluded_reason IS NOT NULL GROUP BY 1) x),
    'recent_batches', (SELECT coalesce(jsonb_agg(jsonb_build_object('batch_id', b.batch_id, 'source', b.source, 'mode', b.mode,
                                                                    'received_at', b.received_at, 'exported_at', b.exported_at,
                                                                    'counts', b.counts,
                                                                    'status', b.result->>'status',
                                                                    'docs', b.result->'docs',
                                                                    'rejected', jsonb_array_length(coalesce(b.result->'rejected', '[]'::jsonb)))
                                                 ORDER BY b.received_at DESC), '[]'::jsonb)
                         FROM (SELECT * FROM public.stock_sigma_batches ORDER BY received_at DESC LIMIT 10) b))
$fn$;

COMMENT ON FUNCTION public.stock_sigma_status() IS
  'Stock v2: the Sigma feed at a glance (GET stock/v2/sigma/status) — last batch / connector / CSV, staged / included / excluded / vanished documents, re-dated documents, drafts, newest balances, the last 10 batches. No money. Migration 20260945000650.';

-- ── 8. a rule or a document type changed (here, or through stock_v2_config_set) → re-decide every document ──
CREATE OR REPLACE FUNCTION public.tg_stock_sigma_reclassify()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
BEGIN
  PERFORM public.stock_sigma_docs_reclassify(NULL);
  RETURN NULL;
END
$fn$;

COMMENT ON FUNCTION public.tg_stock_sigma_reclassify() IS
  'After any write to stock_sigma_rules or stock_sigma_doc_types: stock_sigma_docs.excluded_reason is re-decided for every staged document, whichever writer changed the rules. Migration 20260945000650.';

DROP TRIGGER IF EXISTS trg_stock_sigma_rules_reclassify ON public.stock_sigma_rules;
CREATE TRIGGER trg_stock_sigma_rules_reclassify
  AFTER INSERT OR UPDATE OR DELETE ON public.stock_sigma_rules
  FOR EACH STATEMENT EXECUTE FUNCTION public.tg_stock_sigma_reclassify();
DROP TRIGGER IF EXISTS trg_stock_sigma_doc_types_reclassify ON public.stock_sigma_doc_types;
CREATE TRIGGER trg_stock_sigma_doc_types_reclassify
  AFTER INSERT OR UPDATE OR DELETE ON public.stock_sigma_doc_types
  FOR EACH STATEMENT EXECUTE FUNCTION public.tg_stock_sigma_reclassify();

-- ── grants ──────────────────────────────────────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.stock_sigma_company_name(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.stock_sigma_jtext(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.stock_sigma_norm_lines(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.stock_sigma_rule_matches(jsonb, public.stock_sigma_docs) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.stock_sigma_doc_exclusion(public.stock_sigma_docs) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.stock_sigma_docs_reclassify(text[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.stock_sigma_line_kind(text, text, text, text, numeric) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.stock_sigma_ingest(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.stock_sigma_rule_set(jsonb, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.stock_sigma_effective_lines(date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.stock_sigma_status() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tg_stock_sigma_reclassify() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.stock_sigma_company_name(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.stock_sigma_jtext(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.stock_sigma_norm_lines(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.stock_sigma_rule_matches(jsonb, public.stock_sigma_docs) TO service_role;
GRANT EXECUTE ON FUNCTION public.stock_sigma_doc_exclusion(public.stock_sigma_docs) TO service_role;
GRANT EXECUTE ON FUNCTION public.stock_sigma_docs_reclassify(text[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.stock_sigma_line_kind(text, text, text, text, numeric) TO service_role;
GRANT EXECUTE ON FUNCTION public.stock_sigma_ingest(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.stock_sigma_rule_set(jsonb, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.stock_sigma_effective_lines(date) TO service_role;
GRANT EXECUTE ON FUNCTION public.stock_sigma_status() TO service_role;
DO $ro$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_read_only_user') THEN
    GRANT EXECUTE ON FUNCTION public.stock_sigma_status() TO supabase_read_only_user;
    GRANT EXECUTE ON FUNCTION public.stock_sigma_effective_lines(date) TO supabase_read_only_user;
  END IF;
END
$ro$;

-- the staged documents re-decided against the seeded rules / types (a no-op on an empty staging)
SELECT public.stock_sigma_docs_reclassify(NULL);

COMMIT;
