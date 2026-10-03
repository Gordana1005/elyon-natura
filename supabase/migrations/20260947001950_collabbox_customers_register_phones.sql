-- collabBox komitent phones (owner, Mile, 03.10.2026) — the cohort counts a 10111 LEADS booking on its
-- booking day only with the customer's phone (20260947001850), and the komitent-card lookup of
-- collabbox-sync found nothing from 29.09 to 03.10 (the Коминтенти search ignored its filter — fixed in
-- the function the same night: the form is sent as the operators' "Барај" sends it).
--
--   "Зошто сите 166 иљади … нели треба да внесеме само тоа што недостасува?" — load ONLY what is missing.
--
-- 1. public.collabbox_customers.source accepts 'register_YYYYMMDD': a phone taken from a dated harvest of
--    the collabBox komitent register (exports/collabbox/collab-out-2026-10-01/komitenti_full.csv →
--    source 'register_20261001'), loaded by scripts/load-komitent-register-phones.mjs ONLY for the
--    komitenti of our sales documents (10111 · 10114 · 10036 · 10050 · 10106 · 10055) that no reader can
--    place (no 8-digit phone on a card, in the teleshop registry or on any stored row). Such a row is NOT a
--    card: the writer (collabbox_apply_one) reads cards (source 'card') and parcel rows (source 'parcel')
--    only, so it ignores it; insights_sale_rows' bk0 reads it through its third source ("any stored
--    card"); a real card read later replaces it (the writer's ON CONFLICT … source = 'card'). Rows are
--    insert-only (ON CONFLICT DO NOTHING — never over a card or a parcel row), with skip_reason NULL (a
--    komitent the card verdict would skip — employee, company, deceased, test, wrong number — is not
--    loaded) and run_id = the data_repair_runs id of the load. Rollback of a load:
--      node scripts/load-komitent-register-phones.mjs --rollback <run> --apply
--    (= DELETE … WHERE source = 'register_YYYYMMDD' AND run_id = <run>).
-- 2. public.collabbox_komitenti_needed: priority 1 = no phone ANYWHERE (no parcel phone and no stored
--    phone of any source), 2 = a parcel / register / parcel-registry phone exists (the card only confirms
--    it or brings a verdict). The function now also receives 10111 LEADS documents (index.ts, 03.10).
--    Signature, return shape and grants unchanged.
--
-- Rollback of this migration (after rolling back every register load):
--   ALTER TABLE public.collabbox_customers DROP CONSTRAINT collabbox_customers_source_check;
--   ALTER TABLE public.collabbox_customers ADD CONSTRAINT collabbox_customers_source_check
--     CHECK (source IN ('card', 'parcel'));
--   and the 20260942000900 body of collabbox_komitenti_needed (§15).

ALTER TABLE public.collabbox_customers DROP CONSTRAINT IF EXISTS collabbox_customers_source_check;
ALTER TABLE public.collabbox_customers ADD CONSTRAINT collabbox_customers_source_check
  CHECK (source IN ('card', 'parcel') OR source ~ '^register_[0-9]{8}$');

COMMENT ON TABLE public.collabbox_customers IS
  'collabBox komitent cards the sync read (2026-09-28): phone8 (strict Macedonian NSN, Мобилен first), name, city, address, the skip verdict (employee · company · deceased · wrong_number · test) and flags (do_not_contact). source parcel = no card, the phone a parcel of its document carried. source register_YYYYMMDD = a phone from that day''s harvest of the komitent register, loaded only for komitenti of our sales documents no reader could place (scripts/load-komitent-register-phones.mjs, run_id = its data_repair_runs id; not a card — the writer ignores it, a card read later replaces it; 20260947001950). PII — business owners only; written by the collabbox-sync writer and that loader only.';

-- ── which komitent cards the sync must read ───────────────────────────────────
CREATE OR REPLACE FUNCTION public.collabbox_komitenti_needed(p_docs jsonb)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  SELECT coalesce(jsonb_agg(jsonb_build_object('komitent_id', k.kom, 'priority', k.pri) ORDER BY k.pri, k.kom), '[]'::jsonb)
    FROM (SELECT x.kom,
                 min(CASE WHEN public.collabbox_mk_phone8(p.phone8) IS NULL
                           AND NOT EXISTS (SELECT 1 FROM public.collabbox_customers s
                                            WHERE s.komitent_id = x.kom AND public.collabbox_mk_phone8(s.phone8) IS NOT NULL)
                          THEN 1 ELSE 2 END) AS pri
            FROM (SELECT DISTINCT nullif(btrim(e ->> 'komitent_id'), '') AS kom, nullif(btrim(e ->> 'doc_number'), '') AS doc
                    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_docs) = 'array' THEN p_docs ELSE '[]'::jsonb END) e) x
            LEFT JOIN public.mex_parcels p ON p.tracking_id = x.doc
           WHERE x.kom IS NOT NULL AND x.kom ~ '^[0-9]{1,10}$'
             AND NOT EXISTS (SELECT 1 FROM public.collabbox_customers c WHERE c.komitent_id = x.kom AND c.source = 'card')
             AND NOT EXISTS (SELECT 1 FROM public.teleshop_import_customers t
                              WHERE t.komitent_id = x.kom
                                AND (public.collabbox_mk_phone8(t.phone8) IS NOT NULL OR t.outcome = 'skipped'))
             AND NOT EXISTS (SELECT 1 FROM public.orders o
                              WHERE o.external_source = 'collabbox' AND o.external_order_id = x.doc)
           GROUP BY x.kom) k;
$fn$;

COMMENT ON FUNCTION public.collabbox_komitenti_needed(jsonb) IS
  'collabbox-sync: the komitent ids whose card the sync should read ([{komitent_id, priority}], 1 = no phone anywhere — no parcel phone, no stored phone of any source; 2 = a parcel / register / parcel-registry phone exists), from [{doc_number, komitent_id}] of order AND 10111 LEADS documents. Migrations 20260942000900, 20260947001950.';
