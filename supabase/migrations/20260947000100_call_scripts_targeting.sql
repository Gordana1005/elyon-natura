-- ============================================================================
-- Targeted call scripts (owner, 02.10.2026) — contract docs/CALL-SCRIPTS.md
-- ============================================================================
-- The owner wants scripts for LEADS and for PREDICTION, written on /call-scripts and shown on
-- /calls by what the agent works and who the client is. One script per LIST GROUP (recency band;
-- no split by value / order count / single list), optionally attached to products. Sections
-- Отворање · Презентација · Приговори · Затворање (+ custom) and quick answers (helpers).
-- Admins + managers write and publish, only admins delete; every change is a version and can be
-- restored. NOT LIVE: app_settings.call_scripts.mode = 'off' until the owner switches it.
--
-- What this migration does
--   1. call_scripts: + status, groups, product_ids, priority, sections, version, created_at /
--      created_by, published_at / published_by, copied_from (ADD COLUMN IF NOT EXISTS). The 13 live
--      rows backfill as published (their content is NOT touched).
--      Constraints: status, context_type (+ 'targeted'), groups ⊆ the 12 groups, ≤ 300 products,
--      priority −100…100, sections valid (call_script_sections_problem), legacy rows never target.
--   2. call_script_sections_text(sections, lang) — the derived script_text (mk / sq headings);
--      TypeScript twin sectionsToText (supabase/functions/api/callScriptMatch.ts).
--   3. call_script_versions — append-only (a trigger refuses UPDATE / DELETE), RLS deny-all,
--      service role only. UNIQUE (script_id, version); no FK, so a deleted script keeps its history.
--   4. RLS on call_scripts: the three old policies are dropped (text below), ONE select policy
--      call_scripts_select (InitPlan form): internal staff see published rows, admins / managers
--      see every row. INSERT / UPDATE / DELETE / TRUNCATE revoked from PUBLIC, anon, authenticated —
--      every write goes through the audited writers (service role only):
--        call_script_save · call_script_duplicate · call_scripts_bulk · call_script_restore ·
--        call_script_delete · call_scripts_set_mode
--      Each checks the actor's role itself, takes pg_advisory_xact_lock(hashtext('call_scripts')),
--      validates, writes, and adds a version row + one audit_log row in the same transaction.
--      Machine codes travel in the error HINT (the api maps them): stale (SQLSTATE CS409, DETAIL =
--      the current version), not_found (CS404), forbidden / admin_only (42501), and 22023 for
--      invalid input (unknown_field, bad_title, bad_description, bad_script_text, bad_group, unknown_product,
--      too_many_products, expected_version_required,
--      bad_priority, bad_sections, bad_helpers, bad_translations, script_text_derived,
--      legacy_field, bad_status, bad_transition, publish_needs_text, legacy_fixed, bad_targets,
--      bad_op, too_many, bad_mode, note_too_long).
--   5. call_script_demand() — waiting clients per list × product (members) and per lead group ×
--      product (open lead orders), test phones excluded. Feeds /call-scripts → Coverage.
--   6. app_settings.call_scripts = {"mode":"off"} (off | preview | on) — an OWNER key:
--      tg_app_settings_guard_owner_keys is re-emitted from the LIVE body (drift-guarded) with
--      'call_scripts' added; only admins change it, through call_scripts_set_mode (audited).
--   7. Data: each of the 11 legacy `product` rows gets a DRAFT targeted copy (copied_from = the
--      legacy id, sections = [pitch: script_text], the same for translations.sq, no targeting).
--      Every row gets a v1 'migrate' snapshot. The legacy rows themselves are not changed.
--
-- Rollback (nothing outside call_scripts / app_settings / the new objects is touched):
--   BEGIN;
--   DELETE FROM public.call_scripts WHERE context_type = 'targeted';      -- the copies + new scripts
--   DROP FUNCTION IF EXISTS public.call_script_save(uuid, uuid, integer, jsonb, text),
--     public.call_script_duplicate(uuid, uuid, jsonb, text), public.call_scripts_bulk(uuid, uuid[], jsonb, text),
--     public.call_script_restore(uuid, uuid, integer, text), public.call_script_delete(uuid, uuid, text),
--     public.call_scripts_set_mode(uuid, text, text), public.call_script_demand(), public.call_script_demand_json(),
--     public.call_script_apply_patch(public.call_scripts, jsonb), public.call_script_add_version(public.call_scripts, text, uuid, text),
--     public.call_script_blank(uuid),
--     public.call_script_publish_problem(public.call_scripts);
--   ALTER TABLE public.call_scripts DROP CONSTRAINT IF EXISTS call_scripts_status_check, DROP CONSTRAINT IF EXISTS
--     call_scripts_context_type_check, DROP CONSTRAINT IF EXISTS call_scripts_groups_check, DROP CONSTRAINT IF EXISTS
--     call_scripts_product_ids_check, DROP CONSTRAINT IF EXISTS call_scripts_priority_check, DROP CONSTRAINT IF EXISTS
--     call_scripts_sections_check, DROP CONSTRAINT IF EXISTS call_scripts_legacy_untargeted, DROP CONSTRAINT IF EXISTS
--     call_scripts_version_check;
--   DROP FUNCTION IF EXISTS public.call_script_sections_problem(jsonb), public.call_script_sections_normalize(jsonb),
--     public.call_script_sections_text(jsonb, text), public.call_script_groups();
--   ALTER TABLE public.call_scripts DROP COLUMN status, DROP COLUMN groups, DROP COLUMN product_ids, DROP COLUMN priority,
--     DROP COLUMN sections, DROP COLUMN version, DROP COLUMN created_at, DROP COLUMN created_by, DROP COLUMN published_at,
--     DROP COLUMN published_by, DROP COLUMN copied_from;
--   DROP POLICY IF EXISTS call_scripts_select ON public.call_scripts;  -- then re-create the three old policies:
--   CREATE POLICY "Admins can manage call scripts" ON public.call_scripts FOR ALL USING ((SELECT has_role((SELECT auth.uid()), 'admin'::app_role)));
--   CREATE POLICY "Managers can manage call scripts" ON public.call_scripts FOR ALL USING ((SELECT has_role((SELECT auth.uid()), 'manager'::app_role)));
--   CREATE POLICY "Internal staff can view call scripts" ON public.call_scripts FOR SELECT TO authenticated USING ((SELECT is_internal_staff((SELECT auth.uid()))));
--   GRANT INSERT, UPDATE, DELETE ON public.call_scripts TO authenticated;
--   -- keep call_script_versions (history) or DROP TABLE public.call_script_versions;
--   -- the guard may keep 'call_scripts' harmlessly; DELETE FROM public.app_settings WHERE key = 'call_scripts' needs the service role.
--   COMMIT;
-- ============================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ── 0. dependencies + drift guard ────────────────────────────────────────────
DO $dep$
DECLARE v_missing text;
BEGIN
  SELECT string_agg(x.n, ', ') INTO v_missing
    FROM (VALUES ('public.call_scripts'), ('public.audit_log'), ('public.app_settings'), ('public.products'),
                 ('public.orders'), ('public.profiles'), ('public.prediction_segment_members'),
                 ('public.prediction_segment_lists'), ('public.report_excluded_phones')) x(n)
   WHERE to_regclass(x.n) IS NULL;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION '20260947000100: missing tables: %', v_missing;
  END IF;
  SELECT string_agg(x.n, ', ') INTO v_missing
    FROM (VALUES ('public.is_internal_staff(uuid)'), ('public.is_admin_or_manager(uuid)'),
                 ('public.has_role(uuid,app_role)'), ('public.is_report_excluded_phone(text)'),
                 ('public.is_lead_source(text)'), ('public.tg_app_settings_guard_owner_keys()')) x(n)
   WHERE to_regprocedure(x.n) IS NULL;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION '20260947000100: missing functions: %', v_missing;
  END IF;
END
$dep$;

DO $drift$
DECLARE v_md5 text;
BEGIN
  SELECT md5(replace(p.prosrc, chr(13), '')) INTO v_md5
    FROM pg_proc p WHERE p.oid = to_regprocedure('public.tg_app_settings_guard_owner_keys()');
  IF v_md5 IS NULL OR v_md5 NOT IN (
       '20972a5a1ac9b1d0d60c515b95bbbe28',   -- 20260946000300 shops (… stock_v2, shops_reader) — LIVE 02.10.2026
       'cebcf4fd23bc95d3ef2bb6b465ec71e8')   -- this migration (re-run)
  THEN
    RAISE EXCEPTION 'call scripts: tg_app_settings_guard_owner_keys changed since this migration was written (md5 %) — re-emit it from the live body', v_md5;
  END IF;
END
$drift$;

-- ── 1. columns ───────────────────────────────────────────────────────────────
ALTER TABLE public.call_scripts
  ADD COLUMN IF NOT EXISTS status       text        NOT NULL DEFAULT 'published',
  ADD COLUMN IF NOT EXISTS groups       text[]      NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS product_ids  uuid[]      NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS priority     smallint    NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS sections     jsonb       NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS version      integer     NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS created_at   timestamptz,
  ADD COLUMN IF NOT EXISTS created_by   uuid,
  ADD COLUMN IF NOT EXISTS published_at timestamptz,
  ADD COLUMN IF NOT EXISTS published_by uuid,
  ADD COLUMN IF NOT EXISTS copied_from  uuid;

