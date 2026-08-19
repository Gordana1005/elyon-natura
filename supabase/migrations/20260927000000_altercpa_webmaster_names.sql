-- AlterCPA affiliates get NAMES.
--
-- Their merchant API hands us the affiliate only as a bare integer (`wm`), and
-- there is no directory endpoint to resolve it: comp/list.json returns no
-- wmname/wmlogin, and comp/stats.json cannot even GROUP BY affiliate (item is
-- offer/date/hour/stage/geo only — verified against cpa.moe/en+ru/api-comp.html
-- on 2026-08-18). The names exist only inside their web panel.
--
-- This is the exact wall the operator directory hit: scripts/data/
-- altercpa-operators.json is a hand-transcribed `user` id → name list for the
-- same reason. So the mapping lives here, is maintained by an admin, and
-- auto-populates itself so a new partner can never go unnoticed.
--
-- Orders store the ID, never the name (see 20260927000100). Renaming a partner
-- is therefore one UPDATE here and every surface follows — /orders, the Mirror
-- tab, the Rates tab and the rate-guarantee notifications.

-- ── 1) The lookup ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.altercpa_webmasters (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES public.altercpa_accounts(id) ON DELETE CASCADE,
  -- Their `wm`, kept as text for the same reason altercpa_leads.webmaster is:
  -- it is an opaque identifier, not a number we do arithmetic on.
  wm_id         text NOT NULL,
  -- NULL = discovered but not yet named. That is the work queue, and the UI
  -- renders it as "#3225" so an unnamed partner is visibly unnamed rather than
  -- silently blank.
  name          text,
  note          text,
  seen_count    bigint NOT NULL DEFAULT 0,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  named_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  named_at      timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_altercpa_webmasters
  ON public.altercpa_webmasters (account_id, wm_id);

DROP TRIGGER IF EXISTS trg_altercpa_webmasters_updated_at ON public.altercpa_webmasters;
CREATE TRIGGER trg_altercpa_webmasters_updated_at
  BEFORE UPDATE ON public.altercpa_webmasters
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ── 2) Self-populating sighting counter ──────────────────────────────────────
-- A structural copy of altercpa_record_offer_sighting (20260914000100), and for
-- the same two reasons: PostgREST's on_conflict= cannot be made to accumulate,
-- and ignoreDuplicates would freeze seen_count at whatever the first batch saw.
-- seen_count is the volume an admin sorts by to decide which unnamed affiliate
-- matters, so a silently wrong number is worse than no number.
--
-- Deliberately never touches `name`: the sync discovers affiliates, humans name
-- them, and a re-sighting must not undo an admin's correction.
CREATE OR REPLACE FUNCTION public.altercpa_record_webmaster_sighting(
  _account_id uuid,
  _wm_id      text,
  _n          integer DEFAULT 1
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _id uuid;
BEGIN
  INSERT INTO public.altercpa_webmasters (account_id, wm_id, seen_count, first_seen_at, last_seen_at)
  VALUES (_account_id, btrim(coalesce(nullif(btrim(_wm_id), ''), '(none)')),
          greatest(coalesce(_n, 1), 0), now(), now())
  ON CONFLICT (account_id, wm_id) DO UPDATE
    SET seen_count   = public.altercpa_webmasters.seen_count + greatest(coalesce(_n, 1), 0),
        last_seen_at = now()
  RETURNING id INTO _id;
  RETURN _id;
END;
$$;

-- Service role only: called by the sync function and the backfill, never from a browser.
REVOKE ALL ON FUNCTION public.altercpa_record_webmaster_sighting(uuid, text, integer)
  FROM public, anon, authenticated;

-- ── 3) RLS — same posture as every other altercpa_* table ────────────────────
-- Admin/manager only, deliberately NOT is_internal_staff: which partner sends
-- what volume is commercially sensitive, and affiliates hold real Supabase
-- logins that can hit PostgREST directly.
ALTER TABLE public.altercpa_webmasters ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins and managers manage altercpa webmasters" ON public.altercpa_webmasters;
CREATE POLICY "Admins and managers manage altercpa webmasters" ON public.altercpa_webmasters
  FOR ALL TO authenticated USING (public.is_admin_or_manager(auth.uid()));

REVOKE ALL ON public.altercpa_webmasters FROM anon;

-- ⚠️ A new table needs the explicit GRANT in this project or RLS is never even
-- consulted and the UI sees a permission error instead of an empty list
-- (the trap recorded in the 2026-08-04 security audit).
GRANT SELECT, INSERT, UPDATE, DELETE ON public.altercpa_webmasters TO authenticated;

-- ── 4) Seed the five live affiliates ─────────────────────────────────────────
-- Derived, not guessed. The operator's "Statistics by sources" panel for
-- 12–18 Aug 2026 was cross-matched against our own ledger for the same window,
-- comparing per-phase counts (their inbox column = phase 1+2+3+4, trash
-- excluded — an identity that holds on every row of their table):
--
--   3226  ours 8/2/3     vs Nastia Shakes  8/2/3      exact
--   3223  ours 130/34/9  vs ezaff.com      130/34/11  exact
--   3285  ours 71/25/8   vs LeadBit        72/26/10   ±1
--   2676  ours 1116      vs KMA.biz        1096       nearest by a wide margin
--   3221  ours 809       vs Fomikch        800        nearest by a wide margin
--
-- DO NOTHING, so re-applying this migration can never overwrite a correction an
-- admin has since made in the UI.
INSERT INTO public.altercpa_webmasters (account_id, wm_id, name, note)
SELECT a.id, v.wm_id, v.name, 'Seeded 2026-08-18 from the AlterCPA panel (statistics by sources).'
FROM public.altercpa_accounts a
CROSS JOIN (VALUES
  ('2676', 'KMA.biz'),
  ('3221', 'Fomikch'),
  ('3223', 'ezaff.com'),
  ('3285', 'LeadBit'),
  ('3226', 'Nastia Shakes')
) AS v(wm_id, name)
ON CONFLICT (account_id, wm_id) DO NOTHING;
