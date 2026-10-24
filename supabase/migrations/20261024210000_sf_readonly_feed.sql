-- ============================================================================
-- sf_readonly_feed — THE READ-ONLY WINDOW FOR SALESFORCE (owner 24.10.2026: "Читање од naturall")
--
-- naturall is the writer of the MK courier outcomes in Salesforce: every 15 minutes Salesforce READS this
-- window through PostgREST as the role sf_reader and never writes back (Salesforce repo
-- elyoncoding/natura-salesforce: D-MEX-LIVE-FEED.md §3.1 / §3.2 / §8, GAP-08 / GAP-09, the Apex
-- NaturallClient / NaturallFetchQueueable / NaturallReconcileJob, contracts/mk-courier-outcome/).
-- The Apex is the source of truth for the names: it asks for the columns BY NAME and fails a row on any
-- missing one.
--
-- ADDITIVE ONLY. It adds:
--   table    sf_change_log        seq bigserial, order_id, tracking_id, changed_at (clock_timestamp()).
--                                 Written ONLY by the statement-level triggers below; Salesforce reads
--                                 seq > cursor, changed_at < now − 2 min, order by seq.
--   table    sf_review_orders     the 1.606 orders the 03–04.10.2026 history repairs left for a person
--                                 (the hand-over's review_orders.csv: order id + reason, no personal data);
--                                 read only by sf_order_outcome_v (review_reason = 'review_orders:<reason>').
--   view     sf_order_outcome_v   the 27 contract columns + created_at (the reconcile's 400-day filter):
--                                 one row per MK order whose proof is not empty (it holds a MEX parcel, or
--                                 is paid / returned / shipped); test phones 70123456 / 23123123 excluded.
--   view     sf_parcel_v          the 19 contract columns: one row per mex_parcels row (test phones
--                                 excluded). No receiver name, no full phone (phone_last8 only), no address.
--   triggers AFTER INSERT / UPDATE on orders, AFTER INSERT / UPDATE / DELETE on mex_parcels, FOR EACH
--            STATEMENT with transition tables (the order_products pattern, 20261022120000): one set-based
--            INSERT into sf_change_log per statement, only for rows whose outcome columns changed
--            (IS DISTINCT FROM), so a repair that keeps updated_at (elyon.keep_updated_at) is caught too.
--            A failure is a WARNING, never a failed order / parcel write (one sub-transaction per
--            STATEMENT, not per row).
--   role     sf_reader            NOLOGIN, reached only through PostgREST (GRANT sf_reader TO
--                                 authenticator) with a JWT whose role claim is sf_reader;
--                                 default_transaction_read_only = on, statement_timeout = 30s;
--                                 SELECT on the three objects above and nothing else (+ USAGE on schema
--                                 public and EXECUTE on the pure cohort_order_bucket(), which a view's
--                                 caller needs: functions in a view run with the caller's rights).
-- It changes NO existing column, function, trigger, policy, cron or code path. anon / authenticated get
-- nothing (the schema's default privileges are revoked on every new object).
--
-- THE CONTRACT (exact, proven by scripts/sf-feed/verify-sf-feed-parity.py against the Salesforce repo's
-- migration/trial/courier_contract.py on the same snapshot — 0 differences required):
--   order_key        ALTERCPA:<external_order_id> / CBOX:<external_order_id> / MKCRM:<display_id>
--   current parcel   the mex_parcels row the order holds whose tracking_id = orders.mex_tracking_id; else
--                    the newest last_update_at, then tracking_id (deterministic); mex_* come from THAT row
--   bucket           cohort_order_bucket(...) on the order row, exactly as the Salesforce extract reads it
--   proof            mex_parcel (parcel at MEX 2/7) · mex_parcel_open · the hand-over §3 package proof
--                    (collabbox_courier_flag / mex_register_unlinked: export_clean_handover.py's PROOF + EV,
--                    computed live) · none (paid / returned / shipped without either) · '' = not in the view
--   decider          the newest AlterCPA decision's decided_by_altercpa_user (decided_at desc, id desc)
--   times            timestamptz in the view; in the hashes 'YYYY-MM-DDTHH:MM:SS.000Z' UTC, fraction cut
--   outcome_hash / parcel_hash = md5 of the canonical JSON of every other contract column (keys sorted,
--                    no spaces, UTF-8, non-ASCII raw, price as its text) = courier_contract.canon_hash.
--
-- KNOWN LIMITS (documented for Salesforce):
--   · an AlterCPA decision written to altercpa_leads WITHOUT a change of the order's outcome columns is
--     not logged (decider_altercpa_user); the nightly NaturallReconcileJob (Apply mode) catches it.
--   · a transaction that runs longer than Salesforce's 2-minute lag commits log rows behind the cursor;
--     the same reconcile catches them.
--   · review_reason holds only the 03–04.10.2026 review list (as the contract's interim script does);
--     the linker's manual lists are not in it yet (a contract change on both sides).
--
-- SEED (Salesforce's T0 was 22.10.2026 ~04:40 UTC): at the end of this migration, in the same
-- transaction as the triggers (no gap), every MK order / parcel that changed since 22.10.2026 04:00 UTC
-- is written to sf_change_log once (only when the log is still empty).
--
-- ROLLBACK (removes everything this file adds; triggers first, so no order write can hit a missing table):
--   BEGIN;
--   DROP TRIGGER IF EXISTS sf_change_log_orders_ins ON public.orders;
--   DROP TRIGGER IF EXISTS sf_change_log_orders_upd ON public.orders;
--   DROP TRIGGER IF EXISTS sf_change_log_parcels_ins ON public.mex_parcels;
--   DROP TRIGGER IF EXISTS sf_change_log_parcels_upd ON public.mex_parcels;
--   DROP TRIGGER IF EXISTS sf_change_log_parcels_del ON public.mex_parcels;
--   DROP FUNCTION IF EXISTS public.tg_sf_change_log_orders();
--   DROP FUNCTION IF EXISTS public.tg_sf_change_log_parcels();
--   DROP VIEW IF EXISTS public.sf_order_outcome_v;
--   DROP VIEW IF EXISTS public.sf_parcel_v;
--   DROP TABLE IF EXISTS public.sf_change_log;
--   DROP TABLE IF EXISTS public.sf_review_orders;
--   REVOKE EXECUTE ON FUNCTION public.cohort_order_bucket(text, numeric, timestamptz, text, text, text, text,
--     integer, integer, timestamptz, boolean) FROM sf_reader;
--   REVOKE USAGE ON SCHEMA public FROM sf_reader;
--   REVOKE sf_reader FROM authenticator;
--   DROP ROLE IF EXISTS sf_reader;
--   NOTIFY pgrst, 'reload schema';
--   COMMIT;
-- Instant stop without a rollback: REVOKE sf_reader FROM authenticator (every sf_reader JWT then gets 401).
-- ============================================================================

BEGIN;

SET LOCAL lock_timeout = '10s';

-- ── the role ────────────────────────────────────────────────────────────────
DO $r$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sf_reader') THEN
    CREATE ROLE sf_reader NOLOGIN NOINHERIT;
  END IF;
END
$r$;
ALTER ROLE sf_reader SET default_transaction_read_only = on;
ALTER ROLE sf_reader SET statement_timeout = '30s';
GRANT sf_reader TO authenticator;
GRANT USAGE ON SCHEMA public TO sf_reader;

-- ── the change log ──────────────────────────────────────────────────────────
-- No foreign key, no constraint but the key, every column nullable: an INSERT here cannot fail for a
-- reason an order / parcel write would not also fail for.
CREATE TABLE IF NOT EXISTS public.sf_change_log (
  seq         bigserial   PRIMARY KEY,
  order_id    uuid,
  tracking_id text,
  changed_at  timestamptz NOT NULL DEFAULT clock_timestamp()
);
COMMENT ON TABLE public.sf_change_log IS
  'Salesforce read-only feed (20261024210000): one row per changed MK order / MEX parcel, written only by '
  'the tg_sf_change_log_* statement triggers. Read by the role sf_reader (seq > cursor). Never edit.';

ALTER TABLE public.sf_change_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sf_change_log_sf_reader ON public.sf_change_log;
CREATE POLICY sf_change_log_sf_reader ON public.sf_change_log FOR SELECT TO sf_reader USING (true);

REVOKE ALL ON public.sf_change_log FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.sf_change_log_seq_seq FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.sf_change_log TO service_role;
GRANT SELECT ON public.sf_change_log TO sf_reader;

-- ── the review list (03–04.10.2026, the hand-over's review_orders.csv) ─────
CREATE TABLE IF NOT EXISTS public.sf_review_orders (
  order_id uuid PRIMARY KEY,
  reason   text NOT NULL
);
COMMENT ON TABLE public.sf_review_orders IS
  'Salesforce read-only feed (20261024210000): the orders the 03-04.10.2026 history repairs left for a '
  'person (review_orders.csv of the clean hand-over). Read only by sf_order_outcome_v.';
ALTER TABLE public.sf_review_orders ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sf_review_orders FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.sf_review_orders TO service_role;

INSERT INTO public.sf_review_orders (order_id, reason) VALUES
  ('0041ccdd-edce-4037-80f8-4d7c04083e22', 'parcel_in_register_unlinked'),
  ('00abe7a0-7586-4792-8447-83cb48de6712', 'no_flag'),
  ('00b58293-938a-47e6-9dfa-6e426ac0f009', 'trace_unclaimed_parcel'),
  ('00fae12a-5968-4a54-977a-416422fdf464', 'audit_OK_PAID_PROVEN'),
  ('0101c096-67e6-4466-ae8d-374139a4b8c8', 'audit_OK_PAID_PROVEN'),
  ('0124bb2a-6469-4f04-be41-33cc867bef09', 'no_flag'),
  ('0199191e-4d68-470b-83eb-16131fd3106f', 'audit_OK_PAID_PROVEN'),
  ('01be7daa-3bbb-4661-bd74-ed3d44025327', 'audit_OK_DEAD_CUSTOMER_BOUGHT_ELSEWHERE'),
  ('01c6a55a-4eeb-46f2-961d-679f171e5900', 'no_flag'),
  ('01db3e24-f491-4a1a-9c77-a0822cb0d0ba', 'no_flag'),
  ('01f231f3-5a1e-4bb6-bbd5-48db1b16e000', 'resend_delivered'),
  ('0201209b-4133-4ef2-b66a-4245e3d824db', 'resend_delivered'),
  ('0216e05c-a81c-46fb-8d5f-6ea2dd0e86e8', 'audit_OK_PAID_PROVEN'),
  ('02290ef2-4bfc-4f24-88c7-0f112e5bc47c', 'twin_living_sale'),
  ('023399f8-69d0-4911-b804-101b5f4bd655', 'no_flag'),
  ('0237935a-7f6b-412f-9d61-42ebd16a390c', 'no_flag'),
  ('02acab4f-f20b-44ea-99f0-8aa7f70e3580', 'trace_unclaimed_parcel'),
  ('02e86c80-7d5a-497b-b2e2-c957eb89a0fc', 'trace_unclaimed_parcel'),
  ('02ea56aa-aa42-476c-a276-766caa2f8814', 'dead_as_duplicate'),
  ('03174984-8647-40a1-9593-c764c3326f30', 'audit_SET_CANCELLED_DUPLICATE'),
  ('032369e8-589e-4f50-ac08-592dc2ce038a', 'audit_SET_CANCELLED_DUPLICATE'),
  ('0371ad89-decb-43d0-ba97-c734f412b1b9', 'audit_SET_CANCELLED_DUPLICATE'),
  ('0393ec8c-3572-48d6-8ad7-4219abfb6d28', 'trace_unclaimed_parcel'),
  ('039ba602-b2da-4303-90a7-747ebe34075c', 'audit_SET_CANCELLED_DUPLICATE'),
  ('03e83792-a79a-4967-95ff-4ab6c7e731eb', 'parcel_in_register_unlinked'),
  ('04014277-4ebf-4797-83a0-06faf6675d37', 'resend_delivered'),
  ('040c6032-fc60-4839-9c25-67b21db3b5ed', 'resend_delivered'),
  ('04271343-b614-4532-b626-429bd64a8b93', 'already_proven'),
  ('0460adba-ffd4-4b5d-a779-9d948695925a', 'no_flag'),
  ('04715ea6-d38b-4285-abf7-b41393cfe002', 'no_flag'),
  ('049a3900-0fe3-47e9-b3ad-174610e2774f', 'no_flag'),
  ('04d013fc-2605-4ee5-8172-8475d6498977', 'twin_living_sale'),
  ('04e62324-8091-4c09-b1c9-cb0c79079392', 'resend_delivered'),
  ('04f16e93-6fcf-43e0-96b6-310be8ba2e80', 'no_flag'),
  ('050808d0-bfb6-4e59-ac23-17ddcf488600', 'no_flag'),
  ('051eb81f-6dd9-47b8-8581-9ace2df56b81', 'no_flag'),
  ('053050c2-991c-42a2-a85d-2ee2d88acd7a', 'resend_delivered'),
  ('0545c580-5b44-42fa-a4c3-b6d64fa11298', 'trace_unclaimed_parcel'),
  ('05924256-2355-4dd4-bac7-f97ad9514d6f', 'resend_delivered'),
  ('05b75c7c-dfa2-40b3-8821-0f5e891eafe8', 'parcel_in_register_unlinked'),
  ('05be7f6a-af9e-4706-b3e5-d2f8895ca333', 'resend_delivered'),
  ('05d72aa6-7810-4d85-95bc-d541b8440be3', 'parcel_in_register_unlinked'),
  ('05ee3d8d-8a5e-411c-8a32-1cf1188d928d', 'no_flag'),
  ('0662a265-e3e1-4761-832e-a43e208ddb5b', 'holds_mex_parcel'),
  ('066544ba-7296-4638-9d84-e289f2a40c6e', 'parcel_in_register_unlinked'),
  ('06816f3d-3e04-4a4c-9786-6d82e5e77b5f', 'resend_delivered'),
  ('06b83f89-5908-4125-96c5-628b29ebd69e', 'resend_delivered'),
  ('06f1726e-b687-4934-901e-f346323fcd37', 'audit_OK_PAID_PROVEN'),
  ('07551379-a41d-406f-a35f-3f66e4383c84', 'no_flag'),
  ('077e45bd-b6de-4fa3-b1d8-90825418796c', 'resend_delivered'),
  ('07bf4552-1e34-4adc-8857-27844aef055c', 'no_flag'),
  ('07df2dc0-94e8-4165-b3ae-ab7d6103b5c0', 'audit_OK_PAID_PROVEN'),
  ('07dfc208-aaaa-4231-b815-0013954bfe32', 'resend_delivered'),
  ('07e0e2a1-53e4-47fe-ab8f-942b07cdd877', 'trace_unclaimed_parcel'),
  ('07fe7303-6e2c-4341-9668-4cb4e3499178', 'no_flag'),
  ('083f997e-c0d8-4a2c-a855-a6fc7ce71f94', 'no_flag'),
  ('087948ac-3e16-4b7d-ba15-babe3e03a15c', 'twin_living_sale'),
  ('08882acf-5f1c-416e-aab7-2bed796012c0', 'dead_as_duplicate'),
  ('08a221d6-9fb6-4125-8a9d-ef10089378ff', 'parcel_in_register_unlinked'),
  ('08f3d835-7963-48e9-a480-4c314325e406', 'no_flag'),
  ('09585c54-4f8d-4b24-a6b5-5f7a98b5eba4', 'resend_delivered'),
  ('096103d1-9f44-42e2-9d46-536b970c6a59', 'audit_OK_PAID_PROVEN'),
  ('097f40aa-27da-4ad1-8d23-5b5f5b83a219', 'no_flag'),
  ('098ee9bb-7f78-4c82-852d-7bb04d571e11', 'same_price_twin'),
  ('0994d753-47cc-4c8c-aff7-465744b16251', 'trace_unclaimed_parcel'),
  ('09e21af2-2e5b-45c5-9a09-364aa35b6d06', 'audit_SET_RETURNED'),
  ('09e9d521-2ff2-40fd-9cc2-411461d6d177', 'no_flag'),
  ('0a5912a5-96f6-49f6-af52-49a38de506ad', 'resend_delivered'),
  ('0a96c1ba-2fb8-4342-8b24-986282fd7ad8', 'no_flag'),
  ('0aa0bc0e-d5fc-4809-8e50-d5d8a1ba6bf6', 'audit_OK_PAID_PROVEN'),
  ('0ad37760-5101-40b5-83cb-71c8cf9273a0', 'parcel_in_register_unlinked'),
  ('0b15d18e-3f81-4874-a4bc-641662a52da5', 'resend_delivered'),
  ('0bbad821-6603-40f0-b693-680a26c46aab', 'resend_delivered'),
  ('0bcd5c0a-34bb-43bf-96b2-374f58e9adbb', 'audit_OK_PAID_PROVEN'),
  ('0c17308c-0f7b-4eb0-a982-6e5891da2d80', 'resend_delivered'),
  ('0c547adb-43bf-49f9-8073-6b4c6a7cce89', 'parcel_in_register_unlinked'),
  ('0c8f5a9f-9af3-478e-84a1-970635eecf8b', 'dead_as_duplicate'),
  ('0ccc26e1-0730-405a-8abf-2a64e960ecdd', 'audit_SET_CANCELLED_DUPLICATE'),
  ('0cf0d0e3-2506-4bcd-87ca-6b5c97d7bcd4', 'no_flag'),
  ('0cf98f1f-aa6a-4095-a976-f85933c94ead', 'same_price_twin'),
  ('0d04b7c2-cf39-443e-a2f1-87ef605e07dc', 'twin_living_sale'),
  ('0d875818-b410-4bb9-8b7e-8c17a9f1e076', 'no_flag'),
  ('0df70dfd-c8dd-48dd-a154-c2747818a17a', 'no_flag'),
  ('0e12a3a2-d557-428a-9cfe-8355269db40f', 'resend_delivered'),
  ('0e6927cd-fdf2-403b-8986-633d32fdad58', 'audit_OK_PAID_PROVEN'),
  ('0e6b80a3-42b3-497d-a138-550f2dccdc8a', 'parcel_in_register_unlinked'),
  ('0e7576a9-3939-4751-84a1-55ff6b0a4416', 'already_proven'),
  ('0e76771c-60b2-47e0-99f5-fdd1e564ff91', 'no_flag'),
  ('0ec68a4c-93f7-4764-aab7-777be544a42c', 'no_flag'),
  ('0ecb3d32-9f44-43a1-ab89-d0b62df32ffa', 'audit_OK_PAID_PROVEN'),
  ('0edec088-a368-4d1f-8c65-6d0640b63a1b', 'no_flag'),
  ('0f0111df-f5ed-4ef3-8f06-7dab23638d54', 'own_document_no_flag'),
  ('0f1bc628-fc40-4046-8863-21e690b0f36a', 'no_flag'),
  ('0f8439f8-e890-4e19-94a3-0fd06d62de44', 'no_flag'),
  ('0fa505c4-f3c6-477f-8e4f-cea95c227c68', 'dead_as_duplicate'),
  ('0fe5c50e-7dc7-4199-afc9-ede84cfbbb9c', 'audit_SET_CANCELLED_DUPLICATE'),
  ('1017202e-c08d-429f-809d-63f767209a29', 'no_flag'),
  ('10a4a473-4ade-4fae-8e6d-eea3d2f45bf5', 'no_flag'),
  ('10afe3cd-2471-4bf9-85ad-1f498c6f6d3b', 'parcel_in_register_unlinked'),
  ('10c589d8-c4de-45b4-a27e-fecdee91329a', 'holds_mex_parcel'),
  ('10cb4534-4847-4e22-b438-facf2470aad5', 'audit_SET_CANCELLED_DUPLICATE'),
  ('1104efbe-3b2c-44cc-86ff-c425ea83e530', 'trace_unclaimed_parcel'),
  ('11566f0f-f9f2-450a-a9e4-50cf0cc457a2', 'no_flag'),
  ('11609f5a-bad6-4cd3-92bd-b3b4bf76bc8b', 'resend_delivered'),
  ('118e2df7-1db8-4aa3-a092-72f9ab231d2c', 'no_flag'),
  ('119ec2d3-3588-4876-8977-31168da09776', 'resend_delivered'),
  ('11ceacd4-3952-4b18-a303-14f81add93ef', 'resend_delivered'),
  ('11d49169-8c06-44c8-b0d8-66a85c8d8eb9', 'no_flag'),
  ('12280382-a5f7-4cc0-815c-3d0b6f20fa3d', 'resend_delivered'),
  ('124344bb-b587-4561-be6a-32ed6abd79c5', 'no_flag'),
  ('12de7037-970a-4ff7-b2dc-08e2631c2804', 'twin_living_sale'),
  ('12e3d700-18e0-4f96-9e40-73acb44286eb', 'resend_delivered'),
  ('133f2185-c9f9-4726-8a0b-b1959b89ef28', 'parcel_in_register_unlinked'),
  ('136e9d36-7afe-42da-bdc8-c312c7e83be2', 'dead_as_duplicate'),
  ('137b45ea-d957-4857-bc81-94a506373a4f', 'twin_living_sale'),
  ('1390d300-b952-40ea-af29-115380dab973', 'no_flag'),
  ('13993ef9-fd5d-4dba-aef0-3e4f6cb8c745', 'no_flag'),
  ('13bf08cc-6f56-4f4a-97c6-985c6d3186f7', 'holds_mex_parcel'),
  ('13f871eb-8755-49d6-b30d-a7f00ad06cb5', 'dead_as_duplicate'),
  ('13fa0815-9e1b-4fd5-8c5d-fa7b1fe5e1c3', 'audit_SET_CANCELLED_DUPLICATE'),
  ('1450bb6c-992a-4c30-b306-8ce15d353481', 'no_flag'),
  ('145b1b15-306b-49f2-be31-a2bb6d9c43f9', 'dead_as_duplicate'),
  ('146a5e40-998b-49a4-adcc-25d38a96edae', 'resend_delivered'),
  ('14d4755b-4802-4a1f-b892-e21ad21f4dfb', 'twin_living_sale'),
  ('14ea0393-9ea2-4b46-8d94-e70a4fef473f', 'trace_unclaimed_parcel'),
  ('14ebca10-bc8c-44ad-b699-7f8fa5f47240', 'no_flag'),
  ('150c0394-2018-4fe4-8db0-61e2ea0bbc99', 'parcel_in_register_unlinked'),
  ('15772c74-9371-4608-94ca-efbe9ec3a029', 'audit_OK_PAID_PROVEN'),
  ('15b50f34-dce9-47cf-9bc2-f27f4b31c070', 'audit_OK_PAID_PROVEN'),
  ('15d7550a-4b07-4b8e-9fa3-7306cb32c8d7', 'audit_REVIEW_DEAD_BUT_DELIVERED'),
  ('15ebf04f-bad7-4d49-a813-afeb7521d2c2', 'no_flag'),
  ('163ba8e4-f0fb-4567-a00e-b933d5e041ff', 'audit_SET_RETURNED'),
  ('16439608-311e-4e8f-a56d-28e4ffc0263e', 'trace_unclaimed_parcel'),
  ('16837da3-cfaf-472d-baa5-93b0b44c6fca', 'resend_delivered'),
  ('168eb994-0fa6-459d-90bc-e87f6daf564a', 'resend_delivered'),
  ('1695eeb9-98bd-4f4d-8df0-060ba803a0d1', 'resend_delivered'),
  ('169d8746-322c-4068-811a-89c4ca65426b', 'twin_living_sale'),
  ('16e269c4-ef80-435d-b630-6497ed70aa63', 'audit_OK_PAID_PROVEN'),
  ('16f67199-9a10-4a99-97a6-94dd2c93e415', 'trace_unclaimed_parcel'),
  ('17301c6c-f511-4914-a65c-2caac86a1bcf', 'dead_as_duplicate'),
  ('176b1f85-5be0-4e6f-b2f4-c308beb6b885', 'same_price_twin'),
  ('176b3613-8002-441a-ba6f-2585e160136d', 'audit_OK_PAID_PROVEN'),
  ('17b91756-0f27-4ec9-97d7-08e14974ddce', 'twin_living_sale'),
  ('17be0e4c-4882-46e4-841c-5e397fb9b02d', 'trace_unclaimed_parcel'),
  ('1819ea23-4efb-4ffb-8d48-d6e6e0050e7c', 'same_price_twin'),
  ('186e509a-7b74-493a-ae47-eae15a2a4c7f', 'already_proven'),
  ('1888e871-8a97-4b45-9e88-3767265ec9da', 'no_flag'),
  ('18aff569-890a-4799-bf28-087a078bfa68', 'resend_delivered'),
  ('190ec2ab-b6c8-4e6b-9381-81e1bcd49337', 'no_flag'),
  ('193a0c06-42ba-48f4-b8e8-7dbf2f97bc43', 'dead_as_duplicate'),
  ('19a5ed2e-1c54-44e2-8293-4b9660cf5657', 'already_proven'),
  ('19a831c0-9241-45f5-8350-927a02102e44', 'no_flag'),
  ('1a01ae90-4747-41b8-ba0f-f410ee911f72', 'no_flag'),
  ('1a6be07b-4ef7-4d0b-9ad1-c04553104d14', 'no_flag'),
  ('1a705049-04e5-40e9-bb03-872469cc904a', 'parcel_in_register_unlinked'),
  ('1a8e2ea4-19e8-4c78-917a-b274ded86d19', 'audit_OK_PAID_PROVEN'),
  ('1a969ae9-30d0-4790-8ab8-bc6108e4c16c', 'trace_unclaimed_parcel'),
  ('1aa818bd-bf1b-4a50-b287-6cf340921576', 'parcel_in_register_unlinked'),
  ('1ab76927-7758-4db9-8e39-6080c97b6c35', 'parcel_in_register_unlinked'),
  ('1b0130c4-dbcf-479b-9f88-6ea4eeb7f6e4', 'holds_mex_parcel'),
  ('1b1408fc-8460-4a74-b929-fb40dcf76fc8', 'no_flag'),
  ('1b2ca5fe-f2a9-4be0-a8e9-9a9b96c30054', 'parcel_in_register_unlinked'),
  ('1b3a6d90-a277-4178-8fab-96ac1808e300', 'already_proven'),
  ('1b44ead8-cbab-4a6a-b80d-e844db5fa88d', 'twin_living_sale'),
  ('1b8876a8-9ddd-4912-9ed6-0ca55fee3912', 'resend_delivered'),
  ('1b98afe9-e588-46f0-9f6e-2dbec8b8aa27', 'no_flag'),
  ('1bb6a995-c649-48e6-adad-e48b813e1058', 'trace_unclaimed_parcel'),
  ('1c27664e-fa6d-47d6-bac2-00e225674727', 'resend_delivered'),
  ('1c8559ba-26c1-4788-ae74-55e0a98c7e06', 'no_flag'),
  ('1d972eaa-0c01-493c-bdf1-f2b5fb1f8648', 'no_flag'),
  ('1df7c988-5fea-4116-8141-216ce209c6db', 'no_flag'),
  ('1e055a5b-51e4-4f9e-9053-0e2daefb36fa', 'parcel_in_register_unlinked'),
  ('1e156db3-0fdd-4c17-aaff-c619a64d6bdc', 'no_flag'),
  ('1e5833d7-df74-4b97-a064-9ad16f68576b', 'audit_OK_PAID_PROVEN'),
  ('1e589151-352d-4982-9d54-9ca1d428bf61', 'no_flag'),
  ('1e7d6648-3bb5-4926-a046-445222c20879', 'trace_unclaimed_document'),
  ('1e7e324c-e977-4eda-88d7-de8ff637da61', 'twin_living_sale'),
  ('1e8d18e2-595d-4d0b-a0ce-ba7d45e5a1d3', 'audit_OK_PAID_PROVEN'),
  ('1ea45a8a-d8f8-44ad-ab06-86344a2e0e1d', 'audit_OK_PAID_PROVEN'),
  ('1eaca5d1-2315-4a35-bb82-be3feffaa66f', 'resend_delivered'),
  ('1eb4f39f-ef34-4e46-92eb-0026c8d2c8fd', 'audit_OK_PAID_PROVEN'),
  ('1eca17be-d069-4208-a1d0-262ed01662ea', 'parcel_in_register_unlinked'),
  ('1f433df8-4586-4582-b05c-20a997d682ea', 'no_flag'),
  ('1f435a29-2915-4c70-a141-c75f89eb764a', 'no_flag'),
  ('1fa70858-ae87-4e59-ab91-cd3a88720668', 'parcel_in_register_unlinked'),
  ('1fc6c59d-a916-4374-a513-0e0797187f3f', 'no_flag'),
  ('1fe190ca-59d9-4352-8cf7-3d7e6f52421c', 'parcel_in_register_unlinked'),
  ('1fec6e4c-84bf-475f-b964-d699489bcdad', 'no_flag'),
  ('20065e0c-0bf5-482b-897d-dd77dd5e26be', 'no_flag'),
  ('20202abe-4815-45f7-99a6-7c78aa1057d1', 'audit_SET_RETURNED'),
  ('2027bb41-c43b-4661-ab86-ab61c082671a', 'twin_living_sale'),
  ('202d48a5-0782-47e9-b4d0-5a4f6a04c104', 'no_flag'),
  ('203e2835-34f5-497e-8177-94b2af1b1e09', 'resend_delivered'),
  ('203e60c2-a8dc-4c91-9b48-ff9308f17079', 'resend_delivered'),
  ('2076d589-ac11-4c12-a2fe-1abccefd6fbc', 'audit_OK_PAID_PROVEN'),
  ('20836d33-f41d-4194-abbf-b8aa6ee2f949', 'audit_OK_PAID_PROVEN'),
  ('2094e3d0-3aac-49fb-a135-0c2babd9f187', 'resend_delivered'),
  ('20a76fec-0e8c-418f-a8c8-bcabe359ea47', 'audit_SET_CANCELLED_DUPLICATE'),
  ('211458b1-71ca-4746-9e5f-6e787475fea6', 'resend_delivered'),
  ('2133426c-6105-4276-90f4-5d05bfee72c0', 'resend_delivered'),
  ('216cb93c-f3fe-4393-9c6f-905579105641', 'twin_living_sale'),
  ('218a1704-09c3-4360-8359-6dc80ad5670d', 'resend_delivered'),
  ('21e26f29-a7c8-448f-b900-e1f99f40899b', 'no_flag'),
  ('22230aca-b0ae-4dd9-bebe-270ef0d9d987', 'audit_OK_PAID_PROVEN'),
  ('2235c8e6-f42a-4308-b17e-d719bc091e7d', 'audit_SET_RETURNED'),
  ('22a6fcb0-defd-4ff1-865e-5a1bfe643bb6', 'twin_living_sale'),
  ('22cb27ff-cfd8-4896-aaa5-b76bf063ab57', 'resend_delivered'),
  ('22d100bf-8a95-4497-841a-44c98500910a', 'name_match_collabbox'),
  ('22d7193d-f331-4f83-a4d0-8df0aec4d885', 'no_flag'),
  ('23228de9-8cb7-4419-a819-f3d3937fc7e3', 'no_flag'),
  ('2378a7a7-0d6e-4ebf-8f39-8afbf0b9fe08', 'no_flag'),
  ('2379022f-6890-4d40-b0f9-f4523de7d25c', 'trace_unclaimed_parcel'),
  ('23a2cdf3-19ce-44bf-8a86-873835da1643', 'no_flag'),
  ('23e9b3bb-a22f-4958-bcd3-93da1d99934f', 'audit_SET_RETURNED'),
  ('24085a7f-0403-4d17-ae1a-39766d530149', 'resend_delivered'),
  ('24227d79-cc23-4a1d-b772-472714c3f30a', 'audit_OK_PAID_PROVEN'),
  ('2432d644-2363-433f-a29b-a1c9f8450b81', 'parcel_in_register_unlinked'),
  ('24485d86-5986-495e-9819-b9eabd6356ba', 'audit_SET_CANCELLED_DUPLICATE'),
  ('24a938b7-55d3-4f21-828d-03aa0ae5de6f', 'no_flag'),
  ('24f18fe7-ace2-4f60-9178-1af83f8ae699', 'resend_delivered'),
  ('25386b1d-e052-4c45-a062-32a4cc8c45ff', 'resend_delivered'),
  ('258326a7-c2a1-4cf8-9bbf-8052709467b7', 'parcel_in_register_unlinked'),
  ('2589a81c-fd99-4769-800f-05b321f2294c', 'trace_unclaimed_parcel'),
  ('258fdf1a-7ac3-4ca2-b903-361287c65917', 'resend_delivered'),
  ('25910270-2bb7-421f-8ddc-f98b761813aa', 'audit_SET_CANCELLED_DUPLICATE'),
  ('25c9f932-c706-43cc-8773-2f388912d446', 'audit_OK_PAID_PROVEN'),
  ('25d88f72-f461-46a9-b61b-30187e9823b8', 'no_flag'),
  ('261a6fd9-71a4-495f-8e42-f08f5cba64d8', 'parcel_in_register_unlinked'),
  ('26680b63-3407-4121-9a89-b2932b3a35f1', 'no_flag'),
  ('26834393-e677-4ac0-81e3-b34ea9731f7c', 'resend_delivered'),
  ('26ac97ad-ddcb-47ad-a76e-913cb08b3ed6', 'twin_living_sale'),
  ('26b78f55-a8df-4e18-b7bd-93ce36c0f3fc', 'dead_as_duplicate'),
  ('26ee7d82-3195-4dd2-8b60-cc6236696d70', 'dead_as_duplicate'),
  ('27133454-1db3-4689-8107-9dc82e021ab6', 'twin_living_sale'),
  ('2729dae2-d351-4e3b-8a67-69b09ef40c09', 'dead_as_duplicate'),
  ('27491196-1bba-48fa-83d7-2532638275bc', 'resend_delivered'),
  ('276715a2-0d44-4872-87e9-2d5079376e68', 'no_flag'),
  ('27701821-6887-40af-85f9-d61faf852977', 'resend_delivered'),
  ('27cd25e3-b52e-48ad-8e4a-442f687fb088', 'no_flag'),
  ('27ea5c77-c0dd-48ae-bbf1-fa15aeabe21e', 'name_match_collabbox'),
  ('27fe14a7-4b9a-4312-a110-8e8171907bb3', 'no_flag'),
  ('281eb356-dfa2-4f2e-a34f-86b67705428e', 'audit_OK_PAID_PROVEN'),
  ('28439aba-69cd-4043-a52b-dbffc45498ea', 'no_flag'),
  ('28a0bd8d-d1be-45de-8739-ef70c80c9fce', 'parcel_in_register_unlinked'),
  ('28c1dc64-783e-4c77-bf49-092c59c657ec', 'resend_delivered'),
  ('28d68ad1-a47f-4c60-a53e-357865891278', 'parcel_in_register_unlinked'),
  ('28de2240-d160-42df-a6cf-3ffea333fb75', 'parcel_in_register_unlinked'),
  ('29270abb-1b09-4f8b-aa11-730d93c77f46', 'trace_unclaimed_parcel'),
  ('2967e9c0-dee7-4921-9b97-28d74b25b8eb', 'parcel_in_register_unlinked'),
  ('298cd206-b2dc-4a79-93ea-14976afc2fc2', 'no_flag'),
  ('2995c375-4457-48e6-b7f8-a8d3f3fe8e22', 'resend_delivered'),
  ('29a3e4c5-cde4-4664-978e-9f1014b834e7', 'twin_living_sale'),
  ('29bc5e0c-c15f-4ede-a77e-d63576013c1d', 'parcel_in_register_unlinked'),
  ('29f4225d-74ed-4c35-8a9e-0e4442807067', 'resend_delivered'),
  ('2a3cf218-32c2-4bd3-9170-a74b69d6a414', 'no_flag'),
  ('2a773d53-1bda-4b81-ba51-b5137b142847', 'already_proven'),
  ('2aa2c5c1-5446-4eef-81b2-80e669c79bd1', 'twin_living_sale'),
  ('2b151657-8e03-46b3-9d60-bc47f966dd21', 'twin_living_sale'),
  ('2b196e83-eb72-418f-965f-64c9197eba2f', 'trace_unclaimed_parcel'),
  ('2b19a88d-62fa-4a55-a890-eb73c9484218', 'resend_delivered'),
  ('2b38f571-48a8-4743-90ef-a2955dafede5', 'same_price_twin'),
  ('2b44ba83-1dd3-4ade-b562-d2799043254e', 'twin_living_sale'),
  ('2b563f14-91a3-4191-b6d9-a7452ae0ff7f', 'trace_unclaimed_parcel'),
  ('2bd06921-60b4-481e-99f0-799968465913', 'resend_delivered'),
  ('2bf2b0de-d5b4-474e-8fc2-21bfd467c310', 'parcel_in_register_unlinked'),
  ('2bf6058a-db61-432f-bb3a-f77dad4ebc46', 'parcel_in_register_unlinked'),
  ('2c427900-e420-49ce-9c69-984b26fb9f67', 'audit_OK_PAID_PROVEN'),
  ('2c8b20a7-43f4-4fef-9253-1d907bbeedde', 'resend_delivered'),
  ('2c90e9f0-f689-4a9f-9c32-d5b672104885', 'no_flag'),
  ('2cff802e-379d-42a1-9133-271da54609b0', 'parcel_in_register_unlinked'),
  ('2d1aaa3c-e62a-4fde-b5dd-b8952a1aceeb', 'no_flag'),
  ('2d65506f-b848-4d35-8fb7-60f9f0301a0f', 'trace_unclaimed_parcel'),
  ('2d77b92f-0b61-43b7-b4a3-b84c5eb95522', 'same_price_twin'),
  ('2d834d1c-d0a5-4e7c-9ef5-295abcd74162', 'no_flag'),
  ('2dd4286b-5515-44fa-99aa-1601e002bc0c', 'audit_OK_PAID_PROVEN'),
  ('2dd87e7c-0eed-408e-a86c-8eb83f4a6243', 'trace_unclaimed_parcel'),
  ('2e321dfd-9b95-4159-8314-55f59500514c', 'twin_living_sale'),
  ('2e5de433-312c-4410-9b79-7bf26391888b', 'resend_delivered'),
  ('2ea3f13c-77a8-49b8-ab34-b8d60cc90843', 'no_flag'),
  ('2eaecb5c-7aad-4724-955d-ea0089a63833', 'own_document_no_flag'),
  ('2eb036ec-6d3a-4075-b7e9-f8232017d714', 'audit_OK_PAID_PROVEN'),
  ('2ec7f362-eb13-449b-a71a-73956d8c1d26', 'resend_delivered'),
  ('2ecb3db3-8cd9-4a1d-9d3b-ef2c55643f2e', 'dead_as_duplicate'),
  ('2ee6e982-5076-4ce8-9aa3-af54955d4f67', 'dead_as_duplicate'),
  ('2f4e156a-145f-426e-b054-e73b8072d432', 'resend_delivered'),
  ('3016b151-0946-47d2-8f96-ec5c64d99c4e', 'parcel_in_register_unlinked'),
  ('30c92161-3504-4fe7-b6a3-6ab00597b80b', 'twin_living_sale'),
  ('314c04e9-8655-472f-9c91-49dbd703728c', 'audit_OK_PAID_PROVEN'),
  ('318c15a6-d9ae-48a0-9cea-8db99ebfabe0', 'audit_OK_PAID_PROVEN'),
  ('31b5ce9b-4b14-4f3c-bca2-59491839cf5e', 'audit_OK_PAID_PROVEN'),
  ('31d2f1ab-77f1-4d37-a89e-d9a91fb7954e', 'no_flag'),
  ('31dd53e7-1b54-41c7-a28f-e8ddc28b6469', 'dead_as_duplicate'),
  ('31f3bff7-824c-4e73-a544-edd4e73ab020', 'no_flag'),
  ('3256b59c-8653-463a-ad3b-344ad8eb867b', 'resend_delivered'),
  ('32811efd-b611-4e4f-b464-1d79fc0be865', 'no_flag'),
  ('32ea3267-00b0-45c8-9909-13fd24fb54ec', 'resend_delivered'),
  ('3329c812-0028-4f29-ba69-8149ffe5165f', 'audit_OK_PAID_PROVEN'),
  ('333af921-7263-4055-ab96-ca3c4cee5679', 'resend_delivered'),
  ('33823b00-d2fd-4ddb-84e0-91089c0aeecd', 'audit_OK_PAID_PROVEN'),
  ('33895c72-4d74-4b96-9736-00a2658dd674', 'twin_living_sale'),
  ('33d64d18-8b41-4004-9270-50796410b310', 'parcel_in_register_unlinked'),
  ('3445bdc3-7866-459d-b995-dc08f6053dd8', 'audit_SET_CANCELLED_DUPLICATE'),
  ('34517166-bbd6-49dd-b485-34db5df85622', 'twin_living_sale'),
  ('345a7d2e-3129-4d29-bc17-9234784e2b18', 'trace_unclaimed_parcel'),
  ('3493a5d5-fea6-46ff-a469-15e7ad253973', 'trace_unclaimed_parcel'),
  ('3495e9cb-f38c-4fd4-ba96-2f87cb383003', 'resend_delivered'),
  ('34a50c65-5c00-47e9-8a38-c9a79bd5b24b', 'no_flag'),
  ('34a85f6a-0d57-48c2-b453-cd3c3ee94e6f', 'trace_unclaimed_parcel'),
  ('3536e88d-e0aa-4880-b96c-122138cf7e4e', 'resend_delivered'),
  ('3552ad60-b7b8-4ba6-ac71-c03e3cc1d19e', 'parcel_in_register_unlinked'),
  ('35c3ae53-c4f3-4e68-9cf2-53ce78c2fd9e', 'parcel_in_register_unlinked'),
  ('35e203a2-f836-4e97-9164-5385f4acc6d6', 'audit_SET_CANCELLED_DUPLICATE'),
  ('36b0e62d-104c-4c91-a087-7255f2aa6833', 'no_flag'),
  ('36bcd4b1-2980-44aa-afa0-494785ecca4e', 'no_flag'),
  ('36ec9b4d-3f87-4343-8060-b744291947f9', 'parcel_in_register_unlinked'),
  ('370c3949-5699-4b94-a8c9-d220f640f720', 'no_flag'),
  ('370f4287-b445-4511-bb72-d6b052f28ba4', 'twin_living_sale'),
  ('373e9e19-ddbc-4818-83fd-5a4fa48b206d', 'audit_OK_PAID_PROVEN'),
  ('374c0610-9b57-4aa4-ab5e-46b76fd5e7e0', 'twin_living_sale'),
  ('37566882-0fcd-419d-b234-23a26d2642b3', 'resend_delivered'),
  ('378a1012-8f32-4685-a792-b98f8519c8d4', 'no_flag'),
  ('37eb6374-38fe-4c06-b0e6-a05f7713c592', 'twin_living_sale'),
  ('37fe6ec8-a4c2-43e4-b030-df77988b5c46', 'no_flag'),
  ('3813a6de-5356-4634-973a-fcf599e72d1d', 'parcel_in_register_unlinked'),
  ('3814e0d4-fb22-431b-9f5f-6f9ff84200ed', 'audit_OK_PAID_PROVEN'),
  ('3822b35f-dcec-410c-848e-99c9665aab26', 'no_flag'),
  ('385930b4-ab83-49c4-a7c5-ff291cd9074a', 'no_flag'),
  ('3884e673-369e-495f-bffa-543e7419328a', 'audit_SET_RETURNED'),
  ('388bc102-3ebb-4afc-b120-de50b40fb3a8', 'no_flag'),
  ('389487e6-d02c-4898-8732-0430b62a55a2', 'audit_SET_RETURNED'),
  ('38d689fe-3c51-4844-bec9-8ca032d6fa38', 'parcel_in_register_unlinked'),
  ('390fb92c-1474-4d93-ad15-4753c6ee555f', 'resend_delivered'),
  ('3987efb9-f818-4e41-b349-24f2d69512a4', 'parcel_in_register_unlinked'),
  ('39ad8889-4cd1-4c6a-b493-40b2d9da261f', 'same_price_twin'),
  ('39cfff60-fd0d-4e04-b1bf-464b3f6109f1', 'trace_unclaimed_parcel'),
  ('39d9ac30-e396-49d8-bf95-230bd38aa3b6', 'resend_delivered'),
  ('3a333853-ec54-46b0-86f8-d8cd87c502ed', 'audit_OK_PAID_PROVEN'),
  ('3a33c9ee-6a00-48b6-9bd6-9d3669d0a240', 'no_flag'),
  ('3a5d0f7f-d445-440f-a8c8-5786e304b2f4', 'audit_SET_CANCELLED_DUPLICATE'),
  ('3a8f97a4-b834-4e57-9a9f-9f0225bd9346', 'already_proven'),
  ('3a9f948a-f653-4132-a806-2c4893930fb4', 'resend_delivered'),
  ('3aa23f40-2855-4e54-8260-89690600c35b', 'parcel_in_register_unlinked'),
  ('3aa37ff2-7929-460a-8ef0-07ef486cbd21', 'no_flag'),
  ('3aa7d61b-2f9b-4f2c-94e0-227accb12d4c', 'no_flag'),
  ('3ab12df8-9bac-457c-8b2d-6bf3abeaccbf', 'audit_OK_PAID_PROVEN'),
  ('3ae3a490-14de-44a0-a151-9ba5bbb27c92', 'audit_OK_PAID_PROVEN'),
  ('3b179f82-0a2b-4fc3-98ca-46b570988479', 'audit_SET_CANCELLED_DUPLICATE'),
  ('3b2116cd-f18e-4051-a979-97d0ad6899a1', 'audit_OK_PAID_PROVEN'),
  ('3b311c85-4957-41bf-a899-c5cdf1d82413', 'same_price_twin'),
  ('3b361ed9-e8c8-4f81-807a-91db450f4de3', 'holds_mex_parcel'),
  ('3b9cca20-f93a-4c8e-8aa2-a6a94d8b8ab7', 'audit_OK_PAID_PROVEN'),
  ('3bca35a6-1b25-4e5c-ba53-bb9cec77e210', 'no_flag'),
  ('3c094efa-7d9c-4b86-adf3-9e2161f20435', 'no_flag'),
  ('3c0c1558-ef24-4acc-bbac-180c79576efa', 'audit_OK_DEAD_CUSTOMER_BOUGHT_ELSEWHERE'),
  ('3c31085d-85c2-4cf7-954d-1e4f04911e77', 'trace_unclaimed_parcel'),
  ('3c3a7cc5-e994-4767-9a8c-930fb9eaadac', 'parcel_in_register_unlinked'),
  ('3c5246fa-6f99-477c-88c6-dbed44831631', 'audit_OK_PAID_PROVEN'),
  ('3c6108d6-fc60-4d38-b6c2-dcc2efd06074', 'no_flag'),
  ('3c6b593f-31ea-4ce6-96f1-fd1d1802392c', 'audit_OK_PAID_PROVEN'),
  ('3cc3e153-46ec-4bdf-bb63-e8a550a8def4', 'resend_delivered'),
  ('3ce77684-77c2-4bcd-93e2-245ec123520d', 'twin_living_sale'),
  ('3cf150f9-8447-455b-9aa9-ea1511beb94a', 'audit_OK_PAID_PROVEN'),
  ('3cf376a8-c075-4199-8b47-9e7604613318', 'resend_delivered'),
  ('3d5774c1-5957-44e1-9a27-19763fb38aaf', 'trace_unclaimed_parcel'),
  ('3d5e4896-8514-4b98-9dfb-af6251834ea1', 'resend_delivered'),
  ('3d843210-1eeb-4df7-b6db-549e172bf14b', 'no_flag'),
  ('3de8bec2-90a8-4a44-91dd-4d21dbccbec3', 'parcel_in_register_unlinked'),
  ('3e08ce53-a451-4388-8c2e-4bf7c99d13b9', 'audit_OK_PAID_PROVEN'),
  ('3e10e805-a604-4f1b-86ed-2e23ae18efbc', 'resend_delivered'),
  ('3e3ffa60-9bf1-4f01-a1c2-288387986603', 'twin_living_sale'),
  ('3e4748b7-809b-414c-bf19-31116f8e7f9a', 'same_price_twin'),
  ('3e5769bb-e7f7-481e-91cc-c0003282f42b', 'audit_OK_PAID_PROVEN'),
  ('3e71b3cd-25e0-4f03-8be1-9078b25ac3fc', 'audit_OK_PAID_PROVEN'),
  ('3ed6942f-ed27-4874-9c73-0fc61b038a30', 'twin_living_sale'),
  ('3ed9b037-787e-4d3e-a480-357ee1fac45e', 'no_flag'),
  ('3ed9b883-950c-4c2d-bc54-e5d7e0ff620f', 'audit_OK_PAID_PROVEN'),
  ('3edb204a-1f82-4419-b946-e86f6843536e', 'twin_living_sale'),
  ('3f0b9de7-acbd-4fda-a349-c905b79f48e0', 'trace_unclaimed_parcel'),
  ('3f1a9be3-1e03-4548-9368-4efe5479788d', 'has_basis_operator_ruling'),
  ('3f58fe0d-2eda-412d-98de-243d97f66179', 'has_basis_operator_ruling'),
  ('3f709d3d-101d-4786-8c30-5c757b0e152c', 'resend_delivered'),
  ('3fa7006f-f227-4e82-b0df-757047e94a4b', 'trace_unclaimed_parcel'),
  ('3fb7d620-cbde-4ad4-9582-cb2d77e28c91', 'no_flag'),
  ('3fbf0a94-7823-4d01-8e19-67c1de261a28', 'no_flag'),
  ('3ff9fdcc-088f-4596-9437-4c44f4a68053', 'dead_as_duplicate'),
  ('40273bee-c064-402e-9716-f1f6713cfa41', 'resend_delivered'),
  ('402c1c8d-0462-4603-8e96-6bd56a455360', 'parcel_in_register_unlinked'),
  ('4048b44d-6ed7-407e-87f1-9da74825db36', 'parcel_in_register_unlinked'),
  ('405e849b-bbc9-46c6-a45c-dd7dbb8e3fe0', 'parcel_in_register_unlinked'),
  ('4089d8f0-3895-4de6-aa8f-c15217d1558e', 'no_flag'),
  ('416e9113-c0da-463c-8976-74b3acb43c5d', 'audit_OK_PAID_PROVEN'),
  ('4188f2c7-31d5-4bbf-b101-a356a507a6b0', 'resend_delivered'),
  ('41b15caa-7390-494d-9ec1-0d04325e0835', 'trace_unclaimed_parcel'),
  ('41e42fd2-8dee-417a-9a95-6abadf55affc', 'trace_unclaimed_parcel'),
  ('424fec57-5a96-4dc9-99cc-98e59e1f083f', 'parcel_in_register_unlinked'),
  ('425cca3d-98c1-4fb6-b9c2-9b7dc020ef03', 'resend_delivered'),
  ('426b437f-badf-47e7-83a4-240e020b4799', 'resend_delivered'),
  ('426bc62b-25d5-4767-8f77-b1cde0456a15', 'parcel_in_register_unlinked'),
  ('42c07c19-d17a-4b02-a24e-a0c88afc2a00', 'twin_living_sale'),
  ('42dd6e3c-60a6-4124-ad15-12b3d951c03a', 'trace_unclaimed_parcel'),
  ('43d5342e-fb32-4072-aaf9-9beb46766795', 'no_flag'),
  ('43e7f7cf-445a-48f4-b823-c5f97631916c', 'no_flag'),
  ('44037b7d-9595-48b3-9adb-7c177d7f7686', 'same_price_twin'),
  ('4403e0c1-36f2-4997-a9aa-db65b623af3c', 'no_flag'),
  ('44706118-1da9-4820-8255-b314f5acc784', 'trace_unclaimed_parcel'),
  ('447406ac-dff5-41f0-b41a-18adaa09cb1f', 'parcel_in_register_unlinked'),
  ('448d12f0-ddc0-4cae-8bb0-494f7f448379', 'own_document_no_flag'),
  ('44c4f1bc-aea3-4247-a00a-58739e8dfa40', 'no_flag'),
  ('44c614af-db08-4863-a747-15caa6f3d55e', 'audit_OK_DEAD_CUSTOMER_BOUGHT_ELSEWHERE'),
  ('44c690a0-78ba-4dad-8127-4fd57ba0c326', 'resend_delivered'),
  ('4511b83f-1906-4e66-89dc-9eb53362ab49', 'resend_delivered'),
  ('4525e507-7436-44cf-8408-e1cc5c5daecb', 'name_match_collabbox'),
  ('4537dd58-eb2a-45af-9cdb-a75f7dff1800', 'resend_delivered'),
  ('4538f570-6594-47f6-afe9-706ed76a82e5', 'parcel_in_register_unlinked'),
  ('45588c2e-b17c-4eda-8d53-fc2b98360cb8', 'no_flag'),
  ('45b8aee5-c63c-45a5-9090-0d63e3614cd3', 'twin_living_sale'),
  ('45c2fe25-884d-4217-8d2e-4e7a96f084fe', 'no_flag'),
  ('45c50d4d-2a25-4838-8713-c6248ea07801', 'audit_OK_PAID_PROVEN'),
  ('45c846bd-804f-433a-8a54-d1fe73098302', 'no_flag'),
  ('45e8cec4-b20a-4420-b141-654a31286e1a', 'no_flag'),
  ('45f62f15-1ed3-4aac-bf00-4fea4a7a9f92', 'no_flag'),
  ('4631434e-87b1-4eaf-8281-99015cd7acf4', 'own_document_no_flag'),
  ('473fa69f-6d0a-4d4d-b54f-a7cb6f91c3e6', 'same_price_twin'),
  ('47ef48b3-5613-4138-a3b5-2d37f2f7d5e4', 'twin_living_sale'),
  ('47fa0d9b-356d-421c-8eb6-38fb944212dd', 'no_flag'),
  ('480a27fa-8647-423d-9fac-f33cc46a05aa', 'parcel_in_register_unlinked'),
  ('4843461f-f39a-4d8b-9b9a-6610092fdeb7', 'no_flag'),
  ('48747f37-186b-4293-bb53-0a441be71da3', 'twin_living_sale'),
  ('48764b47-606d-4e9e-9442-a10cd2b24201', 'parcel_in_register_unlinked'),
  ('48a2a564-6eb3-4d51-9add-9bb86d799b65', 'twin_living_sale'),
  ('48a321a4-e285-4566-b3d0-6fc8c3ef9d63', 'resend_delivered'),
  ('48b51a7f-8877-4352-a43c-f2f9578b9e72', 'no_flag'),
  ('48cd0c1b-d7bd-4d68-a93b-0184abc56d75', 'no_flag'),
  ('48ce5762-eafa-4d3b-9c9b-b99b177cf11a', 'audit_OK_PAID_PROVEN'),
  ('48dccf40-e58e-45d3-ae73-0c4945a70bce', 'audit_OK_PAID_PROVEN'),
  ('490fc322-8adb-4433-88b8-21806e1f44c3', 'resend_delivered'),
  ('49d7c49c-2e23-4f72-995c-9b21fdf849de', 'no_flag'),
  ('49dd6b3a-8ac7-4a46-a2eb-ac694146578d', 'audit_OK_PAID_PROVEN'),
  ('4a03d886-4cc3-4614-b6ec-82d6c3bc808f', 'trace_unclaimed_parcel'),
  ('4a40cb73-2fd4-4c1b-bf64-1034743955d9', 'audit_SET_RETURNED'),
  ('4a58db67-ba82-4784-92d1-47473b7df37f', 'no_flag'),
  ('4a759a2e-4401-435b-9b57-ef3185e26740', 'no_flag'),
  ('4a8d149b-65b5-49e2-80b2-3f6a6b91ec4f', 'audit_OK_PAID_PROVEN'),
  ('4ac42556-1eb1-4e4d-bc0b-6fb5a522d013', 'twin_living_sale'),
  ('4ad4b9fe-d27e-4355-9ab6-63d00fd6ae1a', 'resend_delivered'),
  ('4b01d9ee-1f91-4860-bad6-f814070b6280', 'audit_OK_PAID_PROVEN'),
  ('4b0268db-1766-4772-b620-e4f8151acc28', 'audit_OK_PAID_PROVEN'),
  ('4b152ca8-992b-4131-b940-16bb3f846f60', 'resend_delivered'),
  ('4b4b3102-c86b-4424-ba0b-5750e92f4c27', 'audit_OK_PAID_PROVEN'),
  ('4b84f159-224a-4c33-9e21-f10a87667576', 'resend_delivered'),
  ('4ba4daa9-2ece-4e07-bf38-c0c10312b32c', 'no_flag'),
  ('4bac73db-1a39-4601-b8e8-dc198c1b2f4c', 'audit_OK_PAID_PROVEN'),
  ('4bbc1d8b-6f76-43a7-ad63-4dfb693c0866', 'no_flag'),
  ('4bf11f6c-82d0-4e3d-820f-93802b6da06c', 'already_proven'),
  ('4c216b7d-add6-429e-95fd-c49c9828a72c', 'trace_unclaimed_parcel'),
  ('4c2da25b-5c04-49c0-97d1-4ef1a60e8b89', 'audit_OK_PAID_PROVEN'),
  ('4ca4f332-459a-4e48-99d7-153a9cd30168', 'parcel_in_register_unlinked'),
  ('4cde7da5-3e57-43a1-a4e3-6e2455696b2e', 'resend_delivered'),
  ('4dd0c99b-c17e-4b65-aadc-891d7a8bc364', 'resend_delivered'),
  ('4e25c4d0-b0f3-4da8-9ef1-fd4015c2571d', 'holds_mex_parcel'),
  ('4e4251cd-3dcb-4ae8-85ad-be35d12bd29f', 'resend_delivered'),
  ('4e4e55b3-e8b9-4bb8-a003-61c25cc7878b', 'audit_SET_CANCELLED_DUPLICATE'),
  ('4e697e17-dcc2-4fb1-8d9c-4744dd5cf5c1', 'no_flag'),
  ('4e79f478-cadd-4462-8702-bc43e1e0ef70', 'parcel_in_register_unlinked'),
  ('4eb79c7a-4ad8-47c7-8bb5-4ca52efd7fb4', 'no_flag'),
  ('4ec03724-5e3b-46bd-b8d4-f598b10122f4', 'no_flag'),
  ('4ee086ff-42cc-46c5-9081-462316fea81a', 'resend_delivered'),
  ('4eeda123-34d1-4be3-ae9f-f0be9e7f4165', 'no_flag'),
  ('4ef522eb-1578-457f-82cb-201037c8ea0c', 'trace_unclaimed_parcel'),
  ('4efecbe3-3f43-4f19-816f-24ecf649d7f7', 'resend_delivered'),
  ('4f2d8da8-4114-45f3-a28d-b5a4390e109c', 'audit_SET_CANCELLED_DUPLICATE'),
  ('4f2daaf7-abce-4574-ba14-e8519a3c53c9', 'twin_living_sale'),
  ('4f6c3f78-35ae-4afa-ad1e-a4f1f9c2caff', 'parcel_in_register_unlinked'),
  ('4fbabe35-ae69-4733-86e4-764798d2b6ec', 'trace_unclaimed_parcel'),
  ('4fbf6a22-d506-4986-94b1-d11d1ddffd15', 'audit_OK_PAID_PROVEN'),
  ('4fc123c8-7721-4346-a7b0-398c84762534', 'already_proven'),
  ('4fc82fa4-e058-457d-a91a-4e0f01469fd1', 'no_flag'),
  ('4fc8636c-89ec-4ced-9d65-3028013534e6', 'already_proven'),
  ('4fe89960-0852-44eb-9078-78f7831cfa4f', 'no_flag'),
  ('5037bd59-58f1-4a9f-b20f-561e4088d846', 'resend_delivered'),
  ('506e4f0a-a6f1-4733-acb1-dd29de2711e8', 'audit_OK_DEAD_CUSTOMER_BOUGHT_ELSEWHERE'),
  ('50928467-8d91-455c-a68c-5652348daef5', 'audit_SET_CANCELLED_DUPLICATE'),
  ('50bbc5de-f83e-4d20-8210-cdfe2284078a', 'no_flag'),
  ('50d4cfc3-72c1-4c58-ac80-d46c84ac60b7', 'trace_unclaimed_parcel'),
  ('50e176e4-b220-46a8-b329-838b317e8c7b', 'resend_delivered'),
  ('510ccd22-8c0a-4ab0-bddc-a93481567d20', 'no_flag'),
  ('51146006-a8d9-4541-942f-911c24b7443d', 'already_proven'),
  ('5114fbc3-e0b8-494b-825d-5f91d5b48a7b', 'twin_living_sale'),
  ('511bb932-d669-4d63-bdeb-5a40d10e01ee', 'audit_OK_PAID_PROVEN'),
  ('5134c27f-3c0e-41b4-8e12-f774e03baf7c', 'audit_OK_PAID_PROVEN'),
  ('517c0fcc-f32a-4e55-8e0e-34dc2e7d4c06', 'resend_delivered'),
  ('518fe87e-c685-4971-98dc-fa899a21f5e1', 'audit_OK_PAID_PROVEN'),
  ('51a056a9-198f-4f89-a17a-46c36cb247f8', 'no_flag'),
  ('51c31a10-48d9-41d6-94a5-1862d4c60989', 'audit_SET_CANCELLED_DUPLICATE'),
  ('51ea73b3-a0e1-412d-a2b3-368b116b9b76', 'audit_OK_PAID_PROVEN'),
  ('520e5cf5-f56d-4a92-aba3-ba6cf1e04b96', 'twin_living_sale'),
  ('520e661c-741d-4550-8052-a460b3725e47', 'audit_OK_PAID_PROVEN'),
  ('5212a6ae-9ca2-4bad-ae3f-7a57a6eebcd7', 'parcel_in_register_unlinked'),
  ('523e9f06-d62a-4b01-bb15-07b0098c9c4e', 'resend_delivered'),
  ('52be4714-dc03-4077-865b-9f14bd47d88a', 'parcel_in_register_unlinked'),
  ('52d190a2-b0c2-4e82-b63e-41ad0f819e6b', 'resend_delivered'),
  ('52d2b10a-f128-4092-b31b-2912282c0b45', 'same_price_twin'),
  ('530fb766-a063-4504-a1ec-9d583ba409c5', 'no_flag'),
  ('53160336-e4be-4e48-a5bb-f369d00bdd9d', 'audit_OK_PAID_PROVEN'),
  ('5319a60c-4331-44b8-b8b4-cfc978f26830', 'twin_living_sale'),
  ('53488889-12ce-45c6-8b86-813f1040be1a', 'no_flag'),
  ('537893b7-acfb-441a-9d97-578ef8e0370d', 'resend_delivered'),
  ('5391d22f-84cb-4847-b131-907133a91475', 'twin_living_sale'),
  ('53e88f87-b152-4233-b82d-beb1898153fc', 'twin_living_sale'),
  ('54717844-bca1-41f3-89b3-a0f59bff9aa5', 'already_proven'),
  ('5481cd79-17f4-402e-81ea-dbcf802fefe0', 'parcel_in_register_unlinked'),
  ('55504629-bce9-4bd6-b557-153b7ce9ce4b', 'no_flag'),
  ('557126c2-3a1a-412c-936b-657cd7ef52b4', 'trace_unclaimed_parcel'),
  ('55c9b2ca-ad54-47bb-8449-93352a50e13e', 'no_flag'),
  ('55f03fe5-ac98-4a5e-9dc4-4d79b36ecd33', 'no_flag'),
  ('56005e6b-17b6-46a0-9598-fe7689880a67', 'same_price_twin'),
  ('563b16ae-ce65-4b1b-9224-98f1dea05936', 'no_flag'),
  ('5645b186-4dff-4a6a-afa6-ff002d0741df', 'parcel_in_register_unlinked'),
  ('564d6b91-cbae-43d3-a4a8-b6a74ede0538', 'parcel_in_register_unlinked'),
  ('567952e3-2665-4d4b-980a-c0429db5c022', 'trace_unclaimed_parcel'),
  ('56c85182-b39a-4abe-b36b-1f6f722149fe', 'no_flag'),
  ('56c8d8c2-9744-4da2-8c2f-8ef38c21e0d7', 'resend_delivered'),
  ('570c5020-7239-4a86-acaa-44dad144c9ba', 'trace_unclaimed_parcel'),
  ('57730bcd-eb10-417d-9097-931a9c883b0a', 'holds_mex_parcel'),
  ('577b75de-df53-4a49-afbf-6e968f546486', 'trace_unclaimed_parcel'),
  ('5792b839-2165-47d0-9d7d-3f7ef8928fe4', 'already_proven'),
  ('581ba9a5-bbfe-4bb5-8e48-957297281de3', 'no_flag'),
  ('582503dd-8b5e-48a8-96e7-13800b140bc6', 'twin_living_sale'),
  ('58317f2b-6e50-43cb-8364-d0008b3459b0', 'no_flag'),
  ('585fb699-bd94-4272-abf6-c854aa923e53', 'audit_OK_PAID_PROVEN'),
  ('58894da4-bfac-4c65-93b9-1fac802283bf', 'resend_delivered'),
  ('589548f7-2f77-46ee-a2a5-fd1f60223181', 'audit_OK_PAID_PROVEN'),
  ('589717a4-eff2-475d-9edb-e6c5d60af0b9', 'no_flag'),
  ('594bbcfb-e04a-4500-b5e5-7989c3b1f344', 'audit_OK_PAID_PROVEN'),
  ('594cc168-7ba2-4d8c-95c6-6ae01fe87145', 'no_flag'),
  ('595c08dc-e6ca-48bc-913d-4fb10d3065e4', 'resend_delivered'),
  ('5994f70a-098b-4561-b013-07c821bb80fe', 'resend_delivered'),
  ('59cfaa74-774d-4c2d-a0a5-12dd2a3f674e', 'name_match_collabbox'),
  ('59dc9b1d-7d93-4981-b014-0ad3e4d34dfe', 'audit_OK_PAID_PROVEN'),
  ('5a5f96d7-094a-4764-89ce-a73116b6f3a6', 'parcel_in_register_unlinked'),
  ('5a640d03-c4e3-4430-a4e4-44dbede09b46', 'audit_SET_RETURNED'),
  ('5a7d789d-b869-4f86-ae87-7390bdf9d196', 'resend_delivered'),
  ('5aa34c2e-2a83-46e5-acef-a460b2432d02', 'no_flag'),
  ('5ac9370a-6457-470f-8cc2-efa5541e514e', 'resend_delivered'),
  ('5aea401a-dcbd-431c-9b10-dade5ded2f0a', 'parcel_in_register_unlinked'),
  ('5afd1942-abd7-45d0-81fb-53e5a88c7b76', 'resend_delivered'),
  ('5b135b51-5ae4-4693-859e-8fe986102b91', 'parcel_in_register_unlinked'),
  ('5b2ff3fd-1ebe-4d1e-b6f4-b5fa21970591', 'audit_OK_PAID_PROVEN'),
  ('5b3e53cd-683a-4f10-8e93-aea31d3d854d', 'resend_delivered'),
  ('5b6273eb-c4aa-42fa-8807-ebab0f6ed037', 'audit_OK_PAID_PROVEN'),
  ('5b78c81c-17a1-43a5-a71e-6fae38d5f69f', 'resend_delivered'),
  ('5be23844-f822-4f24-99d7-c3836d808b28', 'twin_living_sale'),
  ('5be7b48d-f511-45fc-8a6f-6da8017c6c8e', 'dead_as_duplicate'),
  ('5c44bece-1c86-4646-8a37-1e0582e723f2', 'twin_living_sale'),
  ('5c4ecfde-e571-41d2-96bd-abed7df75fc0', 'twin_living_sale'),
  ('5c6a2b52-15c6-4f60-b824-aa79d4b8b152', 'parcel_in_register_unlinked'),
  ('5caee38e-00b6-4f49-9aca-87e1065b7db8', 'no_flag'),
  ('5cfe6949-1784-4210-9843-1b192b4434dc', 'trace_unclaimed_parcel'),
  ('5d2ba580-10dd-4ebb-9e9d-9379e34d9968', 'twin_living_sale'),
  ('5d424e67-5f24-42b0-98a8-cfa6a36b03d7', 'audit_OK_PAID_PROVEN'),
  ('5d4e64a3-4f76-4627-8ff1-68f15f885c3c', 'twin_living_sale'),
  ('5d5dfda8-5e6a-4757-ac27-02abb88168cb', 'twin_living_sale'),
  ('5d82cc4c-3a60-4816-a0b1-a9d11ceb1de7', 'parcel_in_register_unlinked'),
  ('5d8c5b32-227e-4c13-a62b-395752e9fae6', 'resend_delivered'),
  ('5defa26c-8e93-47d8-a4f0-8c93f63592b3', 'audit_OK_PAID_PROVEN'),
  ('5df72096-a60a-42c9-a2e6-add1cf015519', 'audit_OK_PAID_PROVEN'),
  ('5e23b701-746a-4faf-94cb-4ea1d74a13ff', 'no_flag'),
  ('5e43cf5b-0020-4f0c-ac41-5ea6524999e4', 'no_flag'),
  ('5e4ade3a-0048-4aae-9ca0-e2f7786395a7', 'parcel_in_register_unlinked'),
  ('5e62fece-a4ba-4e15-839b-f10dd61a6bdc', 'holds_mex_parcel'),
  ('5e786f17-66e3-4f35-97f3-b06af8edf5c1', 'resend_open'),
  ('5e9e593d-f961-4c52-a3e8-f98f4d36ff15', 'trace_unclaimed_parcel'),
  ('5ec25694-de0a-4b8c-9d4a-10e269908016', 'trace_unclaimed_parcel'),
  ('5edd0277-a102-4bc6-a92a-06f5daeab303', 'same_price_twin'),
  ('5ee37f59-cbec-435a-b4db-8a7aca71cea3', 'holds_mex_parcel'),
  ('5efa7ae9-5225-4832-bef1-0586847366bb', 'trace_unclaimed_parcel'),
  ('5f41ff11-aaac-4b6f-9a1c-97ec25f0f90a', 'resend_delivered'),
  ('5fd23fd9-6337-4d6c-a97c-03cdac84b222', 'audit_OK_PAID_PROVEN'),
  ('600c338c-3e92-42b8-8e84-64ce765592e4', 'parcel_in_register_unlinked'),
  ('6013a54b-a567-47ac-9c3f-62559e13f7dc', 'audit_OK_PAID_PROVEN'),
  ('601eb3c4-ff2d-4ce7-9ed9-eb1b66af12e9', 'resend_delivered'),
  ('60336df2-ec6c-40fc-a02c-80615515f233', 'trace_unclaimed_document'),
  ('612c7ec0-358a-465a-9f5c-c3d68a29b244', 'resend_delivered'),
  ('616dc0ef-07bc-46b7-a9ae-0beebfb86932', 'own_document_no_flag'),
  ('617636c4-f21c-499c-867c-79f6b759994f', 'parcel_in_register_unlinked'),
  ('61a618bf-86b1-47d1-bb6c-a0c4a15c42bd', 'resend_delivered'),
  ('61db80c1-784c-42b8-84e6-35ba05589ca2', 'twin_living_sale'),
  ('61f1feea-15c1-43cc-b676-6fee50c43431', 'audit_REVIEW_DEAD_BUT_DELIVERED'),
  ('6205c9cb-9edd-48ac-bd88-5b1e70f32eb1', 'audit_OK_PAID_PROVEN'),
  ('624538f2-ba72-4ff9-9af4-b1f582a2290e', 'resend_delivered'),
  ('62478bcb-43aa-4c5c-a0b1-d42dc84b5722', 'already_proven'),
  ('624a6e85-d5b8-4699-b057-8984752bd497', 'audit_OK_PAID_PROVEN'),
  ('626ffd64-78f5-4c77-abe7-a3e4494879a4', 'no_flag'),
  ('62709065-712b-4ff6-b247-e030d76f377e', 'audit_OK_PAID_PROVEN'),
  ('6270915a-baf8-4e9f-a78f-e3fa348229d4', 'already_proven'),
  ('6276c4aa-e995-4978-be28-ab1070bf287f', 'no_flag'),
  ('62889386-f96d-489a-ba98-282a60140a1c', 'parcel_in_register_unlinked'),
  ('628faef3-9b54-4cf3-8aa5-0da22c87768e', 'no_flag'),
  ('62ab36b9-c539-4089-b799-db40e95cb065', 'resend_delivered'),
  ('62b106c1-f842-4559-86e6-6b9466a516a4', 'resend_delivered'),
  ('62cfc8b7-9574-4265-8d58-05f7d8f434a5', 'audit_OK_PAID_PROVEN'),
  ('62d6cba7-d51a-441e-aa55-42534cea5592', 'resend_delivered'),
  ('62e42cc5-25cd-4679-a36c-61178040c68f', 'audit_OK_PAID_PROVEN'),
  ('62e620df-6b53-4cc3-a098-d7710ade74f0', 'audit_OK_PAID_PROVEN'),
  ('6312931b-5cab-4942-bf38-eab404c86dcd', 'no_flag'),
  ('631487d1-a144-4d17-9495-591752bb240d', 'no_flag'),
  ('63967d1d-f58c-44e4-8d73-56924a24dc42', 'resend_delivered'),
  ('63dd4dec-edfd-4c38-bf05-16e29a85df75', 'trace_unclaimed_parcel'),
  ('64286f1b-b879-4180-8242-d7faabaf44e2', 'no_flag'),
  ('644bf612-b0fa-4ac8-81bc-6659d53d1f41', 'twin_living_sale'),
  ('644c9894-4e79-4078-8b55-dd72a8137b22', 'twin_living_sale'),
  ('6459a8d5-6d60-4215-a890-e8a5d96d73be', 'no_flag'),
  ('64794479-a282-42a8-b59d-992ced08bbd4', 'resend_delivered'),
  ('647d20a7-8088-4993-b287-ce32572a922d', 'already_proven'),
  ('6482bbbb-80ef-441e-b106-a1b194848321', 'no_flag'),
  ('6497fffd-70d9-46ae-86f1-5d466caed5b7', 'delivered_later'),
  ('64a87d03-8b71-46b5-9b87-b14b09e6e684', 'twin_living_sale'),
  ('64b35fb3-b959-43e4-97e8-b6c15173b2d8', 'parcel_in_register_unlinked'),
  ('64b615c4-f0ba-4745-b1ff-406784988157', 'audit_OK_PAID_PROVEN'),
  ('64d196c2-30eb-49ec-908b-0dd70477f35d', 'no_flag'),
  ('64d4f985-6d90-416b-9cde-08e6d006579f', 'twin_living_sale'),
  ('64dc85a6-8baf-4efc-b7bd-164ca0ad44af', 'resend_delivered'),
  ('64f14d03-1e2b-4e51-bd50-5ba303a8ddc0', 'audit_OK_PAID_PROVEN'),
  ('64f68f64-eb8f-40a3-802c-6a7fbdf277e5', 'trace_unclaimed_document'),
  ('650b3092-3341-44eb-9870-3eeee7a82bc3', 'audit_OK_PAID_PROVEN'),
  ('65244d36-dde8-4eb7-aa5c-9b40509a63af', 'trace_unclaimed_parcel'),
  ('6526bd48-30e9-44fc-95d6-6e478dae3780', 'audit_OK_PAID_PROVEN'),
  ('652ced3b-d0f3-491e-9f20-35d1234f2d23', 'parcel_in_register_unlinked'),
  ('6540295e-66b3-4631-b0d9-13cd0372cac6', 'already_proven'),
  ('65687b4d-20a4-469c-b2ca-9ac95727f2fa', 'audit_OK_PAID_PROVEN'),
  ('6594bef6-05ff-48eb-a931-44d18157c851', 'parcel_in_register_unlinked'),
  ('65abcbb3-d8e8-4702-a8dd-0dd7f8af0e18', 'dead_as_duplicate'),
  ('661be1b4-7427-40bb-a1ea-a7e7cc247631', 'already_proven'),
  ('66410280-ee47-4a74-b82a-140974e18c0d', 'no_flag'),
  ('66562b40-5082-45ee-baf8-cde9a6894f8f', 'audit_OK_PAID_PROVEN'),
  ('668adce7-b697-4add-8333-138b1cada8cd', 'parcel_in_register_unlinked'),
  ('66c296a7-3433-4458-886f-95e2bbed6a28', 'resend_delivered'),
  ('6753ca90-5f69-4bea-b092-ca892b20d3f3', 'no_flag'),
  ('67727d8f-31ba-4e92-bc69-04e005b6d2a2', 'twin_living_sale'),
  ('67866a89-9d46-4344-87f2-b426f4a90471', 'resend_delivered'),
  ('67efbfdc-2f5b-47e4-8538-4e92d1fa82e7', 'no_flag'),
  ('6815d509-d743-41d3-bbc1-d430aeedeac0', 'parcel_in_register_unlinked'),
  ('682a2364-002b-4fc3-bcf0-b044bfbc5498', 'parcel_in_register_unlinked'),
  ('6839546e-423c-477e-a4fb-03c88503d183', 'resend_delivered'),
  ('68437982-050a-44fa-8d28-5553e600eeeb', 'already_proven'),
  ('6857228f-131f-491c-8634-1760342bd922', 'resend_delivered'),
  ('68641836-9b32-41d4-bf6e-7657705ab17f', 'parcel_in_register_unlinked'),
  ('68dea243-6b4c-45d7-a588-58d3a9117a74', 'audit_REVIEW_DEAD_BUT_DELIVERED'),
  ('6902da2f-85de-4d0f-a6a0-a68f2c7d4786', 'dead_as_duplicate'),
  ('69a5a8e5-652e-4abb-b425-5062230094d5', 'no_flag'),
  ('69fbf894-5ad6-4839-a6ec-114bfd51fe9b', 'resend_delivered'),
  ('6a029180-9d91-4be8-be39-f04145caf23b', 'resend_delivered'),
  ('6a0ca650-7b69-464d-bb5a-abc0daa82fc7', 'resend_delivered'),
  ('6a0e14ac-56a3-4058-979d-7ddedce0be1e', 'no_flag'),
  ('6a1042a1-37e2-42c1-ad6a-b50089184a42', 'no_flag'),
  ('6a502bcf-804d-44a3-8f5a-ab9b194dd3f0', 'audit_OK_PAID_PROVEN'),
  ('6a60e44f-f25d-4acd-9144-61d9393d696a', 'twin_living_sale'),
  ('6a73ab26-3db2-4e7c-9fd3-51663cd9fe78', 'no_flag'),
  ('6a820c59-247e-4dd9-b727-bff16bb47c59', 'audit_OK_PAID_PROVEN'),
  ('6acbb1af-f0af-442e-b9ba-d4aa0a284b93', 'audit_OK_PAID_PROVEN'),
  ('6af30c58-f509-4c21-8d9a-1dbd2c7062c5', 'audit_OK_PAID_PROVEN'),
  ('6b1347dd-acfa-42f2-8c35-f1eec3163f00', 'no_flag'),
  ('6b302865-d9c8-47f5-96e4-854d58a1cb62', 'no_flag'),
  ('6b53e5a2-10e6-4756-8edc-5296ad27de00', 'trace_unclaimed_parcel'),
  ('6ba8fc52-65a7-49ae-8996-bb72bf94c82f', 'resend_delivered'),
  ('6be0fe5d-83d4-42b4-9cca-786e151c5dfc', 'dead_as_duplicate'),
  ('6c09fee3-1b53-42e6-b17d-5e101c787e90', 'parcel_in_register_unlinked'),
  ('6c41a8e5-abfd-4c13-a301-fad573108d27', 'twin_living_sale'),
  ('6c72d238-4014-43cc-a06f-d97be8726a11', 'twin_living_sale'),
  ('6c7356e6-f0cd-40c0-a07b-86ec8b4a5f2e', 'trace_unclaimed_parcel'),
  ('6c76a57f-63c3-41bf-bdc5-6a284d434730', 'resend_delivered'),
  ('6cab58e7-dc43-4dd8-9d5b-616da64283b3', 'already_proven'),
  ('6d087e81-b7d6-4903-a7cc-6c57a2052f3b', 'holds_mex_parcel'),
  ('6d0c76ce-f71e-4a4a-ac45-d24fa6e71f43', 'audit_SET_CANCELLED_DUPLICATE'),
  ('6d35a54e-e672-4ecc-960f-56f896c02c04', 'resend_delivered'),
  ('6d621d3b-0cb7-4d02-a7fe-cb5e96e5a819', 'no_flag'),
  ('6d70c240-68bd-40f1-8b00-a4f4b3107d04', 'no_flag'),
  ('6d712b98-6c49-4458-8e80-eb5096ad99dc', 'resend_delivered'),
  ('6d7bd093-8843-4914-a3c4-3278c2acf57f', 'audit_OK_PAID_PROVEN'),
  ('6e33bc88-a9ec-41ee-8f9d-c21933503f09', 'resend_delivered'),
  ('6e5558ba-9e2d-4ef9-99ab-c18c60d289f4', 'resend_delivered'),
  ('6e5c680c-124c-4a3b-be15-63c4e841d6ef', 'audit_SET_CANCELLED_DUPLICATE'),
  ('6ede73ea-fff9-43bd-b07f-66a34b753f78', 'no_flag'),
  ('6ee345f8-90f3-4961-8edd-dbf630b73944', 'parcel_in_register_unlinked'),
  ('6ef414e2-1047-4101-afdb-3d63deb6cc6c', 'resend_delivered'),
  ('6f181c56-bdaa-4be2-99ab-65ce95d34043', 'twin_living_sale'),
  ('6f802cf6-5e5e-45c4-bd88-66d61fc00f07', 'audit_SET_CANCELLED_DUPLICATE'),
  ('6f8d0459-1f49-40fc-bbb1-d6311d90e8bc', 'resend_delivered'),
  ('7005c9e3-8b5a-486c-add7-f65f0f49c242', 'parcel_in_register_unlinked'),
  ('7052c4aa-406a-4d0d-8e8e-04bdf6ba886c', 'no_flag'),
  ('7053d507-be9d-4446-acfb-2728485c8e1f', 'no_flag'),
  ('708646a2-bbc8-48c2-8f2f-af3b17a7a6d2', 'resend_delivered'),
  ('709816fc-19fd-4d83-8b61-a4a72b63199c', 'resend_delivered'),
  ('70ad2fd7-a198-4798-8f31-32798303e336', 'audit_OK_PAID_PROVEN'),
  ('70c0b1db-17e6-4487-a2e7-00886399e95b', 'resend_delivered'),
  ('70c4460a-284d-4a43-ae34-eb22b4b81fdf', 'no_flag'),
  ('70ee0a0c-bfd0-43b2-a222-74b07c5da77d', 'no_flag'),
  ('7127197d-0e72-43e4-9066-b1e9cbdcb53e', 'audit_SET_CANCELLED_DUPLICATE'),
  ('715b9ed2-542b-4bd5-b6fe-16f1e61669e3', 'no_flag'),
  ('715c9a18-018d-4856-9484-1355fcb4bfc8', 'no_flag'),
  ('71867f7c-cda2-418e-88c4-af8e31c3de50', 'parcel_in_register_unlinked'),
  ('71998b23-eef6-4cfd-b6fa-25b1987387ab', 'twin_living_sale'),
  ('71b5da9c-b275-4b29-af1d-b589362b9772', 'no_flag'),
  ('71b63dfa-d050-4720-b54e-6a2561bc6aba', 'audit_OK_PAID_PROVEN'),
  ('71bddf0a-747d-4c37-9fe1-e1dcca80eaa4', 'resend_delivered'),
  ('71f17521-9934-4632-9085-ddc482d226ef', 'resend_delivered'),
  ('71f74c36-1100-40c6-9023-727174dead11', 'dead_as_duplicate'),
  ('72409d86-d4d3-4122-b94c-150ff8feee3e', 'holds_mex_parcel'),
  ('7249061d-0b5e-4c4c-a0f3-a14c1f61cbc5', 'resend_delivered'),
  ('72cb234f-c0c2-476e-a654-a86710e16283', 'audit_OK_PAID_PROVEN'),
  ('72eb0826-7e23-4acb-b0e7-d3631f9e33dc', 'no_flag'),
  ('72f20a02-395e-412a-b3cb-3e112f4b6218', 'resend_delivered'),
  ('72f8e518-5280-4d86-932a-9846f3c0208f', 'audit_OK_PAID_PROVEN'),
  ('730b0eb6-6490-4e73-8a92-283f201c11f0', 'parcel_in_register_unlinked'),
  ('73180039-08fe-470e-af4c-58e05576d57e', 'parcel_held_by_another_order'),
  ('733f8995-021e-40b2-85ea-15aa3fd1977d', 'trace_unclaimed_parcel'),
  ('73411257-51e0-4971-822c-8374aef2d708', 'resend_delivered'),
  ('73545bbe-2919-4b7f-b8ea-9d8fff8ba0a3', 'audit_REVIEW_DEAD_BUT_DELIVERED'),
  ('73bb373a-3450-4822-aea6-6ddb97fa33a7', 'twin_living_sale'),
  ('73be31e8-f7a8-4e2e-bd55-2e3b2f32b244', 'no_flag'),
  ('73c47282-fb7f-4504-a3aa-bea16f1a8e20', 'parcel_in_register_unlinked'),
  ('73c4fa01-b451-4b65-b391-dde8eb595d8c', 'audit_OK_PAID_PROVEN'),
  ('73c68c67-2ccf-4471-aab9-2fe0a7002b47', 'audit_OK_PAID_PROVEN'),
  ('73f6b1a9-a80d-4c6c-bdc9-15aba896002f', 'audit_OK_PAID_PROVEN'),
  ('73fa4b63-5d8e-46bb-916a-56114cfb1a96', 'resend_delivered'),
  ('740c4333-3346-444f-bb34-f74320b2293f', 'parcel_in_register_unlinked'),
  ('74198aa0-0b90-4cd4-b8d4-c430499402b7', 'resend_delivered'),
  ('748c82c4-945d-4c95-bbee-bd57d09e8ade', 'audit_SET_RETURNED'),
  ('74a636f3-c97c-4c79-98a3-e7bfbc13cde6', 'resend_delivered'),
  ('74cb86e6-1a55-4d34-a585-7800ad5bef66', 'name_match_collabbox'),
  ('750f0b91-6ce2-4b42-9fba-f8d2621ebb42', 'no_flag'),
  ('756663c8-5065-4579-8a63-22264942253f', 'no_flag'),
  ('759fafa6-c703-493f-9f20-6e96cea02acb', 'audit_OK_PAID_PROVEN'),
  ('75ba1594-e76e-4353-a823-d1f46e0a0d31', 'no_flag'),
  ('75cc316c-7763-4b1c-a55e-93e52bba112a', 'same_price_twin'),
  ('75fcef83-0cf6-438f-98ec-4e228a2022aa', 'already_proven'),
  ('760fdc02-bc37-4eee-9287-8e27c81b326c', 'no_flag'),
  ('76317eb2-c409-45ab-ba42-f62e7f059c18', 'twin_living_sale'),
  ('7648ac4f-b5ba-4acd-9cea-e6374c0e21be', 'twin_living_sale'),
  ('7664854c-f9d8-438e-92f9-347bca2251de', 'resend_delivered'),
  ('76879881-ed74-4ade-99ca-c0d25fffbf02', 'audit_OK_DEAD_CUSTOMER_BOUGHT_ELSEWHERE'),
  ('76cdf117-7629-46fa-9630-473108538eb4', 'trace_unclaimed_parcel'),
  ('76fda18d-f15e-46af-bac7-86333a363f39', 'resend_delivered'),
  ('77306752-f3a2-4031-a697-5acf4ba5c195', 'resend_delivered'),
  ('7738d8f5-16ca-497d-89d8-fdc2662ac3ad', 'twin_living_sale'),
  ('773c749e-7a92-4fee-a47b-856b39fe4fe6', 'no_flag'),
  ('7790b120-1c83-4f33-b483-14e8ad7f67be', 'resend_delivered'),
  ('77c2dcf0-40fe-4be1-847c-67630cdea71d', 'audit_OK_PAID_PROVEN'),
  ('78241c51-df36-4409-8022-12e264432b20', 'audit_OK_DEAD_CUSTOMER_BOUGHT_ELSEWHERE'),
  ('784ec084-52b1-49f0-9c50-e9cdbddd376c', 'parcel_in_register_unlinked'),
  ('7873cc3d-2ac5-4e15-8270-d03ba8d53fdd', 'resend_delivered'),
  ('78bfaebd-9777-4e30-8cda-7ea7c4b82c15', 'no_flag'),
  ('78c9b6d6-69ac-4f4c-83b3-ea4c9cccfec7', 'already_proven'),
  ('78f1a847-7e15-4faf-88e5-587e0172b334', 'twin_living_sale'),
  ('78f9c583-8ac6-424f-bfdf-345ad3e53332', 'no_flag'),
  ('796b8a4e-38c5-4678-bd45-3a1881a92f6e', 'already_proven'),
  ('797c7086-1428-4e0d-b387-0d39b2458ee0', 'resend_delivered'),
  ('7982318e-b19a-4d38-9b95-4644601130f3', 'audit_OK_PAID_PROVEN'),
  ('79921611-2fce-4567-a78d-3ce2e0a9fbf6', 'parcel_in_register_unlinked'),
  ('79c20a7e-d6ee-4bd4-9dbd-0346c362e748', 'twin_living_sale'),
  ('79f078e2-e7f2-420f-bd71-ad9a0c4b4393', 'no_flag'),
  ('7a0435d9-15ff-4b5a-89ba-cf1ed52ff426', 'parcel_in_register_unlinked'),
  ('7a10763c-c993-4bbf-a83b-068a36127e95', 'parcel_in_register_unlinked'),
  ('7a1a495d-0d9d-4491-82c0-bc9b7bad8cb3', 'resend_delivered'),
  ('7a20166f-8f8b-4176-8928-5bdec58f8ead', 'audit_OK_PAID_PROVEN'),
  ('7a9d5602-41ff-4e5f-b71e-dc3d34a6d00d', 'resend_delivered'),
  ('7abb26cf-41eb-4b42-8825-27d7b282f630', 'no_flag'),
  ('7ae5c16d-7b36-45ed-9db9-9e2dbc5c1fec', 'no_flag'),
  ('7aff0025-7519-4f0d-a2f2-970b74826f8e', 'resend_delivered'),
  ('7b3923cd-0aaa-47a6-821b-af493ec6a31f', 'no_flag'),
  ('7b3cf866-2a07-40a8-adc0-31f171cf54fa', 'twin_living_sale'),
  ('7b6bf76e-b0b3-4c2a-bcf0-5917cb3e0569', 'audit_SET_CANCELLED_DUPLICATE'),
  ('7b8c3eaa-f7d8-404b-9d76-15b524662243', 'audit_OK_PAID_PROVEN'),
  ('7b926ba5-74fa-431f-aaec-a5d09db9aaee', 'no_flag'),
  ('7bc9bec4-f8e4-451d-b1db-b26e2bdd56a4', 'resend_delivered'),
  ('7bdc3e15-900e-4e35-8db1-59ebaf9dc1c3', 'no_flag'),
  ('7c045ccb-adb6-4997-9d22-733afd55c355', 'already_proven'),
  ('7c0d0d41-1bac-47be-87bf-d1b9546e04f1', 'no_flag'),
  ('7c12c9c5-200f-4022-97c8-b1f54f38add8', 'audit_SET_CANCELLED_DUPLICATE'),
  ('7c1eb513-26d2-49e3-8a4d-4ebb83590c46', 'parcel_in_register_unlinked'),
  ('7c99612d-2403-44fb-b207-8ed9913f7b98', 'already_proven'),
  ('7ccb83c8-1f2a-450f-9a07-6a1958b9e1e0', 'already_proven'),
  ('7d2301e9-fd33-49bf-a05e-749aac4c1437', 'resend_delivered'),
  ('7d40ba8f-5791-4628-abbf-8309e75ab476', 'dead_as_duplicate'),
  ('7d638ee0-2823-48d2-9a09-f7c80ac0e535', 'parcel_in_register_unlinked'),
  ('7d79d1b0-a899-4ad6-b4b3-4d0500009f51', 'twin_living_sale'),
  ('7dffe071-33fb-4738-952a-0e34b790ea08', 'audit_OK_PAID_PROVEN'),
  ('7e0c68d9-44b3-444b-ad81-7dae725a7461', 'resend_delivered'),
  ('7e9e99f6-19d9-40d7-8748-99693c4fe623', 'resend_delivered'),
  ('7ec81e16-4caf-4638-8ba4-7dc3c3bba22a', 'no_flag'),
  ('7f04665d-1b1b-4a75-8184-7a3f2b66a041', 'audit_OK_PAID_PROVEN'),
  ('7f16a756-8020-4ce9-a046-d2d34e3b38c5', 'resend_delivered'),
  ('7f60c063-40fb-4f4c-8d50-2a00685b414d', 'audit_OK_PAID_PROVEN'),
  ('7f67b607-bd89-4118-b3ca-a239c9dbecfa', 'same_price_twin'),
  ('7fa0233c-f3f6-49fa-82f1-996a391fd0fe', 'no_flag'),
  ('7ff78cfd-de18-40af-87e8-15c790738839', 'audit_SET_CANCELLED_DUPLICATE'),
  ('803e6755-51c6-4452-8ff0-cff1e7618154', 'resend_delivered'),
  ('80409649-cde4-45a0-b9b7-9df1b92113a1', 'audit_OK_PAID_PROVEN'),
  ('806cf2e5-8a30-4b96-b5d9-4b5b54746d81', 'same_price_twin'),
  ('807bff21-5d45-44f8-96e9-492130b346aa', 'already_proven'),
  ('807cbcb7-d7a8-4270-abac-d0c4f1c14ef9', 'no_flag'),
  ('808393fb-b20a-4f2a-9ef5-98a822d85da8', 'audit_OK_DEAD_CUSTOMER_BOUGHT_ELSEWHERE'),
  ('8087dcb3-8e3a-41d8-bb0d-b5eb591e8077', 'audit_OK_PAID_PROVEN'),
  ('80acadbc-92fc-43ca-9c1e-3d1db7c9a0f2', 'resend_delivered'),
  ('818dbcf3-4393-43a4-b699-f09030af5bf1', 'parcel_in_register_unlinked'),
  ('81901e91-d9e0-4d9e-9b94-f7fb3932dd74', 'resend_delivered'),
  ('819a5d19-9035-4bbf-a395-d3822ab2bfe7', 'no_flag'),
  ('81a1195b-5196-489b-8e80-55f405960acd', 'trace_unclaimed_parcel'),
  ('81f790c8-5bda-40c4-b1f1-f96b91e332de', 'resend_delivered'),
  ('8203a4c8-a964-4a11-b666-43a663610d0d', 'resend_delivered'),
  ('822061d4-5586-4047-8088-45f33c8cd5de', 'resend_delivered'),
  ('82471255-9860-4f3f-b5cb-6eb982cd4f75', 'no_flag'),
  ('825fee9a-354f-40d0-98ad-2e4fda5c6270', 'no_flag'),
  ('82703a86-e0bb-46a6-b6c6-bac7646a72e7', 'no_flag'),
  ('82a2e6cb-48ff-4064-98f5-e90b99363455', 'parcel_in_register_unlinked'),
  ('82c9c98e-f3e2-4006-a6e1-5271ea39aa5a', 'audit_OK_PAID_PROVEN'),
  ('82d34290-dd03-4381-a355-8189cb460382', 'no_flag'),
  ('832e52ed-3a9c-4263-85db-2410447ed69f', 'resend_delivered'),
  ('83719c55-7b8e-4fed-a07c-fc5a332381af', 'audit_OK_PAID_PROVEN'),
  ('837c20b4-6ba9-4681-bf42-c34d18b6a7c6', 'parcel_in_register_unlinked'),
  ('83885874-471c-4486-967d-b8fb4b05374f', 'audit_OK_PAID_PROVEN'),
  ('83a9561a-5373-44c4-ab8b-24385487d936', 'audit_OK_PAID_PROVEN'),
  ('83acbd60-cb19-4aab-b028-c29794b6694d', 'no_flag'),
  ('83f579ca-22d8-4527-a755-80998dbf52e1', 'parcel_in_register_unlinked'),
  ('841d13dd-2e29-417e-9a1c-3b6ac33c105c', 'audit_OK_PAID_PROVEN'),
  ('8438c05e-2b2c-4ae9-b3a0-9c3b7c48feca', 'twin_living_sale'),
  ('843a98c4-509a-43f2-85a3-9ccdd604e030', 'already_proven'),
  ('84519bd4-7e56-4927-b58f-4439b52c9d1f', 'no_flag'),
  ('849c881b-4730-4f88-8fc1-147503dd613d', 'no_flag'),
  ('84d6d24e-1d00-4c0c-bd2d-786c752d5b5a', 'resend_delivered'),
  ('84f7606f-c17d-443b-8072-5ae871b5ad92', 'same_price_twin'),
  ('84fab9e7-3c43-426e-a9c3-275f03e80af6', 'holds_mex_parcel'),
  ('850e979b-c579-4082-a669-07f5f75ccb12', 'parcel_in_register_unlinked'),
  ('8512da87-45be-4b38-a21d-6ca1cc799c94', 'parcel_in_register_unlinked'),
  ('8551954a-8271-4385-b580-5d3a36223676', 'dead_as_duplicate'),
  ('85779023-8432-4b9d-8bbb-183134ff3a76', 'audit_OK_PAID_PROVEN'),
  ('85a818ac-1d95-4273-bcc1-f44603713617', 'audit_OK_PAID_PROVEN'),
  ('85c30ebd-293d-4f7e-851a-0de0068de5a3', 'resend_delivered'),
  ('863a3d19-3056-4db3-8df9-3993fd573c9b', 'own_document_no_flag'),
  ('8661c352-97a4-4cd4-99c7-cff6d5f3541c', 'parcel_in_register_unlinked'),
  ('8678e662-5955-411a-abb2-b41b66b092a4', 'audit_OK_DEAD_CUSTOMER_BOUGHT_ELSEWHERE'),
  ('8693df23-7c9d-44a5-87eb-326dd69017ed', 'no_flag'),
  ('86b839b4-76f1-4f0b-ace7-02ecfcf22ed1', 'parcel_in_register_unlinked'),
  ('874a86ad-5034-49ce-a6d1-0f4b9be6e345', 'audit_OK_PAID_PROVEN'),
  ('8786cfed-7042-4296-a89c-1aab498c8a7b', 'audit_OK_DEAD_CUSTOMER_BOUGHT_ELSEWHERE'),
  ('87a55bc1-9227-4751-a799-bf7b84c3e52a', 'trace_unclaimed_parcel'),
  ('87ca9086-0ada-4a07-821e-e577ae48698f', 'audit_OK_PAID_PROVEN'),
  ('87ccadb6-83ed-4a47-b627-75eb0479c46f', 'dead_as_duplicate'),
  ('87e30fac-0c1b-4506-a7d4-f58c7b336ef3', 'no_flag'),
  ('87f4e442-2b9f-4ad1-b3b6-1291157bf82d', 'no_flag'),
  ('87ff1e74-1285-4903-b439-cb49c04d70ce', 'audit_SET_CANCELLED_DUPLICATE'),
  ('884644e3-084f-4fbd-b3bf-353c257830ad', 'audit_OK_PAID_PROVEN'),
  ('88549c54-bf82-4ffd-ba0f-6386fbf00a3f', 'twin_living_sale'),
  ('88b2fa20-15bf-4602-ba98-e63fafb58c31', 'resend_delivered'),
  ('890bd08c-b7b5-46c8-8777-44dc8527a867', 'audit_OK_PAID_PROVEN'),
  ('89107d06-1940-4b5c-b788-0152c2238084', 'no_flag'),
  ('89233753-95ec-43d5-b54b-fda4e919f669', 'twin_living_sale'),
  ('893242d0-e731-41ec-9cdb-7186c5c9bea8', 'parcel_in_register_unlinked'),
  ('893e450a-5495-463e-b1b7-731e9dc749ad', 'no_flag'),
  ('8a16a214-e0af-4454-a3d1-164c1e271a2c', 'trace_unclaimed_parcel'),
  ('8a368e86-d9c8-4ea8-8fe5-aa5979e8f243', 'already_proven'),
  ('8a6629af-607d-4275-80e1-7938a9f74b76', 'resend_delivered'),
  ('8a888a32-6816-4b5e-a4ea-25fbb3a6bf90', 'name_match_collabbox'),
  ('8ab7b3f4-0f99-47a2-b535-33c1cccdf161', 'resend_delivered'),
  ('8ac53118-a98f-4a3f-8450-e6b78620b856', 'audit_OK_PAID_PROVEN'),
  ('8acac9ad-9371-4fe7-b0b3-c354154c3c72', 'resend_delivered'),
  ('8ae2d618-7452-47da-97d7-f70c988395c6', 'audit_OK_PAID_PROVEN'),
  ('8b03a6e5-1c90-494b-b8a4-c8bbfa35a14a', 'no_flag'),
  ('8b10cbe7-b8ca-4a8c-9013-946cb515ccac', 'no_flag'),
  ('8b1fe591-4ed7-400a-b5d0-a23e238e52c5', 'no_flag'),
  ('8b2a9c3b-1e34-46c2-960a-e9074a98e097', 'twin_living_sale'),
  ('8b70755a-3eb2-4c50-9acf-7ca6bdd07a22', 'audit_OK_PAID_PROVEN'),
  ('8b7eb2fc-99b0-4f4c-902b-1dad3aa058a0', 'audit_OK_PAID_PROVEN'),
  ('8bd310d6-ab8a-4fb1-906e-612064dd5c76', 'already_proven'),
  ('8bd7faee-1b68-4204-8b57-a148448e16b1', 'resend_delivered'),
  ('8c0d7a4c-85c7-4099-8f5f-40a058918cbf', 'no_flag'),
  ('8c420044-bc45-4869-8fd8-de181162df5c', 'parcel_in_register_unlinked'),
  ('8c8e30d7-dd67-457c-8f02-978cfd6cada2', 'audit_OK_PAID_PROVEN'),
  ('8ca6dd79-b714-42bf-a180-76d15dbb456f', 'no_flag'),
  ('8cb5e62b-e25a-4611-bd92-37ebf16ca969', 'audit_OK_PAID_PROVEN'),
  ('8ccc7779-778c-4fc1-b550-59d84a4f70d3', 'own_document_no_flag'),
  ('8d1f59a9-c512-4221-bce1-567096a0d9f3', 'holds_mex_parcel'),
  ('8d2c6e67-b739-445b-800c-e9e270b450b7', 'resend_delivered'),
  ('8d6b167f-f71d-4879-a8aa-e1d689584b32', 'audit_SET_CANCELLED_DUPLICATE'),
  ('8dac2c0b-ea21-4f04-b28e-836892c61016', 'audit_OK_PAID_PROVEN'),
  ('8e18d500-29ab-47bc-9115-a65979b0aaad', 'resend_delivered'),
  ('8e26df58-a3e6-4bcf-a684-0c861a8eb76e', 'twin_living_sale'),
  ('8e84d0cc-e084-4bfb-bc86-f147ce071a40', 'audit_OK_PAID_PROVEN'),
  ('8e9bd72e-7915-4d5a-b05c-980ef9d03f36', 'no_flag'),
  ('8eb49162-ae78-4a93-856b-0bf5847363b1', 'resend_delivered'),
  ('8ed1264c-7740-4b63-89a7-cd6b7d25a1bd', 'parcel_in_register_unlinked'),
  ('8f418285-4740-4144-9974-d47f7ff9da4c', 'parcel_in_register_unlinked'),
  ('8f7ac481-0996-4d1c-a22e-10739ec416f5', 'own_document_no_flag'),
  ('8ff6518d-bfce-4c3c-aebd-a53424c5fc87', 'audit_REVIEW_DEAD_BUT_DELIVERED'),
  ('8ff7a86e-7291-439d-85d9-e3785ad72c8f', 'parcel_in_register_unlinked'),
  ('8ffc3993-64f6-4a45-a2d9-8074ff2f6c9d', 'resend_delivered'),
  ('901248c8-4cb8-42cb-9687-049d578194dc', 'parcel_in_register_unlinked'),
  ('901b2e8c-2da3-4f6b-a70a-648b9b9d3995', 'parcel_in_register_unlinked'),
  ('9042cf13-9af3-4a10-a939-711ff1d7e601', 'trace_unclaimed_parcel'),
  ('906c0209-37ef-4eeb-9c45-7ff90810f4c9', 'dead_as_duplicate'),
  ('9099f634-aab6-4136-bacc-7bda3e096f41', 'twin_living_sale'),
  ('90a8d269-09b3-40e5-937d-74109d98374b', 'audit_OK_PAID_PROVEN'),
  ('90b9d391-cb27-4e3b-89a3-cd0965a866c3', 'no_flag'),
  ('9105c0e3-9509-485d-8e01-b8b59b5bff33', 'audit_SET_CANCELLED_DUPLICATE'),
  ('91158f58-9f51-4f5d-a4ce-6a2aabf21feb', 'parcel_in_register_unlinked'),
  ('91179961-b9e0-46d4-965c-3f0748fa4523', 'trace_unclaimed_parcel'),
  ('9125e241-b8e8-4f23-bc61-4ba36e4ab1bc', 'trace_unclaimed_parcel'),
  ('915f73d6-5700-4cb5-bd3b-591822d188bd', 'resend_delivered'),
  ('917d5ce4-aa45-49c4-a5c5-57933154c759', 'name_match_mex'),
  ('91f21d0c-82dd-40cd-8b16-3533fcfea9e7', 'twin_living_sale'),
  ('92a4d87f-10a5-42eb-8331-d6171edcef54', 'resend_delivered'),
  ('9353d776-8a7c-441d-a7f7-5fcac2a7558e', 'audit_SET_CANCELLED_DUPLICATE'),
  ('9385177a-51b9-4f2c-9862-c1d4c672aa21', 'parcel_in_register_unlinked'),
  ('93a005e2-e4bf-477f-8ef2-4f219e589c8f', 'has_basis_operator_ruling'),
  ('93bb2acc-6c3a-4d89-b9c1-d986d4f2098b', 'already_proven'),
  ('93c30f90-1098-49d4-88ae-261f4b617d76', 'no_flag'),
  ('93c3cd13-34af-41c0-ba75-ceef58b8edad', 'no_flag'),
  ('93cdaa59-e314-4dd5-9240-8fc03b09fc02', 'holds_mex_parcel'),
  ('93d846a9-a5f3-4a7a-9be3-810969257a43', 'no_flag'),
  ('93f3eb25-0865-472f-8a90-09e81228ff77', 'no_flag'),
  ('9442d1af-41c4-4805-af43-db620d79f501', 'audit_OK_PAID_PROVEN'),
  ('9460748c-6a5d-4e8f-8bd6-61cedc3d84c5', 'audit_SET_CANCELLED_DUPLICATE'),
  ('94b69b1d-1701-429e-ac3b-6954ca0b44ed', 'no_flag'),
  ('94b9749c-542a-451e-bd75-b287d4b42929', 'resend_delivered'),
  ('94baf7d7-1c66-46f6-9919-6558f67f8350', 'audit_SET_CANCELLED_DUPLICATE'),
  ('94fd0ac1-b108-4da6-90bb-54c794d24693', 'trace_unclaimed_parcel'),
  ('950a983b-a202-4f75-aaa6-63817b6681ec', 'no_flag'),
  ('9541430c-5384-4b77-91ff-455fde902458', 'no_flag'),
  ('9547a34f-9a50-4de1-8405-054d10d19d4b', 'audit_REVIEW_DEAD_BUT_DELIVERED'),
  ('9559960d-7bcc-429d-9874-100ed6f4aee9', 'resend_delivered'),
  ('9569e044-14a7-49b0-a963-bcda573e2933', 'no_flag'),
  ('95f6ef3c-f78b-4803-b13d-10c63557bc7e', 'resend_delivered'),
  ('964a26ed-6e24-4a08-bc1d-a99ff8fe3367', 'resend_delivered'),
  ('964e9914-cb69-4f8a-9cc7-8bcfb879ab75', 'audit_SET_CANCELLED_DUPLICATE'),
  ('97005b30-cbbc-4fd1-acf8-786a2b95a7a0', 'trace_unclaimed_parcel'),
  ('9700b9bc-1856-4cb0-aca8-59092cd845a4', 'audit_OK_PAID_PROVEN'),
  ('9701f907-3c83-4aa3-8f46-4192f916c4e2', 'no_flag'),
  ('9732bc7d-2c2d-474e-9de0-1fa31d309ea0', 'no_flag'),
  ('97487387-22de-4490-bd91-325d21589f85', 'audit_OK_PAID_PROVEN'),
  ('9757af70-e867-4deb-b1ea-b87e3caa3afe', 'twin_living_sale'),
  ('9758b5d5-583a-4c26-a01b-880a52cee6b8', 'audit_OK_PAID_PROVEN'),
  ('97869bf0-fdf4-4786-96c7-fa0ecaf0a40f', 'parcel_in_register_unlinked'),
  ('978be06d-9c4b-491f-bc34-3c8173d6f131', 'no_flag'),
  ('978ec9c5-a105-4017-9f8d-157707125c31', 'same_price_twin'),
  ('97a39016-107a-4865-8ffc-3752cb984a7c', 'same_price_twin'),
  ('97ef2f92-4ea3-404a-9d7e-fd1789844935', 'already_proven'),
  ('980700a6-e2f0-440c-b1ea-62fa59ffd286', 'no_flag'),
  ('988b01fa-a986-480e-a060-f7b47d1ebb3c', 'no_flag'),
  ('98a6bf7f-959d-412e-961d-085d8fdeb899', 'no_flag'),
  ('98d565b9-488a-4c95-b5be-a53685e7789f', 'resend_delivered'),
  ('98e1ef30-ec8c-46e7-9806-c94838756738', 'resend_delivered'),
  ('98f025a2-cf7e-4b2f-b368-cc594285964f', 'audit_OK_PAID_PROVEN'),
  ('98fc7fe4-5ad6-449f-b071-910fbc68d61a', 'audit_REVIEW_DEAD_BUT_DELIVERED'),
  ('990e1cc7-9ab9-4978-90cb-c864145337a8', 'no_flag'),
  ('99172ae3-217d-4b59-95df-8f3992a85f27', 'holds_mex_parcel'),
  ('9941e745-6216-41f9-8bc6-7a494efb8ded', 'already_proven'),
  ('995a1bf4-6d7f-4734-bfb4-3eda950ba586', 'twin_living_sale'),
  ('996c4ee4-c3f5-44c8-b293-ebc2bb9fb104', 'trace_unclaimed_parcel'),
  ('9978f3f2-1e39-4f48-a576-fb7b2c06fe9c', 'audit_OK_PAID_PROVEN'),
  ('99a51aee-751d-4775-9441-d5ec9ed04ac3', 'audit_OK_PAID_PROVEN'),
  ('99ac0a02-197a-49b0-82b2-440c37824c55', 'resend_delivered'),
  ('99d57a3a-ce48-450e-b455-19b35317fd28', 'trace_unclaimed_parcel'),
  ('99e6cc3e-1d70-4e9d-9dd8-0907d9e48ba7', 'no_flag'),
  ('9a815723-1afd-4590-837c-4adbcd414a6d', 'no_flag'),
  ('9acfa2a5-dc95-4219-a0aa-fa679e8f7d25', 'twin_living_sale'),
  ('9af48044-374c-40d0-b3e5-1ebea5df7082', 'audit_OK_PAID_PROVEN'),
  ('9af65c6f-5068-420b-9276-c2b690c26480', 'parcel_in_register_unlinked'),
  ('9b714a03-dce3-4e1c-8482-7d05396b9d5d', 'no_flag'),
  ('9b799ed8-5b77-437a-9dbb-3123b7e0747a', 'twin_living_sale'),
  ('9b7c986d-dc8b-4b55-9efa-c777c1aaeddd', 'twin_living_sale'),
  ('9b919938-347b-4a60-acc6-5db68854e543', 'resend_delivered'),
  ('9be146c6-2d75-4c52-a766-45cd3b07544c', 'twin_living_sale'),
  ('9c07d443-5661-458e-a00c-ac472dc3e398', 'audit_OK_PAID_PROVEN'),
  ('9c4fd89e-e2b4-4373-a4f1-00b7807400a4', 'trace_unclaimed_parcel'),
  ('9c9ef359-518b-474c-8a13-125cceace999', 'no_flag'),
  ('9ca40790-4a4c-4fbb-ac4d-55b6514e65ab', 'no_flag'),
  ('9cead76c-8d0a-4f2a-b104-3feff451dc16', 'parcel_in_register_unlinked'),
  ('9d2c73a7-2163-4585-8b51-9460e0bc97e2', 'no_flag'),
  ('9d3b0e20-d26b-49a9-bb40-52da4839245c', 'same_price_twin'),
  ('9d6cfdef-75a1-405c-a1ba-18b0a5787b73', 'audit_OK_PAID_PROVEN'),
  ('9dafcc09-fcf7-4dc1-a181-472283562432', 'resend_delivered'),
  ('9dbaf690-95fa-4177-bc51-0cce5c978bce', 'trace_unclaimed_parcel'),
  ('9e0fb8fe-2f6b-416c-bb5b-fcd0a9c49760', 'no_flag'),
  ('9e17b302-b56f-42b4-b2db-4ebf01439659', 'twin_living_sale'),
  ('9ebd50fa-0e84-46d7-80c9-5af6950badf8', 'audit_OK_PAID_PROVEN'),
  ('9eda8a66-94c8-4d97-8387-4306ab02ef3c', 'trace_unclaimed_parcel'),
  ('9f138d21-d380-4199-ae81-4dc962c969c7', 'no_flag'),
  ('9f575144-b4c2-45ac-88f5-e5830b3f0d42', 'trace_unclaimed_parcel'),
  ('9fb53b52-ccfb-46e2-885e-0f82955d0bd4', 'parcel_in_register_unlinked'),
  ('a0025397-d6e0-40d3-adc3-568948be0a56', 'audit_OK_PAID_PROVEN'),
  ('a011fd87-df93-4692-a823-65701a741a46', 'no_flag'),
  ('a03111f4-974d-40ab-81ef-ffef95e9bc60', 'audit_OK_PAID_PROVEN'),
  ('a039325c-a187-4c30-8372-b568eb694df3', 'no_flag'),
  ('a05fc06a-61c4-4430-8ce1-18ab3793530d', 'resend_delivered'),
  ('a06b3e6d-9fdb-4ecd-adea-a8fb78598385', 'resend_delivered'),
  ('a09a3d3a-7dd1-44f5-9cf2-70baca600412', 'resend_delivered'),
  ('a09e6ffc-8afb-441b-8a54-f08a9e0f74dd', 'no_flag'),
  ('a0b6eddd-2bca-4bf8-89a0-b4d9bbd29b0d', 'resend_delivered'),
  ('a0cfa225-2e9a-4e86-bab7-141901a3da44', 'no_flag'),
  ('a0f0ffab-e299-4f75-979d-9070734c1f40', 'no_flag'),
  ('a10d3695-40fb-478e-b17d-a5ca29039591', 'trace_unclaimed_parcel'),
  ('a10fbb0e-c6c8-45a9-9c06-7ccdade14cfb', 'resend_delivered'),
  ('a110aaa9-4b5f-410b-bda0-70f5ea00f991', 'parcel_in_register_unlinked'),
  ('a1260d44-fd15-4dce-919c-72cf81e5f726', 'twin_living_sale'),
  ('a1352a55-ae1f-48cd-bf6d-fa21e0f5651a', 'twin_living_sale'),
  ('a1403a40-03a7-47b8-893d-b332c0bc1800', 'audit_REVIEW_DEAD_BUT_DELIVERED'),
  ('a16accfb-9c8c-41f3-aebf-b11c0c42bc8b', 'audit_OK_PAID_PROVEN'),
  ('a1a54b3f-03bb-4eb1-9eda-259767733623', 'resend_delivered'),
  ('a1b46a9c-c684-47e8-a8a9-52d4cc7e717a', 'audit_OK_PAID_PROVEN'),
  ('a1bd28db-4b5b-4d47-b838-4574b7163bc6', 'no_flag'),
  ('a1d51a30-45d4-4bb0-9acd-05a25d9487d4', 'audit_SET_CANCELLED_DUPLICATE'),
  ('a1f48bee-7957-4284-9a8a-1e3c9836eeac', 'no_flag'),
  ('a25f9065-8024-4a84-8d47-3fbd11bd9c90', 'parcel_in_register_unlinked'),
  ('a2ae7c5f-c5dc-4ac4-a2d8-c701c9ed70cf', 'parcel_in_register_unlinked'),
  ('a2ceec32-85ce-4e86-82a9-cc8e09cde69c', 'no_flag'),
  ('a311a6a8-7239-4a5c-9f18-b2664200b31f', 'already_proven'),
  ('a350ce1c-8dfc-4738-82b6-0dabf3b79aa6', 'name_match_collabbox'),
  ('a3c5ac39-4eb0-4f8e-adc3-76fbbb11314c', 'no_flag'),
  ('a3d0d497-6f5f-43b5-a6fb-00d340e39e8b', 'audit_SET_CANCELLED_DUPLICATE'),
  ('a3ec3e6c-3087-4745-9faf-e465c7a35887', 'audit_OK_PAID_PROVEN'),
  ('a3eca5c2-435a-4403-bc11-92e88a23217f', 'audit_OK_PAID_PROVEN'),
  ('a41021da-5663-4ea9-b60e-3b5468d12a5e', 'audit_OK_PAID_PROVEN'),
  ('a443d85b-4ceb-4da6-8d23-c481a4eef275', 'same_price_twin'),
  ('a4478b58-6068-48bf-9ba1-b75064f3b63e', 'audit_OK_PAID_PROVEN'),
  ('a460b22f-1bad-4171-b520-e09c6a40555a', 'own_document_no_flag'),
  ('a46b59e3-c45d-4b48-9aba-023f99a9fba6', 'resend_delivered'),
  ('a49d6c20-6045-4419-b465-1be665810db8', 'resend_delivered'),
  ('a4ef5da7-933a-4860-b97f-af5cd15aaf80', 'name_match_mex'),
  ('a523bc1b-acaf-4c8f-a1f3-b00e0db05bf9', 'resend_delivered'),
  ('a57578ae-f965-4c4c-92ea-8e3002c3e6a3', 'audit_OK_PAID_PROVEN'),
  ('a5981434-fe1c-44cf-99c5-cfc6ef45f0ba', 'audit_OK_PAID_PROVEN'),
  ('a59f0d77-bc47-4dd0-99df-ef9337108113', 'resend_delivered'),
  ('a5c6ef77-549b-4db7-be9f-82f236918758', 'audit_OK_PAID_PROVEN'),
  ('a5e1c248-c53a-4e69-b23a-3376e3ec95df', 'parcel_in_register_unlinked'),
  ('a633639b-7baf-4b22-a353-15c81f782374', 'no_flag'),
  ('a67a3c3b-4954-42df-97c4-03accb2ceae1', 'parcel_in_register_unlinked'),
  ('a6bad5de-927b-4cab-8fe7-191fb83d1b4c', 'no_flag'),
  ('a6c3734e-8be6-48d4-b1f7-2530fe8ef872', 'no_flag'),
  ('a6d9b04e-8ff2-445a-8edf-8c11bb503d31', 'dead_as_duplicate'),
  ('a701dd87-df48-4d8d-9069-864485686a4d', 'resend_delivered'),
  ('a7d1f8c7-f2b2-422c-a7a6-96c9023fc049', 'already_proven'),
  ('a7d2e8c3-e082-4483-a278-3950e9ac37a8', 'holds_mex_parcel'),
  ('a829798d-c335-4123-b059-46122648dd5a', 'parcel_in_register_unlinked'),
  ('a82f40f5-fbf9-4294-b2c2-14da36711245', 'parcel_in_register_unlinked'),
  ('a82f6bba-0e43-4c58-ad43-ecbe5b4a6fdb', 'trace_unclaimed_parcel'),
  ('a8377ca0-e7d2-4e2d-9f68-f01ed7a70cdd', 'no_flag'),
  ('a8815c4b-d76e-4302-9a29-15f48617a19f', 'no_flag'),
  ('a8908ced-2551-4011-9113-1d7aea8aad25', 'trace_unclaimed_parcel'),
  ('a8d842bb-4508-4d22-9209-a35b43e33d4e', 'audit_OK_PAID_PROVEN'),
  ('a8ecbeff-1450-4419-bfc0-e5b67ca8e9b7', 'dead_as_duplicate'),
  ('a919d6cf-3646-49aa-8bc1-dc0d8b91f4fd', 'parcel_in_register_unlinked'),
  ('a940e76a-516f-4e94-b74b-dcb7873926e0', 'parcel_in_register_unlinked'),
  ('a94916c2-be34-4664-a8af-2b48670604b5', 'trace_unclaimed_parcel'),
  ('a95d9c91-dcc6-4a81-aa02-869abc728cbc', 'audit_SET_CANCELLED_DUPLICATE'),
  ('a95f9fff-ed51-407e-8018-f78c5598c93b', 'parcel_in_register_unlinked'),
  ('a96d161d-41ba-4fd3-966a-483443281e38', 'same_price_twin'),
  ('aa037c1e-8efb-4bd8-8cd5-69b89335c4d5', 'twin_living_sale'),
  ('aa20ee12-4d7e-445a-a1a3-8a6ed51e8829', 'no_flag'),
  ('aa3ab39d-2512-4736-b442-bb1e305dece3', 'resend_delivered'),
  ('aa57a66b-5f23-425d-8ea5-8a1af65de85b', 'twin_living_sale'),
  ('aa5a55fc-d2ea-43c1-ab24-483dec5a43c8', 'audit_OK_PAID_PROVEN'),
  ('aa64ab4d-8cef-463a-9dfb-2e58ce3812f0', 'audit_SET_CANCELLED_DUPLICATE'),
  ('aa83cb31-05f7-47a9-9e20-fd1caca574fb', 'parcel_in_register_unlinked'),
  ('aa8e17c3-bdc1-4e47-a2e9-cb65626d9d04', 'audit_OK_PAID_PROVEN'),
  ('aa959532-e455-4728-95d0-64db4c99b2f2', 'resend_delivered'),
  ('aaa32055-46c4-48c2-9695-5d0e898ac99e', 'already_proven'),
  ('aaaabbb8-61da-49dd-9884-ba0119e1536f', 'resend_delivered'),
  ('aaf72b02-0d2b-499a-a239-18a05fa59ace', 'twin_living_sale'),
  ('ab205196-4ec7-4403-b8ed-192b941598af', 'audit_SET_CANCELLED_DUPLICATE'),
  ('ab3a72d0-ccaf-4f18-a8a0-426f9e793a58', 'same_price_twin'),
  ('ab9ccfd7-98f3-4169-886e-b94f89eb6591', 'no_flag'),
  ('abc430e1-1d99-4bfa-8e1a-06dc98b6ca69', 'no_flag'),
  ('abd4e0e3-f25f-4395-8170-171aba9cfe37', 'twin_living_sale'),
  ('ac060c66-8f8f-41bc-b1a3-48a55b581b88', 'audit_OK_PAID_PROVEN'),
  ('ac1db17d-3c59-4a67-a1a4-e5017cae7a5c', 'twin_living_sale'),
  ('ac5e54c7-e130-4f42-a1ef-9ec1448aac41', 'twin_living_sale'),
  ('acafcced-11e5-4888-a434-e532d5489e0a', 'resend_delivered'),
  ('ad3e34e4-1f21-4e5f-95df-6a1b1521a2e7', 'resend_delivered'),
  ('ad5249a0-4553-4bd4-b977-5f342d427643', 'parcel_in_register_unlinked'),
  ('adb2ea84-bb49-4468-97b3-28f7e2df7c8a', 'no_flag'),
  ('add4e4dd-7d2c-441b-b56f-05d276416ec2', 'no_flag'),
  ('ae2001a8-c8a0-4c0c-b6cf-0ce91c6479d7', 'parcel_in_register_unlinked'),
  ('aea0911f-827e-4368-bfca-0a44173bb061', 'twin_living_sale'),
  ('aea9d4e9-5f61-4d0b-88e5-6303cbab67c0', 'no_flag'),
  ('aeb18390-8f2d-40d1-89f3-b00a0c2fbbdb', 'resend_delivered'),
  ('aec9a1f2-68f6-4714-ba92-a0b73885d1d4', 'already_proven'),
  ('af1c530c-6c0b-48a2-823a-2f2da4ce9dc3', 'parcel_in_register_unlinked'),
  ('af47e239-fe36-4c6e-9f1a-af3510534ac9', 'no_flag'),
  ('afb3ba2f-9599-4174-a039-9846f0515f8e', 'parcel_in_register_unlinked'),
  ('afcef28d-6db6-4d7e-b64a-e5a32223267a', 'twin_living_sale'),
  ('b021c9c4-4b3d-4ceb-8cc3-882b7798409f', 'resend_delivered'),
  ('b029f8af-89aa-490b-a761-e2e2f99974b7', 'dead_as_duplicate'),
  ('b08d1975-e6ea-42a7-bce9-dfb1ea1b30aa', 'resend_delivered'),
  ('b099d3fa-394c-44ba-9775-b726297b7554', 'twin_living_sale'),
  ('b0cf5ead-8bfe-4f8b-936f-70f12c26c5d4', 'resend_delivered'),
  ('b0d43207-3aca-4f61-bb15-e804fbd6184b', 'audit_SET_CANCELLED_DUPLICATE'),
  ('b11c220e-a35f-4b9a-88d6-77852836f076', 'same_price_twin'),
  ('b1554e40-bc64-48e8-95db-c2df0cfaad0b', 'resend_delivered'),
  ('b1b981db-0311-4a4d-8958-ac3452d8d571', 'holds_mex_parcel'),
  ('b1ba13b5-278c-4494-9951-21772eb1ff7c', 'trace_unclaimed_parcel'),
  ('b23554bd-0135-4d22-8bca-b8b81ac02f59', 'twin_living_sale'),
  ('b24865b1-a6b2-46fa-ba5c-7ce718218638', 'twin_living_sale'),
  ('b25c67f0-576e-44f2-8745-dcc0956b6853', 'audit_OK_PAID_PROVEN'),
  ('b28cf231-a473-43a9-b036-f14025557985', 'resend_delivered'),
  ('b2cde80e-41e1-4c35-b681-827726e54ffb', 'resend_delivered'),
  ('b2dc7bd2-797a-4f88-aad8-7e0c676f95ee', 'resend_delivered'),
  ('b31cd60a-ec5f-4ca1-83a7-295c7ca5ae4a', 'resend_delivered'),
  ('b338fa64-086c-4153-acef-b9d1965bc67f', 'audit_OK_PAID_PROVEN'),
  ('b3670d31-50da-4d90-88ea-d5db535792fa', 'audit_SET_CANCELLED_DUPLICATE'),
  ('b38d183f-550c-4fce-9783-47a97786faa0', 'no_flag'),
  ('b3f505ed-a058-4e57-9f22-6a65de4610d2', 'resend_delivered'),
  ('b469fc07-719c-4921-8afa-744e67087bdf', 'audit_OK_PAID_PROVEN'),
  ('b4859af5-926a-4ef9-b246-a34181b4c684', 'resend_delivered'),
  ('b4a0e55a-a186-41e3-8186-1367ab3b4467', 'resend_delivered'),
  ('b539a50f-bfcf-4e56-9b36-c9cb827ac9ea', 'no_flag'),
  ('b54a757c-433c-4cdd-991b-caacbf6e0d75', 'parcel_in_register_unlinked'),
  ('b5620094-6868-4c69-bc65-371ea8bdbd78', 'no_flag'),
  ('b59b246d-be80-4f98-a3a6-aad9cd53d8ab', 'parcel_in_register_unlinked'),
  ('b5a6cf50-8086-49e7-a335-1f8a742aea98', 'resend_delivered'),
  ('b5b0e754-7c95-4515-b33d-6bbee52331e9', 'already_proven'),
  ('b5dc73fe-9852-4a67-8f9c-3df658c5a2a9', 'twin_living_sale'),
  ('b62f8322-c04e-4497-bada-00c5f9df1661', 'audit_OK_PAID_PROVEN'),
  ('b6771c2a-f4d6-45a7-a11f-b2fb6a32fd05', 'parcel_in_register_unlinked'),
  ('b68ae0f5-7d83-4b0c-b9f3-69b7026900c7', 'no_flag'),
  ('b6c70ed8-8887-43a4-8f2f-d61aa2d4f116', 'no_flag'),
  ('b6fcea9e-e9da-4549-a00a-be7e8356ca36', 'trace_unclaimed_parcel'),
  ('b70e28b9-746b-4180-af4b-eb8da4ab106e', 'parcel_in_register_unlinked'),
  ('b71fbbb1-54ff-42dd-82e9-0fbf15d3a4d6', 'audit_OK_PAID_PROVEN'),
  ('b73bf20f-3beb-4e66-8b18-5dcf9b80fe4b', 'already_proven'),
  ('b767dba8-faf3-471d-b762-7b98e89272bb', 'audit_OK_PAID_PROVEN'),
  ('b7740851-5517-4193-bde5-7713d8b845dc', 'trace_unclaimed_parcel'),
  ('b77fdef2-e6ac-48bc-ba7d-823c06499c28', 'trace_unclaimed_parcel'),
  ('b782b20e-8d3d-499c-94ef-92d9395a569b', 'twin_living_sale'),
  ('b7a57b68-148f-4230-a5c4-18a6641b140e', 'parcel_in_register_unlinked'),
  ('b7ade06b-594d-4fd7-ab17-cb52a86e0b8c', 'trace_unclaimed_parcel'),
  ('b7b116db-b3ff-4ab8-b1d4-d788f4a070d7', 'no_flag'),
  ('b7c11a4d-7b8a-4eb7-8d35-6808f5dfe3fb', 'audit_OK_PAID_PROVEN'),
  ('b7e45e3c-81e5-46a6-9378-d0016f79d3dd', 'parcel_in_register_unlinked'),
  ('b802b0e9-a321-4dd6-af35-e9bd75f1d7da', 'audit_OK_PAID_PROVEN'),
  ('b8509ffc-b27a-43ac-8888-90ed27f7c3af', 'resend_delivered'),
  ('b8544720-b453-483a-b2d1-2b76d4dda295', 'resend_delivered'),
  ('b856cc21-b2c3-4f42-ad39-b12769b7ec62', 'audit_SET_CANCELLED_DUPLICATE'),
  ('b893096b-a54c-4c4f-a771-6ed14d6c0a7b', 'parcel_in_register_unlinked'),
  ('b8a0cc63-5b11-4411-b72f-646c36392a2e', 'no_flag'),
  ('b8ad25ef-b2ba-4dce-8e42-2be1fb60435c', 'trace_unclaimed_parcel'),
  ('b8eebb3c-fd57-4b6d-86e4-ce19ffa3da7e', 'parcel_in_register_unlinked'),
  ('b8f2048e-7141-4c3f-b17c-69259c117314', 'no_flag'),
  ('b9627c80-c523-48a9-985e-1c56b3ad629d', 'no_flag'),
  ('b98f082c-0260-4513-9de8-7babb8dae3e1', 'parcel_in_register_unlinked'),
  ('b9a8359a-5a23-4fde-9647-7550729aa0c2', 'parcel_in_register_unlinked'),
  ('b9aeae94-76d2-455d-872e-99f6babd061d', 'audit_OK_PAID_PROVEN'),
  ('b9e68b2f-57e7-450d-bccf-a97f83982554', 'no_flag'),
  ('ba074dc3-a1ec-42a6-96b6-7499a205cbfb', 'parcel_in_register_unlinked'),
  ('ba13523f-663f-4768-9106-b209ea6acfd9', 'same_price_twin'),
  ('ba14c475-d9a6-4cdd-acb1-d0bf75c43627', 'parcel_held_by_another_order'),
  ('ba1b076c-60ab-4478-a31a-64a4499e0a1e', 'audit_SET_CANCELLED_DUPLICATE'),
  ('ba31e807-ef97-4a13-bdf8-ebfcb7f08195', 'resend_delivered'),
  ('ba5fc629-4c5e-4f56-809e-907764667272', 'audit_OK_PAID_PROVEN'),
  ('ba62981e-d0cd-431d-bf48-a64a6540a7f0', 'trace_unclaimed_parcel'),
  ('ba722c5e-2f3b-411e-920e-600694cf207f', 'resend_delivered'),
  ('ba9bcc6e-145a-444f-ae15-0c90c8929ae5', 'holds_mex_parcel'),
  ('baa3615d-419e-4023-95b0-8305317d637f', 'no_flag'),
  ('baf9d759-1248-47a1-be5e-16d798f4acea', 'audit_SET_CANCELLED_DUPLICATE'),
  ('bb498fb2-ade6-4eeb-bf8d-523d6303c86f', 'twin_living_sale'),
  ('bbd5fcf4-c18c-4742-ab64-3c1bf5e8cc9c', 'twin_living_sale'),
  ('bbd642ef-c1ea-4695-bbb0-c1df1498e8f8', 'no_flag'),
  ('bc05c295-e2d4-40ee-9b1e-fdd390573800', 'trace_unclaimed_parcel'),
  ('bc2616f8-cba9-422a-aa08-f591c7be3821', 'has_basis_operator_ruling'),
  ('bc7bac42-6e08-4413-9924-ba921c467ca4', 'resend_delivered'),
  ('bca279e3-599f-4132-bf37-6ac4a951d795', 'no_flag'),
  ('bca4798e-d044-4d25-bf17-2bd3357dc4e0', 'delivered_later'),
  ('bd2f7e90-1a81-43a3-bbb8-fa3fb85648f5', 'resend_delivered'),
  ('bd4620e5-4bb4-4653-b245-5c3e50389997', 'already_proven'),
  ('bd544636-abfa-463d-8a29-1c424dcc3280', 'no_flag'),
  ('bd661354-e8ac-42d8-982d-1d2c59cb1faa', 'resend_delivered'),
  ('bd965f3a-420e-43d9-8f03-05a0a8bf282a', 'audit_SET_CANCELLED_DUPLICATE'),
  ('bdb4d649-0d33-44f8-a922-db1edeb71064', 'resend_delivered'),
  ('bdbafe92-0095-4ad0-94bc-a1664ecf3ed3', 'dead_as_duplicate'),
  ('bdbe0fb6-50a3-4551-9964-9851429cdae3', 'twin_living_sale'),
  ('bdc48b11-f2d6-4758-a773-f217f07b98e5', 'twin_living_sale'),
  ('be265127-1a28-4c84-aff5-fa79fe98f58f', 'no_flag'),
  ('be52327b-3a01-42fe-9f84-58135e3a0d1a', 'trace_unclaimed_document'),
  ('be626afe-b2ca-4af5-ad26-03f4b7a555c2', 'twin_living_sale'),
  ('be68f2a3-eb9d-496f-8171-1093985be5a2', 'parcel_in_register_unlinked'),
  ('beb8656b-3129-4e6a-ab2d-43917ed6abe9', 'already_proven'),
  ('bec498a1-bc80-4b97-aa54-bb45362f6f4d', 'resend_delivered'),
  ('bec9465c-7709-42c3-bc8c-ac893b3a8588', 'name_match_collabbox'),
  ('bf248cd4-442b-469b-8108-5bbe8f474248', 'audit_OK_PAID_PROVEN'),
  ('bf4a96a9-0284-4fd5-9a95-13241129c34e', 'no_flag'),
  ('bf4f0b75-354d-42a6-8626-80b493080ee1', 'resend_delivered'),
  ('bf60e1c4-fd85-4cc4-8a41-1f6f5b894dd7', 'twin_living_sale'),
  ('bf62c81b-a1e9-44e2-b498-0a587881f0fc', 'resend_delivered'),
  ('bfceeda7-c8ab-4682-9295-52b973b3fc01', 'trace_unclaimed_parcel'),
  ('bfe31a4b-a9b9-40af-9ed2-2c4d35836646', 'parcel_in_register_unlinked'),
  ('c02068e8-ff63-4e57-9c4d-0d38211f3b63', 'same_price_twin'),
  ('c03a1287-8dee-4048-af72-accd36eaaf39', 'same_price_twin'),
  ('c07e6508-ca37-492d-b6d7-ce674f67e779', 'no_flag'),
  ('c08f62ab-b73e-4efe-94c6-ceba4af2492d', 'resend_delivered'),
  ('c095877a-ad1d-410e-b928-199a16e06b0b', 'dead_as_duplicate'),
  ('c095c2eb-7031-4858-a733-0fde743e0a4f', 'holds_mex_parcel'),
  ('c0a7d527-6e73-4aa1-a1dd-c6aeece9df81', 'resend_delivered'),
  ('c0d4f2e2-0542-4be7-8004-858219c5d7b8', 'trace_unclaimed_parcel'),
  ('c103547e-4e93-4a35-8076-3dde0746140e', 'parcel_in_register_unlinked'),
  ('c14b18e4-e8c8-43b1-9fc9-072407fe655d', 'parcel_in_register_unlinked'),
  ('c1b7102e-12fa-4090-88c7-edb554206e98', 'no_flag'),
  ('c1cfb954-ebe3-4821-87f0-a34556485461', 'no_flag'),
  ('c1d42a31-01a9-4299-b5ca-e7c1be9e9a9a', 'trace_unclaimed_parcel'),
  ('c22316f8-9fc3-43c0-ae19-87490ae3438a', 'no_flag'),
  ('c246f021-9568-4cf3-a695-5a377d02c8a9', 'already_proven'),
  ('c24c8354-2892-481b-9d8c-787c0a39c0f6', 'parcel_in_register_unlinked'),
  ('c27a0c22-183b-4f5f-93da-738aad3387cd', 'no_flag'),
  ('c2e8c306-10cf-43f2-b9a0-910736c48be7', 'audit_OK_PAID_PROVEN'),
  ('c325691b-771b-4784-a709-b7e5e8487051', 'resend_delivered'),
  ('c32574ca-04e4-4312-ab22-9fed71a7e13c', 'parcel_in_register_unlinked'),
  ('c3d84315-28a2-4f7f-a9ff-262f186794b0', 'resend_delivered'),
  ('c3fe1bcb-7b36-4ec7-856d-88848020f066', 'own_document_no_flag'),
  ('c4092318-9b3b-407a-b02c-364a1560e63d', 'no_flag'),
  ('c41c4e90-ea98-4415-90f3-31945f3928e5', 'resend_delivered'),
  ('c42878a9-4717-4841-9756-13d8dfc722df', 'audit_OK_PAID_PROVEN'),
  ('c43ffac8-1ca2-4a82-aca4-88ed624c421a', 'trace_unclaimed_parcel'),
  ('c4459218-ee29-4f27-bfc4-4436a6231f4f', 'dead_as_duplicate'),
  ('c4a57bcb-121d-4749-b152-01501d9fe1e9', 'audit_SET_CANCELLED_DUPLICATE'),
  ('c4ffaa98-19f7-4bd6-8c55-f31a6ecae1ba', 'dead_as_duplicate'),
  ('c507dc40-26c0-4f2c-87ea-e582df7862e1', 'audit_SET_CANCELLED_DUPLICATE'),
  ('c528233d-525d-4f8a-ab45-e969771033c8', 'no_flag'),
  ('c540a3ce-d8f6-4cff-ad21-a6950a53df2d', 'no_flag'),
  ('c551aed1-0da2-43c6-aa77-98a0fca61300', 'audit_SET_RETURNED'),
  ('c55af757-6493-421c-be15-07562920985d', 'resend_open'),
  ('c5912ccd-47cb-4938-809f-e2364a580355', 'twin_living_sale'),
  ('c5c19f3d-78e5-4edf-89c6-4f8d7be52a0b', 'resend_delivered'),
  ('c5e61b19-634b-4662-ad54-4210e13c7a5c', 'audit_SET_CANCELLED_DUPLICATE'),
  ('c5ec1988-531c-478c-b9e9-f0f80dc92d8d', 'audit_SET_CANCELLED_DUPLICATE'),
  ('c6096d05-56d5-49d7-b031-18dd115c7b59', 'audit_OK_DEAD_CUSTOMER_BOUGHT_ELSEWHERE'),
  ('c6267f22-09ae-4c26-97a2-767a12c84886', 'parcel_in_register_unlinked'),
  ('c653ab8a-d51e-4eb9-a3bf-a78e32ffd367', 'no_flag'),
  ('c6a481e5-07df-463e-8d44-ca59ed52d3a0', 'no_flag'),
  ('c6a829d4-bf4e-4d6b-a5b1-86f43d6b5de4', 'no_flag'),
  ('c70415a5-42d5-4443-91f7-e623ec0756fe', 'resend_delivered'),
  ('c74262ad-831a-4926-936e-4f8d12cef765', 'resend_delivered'),
  ('c7454320-d6f7-49bc-a7c3-4cd334ff771b', 'resend_delivered'),
  ('c7ae4759-1cf3-4656-9148-fb4a090f7694', 'parcel_in_register_unlinked'),
  ('c7c8ad9d-a77f-45a1-b2a4-bb6d7f2bbe0f', 'parcel_in_register_unlinked'),
  ('c7d71914-21c8-42cf-8b02-2701b10942bd', 'audit_OK_PAID_PROVEN'),
  ('c80e7732-92b8-4e77-9801-2bf7cccf16d0', 'audit_OK_PAID_PROVEN'),
  ('c816f810-1744-49a4-a90b-2c5ea315ffc9', 'audit_SET_CANCELLED_DUPLICATE'),
  ('c81e03c3-48be-4179-bbac-d7f0284c4706', 'resend_delivered'),
  ('c8315231-9e5d-43e2-80d7-aa353b9a4f28', 'twin_living_sale'),
  ('c83a1e1b-5ae4-4f4a-b57f-b9a03cbaedcb', 'trace_unclaimed_parcel'),
  ('c849a57a-911b-4941-917a-680bbbb49a35', 'parcel_in_register_unlinked'),
  ('c876fb99-0c4c-4b31-a16e-5c42620acf8e', 'resend_delivered'),
  ('c8a73974-d783-4ef9-a944-38ad80061f97', 'audit_OK_PAID_PROVEN'),
  ('c8ada487-ec4d-4716-b161-40df427b2766', 'audit_OK_PAID_PROVEN'),
  ('c8edba6d-2bb8-4bcf-96d6-f6477b6c6902', 'audit_SET_CANCELLED_DUPLICATE'),
  ('c953a733-4051-4efd-9986-8df22b9e9049', 'no_flag'),
  ('c98d04d1-0cd5-41e6-9713-3def5696a5a8', 'has_basis_operator_ruling'),
  ('c98fb2dd-f0c7-4a88-b16b-76d5a9953b9b', 'no_flag'),
  ('c9a5095f-b04b-4bee-b3bf-b66c4d257077', 'holds_mex_parcel'),
  ('c9abd8cd-6107-4900-a95d-61c30993f9c5', 'parcel_in_register_unlinked'),
  ('c9bcedbc-de0b-4180-a702-a68cced07e20', 'audit_OK_PAID_PROVEN'),
  ('c9d9701e-cf5e-4ed3-b6a6-e6e7cd2f265b', 'audit_OK_PAID_PROVEN'),
  ('ca1fa334-c4c4-4625-9e0e-217978f5047e', 'no_flag'),
  ('ca301841-1aa4-4018-9aa3-cd44e62dba84', 'dead_as_duplicate'),
  ('ca447664-3161-4d02-8720-3eb3a6b3a09e', 'no_flag'),
  ('cad7cef5-a45e-4b96-9da8-6d685bdebb70', 'parcel_in_register_unlinked'),
  ('cb6b50e8-9298-407f-b922-5c3817875363', 'audit_OK_PAID_PROVEN'),
  ('cc074c22-e386-4922-8e3b-f452af8dc09e', 'audit_OK_PAID_PROVEN'),
  ('cc30b365-bc77-49cc-bdf8-b1f6079a19c7', 'dead_as_duplicate'),
  ('cc38e6e4-af96-4a7e-9a23-a6aea32bfb52', 'parcel_in_register_unlinked'),
  ('cc4bebeb-2b92-4b48-b1d2-ab49fabc56fb', 'parcel_in_register_unlinked'),
  ('cc67026a-13ec-424a-bba5-20833002eb8f', 'trace_unclaimed_document'),
  ('cc7cdfa0-9e3e-4e5d-ae40-71acfb2b50b7', 'resend_delivered'),
  ('cc964991-d5fe-45a5-94cd-1912c58bfa01', 'no_flag'),
  ('cc9838f4-99db-42fd-8c6c-60d44a1772cd', 'audit_SET_CANCELLED_DUPLICATE'),
  ('cca241b8-f553-4e62-8d64-23f38ec7b3d6', 'no_flag'),
  ('ccb39c37-c660-414a-9523-6faf96b74a2b', 'no_flag'),
  ('ccc25e6b-56cd-4ae7-8cb5-4bc7e27c041c', 'audit_OK_PAID_PROVEN'),
  ('cccd7d5a-973c-4daf-b43f-76e8d18e4179', 'audit_OK_PAID_PROVEN'),
  ('ccf3ef92-bbdb-4fe4-b363-93da2e8609cc', 'twin_living_sale'),
  ('cd0ac3bc-0132-4ef9-879f-681cd6de949a', 'parcel_in_register_unlinked'),
  ('cd19b892-e1c8-4e61-bcf2-b34d7058dfc1', 'audit_SET_CANCELLED_DUPLICATE'),
  ('cd794420-c048-498b-8e39-eb59434bd984', 'no_flag'),
  ('cde8baca-146c-4812-9cdc-a8604cc2c942', 'resend_delivered'),
  ('cdf1692c-bcc8-4f2b-aad3-6a8aeb512f2f', 'audit_OK_PAID_PROVEN'),
  ('cdf51ec4-b757-4c47-b64f-40155e89ac39', 'holds_mex_parcel'),
  ('ce19718e-6ffd-47e2-b231-4e2c1508a93f', 'resend_delivered'),
  ('ce2998e5-eb08-484e-b9b5-c9cee3950836', 'resend_delivered'),
  ('ce3cda83-67d2-49f2-a4d6-91ef88967fdc', 'no_flag'),
  ('ce42836c-b692-48be-9f1e-cca66586de76', 'no_flag'),
  ('ce6536cb-f2d5-4211-bed5-63146cdafb28', 'no_flag'),
  ('cea67b50-ddd1-4cf1-9182-ed4a4651cd43', 'resend_delivered'),
  ('cea9b9bb-ea48-4341-a4f2-7de27642a342', 'twin_living_sale'),
  ('ceeefd16-779f-41c2-a3c4-36bff98ed347', 'delivered_later'),
  ('cf36e617-f5fc-449b-9f74-ddd9df52dc5d', 'dead_as_duplicate'),
  ('cf419145-7182-4afd-aca1-15eeec995f55', 'resend_delivered'),
  ('cf53ffac-375d-4955-b594-de0ba1e66c3c', 'resend_open'),
  ('cf5be35b-4128-49be-b86b-afa4f9500229', 'no_flag'),
  ('cf7213a8-e55d-4dbc-a175-2b4b0e959b87', 'no_flag'),
  ('cf873085-811a-46fd-9ec8-db472334e742', 'no_flag'),
  ('cf98020e-c01b-4e8b-9f3a-6bab01ac5e83', 'no_flag'),
  ('d0ca9cbf-7c10-416b-87b8-72b50ac187ba', 'no_flag'),
  ('d0e21a66-9d8d-487e-8d77-4aef7ce8121f', 'no_flag'),
  ('d0f77ab8-2637-4a4f-aa12-0c07dc687970', 'resend_delivered'),
  ('d1101af8-ca5d-482a-a4e5-7b2202daa2c9', 'twin_living_sale'),
  ('d111333a-0687-4bec-9be7-9923f7d1d0d8', 'parcel_in_register_unlinked'),
  ('d1201a33-1b56-4dc4-a1d3-c962dbd27653', 'no_flag'),
  ('d1388a02-2c2a-4df8-8c53-f72ea014db62', 'parcel_in_register_unlinked'),
  ('d13fd377-5344-4b6c-b8bd-ebb6d41a4b33', 'resend_delivered'),
  ('d17b3687-899b-42fd-8dce-6f3823ef03a3', 'trace_unclaimed_parcel'),
  ('d1db51ad-7028-4098-ba58-cf77183624bf', 'audit_OK_PAID_PROVEN'),
  ('d26ff8e6-ff2b-4ebc-81df-5ce9a5a181d7', 'audit_SET_CANCELLED_DUPLICATE'),
  ('d285f9b7-647d-4355-9afb-f4524f81e5cc', 'audit_SET_CANCELLED_DUPLICATE'),
  ('d2a54d29-54eb-4490-ba2c-8b5569cbce82', 'audit_SET_CANCELLED_DUPLICATE'),
  ('d2e15049-438f-4131-aa31-63c75698ead1', 'audit_OK_PAID_PROVEN'),
  ('d2ef69d0-d722-4494-b13a-2b6b3d58d12c', 'no_flag'),
  ('d33254c6-844f-42ec-8dd6-edd65a33b84a', 'no_flag'),
  ('d344dd01-517f-4aff-8e08-3ea47970df79', 'trace_unclaimed_document'),
  ('d36ac542-7a5a-47ea-ae5b-969f0fb55767', 'parcel_in_register_unlinked'),
  ('d3bfa5cc-1433-426f-8b43-586f0888bbe4', 'trace_unclaimed_parcel'),
  ('d3c0c2ec-e7ea-4415-ae91-f7da674c002d', 'resend_delivered'),
  ('d3dcd132-7ab2-434d-8c48-62b9ada8a579', 'audit_OK_PAID_PROVEN'),
  ('d3e4bedd-bade-4405-98eb-f849e39570fe', 'audit_REVIEW_DEAD_BUT_RETURNED'),
  ('d3ef7f77-b5ae-4d18-a84b-1eaede935893', 'audit_OK_PAID_PROVEN'),
  ('d41411c7-3836-4bb8-9d8a-81b7de2abae0', 'parcel_in_register_unlinked'),
  ('d4f30d19-637c-4d8f-9d60-abdb31afb949', 'trace_unclaimed_parcel'),
  ('d51f85a1-db04-47c3-a2d9-61f70b52c963', 'audit_OK_PAID_PROVEN'),
  ('d532999d-1b25-4852-837e-e42936db0b61', 'trace_unclaimed_document'),
  ('d58a87ee-7f54-4044-9792-8964146b3d81', 'audit_SET_CANCELLED_DUPLICATE'),
  ('d5958bea-6bb0-410c-bdf6-a1e804e1b2c5', 'dead_as_duplicate'),
  ('d5fb0574-94ce-4379-915a-50dac0b5971f', 'twin_living_sale'),
  ('d6316467-a365-45e5-8fc2-7751664e258a', 'audit_SET_CANCELLED_DUPLICATE'),
  ('d65f1da2-b988-40fd-9d0d-8bdc47f06e30', 'trace_unclaimed_parcel'),
  ('d6aba74d-403b-4d21-8b76-9ddebeb7f6d4', 'resend_delivered'),
  ('d6d0a6ab-c051-4532-b013-820ca121766f', 'dead_as_duplicate'),
  ('d6f461f8-d906-4534-899b-b1b70008b413', 'audit_OK_PAID_PROVEN'),
  ('d6f4a7fc-60e0-4595-aa5f-2d4c6d150914', 'resend_delivered'),
  ('d72effa1-2765-4515-91a9-8dcb04dcb20a', 'audit_OK_DEAD_CUSTOMER_BOUGHT_ELSEWHERE'),
  ('d781e42b-2e2a-47e0-b3e6-7fbcf1b7f0ab', 'resend_delivered'),
  ('d78b5bd5-317a-4bd7-b001-b059295b5f83', 'no_flag'),
  ('d78dced4-e318-4e5f-a00b-35d183cfc9f0', 'no_flag'),
  ('d7bc0116-28ea-4dcc-a92b-c5171fb721e5', 'audit_OK_PAID_PROVEN'),
  ('d814731f-379b-402a-b4d8-387e2f914a43', 'already_proven'),
  ('d82e99f0-4be8-4ec4-b23a-73b50ead5782', 'parcel_in_register_unlinked'),
  ('d87eb114-0abe-4c39-99b5-45fcf162849e', 'audit_OK_PAID_PROVEN'),
  ('d8d5089a-5546-4031-a917-c6c6c72f8c58', 'holds_mex_parcel'),
  ('d8d53d5e-fbc6-45f8-95cc-20616909a264', 'already_proven'),
  ('d8f59f89-847b-471c-8461-a14ae3eca753', 'trace_unclaimed_parcel'),
  ('d8f65ad9-ed92-4b2e-88b0-3fd0f3a2ba5f', 'resend_delivered'),
  ('d90acee2-3539-4b59-b0c6-da4ca87c9042', 'no_flag'),
  ('d98e8443-981f-4933-9003-494b6bfa5040', 'resend_delivered'),
  ('d99f44e2-659f-45b8-a127-8df6dc2ff8a5', 'resend_delivered'),
  ('d9eeb037-1798-42b2-beca-326d226e02c5', 'audit_SET_CANCELLED_DUPLICATE'),
  ('da07e112-d28b-4137-b402-ba8776cfe467', 'own_document_no_flag'),
  ('da0a88a0-5a7b-4db9-b497-54ace42f7c37', 'resend_delivered'),
  ('da0f0051-5499-4172-908a-f7befa8e1b3d', 'audit_SET_CANCELLED_DUPLICATE'),
  ('da68bd0d-9a6b-49c0-b5cc-ef77341f94b7', 'same_price_twin'),
  ('da9f68ca-4083-41d8-a09c-e3b8b415f9ce', 'audit_OK_PAID_PROVEN'),
  ('dab24dd7-d2d3-45ea-903a-6c352e81e5aa', 'resend_delivered'),
  ('dace357f-2d99-42ba-8cc3-2492cfb6416d', 'no_flag'),
  ('db0a6ac6-d927-45c6-aeda-f09b70b9396b', 'resend_delivered'),
  ('db18f557-35ff-429a-9ad9-a40b57148b6e', 'trace_unclaimed_parcel'),
  ('db2b8073-7460-4d6a-bd7c-b2099a1abe0e', 'no_flag'),
  ('db5685f2-6a0d-4e0f-a895-d6fe8518f453', 'audit_SET_CANCELLED_DUPLICATE'),
  ('db59530b-6e40-420d-a5e7-40ed06683063', 'no_flag'),
  ('db998881-6faa-488c-b94e-bda1e1bafa1f', 'resend_delivered'),
  ('dba071d0-b71f-4176-ab6e-a0ce35f158af', 'parcel_in_register_unlinked'),
  ('dbaf12cf-ff34-42e9-b9eb-2d203f103547', 'audit_SET_CANCELLED_DUPLICATE'),
  ('dbcc2ed6-c695-4a0f-9e78-2cf74cb25244', 'audit_OK_PAID_PROVEN'),
  ('dc22068b-81b2-4b27-8d9f-450e9ae7729d', 'no_flag'),
  ('dcb06919-ec70-487c-ab6f-33b8b7b378d0', 'trace_unclaimed_parcel'),
  ('dce6454b-cd5f-4c62-874c-6cefdbc1b20f', 'own_document_no_flag'),
  ('dd00bcb4-feed-4523-9b8d-8d3791df3a7a', 'twin_living_sale'),
  ('dd49b703-fbe0-463f-9f69-a28b216d065d', 'already_proven'),
  ('dd77daa3-6e08-477b-a70c-0793bfcd2b8c', 'audit_SET_CANCELLED_DUPLICATE'),
  ('dd7eb3df-70cc-4163-b7d3-a8a626d350da', 'twin_living_sale'),
  ('ddc4fe50-687e-4899-b439-8bb5cfd583a0', 'no_flag'),
  ('dddaba6b-e1b4-4b5d-b4cc-0a45ffe6063b', 'no_flag'),
  ('dddd638f-e555-4701-9ae0-f4760b67c273', 'no_flag'),
  ('de7e37c8-09cb-43f9-86ac-da0d4ffba40f', 'audit_SET_CANCELLED_DUPLICATE'),
  ('de90f897-01c2-4e71-9401-cd40b0778a01', 'resend_delivered'),
  ('ded4fd99-99f6-4c18-b889-05317a3caf27', 'same_price_twin'),
  ('df1c6907-3d0b-4d2c-999f-623d1363b520', 'dead_as_duplicate'),
  ('df998508-9ead-4759-956a-e50a517334a8', 'twin_living_sale'),
  ('dfa75f72-351d-41fc-8cd9-51a140048a56', 'audit_OK_PAID_PROVEN'),
  ('dfcef911-20d5-4d53-ac9d-2e6ecf0d441a', 'parcel_in_register_unlinked'),
  ('dfed7804-9095-4252-adc5-e672506cad4d', 'parcel_in_register_unlinked'),
  ('e00b8742-9aad-4911-bc82-57c17733ff67', 'parcel_in_register_unlinked'),
  ('e0611f43-4b32-4b46-85fa-56383ffc72af', 'no_flag'),
  ('e06e82dd-04c3-4ced-a071-34bb1e2cd985', 'no_flag'),
  ('e0c957f1-7a68-4c58-a685-6308d16eb8e7', 'audit_OK_PAID_PROVEN'),
  ('e0f161b8-5341-4c00-aaab-ff02bfb53108', 'no_flag'),
  ('e0f79c72-0c17-4b78-a991-f9470dccc80f', 'resend_delivered'),
  ('e11c7535-280a-477f-a381-b326973663b5', 'no_flag'),
  ('e1a4142c-6fcd-4191-a8b7-a1f80f4d6afd', 'no_flag'),
  ('e1aa84f7-9a8f-49c2-9468-d72afb441332', 'no_flag'),
  ('e1c41039-fcfb-417e-901f-d254b240ba98', 'parcel_in_register_unlinked'),
  ('e1ca8761-aeaa-4622-b9b6-76dfb592c997', 'resend_delivered'),
  ('e1f7829f-9495-49ac-8595-75f858c8b0cd', 'audit_OK_PAID_PROVEN'),
  ('e20eb5dc-c04c-434f-8de7-e47ade8db762', 'parcel_in_register_unlinked'),
  ('e21f251b-1e85-479a-b1b9-ef74ebc671b8', 'twin_living_sale'),
  ('e22ab02c-2db6-48ce-a380-00d2d32c7811', 'audit_OK_PAID_PROVEN'),
  ('e245fd2f-a5dc-48e0-8993-321b976a74a1', 'audit_SET_CANCELLED_DUPLICATE'),
  ('e250f4ea-9942-463b-bb1c-a3f95f3f8a15', 'resend_delivered'),
  ('e272704f-013b-482e-b9c8-ef4e239d7b8d', 'name_match_mex'),
  ('e279c670-670d-424d-8f8d-7b14f3803f78', 'audit_OK_PAID_PROVEN'),
  ('e2975534-27cb-40ce-8269-fcc3d7aef157', 'no_flag'),
  ('e2abccc9-70f3-4671-b520-57876812529c', 'no_flag'),
  ('e2d0f07f-4f01-46dc-ad62-6eba1c1dcc21', 'holds_mex_parcel'),
  ('e2fc1d1b-04e3-4c2f-ac4d-698aa4770cd7', 'already_proven'),
  ('e319a1ce-2867-42d7-9147-69d08a626fa6', 'parcel_in_register_unlinked'),
  ('e32caba1-d40c-4917-ae67-605032ee2ba7', 'audit_OK_DEAD_CUSTOMER_BOUGHT_ELSEWHERE'),
  ('e3649ba0-3ad4-466a-9f76-46f4f4477358', 'audit_OK_PAID_PROVEN'),
  ('e3708b36-d2f4-42e8-822f-c6388b04a9f8', 'dead_as_duplicate'),
  ('e381dbac-97bb-45d2-96f9-ca602bc83b69', 'trace_unclaimed_parcel'),
  ('e382f785-6acf-4ab0-a17e-ad113f422912', 'already_proven'),
  ('e3b07262-d675-409a-9979-ed0bce67db36', 'audit_SET_CANCELLED_DUPLICATE'),
  ('e3bb7849-6577-462d-82be-3afeb5356a2c', 'resend_delivered'),
  ('e3bf49c0-f087-4ee7-8640-8835338853a7', 'resend_delivered'),
  ('e3d39aeb-60c6-47c0-8b8c-ee194f1905a5', 'resend_delivered'),
  ('e3d871a4-3f68-44b9-ac45-3aa88da2003d', 'resend_delivered'),
  ('e3eacd29-4af5-4336-a5ea-168c5eb49551', 'parcel_in_register_unlinked'),
  ('e43abcaf-0416-4b0e-a174-10c0ba189401', 'parcel_in_register_unlinked'),
  ('e43cb0d9-81d2-4f75-8147-e207c46b3944', 'parcel_in_register_unlinked'),
  ('e451eb52-87fd-43b9-a807-8c473f47b332', 'no_flag'),
  ('e480f1c2-3c0a-40c3-9c01-66426acfe494', 'trace_unclaimed_parcel'),
  ('e4d18993-e903-42df-a66a-4ddbadffee52', 'trace_unclaimed_parcel'),
  ('e4ecba28-82ad-4900-9129-15d24b946c24', 'audit_OK_PAID_PROVEN'),
  ('e55d86a2-a0c8-4ea4-9bc8-417ff1cb655f', 'no_flag'),
  ('e578d905-7b91-4b36-bd3d-9d2283c3383c', 'twin_living_sale'),
  ('e5cadfd5-9456-46b9-8612-ff78fa19430c', 'no_flag'),
  ('e5ef88a4-07c3-40bc-83f7-cd1905df574b', 'audit_OK_PAID_PROVEN'),
  ('e6827423-1b22-4fcf-a21e-d078690e17dd', 'audit_OK_PAID_PROVEN'),
  ('e691d160-1333-4d88-8661-f9dc2ace23ab', 'parcel_in_register_unlinked'),
  ('e6a310da-8797-4d26-8e9e-c94bb283fb15', 'twin_living_sale'),
  ('e6bf8b0e-edc5-4543-9b26-6499115911f8', 'resend_delivered'),
  ('e6d1be99-36ba-4680-8184-4c8387ee087d', 'twin_living_sale'),
  ('e6e48e36-8bdc-4652-8686-4c94078ff1c5', 'dead_as_duplicate'),
  ('e6f3c952-6803-4f12-96d0-bf96a2d73ee9', 'no_flag'),
  ('e6fb0a28-8e92-4f63-9d08-8795e9779bda', 'audit_OK_PAID_PROVEN'),
  ('e70fc8e7-2b6d-4a5c-9bc5-b01742aef8d5', 'parcel_in_register_unlinked'),
  ('e7385686-9764-405d-a96d-afaffdfab44a', 'twin_living_sale'),
  ('e73c89dd-3ebc-4832-be28-c977955dabad', 'no_flag'),
  ('e7480a7e-e657-4d69-95c2-a18996d1ad15', 'no_flag'),
  ('e787a202-0d82-4119-9973-3cd549e1cb90', 'audit_OK_PAID_PROVEN'),
  ('e7a31972-e297-4828-a722-18ba41c55963', 'audit_OK_PAID_PROVEN'),
  ('e7adcb4c-219d-4236-8489-388c60ba29a6', 'resend_delivered'),
  ('e7ae0b11-86fd-4776-a150-b63b3a483475', 'parcel_in_register_unlinked'),
  ('e7e1e9b5-347e-4d2a-82f6-b81e8236dd5b', 'trace_unclaimed_parcel'),
  ('e84c4f6c-9e90-458e-ab49-78f5ea4af4e7', 'audit_OK_PAID_PROVEN'),
  ('e84cf139-8cbd-4547-a4d5-e705a4db6bcd', 'parcel_in_register_unlinked'),
  ('e8efb23c-8ae1-4467-be3a-2ee77c782fa2', 'parcel_in_register_unlinked'),
  ('e91512ef-f121-4d14-9a8b-4ed938b58d45', 'twin_living_sale'),
  ('e918e5bf-8982-4cf3-a157-efc65007abe3', 'parcel_held_by_another_order'),
  ('e9427092-85cc-4a46-85e1-6fdc4d5ec044', 'trace_unclaimed_parcel'),
  ('e9b0a6a1-cf6f-43d3-8343-47081094879b', 'no_flag'),
  ('e9e35edb-8c4f-4313-99f1-abceb87234f9', 'twin_living_sale'),
  ('e9eff1fa-3d52-4ce2-b890-9be3916903aa', 'parcel_in_register_unlinked'),
  ('ea1ba250-0320-43d2-a565-43d9f0054bd0', 'audit_OK_PAID_PROVEN'),
  ('ea32714e-8765-4587-a631-dec641cc86a5', 'audit_SET_CANCELLED_DUPLICATE'),
  ('ea3fe0ae-2318-4ca1-87b7-3689d0b476bc', 'parcel_in_register_unlinked'),
  ('ea403a37-ebc4-48d0-ba26-c2916daa513e', 'no_flag'),
  ('eaaded14-dc30-4c3c-baa1-254f0c48b18d', 'trace_unclaimed_parcel'),
  ('eac352d9-25c9-4193-a872-df2575dab047', 'no_flag'),
  ('eb335d83-b0f8-43e5-8f1c-157439c440a7', 'no_flag'),
  ('eb9c50c5-91d2-4c02-808d-24a453931be5', 'no_flag'),
  ('eb9e1a20-9b5a-4d4a-a901-4b156a9ff6e9', 'no_flag'),
  ('ebb977a4-da57-4087-a781-37793ab42376', 'no_flag'),
  ('ebe387d5-2777-4ebd-b350-9b4c396fe9b2', 'audit_OK_PAID_PROVEN'),
  ('ebeda733-1cc4-4ef1-82f8-1b8fcedef04c', 'twin_living_sale'),
  ('ebfdfef6-c4b2-4e5e-ba6b-b2223a59baaf', 'audit_OK_PAID_PROVEN'),
  ('ec0f0887-5565-4ef6-9592-7b776f7b37ee', 'audit_OK_PAID_PROVEN'),
  ('ec21075a-c1bc-4a75-bb1a-80c15c452609', 'audit_OK_PAID_PROVEN'),
  ('ec5dbb0d-f750-4cdb-9cb4-7e2b52286e75', 'no_flag'),
  ('ecd31835-8bea-4445-9c7b-c37961de1446', 'no_flag'),
  ('ece7804b-58a8-47b4-afd6-4de8808e5b21', 'audit_OK_PAID_PROVEN'),
  ('ed2c6b03-368a-4fe7-94c1-3f602ca1d683', 'audit_SET_RETURNED'),
  ('ed74f340-faa4-4211-a2f5-26fba1ca3e73', 'trace_unclaimed_parcel'),
  ('edadec30-267e-4cee-abc8-b1d325968ede', 'parcel_in_register_unlinked'),
  ('edb01c42-5761-4f9a-85b3-ca080fc68377', 'audit_OK_PAID_PROVEN'),
  ('edbfeed2-35d5-4ef1-a979-e168fda13774', 'audit_OK_PAID_PROVEN'),
  ('edd0182c-c45f-42fc-83e6-7c0751c293b3', 'trace_unclaimed_parcel'),
  ('eddd3fc7-2d40-4ca0-b4c1-7e5fdc469373', 'no_flag'),
  ('edeed431-1dc7-434c-a81e-ad9091e5222b', 'resend_delivered'),
  ('ee4b4c58-c648-48e3-b15d-ca00894f913f', 'audit_SET_RETURNED'),
  ('ee6457cf-2705-4f6a-be2a-dc2e98244bf4', 'resend_delivered'),
  ('ee64d122-4739-4995-80b1-4794dc2e5281', 'no_flag'),
  ('eec833f0-328d-4010-91c3-fac1139bb5d8', 'parcel_in_register_unlinked'),
  ('eee6aa0f-0606-4c8a-b38e-23658bb5da20', 'resend_delivered'),
  ('eef1c51e-c659-49c9-b38a-9a33e3052ec4', 'trace_unclaimed_parcel'),
  ('ef249c28-f26b-41e2-b297-1c48645745cb', 'no_flag'),
  ('ef41831a-e635-49be-ae72-bfece9f4b6da', 'resend_delivered'),
  ('ef443651-582f-4123-a806-faceb4f6d956', 'audit_SET_CANCELLED_DUPLICATE'),
  ('ef47e20a-0483-47a7-9e47-459d55d088aa', 'dead_as_duplicate'),
  ('ef81d198-5862-49f4-95a0-b83a65c3b932', 'twin_living_sale'),
  ('ef97aa92-4ca9-4623-a4a2-e80949ff1d6f', 'trace_unclaimed_parcel'),
  ('efbda356-bcb1-4522-9b5b-114aa9fdf8b3', 'no_flag'),
  ('efc1c298-2274-49fd-a440-11fa8a5883d7', 'audit_OK_PAID_PROVEN'),
  ('efc9e93f-19da-43c5-8012-950d4c2466e2', 'twin_living_sale'),
  ('efd99571-70f7-44d3-ab16-219ca9373f18', 'trace_unclaimed_parcel'),
  ('efe3274c-11a4-43b4-8c72-64e4f42dc6d2', 'no_flag'),
  ('effb02c8-57d8-4ecb-910c-ed886c8d62d4', 'parcel_in_register_unlinked'),
  ('f0575d9b-4908-4128-8d37-b334dd50c377', 'same_price_twin'),
  ('f06ccaa2-c0ff-4b48-afb8-96b5f76868f4', 'resend_delivered'),
  ('f077c7cc-7432-4a6d-9f95-11e83d73491e', 'audit_OK_PAID_PROVEN'),
  ('f07c88bc-ff12-4faa-8558-8e384a38f7ff', 'resend_delivered'),
  ('f133c8be-1527-4d39-876e-a8d0c816bfca', 'resend_delivered'),
  ('f13e3e38-7749-4121-bac4-27bdfe097e0c', 'parcel_in_register_unlinked'),
  ('f15bfd29-7549-4ce3-8d67-6abf2e3d9b10', 'audit_OK_PAID_PROVEN'),
  ('f16252e1-9a03-4e69-aa3d-774383414a77', 'resend_delivered'),
  ('f163217f-9be4-4f90-a927-b0a3d350d5d9', 'audit_OK_PAID_PROVEN'),
  ('f19bb31d-de1c-4c19-a813-0b591fdf2e2c', 'same_price_twin'),
  ('f1f2e624-4bd2-4545-9b28-4ec6a131edbe', 'no_flag'),
  ('f1fc0145-7c0b-450f-b5e9-d2f0001d9321', 'resend_delivered'),
  ('f21ab3ba-e5ea-4078-9c64-d9565a09060a', 'resend_delivered'),
  ('f238599e-a4bc-463f-8afc-c65198634137', 'resend_delivered'),
  ('f2525bbe-77c9-4424-aee6-406fa250c1ae', 'audit_SET_CANCELLED_DUPLICATE'),
  ('f259737a-de52-4b99-bddf-790082ad26d1', 'no_flag'),
  ('f26854d7-1141-40d3-8ab9-9db0776a5965', 'no_flag'),
  ('f27a451c-c593-41b5-90e4-d529561a5ca1', 'parcel_in_register_unlinked'),
  ('f2f1de90-e62a-481c-aec5-d73d680c1849', 'trace_unclaimed_parcel'),
  ('f30f27de-30e6-4a04-aab4-00af68ac2c04', 'audit_SET_RETURNED'),
  ('f315c796-c60b-450d-be94-4ba6e734e771', 'name_match_collabbox'),
  ('f38abab3-46be-41e7-be41-0f87a6c99384', 'no_flag'),
  ('f38ffc85-d134-45bd-9f68-c2d079c8308b', 'parcel_in_register_unlinked'),
  ('f3f0ae67-fa4e-498f-b5c4-92deeff60a46', 'parcel_in_register_unlinked'),
  ('f40fb23d-d215-4170-9c07-fa14feb468db', 'audit_SET_CANCELLED_DUPLICATE'),
  ('f435a647-4e05-474f-860c-0da3500b50f7', 'twin_living_sale'),
  ('f49f9722-61a6-4d11-9d14-3dd06172b8f5', 'no_flag'),
  ('f4bffcb2-8357-41fa-8f05-6493b7c66700', 'dead_as_duplicate'),
  ('f4fe1812-02e8-417d-ac9d-bf7eccbb091d', 'no_flag'),
  ('f5100dc4-6f6f-44d4-8541-66d13b37a4d1', 'resend_delivered'),
  ('f5165de3-e61d-4abf-a801-6051a6822f85', 'twin_living_sale'),
  ('f57eff98-2325-4e41-b951-e101cb3ce537', 'no_flag'),
  ('f5a92e11-cfed-47d5-b89e-e620459b07c4', 'audit_OK_PAID_PROVEN'),
  ('f5b61d1f-6d65-42a8-bb82-bf81121c50c3', 'audit_OK_PAID_PROVEN'),
  ('f5e57049-bf3a-4fe8-9279-2709dfcfecfd', 'no_flag'),
  ('f638f8a3-d4f7-4934-a06d-221aa1443baf', 'twin_living_sale'),
  ('f63e5798-63b0-4aba-84d4-c6e3d867387e', 'resend_delivered'),
  ('f6633863-562f-4742-8a2c-aaad13304466', 'parcel_in_register_unlinked'),
  ('f672bfa3-55ad-4357-91d7-b1da67f84a58', 'no_flag'),
  ('f6e93e11-eefe-4510-9741-c6d6a623cb5d', 'audit_OK_PAID_PROVEN'),
  ('f706d5f5-1eea-490f-a785-612af591f2f9', 'twin_living_sale'),
  ('f71cb7cc-0c8f-40dd-a82e-823a4ab2de9c', 'resend_delivered'),
  ('f72b3cb1-218a-4089-a028-ac6356b16ede', 'same_price_twin'),
  ('f7a35659-2bba-42ea-b17d-15295f5a491a', 'parcel_in_register_unlinked'),
  ('f7c03612-3386-4343-8e1a-5c4f5efe4a42', 'twin_living_sale'),
  ('f7cb3675-e774-448a-a479-5fab75d7f357', 'resend_delivered'),
  ('f7fa3af8-b032-4147-bad9-00b853b36a92', 'parcel_in_register_unlinked'),
  ('f7fc74bf-82ca-47d8-99e4-c9959de75cc4', 'resend_delivered'),
  ('f8072255-e99d-455b-a677-ce2d20dd762c', 'parcel_in_register_unlinked'),
  ('f82cf950-b1aa-42d1-916d-098c7133fda8', 'audit_OK_PAID_PROVEN'),
  ('f8319736-4f81-4ada-86fb-c1815fb6f155', 'audit_OK_PAID_PROVEN'),
  ('f87a605b-7da3-48c7-8348-799c0d577351', 'no_flag'),
  ('f8a13a0e-1d2b-46a4-b17b-89d19e75fcbc', 'audit_OK_PAID_PROVEN'),
  ('f8aebee8-acdf-4c3a-8685-9c867c700924', 'parcel_in_register_unlinked'),
  ('f8b76eed-6c32-46dc-9f66-2f297670cb2b', 'same_price_twin'),
  ('f8df43e3-6763-45df-af5f-aa8b9891d223', 'no_flag'),
  ('f8e6070e-79e9-496f-a365-eb69c3592f95', 'audit_OK_PAID_PROVEN'),
  ('f9105a17-be9f-42c8-8c2e-da4ed948236c', 'already_proven'),
  ('f92c9fba-82e7-45b6-87d8-42ef25f683b4', 'same_price_twin'),
  ('f94b6f53-405f-4ab8-b3c4-1d0087dce057', 'resend_delivered'),
  ('f96c8b5b-e4f6-4e7f-9819-8865e6e5b007', 'audit_OK_PAID_PROVEN'),
  ('f998aa91-148a-4cc9-afb9-818461f3b741', 'same_price_twin'),
  ('f99a4379-903a-4b28-8774-d33d6b8da783', 'no_flag'),
  ('f9c0359a-4f88-40ab-bd35-5c4d93f3a4e9', 'no_flag'),
  ('f9c27929-d156-45b1-9601-310603500f7e', 'twin_living_sale'),
  ('f9cb1793-c3e6-41b7-9dd4-b8cb6d9f68de', 'parcel_in_register_unlinked'),
  ('fa476d9a-cba0-4c8c-b1d6-82f59ac8911b', 'audit_OK_PAID_PROVEN'),
  ('fa5afaf2-84a6-4cd7-991f-d3734115885d', 'audit_SET_CANCELLED_DUPLICATE'),
  ('fa5f0dce-5a86-4b9a-b738-f5c94696103b', 'parcel_in_register_unlinked'),
  ('fa664b4c-5906-4810-b597-f6bb48e4e58a', 'audit_OK_DEAD_CUSTOMER_BOUGHT_ELSEWHERE'),
  ('fa66f27d-5140-419e-bdbd-a5e66b9e578d', 'audit_OK_DEAD_CUSTOMER_BOUGHT_ELSEWHERE'),
  ('fa6d333e-6996-4e98-b0e1-df0511869a62', 'audit_OK_PAID_PROVEN'),
  ('fa7d7fa0-0543-45b0-9ea1-36fe77613c93', 'no_flag'),
  ('fa83d8d0-2ee7-4112-81bb-dbf2200c3acc', 'audit_OK_PAID_PROVEN'),
  ('fa8855e1-b210-4d34-97c3-7fb4dc91cc11', 'no_flag'),
  ('fad5ab11-dfd3-4dbc-8c20-e3572f4469dd', 'no_flag'),
  ('faed57d2-ad02-42e8-b07b-7b7644c21197', 'parcel_in_register_unlinked'),
  ('fb85a07e-fc1c-4a59-bbdb-9cb707c7fc36', 'no_flag'),
  ('fb9e360d-17fd-4023-b658-5c29c6c23291', 'same_price_twin'),
  ('fbf91997-34d0-4a81-a372-ea198ab0b6df', 'already_proven'),
  ('fbfe1040-4b4a-429c-8aad-629bee887cbc', 'parcel_in_register_unlinked'),
  ('fc34ba60-9809-40a2-a4ba-d1dcedb2ba68', 'parcel_in_register_unlinked'),
  ('fc5a2efe-229e-4c7d-8b75-7ca8360d2679', 'audit_OK_PAID_PROVEN'),
  ('fc722fb3-4414-4698-b932-c9cb2ef20a7f', 'parcel_in_register_unlinked'),
  ('fc819b38-46ef-4f80-8cee-06c7640fb296', 'dead_as_duplicate'),
  ('fc8ee55b-98c8-47a0-8233-e5ce438d6ca2', 'no_flag'),
  ('fca33c9d-0665-4e22-b0e9-19eb421b8ed6', 'no_flag'),
  ('fcd451ca-efd1-4458-8e17-2961869f34bb', 'audit_OK_PAID_PROVEN'),
  ('fce42597-8809-44be-abc5-d6ab781a47f2', 'audit_OK_PAID_PROVEN'),
  ('fcea7f49-5367-48f0-8220-53ae490013fb', 'resend_delivered'),
  ('fcf058a2-2372-48ef-abb3-36d1331f1040', 'resend_delivered'),
  ('fcfc47ca-409d-4fdb-8af7-20f2c705b377', 'trace_unclaimed_parcel'),
  ('fd44c543-42dc-43ea-8148-460f690bf80d', 'parcel_in_register_unlinked'),
  ('fd743187-f19c-4730-9e26-8d6a996dee0c', 'no_flag'),
  ('fdd8a7e2-29ce-4325-8730-84de2d75711c', 'twin_living_sale'),
  ('fe04605b-f23d-49e8-9f50-3de9783ff8a5', 'no_flag'),
  ('fe0585c5-c452-4f4e-b588-89cd21ccf3f8', 'resend_delivered'),
  ('fe2e6d41-1fe3-458a-b300-474d76b9ac2c', 'trace_unclaimed_parcel'),
  ('fe375cdb-3d07-4b41-9c99-9eb794f0c925', 'parcel_in_register_unlinked'),
  ('fed22751-8d20-4b1b-8035-2e491add2bbf', 'no_flag'),
  ('feee1645-c4bf-43c6-8ecb-b4d2dbd6dc6c', 'no_flag'),
  ('fef9deda-6a6d-4692-b966-01f9fa3b6464', 'audit_SET_CANCELLED_DUPLICATE'),
  ('ff131bf2-c0a6-49ec-ab8a-7c83b312a70b', 'resend_delivered'),
  ('ff1a7063-ba8c-49a9-b45b-68c113420c5f', 'trace_unclaimed_parcel'),
  ('ff627597-28d5-4063-93d1-d6a8a276fd89', 'no_flag'),
  ('ffe5109d-40b1-4167-a217-ea509495991c', 'trace_unclaimed_parcel')
ON CONFLICT (order_id) DO NOTHING;

-- ── the views ───────────────────────────────────────────────────────────────
-- Views run as their owner (postgres) for the tables; sf_reader holds no table privilege.
GRANT EXECUTE ON FUNCTION public.cohort_order_bucket(text, numeric, timestamptz, text, text, text, text,
  integer, integer, timestamptz, boolean) TO sf_reader;

CREATE OR REPLACE VIEW public.sf_order_outcome_v AS
-- @@ORDER_VIEW_BEGIN
SELECT x.order_key, x.id, x.display_id, x.external_source, x.external_order_id, x.status, x.paid_basis,
       x.paid_at, x.returned_at, x.shipped_at, x.cancelled_at, x.cancellation_reason,
       x.mex_tracking_id, x.mex_account, x.mex_status_id, x.mex_cod_mkd, x.mex_delivered_at, x.parcel_count,
       x.price, x.bucket, x.proof, x.proof_reference, x.proof_courier, x.link_method, x.decider_altercpa_user,
       x.review_reason,
       md5('{"bucket":' || coalesce(to_json(x.bucket)::text, 'null')
        || ',"cancellation_reason":' || coalesce(to_json(x.cancellation_reason)::text, 'null')
        || ',"cancelled_at":' || coalesce('"' || to_char(x.cancelled_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') || '.000Z"', 'null')
        || ',"decider_altercpa_user":' || coalesce(x.decider_altercpa_user::text, 'null')
        || ',"display_id":' || coalesce(to_json(x.display_id)::text, 'null')
        || ',"external_order_id":' || coalesce(to_json(x.external_order_id)::text, 'null')
        || ',"external_source":' || coalesce(to_json(x.external_source)::text, 'null')
        || ',"id":' || coalesce(to_json(x.id::text)::text, 'null')
        || ',"link_method":' || coalesce(to_json(x.link_method)::text, 'null')
        || ',"mex_account":' || coalesce(to_json(x.mex_account)::text, 'null')
        || ',"mex_cod_mkd":' || coalesce(x.mex_cod_mkd::text, 'null')
        || ',"mex_delivered_at":' || coalesce('"' || to_char(x.mex_delivered_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') || '.000Z"', 'null')
        || ',"mex_status_id":' || coalesce(x.mex_status_id::text, 'null')
        || ',"mex_tracking_id":' || coalesce(to_json(x.mex_tracking_id)::text, 'null')
        || ',"order_key":' || coalesce(to_json(x.order_key)::text, 'null')
        || ',"paid_at":' || coalesce('"' || to_char(x.paid_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') || '.000Z"', 'null')
        || ',"paid_basis":' || coalesce(to_json(x.paid_basis)::text, 'null')
        || ',"parcel_count":' || coalesce(x.parcel_count::text, 'null')
        || ',"price":' || coalesce(to_json(x.price::text)::text, 'null')
        || ',"proof":' || coalesce(to_json(x.proof)::text, 'null')
        || ',"proof_courier":' || coalesce(to_json(x.proof_courier)::text, 'null')
        || ',"proof_reference":' || coalesce(to_json(x.proof_reference)::text, 'null')
        || ',"returned_at":' || coalesce('"' || to_char(x.returned_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') || '.000Z"', 'null')
        || ',"review_reason":' || coalesce(to_json(x.review_reason)::text, 'null')
        || ',"shipped_at":' || coalesce('"' || to_char(x.shipped_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') || '.000Z"', 'null')
        || ',"status":' || coalesce(to_json(x.status)::text, 'null')
        || '}') AS outcome_hash,
       x.created_at
  FROM (
    SELECT CASE WHEN o.external_source = 'altercpa' AND coalesce(o.external_order_id, '') <> ''
                  THEN 'ALTERCPA:' || o.external_order_id
                WHEN o.external_source = 'collabbox' AND coalesce(o.external_order_id, '') <> ''
                  THEN 'CBOX:' || o.external_order_id
                ELSE 'MKCRM:' || o.display_id END AS order_key,
           o.id, o.display_id, o.external_source, o.external_order_id, o.status::text AS status, o.paid_basis,
           o.paid_at, o.returned_at, o.shipped_at, o.cancelled_at, o.cancellation_reason,
           cur.tracking_id AS mex_tracking_id, cur.account AS mex_account, cur.status_id AS mex_status_id,
           cur.cod_mkd AS mex_cod_mkd, cur.delivered_at AS mex_delivered_at,
           pc.parcel_count,
           o.price,
           public.cohort_order_bucket(o.status::text, o.price, o.sold_at, o.paid_basis, o.source_type,
             o.sale_source_detail, o.mex_tracking_id, o.mex_status_id, o.mex_cod_mkd, o.mex_delivered_at,
             false) AS bucket,
           CASE WHEN cur.tracking_id IS NOT NULL AND cur.status_id IN (2, 7) THEN 'mex_parcel'
                WHEN cur.tracking_id IS NOT NULL THEN 'mex_parcel_open'
                WHEN pk.package_proof IN ('collabbox_courier_flag', 'mex_register_unlinked') THEN pk.package_proof
                WHEN o.status IN ('paid', 'returned', 'shipped') THEN 'none'
                ELSE '' END AS proof,
           CASE WHEN cur.tracking_id IS NOT NULL THEN cur.tracking_id
                WHEN pk.package_proof IN ('collabbox_courier_flag', 'mex_register_unlinked')
                  THEN coalesce(nullif(ev.doc, ''), nullif(ev.tracking, ''), '')
                ELSE '' END AS proof_reference,
           CASE WHEN cur.tracking_id IS NOT NULL THEN cur.account
                WHEN pk.package_proof IN ('collabbox_courier_flag', 'mex_register_unlinked')
                  THEN coalesce(ev.courier, '')
                ELSE '' END AS proof_courier,
           cur.link_method,
           dc.decided_by_altercpa_user AS decider_altercpa_user,
           'review_orders:' || rv.reason AS review_reason,
           o.created_at
      FROM public.orders o
      LEFT JOIN LATERAL (
        SELECT p.tracking_id, p.account, p.status_id, p.cod_mkd, p.delivered_at, p.link_method
          FROM public.mex_parcels p
         WHERE p.order_id = o.id
         ORDER BY (p.tracking_id = o.mex_tracking_id) IS TRUE DESC, p.last_update_at DESC NULLS LAST, p.tracking_id
         LIMIT 1) cur ON true
      -- the hand-over §3 evidence (export_clean_handover.py EV), read only where the package proof needs it
      LEFT JOIN LATERAL (
        SELECT r.rule, coalesce(r.evidence->>'resend_doc', r.evidence->>'doc') AS doc,
               r.evidence->>'tracking' AS tracking, r.evidence->>'courier' AS courier
          FROM public.data_repair_rows r
          JOIN public.data_repair_runs rr ON rr.id = r.run_id
         WHERE o.mex_tracking_id IS NULL
           AND (o.status = 'returned' OR (o.status = 'paid' AND o.paid_basis = 'operator_ruling'))
           AND r.order_id = o.id
           AND rr.applied_at >= timestamptz '2026-10-03 18:00:00+00'
           AND r.after IS NOT NULL
           AND rr.key <> 'cod-price' AND rr.key NOT LIKE 'rollback-%'
         ORDER BY rr.applied_at DESC, r.id DESC
         LIMIT 1) ev ON true
      -- the hand-over §3 package proof (export_clean_handover.py PROOF)
      CROSS JOIN LATERAL (
        SELECT CASE WHEN o.mex_tracking_id IS NOT NULL AND o.mex_status_id IN (2, 7) THEN 'mex_parcel'
                    WHEN o.mex_tracking_id IS NOT NULL THEN 'mex_parcel_open'
                    WHEN o.status = 'paid' AND o.paid_basis = 'operator_ruling' THEN 'collabbox_courier_flag'
                    WHEN o.status = 'returned' AND ev.rule IN ('paid_returned', 'dead_returned', 'dup_own_doc_returned')
                      THEN 'collabbox_courier_flag'
                    WHEN o.status = 'returned' AND ev.rule LIKE 'mex_returned%' THEN 'mex_register_unlinked'
                    WHEN o.status IN ('paid', 'returned', 'shipped') THEN 'none'
                    ELSE '' END AS package_proof) pk
      CROSS JOIN LATERAL (
        SELECT count(*)::integer AS parcel_count FROM public.mex_parcels pc WHERE pc.order_id = o.id) pc
      -- the AlterCPA login that decided the lead (the newest decision)
      LEFT JOIN LATERAL (
        SELECT l.decided_by_altercpa_user FROM public.altercpa_leads l
         WHERE l.order_id = o.id AND l.decided_by_altercpa_user IS NOT NULL
         ORDER BY l.decided_at DESC NULLS LAST, l.id DESC
         LIMIT 1) dc ON true
      LEFT JOIN public.sf_review_orders rv ON rv.order_id = o.id
     WHERE right(regexp_replace(coalesce(o.customer_phone, ''), '[^0-9]', '', 'g'), 8) NOT IN ('70123456', '23123123')
  ) x
 WHERE x.proof <> ''
-- @@ORDER_VIEW_END
;

CREATE OR REPLACE VIEW public.sf_parcel_v AS
-- @@PARCEL_VIEW_BEGIN
SELECT y.account, y.tracking_id, y.sender_reference, y.series, y.status_id, y.status_name, y.cod_mkd,
       y.created_at_mex, y.last_update_at, y.delivered_at, y.returned_at, y.picked_up_at, y.receiver_city,
       y.phone_last8, y.holder_order_key, y.link_method, y.linked_at, y.history,
       md5('{"account":' || coalesce(to_json(y.account)::text, 'null')
        || ',"cod_mkd":' || coalesce(y.cod_mkd::text, 'null')
        || ',"created_at_mex":' || coalesce('"' || to_char(y.created_at_mex AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') || '.000Z"', 'null')
        || ',"delivered_at":' || coalesce('"' || to_char(y.delivered_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') || '.000Z"', 'null')
        || ',"history":' || CASE WHEN y.history THEN 'true' ELSE 'false' END
        || ',"holder_order_key":' || coalesce(to_json(y.holder_order_key)::text, 'null')
        || ',"last_update_at":' || coalesce('"' || to_char(y.last_update_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') || '.000Z"', 'null')
        || ',"link_method":' || coalesce(to_json(y.link_method)::text, 'null')
        || ',"linked_at":' || coalesce('"' || to_char(y.linked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') || '.000Z"', 'null')
        || ',"phone_last8":' || coalesce(to_json(y.phone_last8)::text, 'null')
        || ',"picked_up_at":' || coalesce('"' || to_char(y.picked_up_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') || '.000Z"', 'null')
        || ',"receiver_city":' || coalesce(to_json(y.receiver_city)::text, 'null')
        || ',"returned_at":' || coalesce('"' || to_char(y.returned_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') || '.000Z"', 'null')
        || ',"sender_reference":' || coalesce(to_json(y.sender_reference)::text, 'null')
        || ',"series":' || coalesce(to_json(y.series)::text, 'null')
        || ',"status_id":' || coalesce(y.status_id::text, 'null')
        || ',"status_name":' || coalesce(to_json(y.status_name)::text, 'null')
        || ',"tracking_id":' || coalesce(to_json(y.tracking_id)::text, 'null')
        || '}') AS parcel_hash
  FROM (
    SELECT p.account, p.tracking_id, p.sender_reference, p.series, p.status_id, p.status_name, p.cod_mkd,
           p.created_at_mex, p.last_update_at, p.delivered_at, p.returned_at, p.picked_up_at, p.receiver_city,
           p.phone8 AS phone_last8,
           CASE WHEN h.id IS NULL THEN NULL
                WHEN h.external_source = 'altercpa' AND coalesce(h.external_order_id, '') <> ''
                  THEN 'ALTERCPA:' || h.external_order_id
                WHEN h.external_source = 'collabbox' AND coalesce(h.external_order_id, '') <> ''
                  THEN 'CBOX:' || h.external_order_id
                ELSE 'MKCRM:' || h.display_id END AS holder_order_key,
           p.link_method, p.linked_at, (p.history_run IS NOT NULL) AS history
      FROM public.mex_parcels p
      LEFT JOIN public.orders h ON h.id = p.order_id
     WHERE coalesce(p.phone8, '') NOT IN ('70123456', '23123123')
  ) y
-- @@PARCEL_VIEW_END
;

COMMENT ON VIEW public.sf_order_outcome_v IS
  'Salesforce read-only feed (20261024210000): the 27 columns of contracts/mk-courier-outcome views + created_at. '
  'Read by sf_reader only. Change only together with the Salesforce contract.';
COMMENT ON VIEW public.sf_parcel_v IS
  'Salesforce read-only feed (20261024210000): the 19 columns of contracts/mk-courier-outcome views. '
  'No receiver name, no full phone. Read by sf_reader only.';

REVOKE ALL ON public.sf_order_outcome_v FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.sf_parcel_v FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.sf_order_outcome_v TO sf_reader, service_role;
GRANT SELECT ON public.sf_parcel_v TO sf_reader, service_role;

DO $g$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_read_only_user') THEN
    EXECUTE 'GRANT SELECT ON public.sf_change_log, public.sf_review_orders, public.sf_order_outcome_v, '
            'public.sf_parcel_v TO supabase_read_only_user';
  END IF;
END $g$;

-- ── the triggers ────────────────────────────────────────────────────────────
-- orders: the columns the order view reads (outcome, key, current-parcel choice, bucket inputs, the test-
-- phone filter, the reconcile's created_at). Logged only for rows the view can hold (paid / returned /
-- shipped before or after, or holding a parcel). A changed order key also re-sends its parcels (their
-- holder_order_key).
CREATE OR REPLACE FUNCTION public.tg_sf_change_log_orders()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
BEGIN
  BEGIN
    IF TG_OP = 'INSERT' THEN
      INSERT INTO public.sf_change_log (order_id, tracking_id)
      SELECT n.id, n.mex_tracking_id
        FROM new_rows n
       WHERE n.status IN ('paid', 'returned', 'shipped') OR n.mex_tracking_id IS NOT NULL;
    ELSIF TG_OP = 'UPDATE' THEN
      WITH d AS (
        SELECT n.id,
               (o.external_source, o.external_order_id, o.display_id)
                 IS DISTINCT FROM (n.external_source, n.external_order_id, n.display_id) AS key_changed
          FROM new_rows n
          JOIN old_rows o ON o.id = n.id
         WHERE (o.status, o.paid_basis, o.paid_at, o.returned_at, o.shipped_at, o.cancelled_at,
                o.cancellation_reason, o.price, o.display_id, o.external_source, o.external_order_id,
                o.mex_tracking_id, o.mex_account, o.mex_status_id, o.mex_cod_mkd, o.mex_delivered_at,
                o.sold_at, o.source_type, o.sale_source_detail, o.customer_phone, o.created_at)
               IS DISTINCT FROM
               (n.status, n.paid_basis, n.paid_at, n.returned_at, n.shipped_at, n.cancelled_at,
                n.cancellation_reason, n.price, n.display_id, n.external_source, n.external_order_id,
                n.mex_tracking_id, n.mex_account, n.mex_status_id, n.mex_cod_mkd, n.mex_delivered_at,
                n.sold_at, n.source_type, n.sale_source_detail, n.customer_phone, n.created_at)
           AND (n.status IN ('paid', 'returned', 'shipped') OR o.status IN ('paid', 'returned', 'shipped')
                OR n.mex_tracking_id IS NOT NULL OR o.mex_tracking_id IS NOT NULL
                OR EXISTS (SELECT 1 FROM public.mex_parcels p WHERE p.order_id = n.id))
      )
      INSERT INTO public.sf_change_log (order_id, tracking_id)
      SELECT d.id, NULL::text FROM d
      UNION ALL
      SELECT p.order_id, p.tracking_id FROM d JOIN public.mex_parcels p ON p.order_id = d.id WHERE d.key_changed;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'sf_change_log (orders %) skipped: % %', TG_OP, SQLSTATE, SQLERRM;
  END;
  RETURN NULL;
END;
$fn$;

-- mex_parcels: the facts and the link the parcel view reads; the holder order (new and old) is logged too,
-- since the order view takes its mex_* columns and parcel_count from the parcel rows.
CREATE OR REPLACE FUNCTION public.tg_sf_change_log_parcels()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
BEGIN
  BEGIN
    IF TG_OP = 'INSERT' THEN
      INSERT INTO public.sf_change_log (order_id, tracking_id)
      SELECT n.order_id, n.tracking_id FROM new_rows n;
    ELSIF TG_OP = 'DELETE' THEN
      INSERT INTO public.sf_change_log (order_id, tracking_id)
      SELECT o.order_id, o.tracking_id FROM old_rows o WHERE o.order_id IS NOT NULL;
    ELSE
      WITH d AS (
        SELECT n.tracking_id, n.order_id, o.order_id AS old_order_id
          FROM new_rows n
          JOIN old_rows o ON o.tracking_id = n.tracking_id
         WHERE (o.account, o.sender_reference, o.series, o.status_id, o.status_name, o.cod_mkd,
                o.created_at_mex, o.last_update_at, o.delivered_at, o.returned_at, o.picked_up_at,
                o.receiver_city, o.phone8, o.order_id, o.link_method, o.linked_at, o.history_run)
               IS DISTINCT FROM
               (n.account, n.sender_reference, n.series, n.status_id, n.status_name, n.cod_mkd,
                n.created_at_mex, n.last_update_at, n.delivered_at, n.returned_at, n.picked_up_at,
                n.receiver_city, n.phone8, n.order_id, n.link_method, n.linked_at, n.history_run)
      )
      INSERT INTO public.sf_change_log (order_id, tracking_id)
      SELECT d.order_id, d.tracking_id FROM d
      UNION ALL
      SELECT d.old_order_id, NULL::text FROM d
       WHERE d.old_order_id IS NOT NULL AND d.old_order_id IS DISTINCT FROM d.order_id;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'sf_change_log (mex_parcels %) skipped: % %', TG_OP, SQLSTATE, SQLERRM;
  END;
  RETURN NULL;
END;
$fn$;

REVOKE ALL ON FUNCTION public.tg_sf_change_log_orders()  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tg_sf_change_log_parcels() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS sf_change_log_orders_ins ON public.orders;
DROP TRIGGER IF EXISTS sf_change_log_orders_upd ON public.orders;
DROP TRIGGER IF EXISTS sf_change_log_parcels_ins ON public.mex_parcels;
DROP TRIGGER IF EXISTS sf_change_log_parcels_upd ON public.mex_parcels;
DROP TRIGGER IF EXISTS sf_change_log_parcels_del ON public.mex_parcels;

CREATE TRIGGER sf_change_log_orders_ins
  AFTER INSERT ON public.orders
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.tg_sf_change_log_orders();

CREATE TRIGGER sf_change_log_orders_upd
  AFTER UPDATE ON public.orders
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.tg_sf_change_log_orders();

CREATE TRIGGER sf_change_log_parcels_ins
  AFTER INSERT ON public.mex_parcels
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.tg_sf_change_log_parcels();

CREATE TRIGGER sf_change_log_parcels_upd
  AFTER UPDATE ON public.mex_parcels
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.tg_sf_change_log_parcels();

CREATE TRIGGER sf_change_log_parcels_del
  AFTER DELETE ON public.mex_parcels
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.tg_sf_change_log_parcels();

-- ── the seed: everything that changed since Salesforce's T0 (22.10.2026 ~04:40 UTC) ─────────────
-- The triggers above already hold their locks on orders / mex_parcels, so no write can fall between the
-- seed and the first trigger row. Signals (a superset; Salesforce stores a row only when its content is new):
-- orders updated / created / with an outcome time since then, a status change (order_history), a repair
-- (data_repair_rows), the collab-entry rule, the approval hold; parcels updated / linked / new / seen.
-- Only orders the view holds are logged. Runs only on an empty log.
DO $seed$
DECLARE
  t0 constant timestamptz := timestamptz '2026-10-22 04:00:00+00';
BEGIN
  IF EXISTS (SELECT 1 FROM public.sf_change_log) THEN
    RAISE NOTICE 'sf_change_log is not empty: no seed';
    RETURN;
  END IF;
  INSERT INTO public.sf_change_log (order_id, tracking_id)
  SELECT s.order_id, s.tracking_id
    FROM (
      SELECT c.id AS order_id, NULL::text AS tracking_id, 1 AS part
        FROM (
          SELECT o.id FROM public.orders o
           WHERE o.updated_at >= t0 OR o.created_at >= t0
              OR greatest(o.paid_at, o.returned_at, o.cancelled_at, o.trashed_at, o.confirmed_at, o.shipped_at,
                          o.sold_at, o.mex_delivered_at, o.mex_returned_at, o.mex_last_update_at) >= t0
          UNION SELECT h.order_id FROM public.order_history h WHERE h.changed_at >= t0
          UNION SELECT r.order_id FROM public.data_repair_rows r JOIN public.data_repair_runs rr ON rr.id = r.run_id
                 WHERE rr.applied_at >= t0 OR r.created_at >= t0
          UNION SELECT i.order_id FROM public.collab_entry_rule_items i
                  JOIN public.collab_entry_rule_runs cr ON cr.id = i.run_id
                 WHERE cr.ran_at >= t0 OR cr.undone_at >= t0
          UNION SELECT a.order_id FROM public.approval_hold_log a WHERE a.at >= t0
          UNION SELECT p.order_id FROM public.mex_parcels p
                 WHERE p.order_id IS NOT NULL
                   AND (p.last_update_at >= t0 OR p.linked_at >= t0 OR p.first_seen_at >= t0 OR p.last_seen_at >= t0)
        ) c
       WHERE EXISTS (SELECT 1 FROM public.sf_order_outcome_v v WHERE v.id = c.id)
      UNION ALL
      SELECT p.order_id, p.tracking_id, 2 AS part
        FROM public.mex_parcels p
       WHERE (p.last_update_at >= t0 OR p.linked_at >= t0 OR p.first_seen_at >= t0 OR p.last_seen_at >= t0)
         AND coalesce(p.phone8, '') NOT IN ('70123456', '23123123')
    ) s
   ORDER BY s.part, s.order_id, s.tracking_id;
END
$seed$;

NOTIFY pgrst, 'reload schema';

COMMIT;