-- the live rows: created / published when last saved (only rows the backfill has not seen yet)
UPDATE public.call_scripts
   SET created_at   = coalesce(created_at, updated_at),
       published_at = CASE WHEN status = 'published' THEN coalesce(published_at, updated_at) ELSE published_at END
 WHERE created_at IS NULL;
ALTER TABLE public.call_scripts ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE public.call_scripts ALTER COLUMN created_at SET NOT NULL;

COMMENT ON COLUMN public.call_scripts.status IS 'draft | published | archived. Agents see published rows only (RLS call_scripts_select). Written only by the call_script_* writers. 20260947000100.';
COMMENT ON COLUMN public.call_scripts.groups IS 'Targeted rows: the list groups (lead_new, lead_callback, newcomers, d21, d57, m4_6, m6_12, y1_2, y2plus, cancels, never_converted, trash); {} = every group. Legacy rows: always {}.';
COMMENT ON COLUMN public.call_scripts.product_ids IS 'Targeted rows: the products (twins = same name count as one); {} = every product. ≤ 300.';
COMMENT ON COLUMN public.call_scripts.priority IS '−100…100; breaks a tie inside a match tier after "primary product first" (callScriptMatch.ts matchScripts).';
COMMENT ON COLUMN public.call_scripts.sections IS 'Ordered [{id, key: opening|pitch|objections|closing|custom, title? (custom), text ≤ 8000}], ≤ 12; script_text is derived from it (call_script_sections_text).';
COMMENT ON COLUMN public.call_scripts.version IS 'Bumped by every write; call_script_versions holds the snapshot of each version. The api refuses a save whose expected_version is not this (409 stale).';
COMMENT ON COLUMN public.call_scripts.copied_from IS 'The script this one was duplicated from (the 11 legacy product rows for the migration copies).';

-- ── 2. groups, sections: validation, normalisation, derived text ─────────────
CREATE OR REPLACE FUNCTION public.call_script_groups()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $fn$
  SELECT ARRAY['lead_new', 'lead_callback', 'newcomers', 'd21', 'd57', 'm4_6', 'm6_12', 'y1_2', 'y2plus',
               'cancels', 'never_converted', 'trash']::text[];
$fn$;
COMMENT ON FUNCTION public.call_script_groups() IS
  'The 12 call-script groups in display order — twin of ALL_GROUPS in supabase/functions/api/callScriptMatch.ts. 20260947000100.';

-- NULL = valid; else the first problem (validateSections in callScriptMatch.ts uses the same codes).
CREATE OR REPLACE FUNCTION public.call_script_sections_problem(p jsonb)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_temp
AS $fn$
DECLARE
  e jsonb;
  i int := 0;
  k text;
  sid text;
  t text;
  seen_keys text[] := '{}';
  seen_ids text[] := '{}';
BEGIN
  IF p IS NULL OR jsonb_typeof(p) <> 'array' THEN RETURN 'not_array'; END IF;
  IF jsonb_array_length(p) > 12 THEN RETURN 'too_many'; END IF;
  FOR e IN SELECT x FROM jsonb_array_elements(p) AS x LOOP
    i := i + 1;
    IF jsonb_typeof(e) <> 'object' THEN RETURN 'not_object:' || i; END IF;
    k := e->>'key';
    IF k IS NULL OR k NOT IN ('opening', 'pitch', 'objections', 'closing', 'custom') THEN RETURN 'bad_key:' || i; END IF;
    IF jsonb_typeof(e->'id') IS DISTINCT FROM 'string' THEN RETURN 'bad_id:' || i; END IF;
    sid := e->>'id';
    IF k <> 'custom' THEN
      IF k = ANY (seen_keys) THEN RETURN 'duplicate_key:' || i; END IF;
      seen_keys := seen_keys || k;
      IF sid <> k THEN RETURN 'bad_id:' || i; END IF;
    ELSE
      IF sid !~ '^custom-[a-z0-9]{6,12}$' THEN RETURN 'bad_id:' || i; END IF;
      t := CASE WHEN jsonb_typeof(e->'title') = 'string'
                THEN regexp_replace(e->>'title', '^[ \t\r\n]+|[ \t\r\n]+$', '', 'g') ELSE '' END;
      IF t = '' THEN RETURN 'title_required:' || i; END IF;
      IF length(t) > 80 THEN RETURN 'title_too_long:' || i; END IF;
    END IF;
    IF sid = ANY (seen_ids) THEN RETURN 'duplicate_id:' || i; END IF;
    seen_ids := seen_ids || sid;
    IF jsonb_typeof(e->'text') IS DISTINCT FROM 'string' THEN RETURN 'text_not_string:' || i; END IF;
    IF length(e->>'text') > 8000 THEN RETURN 'text_too_long:' || i; END IF;
  END LOOP;
  RETURN NULL;
END
$fn$;
COMMENT ON FUNCTION public.call_script_sections_problem(jsonb) IS
  'NULL when a sections array is valid (≤ 12; key opening|pitch|objections|closing|custom; a fixed key once with id = key; custom id custom-[a-z0-9]{6,12} + a title ≤ 80; text ≤ 8000), else the first problem. Twin of validateSections. 20260947000100.';

-- Keeps only {id, key, text} (+ the trimmed title of a custom section), in order.
CREATE OR REPLACE FUNCTION public.call_script_sections_normalize(p jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $fn$
  SELECT CASE WHEN p IS NULL OR jsonb_typeof(p) <> 'array' THEN p ELSE
    coalesce((
      SELECT jsonb_agg(
               CASE WHEN jsonb_typeof(e) <> 'object' THEN e
                    WHEN e->>'key' = 'custom'
                      THEN jsonb_build_object('id', e->'id', 'key', e->'key',
                             'title', CASE WHEN jsonb_typeof(e->'title') = 'string'
                                           THEN to_jsonb(regexp_replace(e->>'title', '^[ \t\r\n]+|[ \t\r\n]+$', '', 'g'))
                                           ELSE e->'title' END,
                             'text', e->'text')
                    ELSE jsonb_build_object('id', e->'id', 'key', e->'key', 'text', e->'text')
               END ORDER BY ord)
        FROM jsonb_array_elements(p) WITH ORDINALITY AS a(e, ord)
    ), '[]'::jsonb) END;
$fn$;

-- The derived plain text: "Heading\ntext" blocks joined by a blank line, empty sections skipped,
-- space / tab / CR / LF trimmed. MUST stay identical to sectionsToText (callScriptMatch.ts).
CREATE OR REPLACE FUNCTION public.call_script_sections_text(p_sections jsonb, p_lang text DEFAULT 'mk')
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $fn$
  SELECT coalesce(string_agg(CASE WHEN x.h <> '' THEN x.h || E'\n' || x.t ELSE x.t END, E'\n\n' ORDER BY x.ord), '')
    FROM (
      SELECT a.ord,
             regexp_replace(CASE WHEN jsonb_typeof(a.e->'text') = 'string' THEN a.e->>'text' ELSE coalesce(a.e->>'text', '') END,
                            '^[ \t\r\n]+|[ \t\r\n]+$', '', 'g') AS t,
             CASE a.e->>'key'
               WHEN 'opening'    THEN CASE WHEN p_lang = 'sq' THEN 'Hapja'         ELSE 'Отворање'     END
               WHEN 'pitch'      THEN CASE WHEN p_lang = 'sq' THEN 'Prezantimi'    ELSE 'Презентација' END
               WHEN 'objections' THEN CASE WHEN p_lang = 'sq' THEN 'Kundërshtimet' ELSE 'Приговори'    END
               WHEN 'closing'    THEN CASE WHEN p_lang = 'sq' THEN 'Mbyllja'       ELSE 'Затворање'    END
               ELSE regexp_replace(coalesce(a.e->>'title', ''), '^[ \t\r\n]+|[ \t\r\n]+$', '', 'g')
             END AS h
        FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_sections) = 'array' THEN p_sections ELSE '[]'::jsonb END)
             WITH ORDINALITY AS a(e, ord)
    ) x
   WHERE x.t <> '';
$fn$;
COMMENT ON FUNCTION public.call_script_sections_text(jsonb, text) IS
  'The derived script_text of a sectioned script (mk / sq headings). Twin of sectionsToText in supabase/functions/api/callScriptMatch.ts. 20260947000100.';

-- ── 3. constraints ───────────────────────────────────────────────────────────
ALTER TABLE public.call_scripts DROP CONSTRAINT IF EXISTS call_scripts_status_check;
ALTER TABLE public.call_scripts ADD CONSTRAINT call_scripts_status_check CHECK (status IN ('draft', 'published', 'archived'));
ALTER TABLE public.call_scripts DROP CONSTRAINT IF EXISTS call_scripts_context_type_check;
ALTER TABLE public.call_scripts ADD CONSTRAINT call_scripts_context_type_check
  CHECK (context_type IN ('order', 'prediction_lead', 'product', 'targeted'));
ALTER TABLE public.call_scripts DROP CONSTRAINT IF EXISTS call_scripts_groups_check;
ALTER TABLE public.call_scripts ADD CONSTRAINT call_scripts_groups_check CHECK (groups <@ ARRAY[
  'lead_new', 'lead_callback', 'newcomers', 'd21', 'd57', 'm4_6', 'm6_12', 'y1_2', 'y2plus', 'cancels', 'never_converted', 'trash']::text[]);
ALTER TABLE public.call_scripts DROP CONSTRAINT IF EXISTS call_scripts_product_ids_check;
ALTER TABLE public.call_scripts ADD CONSTRAINT call_scripts_product_ids_check CHECK (cardinality(product_ids) <= 300);
ALTER TABLE public.call_scripts DROP CONSTRAINT IF EXISTS call_scripts_priority_check;
ALTER TABLE public.call_scripts ADD CONSTRAINT call_scripts_priority_check CHECK (priority BETWEEN -100 AND 100);
ALTER TABLE public.call_scripts DROP CONSTRAINT IF EXISTS call_scripts_sections_check;
ALTER TABLE public.call_scripts ADD CONSTRAINT call_scripts_sections_check CHECK (public.call_script_sections_problem(sections) IS NULL);
ALTER TABLE public.call_scripts DROP CONSTRAINT IF EXISTS call_scripts_legacy_untargeted;
ALTER TABLE public.call_scripts ADD CONSTRAINT call_scripts_legacy_untargeted
  CHECK (context_type = 'targeted' OR (groups = '{}' AND product_ids = '{}'));
ALTER TABLE public.call_scripts DROP CONSTRAINT IF EXISTS call_scripts_version_check;
ALTER TABLE public.call_scripts ADD CONSTRAINT call_scripts_version_check CHECK (version >= 1);

CREATE INDEX IF NOT EXISTS call_scripts_targeted_idx ON public.call_scripts (status) WHERE context_type = 'targeted';

-- ── 4. versions (append-only) ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.call_script_versions (
  id          bigserial PRIMARY KEY,
  script_id   uuid        NOT NULL,
  version     integer     NOT NULL,
  action      text        NOT NULL CHECK (action IN ('migrate', 'create', 'update', 'publish', 'unpublish', 'archive',
                                                    'restore', 'duplicate', 'bulk', 'delete')),
  snapshot    jsonb       NOT NULL,
  actor_id    uuid,
  actor_name  text,
  note        text        CHECK (note IS NULL OR length(note) <= 500),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT call_script_versions_script_version_key UNIQUE (script_id, version)
);
COMMENT ON TABLE public.call_script_versions IS
  'Every version of every call script (snapshot = the row after the action; for delete, the row before). Append-only (trigger), service role only (RLS deny-all). No FK: a deleted script keeps its history and can be restored by an admin. 20260947000100.';
CREATE INDEX IF NOT EXISTS call_script_versions_delete_idx ON public.call_script_versions (created_at DESC) WHERE action = 'delete';

CREATE OR REPLACE FUNCTION public.tg_call_script_versions_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
BEGIN
  RAISE EXCEPTION 'call_script_versions is append-only' USING ERRCODE = '42501';
END
$fn$;
DROP TRIGGER IF EXISTS trg_call_script_versions_append_only ON public.call_script_versions;
CREATE TRIGGER trg_call_script_versions_append_only
  BEFORE UPDATE OR DELETE ON public.call_script_versions
  FOR EACH ROW EXECUTE FUNCTION public.tg_call_script_versions_append_only();

ALTER TABLE public.call_script_versions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.call_script_versions FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.call_script_versions_id_seq FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON public.call_script_versions TO service_role;
GRANT USAGE ON SEQUENCE public.call_script_versions_id_seq TO service_role;

-- ── 5. RLS on call_scripts ───────────────────────────────────────────────────
-- Dropped (for the rollback):
--   "Admins can manage call scripts"       FOR ALL                      USING ((SELECT has_role((SELECT auth.uid()), 'admin'::app_role)))
--   "Managers can manage call scripts"     FOR ALL                      USING ((SELECT has_role((SELECT auth.uid()), 'manager'::app_role)))
--   "Internal staff can view call scripts" FOR SELECT TO authenticated  USING ((SELECT is_internal_staff((SELECT auth.uid()))))
DROP POLICY IF EXISTS "Admins can manage call scripts" ON public.call_scripts;
DROP POLICY IF EXISTS "Managers can manage call scripts" ON public.call_scripts;
DROP POLICY IF EXISTS "Internal staff can view call scripts" ON public.call_scripts;
DROP POLICY IF EXISTS call_scripts_select ON public.call_scripts;
CREATE POLICY call_scripts_select ON public.call_scripts
  FOR SELECT TO authenticated
  USING ((SELECT public.is_internal_staff((SELECT auth.uid())))
         AND (status = 'published' OR (SELECT public.is_admin_or_manager((SELECT auth.uid())))));
ALTER TABLE public.call_scripts ENABLE ROW LEVEL SECURITY;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.call_scripts FROM PUBLIC, anon, authenticated;

-- ── 6. writer internals (not executable by anyone but the owner) ─────────────
-- A new, empty targeted draft (by field name — never by column position).
CREATE OR REPLACE FUNCTION public.call_script_blank(p_actor uuid)
RETURNS public.call_scripts
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
DECLARE r public.call_scripts;
BEGIN
  r.id := gen_random_uuid();
  r.context_type := 'targeted';
  r.status := 'draft';
  r.title := '';
  r.description := NULL;
  r.script_text := '';
  r.helpers := '[]'::jsonb;
  r.translations := '{}'::jsonb;
  r.groups := '{}';
  r.product_ids := '{}';
  r.priority := 0;
  r.sections := '[]'::jsonb;
  r.version := 1;
  r.created_at := now();
  r.created_by := p_actor;
  r.updated_at := now();
  r.updated_by := p_actor;
  r.published_at := NULL;
  r.published_by := NULL;
  r.copied_from := NULL;
  RETURN r;
END
$fn$;

-- The validated row after a patch (title, description, groups, product_ids, priority, sections,
-- helpers, translations, script_text). Status / versions / stamps are the caller's business.
CREATE OR REPLACE FUNCTION public.call_script_apply_patch(p_row public.call_scripts, p_patch jsonb)
RETURNS public.call_scripts
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
DECLARE
  r public.call_scripts := p_row;
  v_targeted boolean := (p_row.context_type = 'targeted');
  k text;
  v jsonb;
  v_txt text;
  v_arr text[];
  v_ids uuid[];
  v_missing text;
  v_problem text;
  v_tr jsonb;
  v_sq jsonb;
  v_sq_out jsonb;
BEGIN
  IF p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object' THEN
    RAISE EXCEPTION 'patch must be an object' USING ERRCODE = '22023', HINT = 'unknown_field';
  END IF;
  FOR k IN SELECT jsonb_object_keys(p_patch) LOOP
    IF k NOT IN ('title', 'description', 'status', 'groups', 'product_ids', 'priority', 'sections', 'helpers', 'translations', 'script_text') THEN
      RAISE EXCEPTION 'unknown field: %', k USING ERRCODE = '22023', HINT = 'unknown_field';
    END IF;
    IF NOT v_targeted AND k IN ('status', 'groups', 'product_ids', 'priority', 'sections') THEN
      RAISE EXCEPTION 'a legacy % script takes only title, description, script_text, helpers, translations (got %)', p_row.context_type, k
        USING ERRCODE = '22023', HINT = 'legacy_field';
    END IF;
    IF v_targeted AND k = 'script_text' THEN
      RAISE EXCEPTION 'script_text is derived from the sections' USING ERRCODE = '22023', HINT = 'script_text_derived';
    END IF;
  END LOOP;

  -- title
  IF p_patch ? 'title' THEN
    v := p_patch->'title';
    IF jsonb_typeof(v) <> 'string' THEN RAISE EXCEPTION 'title must be text' USING ERRCODE = '22023', HINT = 'bad_title'; END IF;
    v_txt := regexp_replace(v #>> '{}', '^[ \t\r\n]+|[ \t\r\n]+$', '', 'g');
    IF length(v_txt) > 200 THEN RAISE EXCEPTION 'title is too long (max 200)' USING ERRCODE = '22023', HINT = 'bad_title'; END IF;
    r.title := v_txt;
  END IF;
  -- description
  IF p_patch ? 'description' THEN
    v := p_patch->'description';
    IF jsonb_typeof(v) NOT IN ('string', 'null') THEN RAISE EXCEPTION 'description must be text' USING ERRCODE = '22023', HINT = 'bad_description'; END IF;
    v_txt := nullif(regexp_replace(coalesce(v #>> '{}', ''), '^[ \t\r\n]+|[ \t\r\n]+$', '', 'g'), '');
    IF length(v_txt) > 2000 THEN RAISE EXCEPTION 'description is too long (max 2000)' USING ERRCODE = '22023', HINT = 'bad_description'; END IF;
    r.description := v_txt;
  END IF;
  -- groups
  IF p_patch ? 'groups' THEN
    v := p_patch->'groups';
    IF jsonb_typeof(v) <> 'array' OR EXISTS (SELECT 1 FROM jsonb_array_elements(v) e WHERE jsonb_typeof(e) <> 'string') THEN
      RAISE EXCEPTION 'groups must be a list of group ids' USING ERRCODE = '22023', HINT = 'bad_group';
    END IF;
    SELECT string_agg(g, ', ') INTO v_missing
      FROM jsonb_array_elements_text(v) g WHERE g <> ALL (public.call_script_groups());
    IF v_missing IS NOT NULL THEN
      RAISE EXCEPTION 'unknown group: %', v_missing USING ERRCODE = '22023', HINT = 'bad_group';
    END IF;
    SELECT coalesce(array_agg(g ORDER BY array_position(public.call_script_groups(), g)), '{}')
      INTO v_arr FROM (SELECT DISTINCT g FROM jsonb_array_elements_text(v) g) d;
    r.groups := v_arr;
  END IF;
  -- product_ids
  IF p_patch ? 'product_ids' THEN
    v := p_patch->'product_ids';
    IF jsonb_typeof(v) <> 'array' OR EXISTS (
         SELECT 1 FROM jsonb_array_elements(v) e
          WHERE jsonb_typeof(e) <> 'string'
             OR (e #>> '{}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') THEN
      RAISE EXCEPTION 'product_ids must be a list of product ids' USING ERRCODE = '22023', HINT = 'unknown_product';
    END IF;
    SELECT coalesce(array_agg(DISTINCT (e)::uuid), '{}') INTO v_ids FROM jsonb_array_elements_text(v) e;
    IF cardinality(v_ids) > 300 THEN
      RAISE EXCEPTION 'at most 300 products per script' USING ERRCODE = '22023', HINT = 'too_many_products';
    END IF;
    SELECT string_agg(i::text, ', ') INTO v_missing
      FROM unnest(v_ids) i WHERE NOT EXISTS (SELECT 1 FROM public.products p WHERE p.id = i);
    IF v_missing IS NOT NULL THEN
      RAISE EXCEPTION 'unknown product: %', v_missing USING ERRCODE = '22023', HINT = 'unknown_product', DETAIL = v_missing;
    END IF;
    SELECT coalesce(array_agg(i ORDER BY i), '{}') INTO v_ids FROM unnest(v_ids) i;
    r.product_ids := v_ids;
  END IF;
  -- priority
  IF p_patch ? 'priority' THEN
    v := p_patch->'priority';
    IF jsonb_typeof(v) <> 'number' OR (v #>> '{}')::numeric <> trunc((v #>> '{}')::numeric)
       OR (v #>> '{}')::numeric NOT BETWEEN -100 AND 100 THEN
      RAISE EXCEPTION 'priority must be a whole number between -100 and 100' USING ERRCODE = '22023', HINT = 'bad_priority';
    END IF;
    r.priority := (v #>> '{}')::smallint;
  END IF;
  -- sections
  IF p_patch ? 'sections' THEN
    v := public.call_script_sections_normalize(p_patch->'sections');
    v_problem := public.call_script_sections_problem(v);
    IF v_problem IS NOT NULL THEN
      RAISE EXCEPTION 'invalid sections: %', v_problem USING ERRCODE = '22023', HINT = 'bad_sections', DETAIL = v_problem;
    END IF;
    r.sections := v;
  END IF;
  -- helpers (the quick answers)
  IF p_patch ? 'helpers' THEN
    v := p_patch->'helpers';
    IF jsonb_typeof(v) <> 'array' OR jsonb_array_length(v) > 50 OR EXISTS (
         SELECT 1 FROM jsonb_array_elements(v) h
          WHERE jsonb_typeof(h) <> 'object'
             OR jsonb_typeof(h->'title') IS DISTINCT FROM 'string' OR length(h->>'title') > 200
             OR jsonb_typeof(h->'content') IS DISTINCT FROM 'string' OR length(h->>'content') > 4000
             OR coalesce(jsonb_typeof(h->'category'), 'null') NOT IN ('string', 'null')) THEN
      RAISE EXCEPTION 'helpers must be ≤ 50 {title ≤ 200, content ≤ 4000, category?}' USING ERRCODE = '22023', HINT = 'bad_helpers';
    END IF;
    SELECT coalesce(jsonb_agg(jsonb_build_object('title', h->'title', 'content', h->'content', 'category', coalesce(h->'category', 'null'::jsonb)) ORDER BY ord), '[]'::jsonb)
      INTO r.helpers FROM jsonb_array_elements(v) WITH ORDINALITY AS a(h, ord);
  END IF;
  -- script_text (legacy rows only)
  IF p_patch ? 'script_text' THEN
    v := p_patch->'script_text';
    IF jsonb_typeof(v) <> 'string' OR length(v #>> '{}') > 20000 THEN
      RAISE EXCEPTION 'script_text must be text ≤ 20000' USING ERRCODE = '22023', HINT = 'bad_script_text';
    END IF;
    r.script_text := v #>> '{}';
  END IF;
  -- translations: {sq: {title, description, sections, helpers, script_text}} — mk + sq only
  IF p_patch ? 'translations' THEN
    v_tr := p_patch->'translations';
    IF jsonb_typeof(v_tr) = 'null' THEN v_tr := '{}'::jsonb; END IF;
    IF jsonb_typeof(v_tr) <> 'object' OR EXISTS (SELECT 1 FROM jsonb_object_keys(v_tr) t WHERE t <> 'sq') THEN
      RAISE EXCEPTION 'translations take only sq (scripts are written in mk and sq)' USING ERRCODE = '22023', HINT = 'bad_translations';
    END IF;
    v_sq := v_tr->'sq';
    IF v_sq IS NULL OR jsonb_typeof(v_sq) = 'null' THEN
      r.translations := '{}'::jsonb;
    ELSE
      IF jsonb_typeof(v_sq) <> 'object' OR EXISTS (
           SELECT 1 FROM jsonb_object_keys(v_sq) t WHERE t NOT IN ('title', 'description', 'sections', 'helpers', 'script_text')) THEN
        RAISE EXCEPTION 'translations.sq takes title, description, sections, helpers, script_text' USING ERRCODE = '22023', HINT = 'bad_translations';
      END IF;
      IF coalesce(jsonb_typeof(v_sq->'title'), 'null') NOT IN ('string', 'null')
         OR coalesce(jsonb_typeof(v_sq->'description'), 'null') NOT IN ('string', 'null')
         OR length(v_sq->>'title') > 200 OR length(v_sq->>'description') > 2000 THEN
        RAISE EXCEPTION 'translations.sq title / description must be text' USING ERRCODE = '22023', HINT = 'bad_translations';
      END IF;
      v_sq_out := jsonb_strip_nulls(jsonb_build_object('title', v_sq->'title', 'description', v_sq->'description'));
      IF v_sq ? 'sections' AND jsonb_typeof(v_sq->'sections') <> 'null' THEN
        v := public.call_script_sections_normalize(v_sq->'sections');
        v_problem := public.call_script_sections_problem(v);
        IF v_problem IS NOT NULL THEN
          RAISE EXCEPTION 'invalid sq sections: %', v_problem USING ERRCODE = '22023', HINT = 'bad_translations', DETAIL = v_problem;
        END IF;
        v_sq_out := v_sq_out || jsonb_build_object('sections', v);
      END IF;
      IF v_sq ? 'helpers' AND jsonb_typeof(v_sq->'helpers') <> 'null' THEN
        v := v_sq->'helpers';
        IF jsonb_typeof(v) <> 'array' OR jsonb_array_length(v) > 50 OR EXISTS (
             SELECT 1 FROM jsonb_array_elements(v) h
              WHERE jsonb_typeof(h) <> 'object'
                 OR jsonb_typeof(h->'title') IS DISTINCT FROM 'string' OR length(h->>'title') > 200
                 OR jsonb_typeof(h->'content') IS DISTINCT FROM 'string' OR length(h->>'content') > 4000) THEN
          RAISE EXCEPTION 'translations.sq.helpers invalid' USING ERRCODE = '22023', HINT = 'bad_translations';
        END IF;
        v_sq_out := v_sq_out || jsonb_build_object('helpers', v);
      END IF;
      IF v_targeted THEN
        IF v_sq_out ? 'sections' THEN
          v_sq_out := v_sq_out || jsonb_build_object('script_text', public.call_script_sections_text(v_sq_out->'sections', 'sq'));
        END IF;
      ELSIF v_sq ? 'script_text' AND jsonb_typeof(v_sq->'script_text') <> 'null' THEN
        IF jsonb_typeof(v_sq->'script_text') <> 'string' OR length(v_sq->>'script_text') > 20000 THEN
          RAISE EXCEPTION 'translations.sq.script_text must be text' USING ERRCODE = '22023', HINT = 'bad_translations';
        END IF;
        v_sq_out := v_sq_out || jsonb_build_object('script_text', v_sq->'script_text');
      END IF;
      r.translations := CASE WHEN v_sq_out = '{}'::jsonb THEN '{}'::jsonb ELSE jsonb_build_object('sq', v_sq_out) END;
    END IF;
  END IF;

  IF v_targeted THEN
    r.script_text := public.call_script_sections_text(r.sections, 'mk');
  END IF;
  RETURN r;
END
$fn$;

-- NULL when the row may be published; else why not (a targeted script needs a title and a section with text).
CREATE OR REPLACE FUNCTION public.call_script_publish_problem(p_row public.call_scripts)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $fn$
  SELECT CASE
    WHEN p_row.context_type <> 'targeted' THEN NULL
    WHEN regexp_replace(coalesce(p_row.title, ''), '^[ \t\r\n]+|[ \t\r\n]+$', '', 'g') = '' THEN 'title_required'
    WHEN public.call_script_sections_text(p_row.sections, 'mk') = '' THEN 'text_required'
    ELSE NULL END;
$fn$;

-- One version row (the snapshot = the row as given).
CREATE OR REPLACE FUNCTION public.call_script_add_version(p_row public.call_scripts, p_action text, p_actor uuid, p_note text)
RETURNS void
LANGUAGE sql
SET search_path = public, pg_temp
AS $fn$
  INSERT INTO public.call_script_versions (script_id, version, action, snapshot, actor_id, actor_name, note)
  VALUES (p_row.id, p_row.version, p_action, to_jsonb(p_row), p_actor,
          (SELECT pr.full_name FROM public.profiles pr WHERE pr.user_id = p_actor LIMIT 1), p_note);
$fn$;

REVOKE ALL ON FUNCTION public.call_script_blank(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.call_script_apply_patch(public.call_scripts, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.call_script_publish_problem(public.call_scripts) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.call_script_add_version(public.call_scripts, text, uuid, text) FROM PUBLIC, anon, authenticated;

-- ── 7. the writers (service role only) ───────────────────────────────────────
-- Create (p_id NULL: a targeted script, status from the patch, default draft) or update (p_id +
-- p_expected_version). Status moves: draft ↔ published, any → archived, archived → draft.
CREATE OR REPLACE FUNCTION public.call_script_save(p_actor uuid, p_id uuid, p_expected_version integer, p_patch jsonb, p_note text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_old public.call_scripts;
  v_new public.call_scripts;
  v_status text;
  v_action text;
  v_problem text;
  v_email text;
BEGIN
  IF p_actor IS NULL THEN RAISE EXCEPTION 'actor is required' USING ERRCODE = '22023', HINT = 'forbidden'; END IF;
  IF NOT public.is_admin_or_manager(p_actor) THEN
    RAISE EXCEPTION 'only admins and managers write call scripts' USING ERRCODE = '42501', HINT = 'forbidden';
  END IF;
  IF length(v_note) > 500 THEN RAISE EXCEPTION 'note is too long (max 500)' USING ERRCODE = '22023', HINT = 'note_too_long'; END IF;
  IF p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object' THEN
    RAISE EXCEPTION 'patch must be an object' USING ERRCODE = '22023', HINT = 'unknown_field';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('call_scripts'));
  SELECT u.email INTO v_email FROM auth.users u WHERE u.id = p_actor;

  IF p_id IS NULL THEN
    -- ── create ──
    v_status := coalesce(p_patch->>'status', 'draft');
    IF v_status NOT IN ('draft', 'published') THEN
      RAISE EXCEPTION 'a new script is a draft or published (got %)', v_status USING ERRCODE = '22023', HINT = 'bad_status';
    END IF;
    v_old := public.call_script_blank(p_actor);
    v_new := public.call_script_apply_patch(v_old, p_patch - 'status');
    v_new.status := v_status;
    IF v_status = 'published' THEN
      v_problem := public.call_script_publish_problem(v_new);
      IF v_problem IS NOT NULL THEN
        RAISE EXCEPTION 'a published script needs a title and a section with text (%)', v_problem USING ERRCODE = '22023', HINT = 'publish_needs_text', DETAIL = v_problem;
      END IF;
      v_new.published_at := now();
      v_new.published_by := p_actor;
    END IF;
    INSERT INTO public.call_scripts SELECT v_new.*;
    v_action := 'create';
  ELSE
    -- ── update ──
    SELECT * INTO v_old FROM public.call_scripts WHERE id = p_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'call script % not found', p_id USING ERRCODE = 'CS404', HINT = 'not_found'; END IF;
    IF p_expected_version IS NULL THEN
      RAISE EXCEPTION 'expected_version is required' USING ERRCODE = '22023', HINT = 'expected_version_required', DETAIL = v_old.version::text;
    END IF;
    IF v_old.version <> p_expected_version THEN
      RAISE EXCEPTION 'call script % is at version %, not %', p_id, v_old.version, p_expected_version
        USING ERRCODE = 'CS409', HINT = 'stale', DETAIL = v_old.version::text;
    END IF;
    v_new := public.call_script_apply_patch(v_old, p_patch - 'status');
    v_status := coalesce(p_patch->>'status', v_old.status);
    IF p_patch ? 'status' AND v_old.context_type <> 'targeted' THEN
      RAISE EXCEPTION 'a legacy script has no status' USING ERRCODE = '22023', HINT = 'legacy_field';
    END IF;
    IF v_status NOT IN ('draft', 'published', 'archived') THEN
      RAISE EXCEPTION 'unknown status %', v_status USING ERRCODE = '22023', HINT = 'bad_status';
    END IF;
    IF v_old.status = 'archived' AND v_status = 'published' THEN
      RAISE EXCEPTION 'an archived script goes back to draft first' USING ERRCODE = '22023', HINT = 'bad_transition';
    END IF;
    v_new.status := v_status;
    v_action := CASE
      WHEN v_status = v_old.status THEN 'update'
      WHEN v_status = 'published' THEN 'publish'
      WHEN v_status = 'archived' THEN 'archive'
      WHEN v_old.status = 'published' THEN 'unpublish'
      ELSE 'update' END;
    IF v_status = 'published' THEN
      v_problem := public.call_script_publish_problem(v_new);
      IF v_problem IS NOT NULL THEN
        RAISE EXCEPTION 'a published script needs a title and a section with text (%)', v_problem USING ERRCODE = '22023', HINT = 'publish_needs_text', DETAIL = v_problem;
      END IF;
      IF v_old.status <> 'published' THEN
        v_new.published_at := now();
        v_new.published_by := p_actor;
      END IF;
    ELSE
      v_new.published_at := NULL;
      v_new.published_by := NULL;
    END IF;
    -- nothing changed → no version, no audit
    IF (to_jsonb(v_new) - ARRAY['updated_at', 'updated_by']) = (to_jsonb(v_old) - ARRAY['updated_at', 'updated_by']) THEN
      RETURN jsonb_build_object('script', to_jsonb(v_old), 'action', 'none', 'changed', false);
    END IF;
    v_new.version := v_old.version + 1;
    v_new.updated_at := now();
    v_new.updated_by := p_actor;
    UPDATE public.call_scripts c
       SET title = v_new.title, description = v_new.description, script_text = v_new.script_text,
           helpers = v_new.helpers, translations = v_new.translations, status = v_new.status,
           groups = v_new.groups, product_ids = v_new.product_ids, priority = v_new.priority,
           sections = v_new.sections, version = v_new.version, updated_at = v_new.updated_at,
           updated_by = v_new.updated_by, published_at = v_new.published_at, published_by = v_new.published_by
     WHERE c.id = v_new.id;
  END IF;

  PERFORM public.call_script_add_version(v_new, v_action, p_actor, v_note);
  INSERT INTO public.audit_log (actor_id, actor_email, action, target_type, target_id, target_name, payload)
  VALUES (p_actor, v_email, 'call_script.' || v_action, 'call_script', v_new.id::text, v_new.title,
          jsonb_build_object('version', v_new.version, 'status', v_new.status, 'from_status', CASE WHEN p_id IS NULL THEN NULL ELSE v_old.status END,
                             'context_type', v_new.context_type, 'groups', to_jsonb(v_new.groups), 'product_ids', to_jsonb(v_new.product_ids),
                             'fields', (SELECT coalesce(jsonb_agg(k ORDER BY k), '[]'::jsonb) FROM jsonb_object_keys(p_patch) k),
                             'note', v_note));
  RETURN jsonb_build_object('script', to_jsonb(v_new), 'action', v_action, 'changed', true);
END
$fn$;

-- Copies a script to up to 50 targets [{title?, groups, product_ids}] as DRAFTS (copied_from = p_id).
-- A legacy source becomes sections [pitch: script_text] (+ the same for sq).
CREATE OR REPLACE FUNCTION public.call_script_duplicate(p_actor uuid, p_id uuid, p_targets jsonb, p_note text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_src public.call_scripts;
  v_base public.call_scripts;
  v_new public.call_scripts;
  v_t jsonb;
  v_sq jsonb;
  v_created jsonb := '[]'::jsonb;
  v_email text;
BEGIN
  IF p_actor IS NULL OR NOT public.is_admin_or_manager(p_actor) THEN
    RAISE EXCEPTION 'only admins and managers write call scripts' USING ERRCODE = '42501', HINT = 'forbidden';
  END IF;
  IF length(v_note) > 500 THEN RAISE EXCEPTION 'note is too long (max 500)' USING ERRCODE = '22023', HINT = 'note_too_long'; END IF;
  IF p_targets IS NULL OR jsonb_typeof(p_targets) <> 'array' OR jsonb_array_length(p_targets) = 0 THEN
    RAISE EXCEPTION 'targets must be a non-empty list' USING ERRCODE = '22023', HINT = 'bad_targets';
  END IF;
  IF jsonb_array_length(p_targets) > 50 THEN
    RAISE EXCEPTION 'at most 50 copies at once' USING ERRCODE = '22023', HINT = 'too_many';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('call_scripts'));
  SELECT * INTO v_src FROM public.call_scripts WHERE id = p_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'call script % not found', p_id USING ERRCODE = 'CS404', HINT = 'not_found'; END IF;
  SELECT u.email INTO v_email FROM auth.users u WHERE u.id = p_actor;

  v_base := v_src;
  v_base.context_type := 'targeted';
  v_base.status := 'draft';
  v_base.groups := '{}';
  v_base.product_ids := '{}';
  v_base.version := 1;
  v_base.created_at := now();
  v_base.created_by := p_actor;
  v_base.updated_at := now();
  v_base.updated_by := p_actor;
  v_base.published_at := NULL;
  v_base.published_by := NULL;
  v_base.copied_from := v_src.id;
  IF v_src.context_type <> 'targeted' THEN
    v_base.sections := CASE WHEN btrim(coalesce(v_src.script_text, '')) = '' THEN '[]'::jsonb
                            ELSE jsonb_build_array(jsonb_build_object('id', 'pitch', 'key', 'pitch', 'text', v_src.script_text)) END;
    v_base.priority := 0;
    v_sq := v_src.translations->'sq';
    v_base.translations := CASE WHEN v_sq IS NULL OR jsonb_typeof(v_sq) <> 'object' THEN '{}'::jsonb ELSE jsonb_build_object('sq',
      jsonb_strip_nulls(jsonb_build_object('title', v_sq->'title', 'description', v_sq->'description', 'helpers', v_sq->'helpers'))
      || CASE WHEN btrim(coalesce(v_sq->>'script_text', '')) = '' THEN '{}'::jsonb
              ELSE jsonb_build_object('sections', jsonb_build_array(jsonb_build_object('id', 'pitch', 'key', 'pitch', 'text', v_sq->>'script_text'))) END)
    END;
  END IF;

  FOR v_t IN SELECT x FROM jsonb_array_elements(p_targets) x LOOP
    IF jsonb_typeof(v_t) <> 'object' OR EXISTS (SELECT 1 FROM jsonb_object_keys(v_t) k WHERE k NOT IN ('title', 'groups', 'product_ids')) THEN
      RAISE EXCEPTION 'a target is {title?, groups, product_ids}' USING ERRCODE = '22023', HINT = 'bad_targets';
    END IF;
    v_new := v_base;
    v_new.id := gen_random_uuid();
    -- re-validate the copied content + the target through the same patch path
    v_new := public.call_script_apply_patch(v_new, jsonb_strip_nulls(jsonb_build_object(
      'title', coalesce(v_t->'title', to_jsonb(v_src.title)),
      'groups', coalesce(v_t->'groups', '[]'::jsonb),
      'product_ids', coalesce(v_t->'product_ids', '[]'::jsonb),
      'sections', v_new.sections,
      'translations', v_new.translations)));
    INSERT INTO public.call_scripts SELECT v_new.*;
    PERFORM public.call_script_add_version(v_new, 'duplicate', p_actor, v_note);
    v_created := v_created || jsonb_build_object('id', v_new.id, 'title', v_new.title, 'groups', to_jsonb(v_new.groups), 'product_ids', to_jsonb(v_new.product_ids));
  END LOOP;

  INSERT INTO public.audit_log (actor_id, actor_email, action, target_type, target_id, target_name, payload)
  VALUES (p_actor, v_email, 'call_script.duplicate', 'call_script', v_src.id::text, v_src.title,
          jsonb_build_object('created', v_created, 'count', jsonb_array_length(v_created), 'note', v_note));
  RETURN jsonb_build_object('created', v_created);
END
$fn$;

-- Up to 200 scripts at once: {add_groups, remove_groups, add_products, remove_products, status?, priority?}.
-- One version row per changed script (action 'bulk'), ONE audit row.
CREATE OR REPLACE FUNCTION public.call_scripts_bulk(p_actor uuid, p_ids uuid[], p_op jsonb, p_note text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_ids uuid[];
  v_id uuid;
  v_old public.call_scripts;
  v_new public.call_scripts;
  v_add_g text[] := '{}';
  v_rem_g text[] := '{}';
  v_add_p uuid[] := '{}';
  v_rem_p uuid[] := '{}';
  v_status text;
  v_patch jsonb;
  v_updated jsonb := '[]'::jsonb;
  v_skipped jsonb := '[]'::jsonb;
  v_email text;
  v_chk public.call_scripts;
BEGIN
  IF p_actor IS NULL OR NOT public.is_admin_or_manager(p_actor) THEN
    RAISE EXCEPTION 'only admins and managers write call scripts' USING ERRCODE = '42501', HINT = 'forbidden';
  END IF;
  IF length(v_note) > 500 THEN RAISE EXCEPTION 'note is too long (max 500)' USING ERRCODE = '22023', HINT = 'note_too_long'; END IF;
  SELECT coalesce(array_agg(DISTINCT i), '{}') INTO v_ids FROM unnest(p_ids) i WHERE i IS NOT NULL;
  IF cardinality(v_ids) = 0 THEN RAISE EXCEPTION 'no script ids' USING ERRCODE = '22023', HINT = 'bad_op'; END IF;
  IF cardinality(v_ids) > 200 THEN RAISE EXCEPTION 'at most 200 scripts at once' USING ERRCODE = '22023', HINT = 'too_many'; END IF;
  IF p_op IS NULL OR jsonb_typeof(p_op) <> 'object' OR p_op = '{}'::jsonb
     OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_op) k WHERE k NOT IN ('add_groups', 'remove_groups', 'add_products', 'remove_products', 'status', 'priority')) THEN
    RAISE EXCEPTION 'op is {add_groups, remove_groups, add_products, remove_products, status?, priority?}' USING ERRCODE = '22023', HINT = 'bad_op';
  END IF;
  -- validate the lists once through the patch path (unknown groups / products raise here)
  v_chk := public.call_script_blank(p_actor);
  v_add_g := (public.call_script_apply_patch(v_chk, jsonb_build_object('groups', coalesce(p_op->'add_groups', '[]'::jsonb)))).groups;
  v_rem_g := (public.call_script_apply_patch(v_chk, jsonb_build_object('groups', coalesce(p_op->'remove_groups', '[]'::jsonb)))).groups;
  v_add_p := (public.call_script_apply_patch(v_chk, jsonb_build_object('product_ids', coalesce(p_op->'add_products', '[]'::jsonb)))).product_ids;
  IF p_op ? 'remove_products' THEN
    IF jsonb_typeof(p_op->'remove_products') <> 'array' THEN RAISE EXCEPTION 'remove_products must be a list' USING ERRCODE = '22023', HINT = 'bad_op'; END IF;
    SELECT coalesce(array_agg(DISTINCT e::uuid), '{}') INTO v_rem_p
      FROM jsonb_array_elements_text(p_op->'remove_products') e
     WHERE e ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  END IF;
  IF p_op ? 'priority' THEN PERFORM public.call_script_apply_patch(v_chk, jsonb_build_object('priority', p_op->'priority')); END IF;
  v_status := p_op->>'status';
  IF v_status IS NOT NULL AND v_status NOT IN ('draft', 'published', 'archived') THEN
    RAISE EXCEPTION 'unknown status %', v_status USING ERRCODE = '22023', HINT = 'bad_status';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('call_scripts'));
  SELECT u.email INTO v_email FROM auth.users u WHERE u.id = p_actor;

  FOREACH v_id IN ARRAY v_ids LOOP
    SELECT * INTO v_old FROM public.call_scripts WHERE id = v_id FOR UPDATE;
    IF NOT FOUND THEN v_skipped := v_skipped || jsonb_build_object('id', v_id, 'reason', 'not_found'); CONTINUE; END IF;
    IF v_old.context_type <> 'targeted' THEN v_skipped := v_skipped || jsonb_build_object('id', v_id, 'reason', 'legacy'); CONTINUE; END IF;
    v_patch := jsonb_build_object(
      'groups', (SELECT coalesce(jsonb_agg(g), '[]'::jsonb) FROM unnest(v_old.groups || v_add_g) g WHERE g <> ALL (v_rem_g)),
      'product_ids', (SELECT coalesce(jsonb_agg(p), '[]'::jsonb) FROM unnest(v_old.product_ids || v_add_p) p WHERE p <> ALL (v_rem_p)));
    IF p_op ? 'priority' THEN v_patch := v_patch || jsonb_build_object('priority', p_op->'priority'); END IF;
    BEGIN
      v_new := public.call_script_apply_patch(v_old, v_patch);
    EXCEPTION WHEN SQLSTATE '22023' THEN
      v_skipped := v_skipped || jsonb_build_object('id', v_id, 'reason', 'invalid'); CONTINUE;
    END;
    IF v_status IS NOT NULL AND v_status <> v_old.status THEN
      IF v_old.status = 'archived' AND v_status = 'published' THEN
        v_skipped := v_skipped || jsonb_build_object('id', v_id, 'reason', 'bad_transition'); CONTINUE;
      END IF;
      v_new.status := v_status;
      IF v_status = 'published' THEN
        IF public.call_script_publish_problem(v_new) IS NOT NULL THEN
          v_skipped := v_skipped || jsonb_build_object('id', v_id, 'reason', 'publish_needs_text'); CONTINUE;
        END IF;
        v_new.published_at := now();
        v_new.published_by := p_actor;
      ELSE
        v_new.published_at := NULL;
        v_new.published_by := NULL;
      END IF;
    END IF;
    IF (to_jsonb(v_new) - ARRAY['updated_at', 'updated_by']) = (to_jsonb(v_old) - ARRAY['updated_at', 'updated_by']) THEN
      v_skipped := v_skipped || jsonb_build_object('id', v_id, 'reason', 'unchanged'); CONTINUE;
    END IF;
    v_new.version := v_old.version + 1;
    v_new.updated_at := now();
    v_new.updated_by := p_actor;
    UPDATE public.call_scripts c
       SET groups = v_new.groups, product_ids = v_new.product_ids, priority = v_new.priority, status = v_new.status,
           published_at = v_new.published_at, published_by = v_new.published_by, version = v_new.version,
           updated_at = v_new.updated_at, updated_by = v_new.updated_by
     WHERE c.id = v_id;
    PERFORM public.call_script_add_version(v_new, 'bulk', p_actor, v_note);
    v_updated := v_updated || jsonb_build_object('id', v_id, 'version', v_new.version);
  END LOOP;

  IF jsonb_array_length(v_updated) > 0 THEN
    INSERT INTO public.audit_log (actor_id, actor_email, action, target_type, target_id, target_name, payload)
    VALUES (p_actor, v_email, 'call_script.bulk', 'call_script',
            CASE WHEN jsonb_array_length(v_updated) = 1 THEN v_updated->0->>'id' END, NULL,
            jsonb_build_object('op', p_op, 'updated', v_updated, 'skipped', v_skipped, 'note', v_note));
  END IF;
  RETURN jsonb_build_object('updated', v_updated, 'skipped', v_skipped);
END
$fn$;

-- Content + targeting come back from a version's snapshot as a NEW version, keeping the current
-- status. A deleted script (admins only) comes back with the same id — a targeted one as a draft,
-- a legacy product row as published (legacy rows have no draft). Products that no longer exist
-- are dropped (reported).
CREATE OR REPLACE FUNCTION public.call_script_restore(p_actor uuid, p_id uuid, p_version integer, p_note text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_snap jsonb;
  v_old public.call_scripts;
  v_new public.call_scripts;
  v_from public.call_scripts;
  v_exists boolean;
  v_dropped jsonb := '[]'::jsonb;
  v_max int;
  v_email text;
BEGIN
  IF p_actor IS NULL OR NOT public.is_admin_or_manager(p_actor) THEN
    RAISE EXCEPTION 'only admins and managers write call scripts' USING ERRCODE = '42501', HINT = 'forbidden';
  END IF;
  IF length(v_note) > 500 THEN RAISE EXCEPTION 'note is too long (max 500)' USING ERRCODE = '22023', HINT = 'note_too_long'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('call_scripts'));
  SELECT v.snapshot INTO v_snap FROM public.call_script_versions v WHERE v.script_id = p_id AND v.version = p_version;
  IF v_snap IS NULL THEN RAISE EXCEPTION 'version % of call script % not found', p_version, p_id USING ERRCODE = 'CS404', HINT = 'not_found'; END IF;
  SELECT u.email INTO v_email FROM auth.users u WHERE u.id = p_actor;
  v_from := jsonb_populate_record(NULL::public.call_scripts, v_snap);
  SELECT coalesce(jsonb_agg(i), '[]'::jsonb) INTO v_dropped
    FROM unnest(coalesce(v_from.product_ids, '{}')) i WHERE NOT EXISTS (SELECT 1 FROM public.products p WHERE p.id = i);
  v_from.product_ids := ARRAY(SELECT i FROM unnest(coalesce(v_from.product_ids, '{}')) i WHERE EXISTS (SELECT 1 FROM public.products p WHERE p.id = i) ORDER BY i);

  SELECT * INTO v_old FROM public.call_scripts WHERE id = p_id FOR UPDATE;
  v_exists := FOUND;
  IF v_exists THEN
    v_new := v_old;
    v_new.title := v_from.title;
    v_new.description := v_from.description;
    v_new.helpers := coalesce(v_from.helpers, '[]'::jsonb);
    v_new.translations := coalesce(v_from.translations, '{}'::jsonb);
    IF v_old.context_type = 'targeted' THEN
      v_new.sections := coalesce(v_from.sections, '[]'::jsonb);
      v_new.groups := coalesce(v_from.groups, '{}');
      v_new.product_ids := v_from.product_ids;
      v_new.priority := coalesce(v_from.priority, 0);
      v_new.script_text := public.call_script_sections_text(v_new.sections, 'mk');
      IF v_new.status = 'published' AND public.call_script_publish_problem(v_new) IS NOT NULL THEN
        RAISE EXCEPTION 'that version has no text — unpublish the script before restoring it' USING ERRCODE = '22023', HINT = 'publish_needs_text';
      END IF;
    ELSE
      v_new.script_text := coalesce(v_from.script_text, '');
    END IF;
    v_new.version := v_old.version + 1;
  ELSE
    IF NOT public.has_role(p_actor, 'admin'::app_role) THEN
      RAISE EXCEPTION 'only admins restore a deleted script' USING ERRCODE = '42501', HINT = 'admin_only';
    END IF;
    SELECT max(v.version) INTO v_max FROM public.call_script_versions v WHERE v.script_id = p_id;
    v_new := v_from;
    v_new.id := p_id;
    v_new.status := CASE WHEN v_from.context_type = 'targeted' THEN 'draft' ELSE 'published' END;
    v_new.published_at := CASE WHEN v_new.status = 'published' THEN now() END;
    v_new.published_by := CASE WHEN v_new.status = 'published' THEN p_actor END;
    v_new.groups := CASE WHEN v_from.context_type = 'targeted' THEN coalesce(v_from.groups, '{}') ELSE '{}' END;
    v_new.product_ids := CASE WHEN v_from.context_type = 'targeted' THEN v_from.product_ids ELSE '{}' END;
    v_new.created_at := coalesce(v_from.created_at, now());
    v_new.version := coalesce(v_max, 0) + 1;
    IF v_from.context_type = 'targeted' THEN
      v_new.script_text := public.call_script_sections_text(coalesce(v_new.sections, '[]'::jsonb), 'mk');
    END IF;
  END IF;
  v_new.updated_at := now();
  v_new.updated_by := p_actor;

  IF v_exists THEN
    UPDATE public.call_scripts c
       SET title = v_new.title, description = v_new.description, script_text = v_new.script_text, helpers = v_new.helpers,
           translations = v_new.translations, groups = v_new.groups, product_ids = v_new.product_ids,
           priority = v_new.priority, sections = v_new.sections, version = v_new.version,
           updated_at = v_new.updated_at, updated_by = v_new.updated_by
     WHERE c.id = p_id;
  ELSE
    INSERT INTO public.call_scripts SELECT v_new.*;
  END IF;
  PERFORM public.call_script_add_version(v_new, 'restore', p_actor, v_note);
  INSERT INTO public.audit_log (actor_id, actor_email, action, target_type, target_id, target_name, payload)
  VALUES (p_actor, v_email, 'call_script.restore', 'call_script', p_id::text, v_new.title,
          jsonb_build_object('from_version', p_version, 'version', v_new.version, 'was_deleted', NOT v_exists,
                             'status', v_new.status, 'dropped_products', v_dropped, 'note', v_note));
  RETURN jsonb_build_object('script', to_jsonb(v_new), 'was_deleted', NOT v_exists, 'dropped_products', v_dropped);
END
$fn$;

-- Admins only: a snapshot version (the row before), then the delete. The order / prediction_lead rows stay.
CREATE OR REPLACE FUNCTION public.call_script_delete(p_actor uuid, p_id uuid, p_note text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_old public.call_scripts;
  v_snap public.call_scripts;
  v_email text;
BEGIN
  IF p_actor IS NULL OR NOT public.has_role(p_actor, 'admin'::app_role) THEN
    RAISE EXCEPTION 'only admins delete call scripts' USING ERRCODE = '42501', HINT = 'admin_only';
  END IF;
  IF length(v_note) > 500 THEN RAISE EXCEPTION 'note is too long (max 500)' USING ERRCODE = '22023', HINT = 'note_too_long'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('call_scripts'));
  SELECT * INTO v_old FROM public.call_scripts WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'call script % not found', p_id USING ERRCODE = 'CS404', HINT = 'not_found'; END IF;
  IF v_old.context_type IN ('order', 'prediction_lead') THEN
    RAISE EXCEPTION 'the % script is fixed and cannot be deleted', v_old.context_type USING ERRCODE = '22023', HINT = 'legacy_fixed';
  END IF;
  SELECT u.email INTO v_email FROM auth.users u WHERE u.id = p_actor;
  v_snap := v_old;
  v_snap.version := v_old.version + 1;
  PERFORM public.call_script_add_version(v_snap, 'delete', p_actor, v_note);
  DELETE FROM public.call_scripts WHERE id = p_id;
  INSERT INTO public.audit_log (actor_id, actor_email, action, target_type, target_id, target_name, payload)
  VALUES (p_actor, v_email, 'call_script.delete', 'call_script', p_id::text, v_old.title,
          jsonb_build_object('version', v_snap.version, 'context_type', v_old.context_type, 'status', v_old.status, 'note', v_note));
  RETURN jsonb_build_object('ok', true, 'version', v_snap.version);
END
$fn$;

-- The switch (admins = owners). Audited call_scripts.mode.
CREATE OR REPLACE FUNCTION public.call_scripts_set_mode(p_actor uuid, p_mode text, p_note text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_from text;
  v_email text;
BEGIN
  IF p_actor IS NULL OR NOT public.has_role(p_actor, 'admin'::app_role) THEN
    RAISE EXCEPTION 'only admins switch the call scripts' USING ERRCODE = '42501', HINT = 'admin_only';
  END IF;
  IF p_mode IS NULL OR p_mode NOT IN ('off', 'preview', 'on') THEN
    RAISE EXCEPTION 'mode is off, preview or on' USING ERRCODE = '22023', HINT = 'bad_mode';
  END IF;
  IF length(v_note) > 500 THEN RAISE EXCEPTION 'note is too long (max 500)' USING ERRCODE = '22023', HINT = 'note_too_long'; END IF;
  SELECT s.value->>'mode' INTO v_from FROM public.app_settings s WHERE s.key = 'call_scripts' FOR UPDATE;
  IF v_from IS NOT DISTINCT FROM p_mode THEN
    RETURN jsonb_build_object('mode', p_mode, 'changed', false);
  END IF;
  INSERT INTO public.app_settings (key, value, updated_at, updated_by)
  VALUES ('call_scripts', jsonb_build_object('mode', p_mode), now(), p_actor)
  ON CONFLICT (key) DO UPDATE SET value = coalesce(public.app_settings.value, '{}'::jsonb) || jsonb_build_object('mode', p_mode),
                                  updated_at = now(), updated_by = p_actor;
  SELECT u.email INTO v_email FROM auth.users u WHERE u.id = p_actor;
  INSERT INTO public.audit_log (actor_id, actor_email, action, target_type, target_id, target_name, payload)
  VALUES (p_actor, v_email, 'call_scripts.mode', 'app_settings', 'call_scripts', p_mode,
          jsonb_build_object('from', v_from, 'to', p_mode, 'note', v_note));
  RETURN jsonb_build_object('mode', p_mode, 'from', v_from, 'changed', true);
END
$fn$;

-- Waiting clients per list × product (members, through the trigger order's product) and per lead
-- group × product (open lead orders). Test phones excluded.
CREATE OR REPLACE FUNCTION public.call_script_demand()
RETURNS TABLE(kind text, list_id uuid, lead_group text, product_id uuid, product_name text, waiting integer, assigned integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  WITH m AS (
    SELECT mm.list_id, o.product_id, count(*)::int AS waiting, count(*) FILTER (WHERE mm.assigned_agent_id IS NOT NULL)::int AS assigned
      FROM public.prediction_segment_members mm
      JOIN public.prediction_segment_lists l ON l.id = mm.list_id AND l.is_active
      LEFT JOIN public.orders o ON o.id = mm.trigger_order_id
     WHERE NOT mm.is_completed
       -- = NOT is_report_excluded_phone(phone), inlined: that function is SECURITY DEFINER (never inlined)
       -- and cost ~2 s over the 113k open members; this anti-join is the same rule (report_excluded_phones.phone8)
       AND NOT EXISTS (SELECT 1 FROM public.report_excluded_phones x
                        WHERE x.phone8 = right(regexp_replace(mm.customer_phone, '[^0-9]', '', 'g'), 8))
     GROUP BY mm.list_id, o.product_id
  ),
  ld AS (
    SELECT CASE WHEN o.status::text = 'call_again' THEN 'lead_callback' ELSE 'lead_new' END AS lead_group,
           o.product_id, count(*)::int AS waiting, count(*) FILTER (WHERE o.assigned_agent_id IS NOT NULL)::int AS assigned
      FROM public.orders o
     WHERE o.status::text IN ('pending', 'take', 'call_again')
       AND public.is_lead_source(o.source_type)
       AND NOT EXISTS (SELECT 1 FROM public.report_excluded_phones x
                        WHERE x.phone8 = right(regexp_replace(o.customer_phone, '[^0-9]', '', 'g'), 8))
     GROUP BY 1, 2
  )
  SELECT 'member'::text, m.list_id, NULL::text, m.product_id, p.name, m.waiting, m.assigned
    FROM m LEFT JOIN public.products p ON p.id = m.product_id
  UNION ALL
  SELECT 'lead'::text, NULL::uuid, ld.lead_group, ld.product_id, p.name, ld.waiting, ld.assigned
    FROM ld LEFT JOIN public.products p ON p.id = ld.product_id
  ORDER BY 1, 2, 3, 4;   -- deterministic: the api reads it in 1000-row pages (PostgREST db-max-rows)
$fn$;
-- The same rows as ONE jsonb array: PostgREST caps a set-returning rpc at 1000 rows (db-max-rows)
-- and the demand is ~3.400 rows, so the api reads this wrapper in a single call.
CREATE OR REPLACE FUNCTION public.call_script_demand_json()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  SELECT coalesce(jsonb_agg(to_jsonb(d)), '[]'::jsonb) FROM public.call_script_demand() d;
$fn$;

COMMENT ON FUNCTION public.call_script_demand() IS
  'Call-scripts coverage demand: open members of active lists by trigger-order product, and open lead orders (pending/take → lead_new, call_again → lead_callback) by product; test phones excluded. Service role. 20260947000100.';

DO $grants$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.call_script_save(uuid, uuid, integer, jsonb, text)',
    'public.call_script_duplicate(uuid, uuid, jsonb, text)',
    'public.call_scripts_bulk(uuid, uuid[], jsonb, text)',
    'public.call_script_restore(uuid, uuid, integer, text)',
    'public.call_script_delete(uuid, uuid, text)',
    'public.call_scripts_set_mode(uuid, text, text)',
    'public.call_script_demand()',
    'public.call_script_demand_json()'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END LOOP;
END
$grants$;

-- ── 8. the switch (an OWNER key) ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.tg_app_settings_guard_owner_keys()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
DECLARE
  _guarded constant text[] := ARRAY['no_parcel_rule', 'stock_mex_movements', 'stock_counted_at', 'mex_push', 'link_lead_parcels', 'leads_parcel_orders', 'stock_v2', 'shops_reader', 'call_scripts'];
BEGIN
  IF current_user IN ('anon', 'authenticated')
     AND (CASE WHEN TG_OP = 'DELETE' THEN OLD.key ELSE NEW.key END = ANY (_guarded)
          OR (TG_OP = 'UPDATE' AND OLD.key = ANY (_guarded))) THEN
    RAISE EXCEPTION 'app_settings.% is changed only through its owners'' switch in the app',
                    CASE WHEN TG_OP = 'INSERT' THEN NEW.key ELSE OLD.key END
      USING ERRCODE = '42501';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$fn$;

INSERT INTO public.app_settings (key, value) VALUES ('call_scripts', '{"mode":"off"}'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- ── 9. data: draft copies of the 11 legacy product scripts + the v1 snapshots ─
INSERT INTO public.call_scripts (id, context_type, title, description, script_text, helpers, translations, status,
                                 groups, product_ids, priority, sections, version, created_at, created_by,
                                 updated_at, updated_by, published_at, published_by, copied_from)
SELECT gen_random_uuid(), 'targeted', l.title, l.description,
       public.call_script_sections_text(s.sections, 'mk'),
       coalesce(l.helpers, '[]'::jsonb),
       CASE WHEN jsonb_typeof(l.translations->'sq') = 'object' THEN jsonb_build_object('sq',
         jsonb_strip_nulls(jsonb_build_object('title', l.translations->'sq'->'title', 'description', l.translations->'sq'->'description',
                                              'helpers', l.translations->'sq'->'helpers'))
         || CASE WHEN btrim(coalesce(l.translations->'sq'->>'script_text', '')) = '' THEN '{}'::jsonb
                 ELSE jsonb_build_object(
                        'sections', jsonb_build_array(jsonb_build_object('id', 'pitch', 'key', 'pitch', 'text', l.translations->'sq'->>'script_text')),
                        'script_text', public.call_script_sections_text(
                          jsonb_build_array(jsonb_build_object('id', 'pitch', 'key', 'pitch', 'text', l.translations->'sq'->>'script_text')), 'sq'))
            END)
         ELSE '{}'::jsonb END,
       'draft', '{}', '{}', 0, s.sections, 1, now(), NULL, now(), NULL, NULL, NULL, l.id
  FROM public.call_scripts l
  CROSS JOIN LATERAL (SELECT CASE WHEN btrim(coalesce(l.script_text, '')) = '' THEN '[]'::jsonb
                                  ELSE jsonb_build_array(jsonb_build_object('id', 'pitch', 'key', 'pitch', 'text', l.script_text)) END AS sections) s
 WHERE l.context_type = 'product'
   AND NOT EXISTS (SELECT 1 FROM public.call_scripts t WHERE t.context_type = 'targeted' AND t.copied_from = l.id);

INSERT INTO public.call_script_versions (script_id, version, action, snapshot, actor_id, actor_name, note)
SELECT c.id, c.version, 'migrate', to_jsonb(c), NULL, NULL,
       CASE WHEN c.copied_from IS NOT NULL THEN '20260947000100: draft copy of the legacy product script'
            ELSE '20260947000100: the live row at migration' END
  FROM public.call_scripts c
ON CONFLICT (script_id, version) DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';
