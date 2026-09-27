-- ============================================================================
-- SALES PEOPLE & TEAMS — who decided each sale, and in which team (2026-09-27)
--
-- Two call-centre groups sell for this business and the CRM could not tell
-- them apart: AlterCPA lead operators decide inside AlterCPA's own panel (6 of
-- them have no CRM login at all), ElyonCRM prediction agents cold-call
-- existing clients in our CRM. Roles cannot separate them — almost every
-- login holds pending_agent + prediction_agent. Owner rules (Mile,
-- 2026-09-27): SOURCE wins for money (orders.sale_source, migration
-- 20260935000000); the TEAM is shown next to it; managers are shown and never
-- earn.
--
-- What this migration adds:
--   sales_people             one row per HUMAN — a CRM login is optional
--                            (AlterCPA-only operators are people too)
--   sales_person_identities  the external handles that name a person: an
--                            AlterCPA user id (per account), a collabBox
--                            author, an operator name as written on orders.
--                            SQL only ever matches these EXACTLY; the script
--                            fold (agentIdentityKey) runs once, in Node, in
--                            scripts/seed-sales-people.mjs
--   sales_teams              crm_prediction · altercpa_leads · management
--   sales_team_members       person × team × date range; at most ONE primary
--                            team per person per day (EXCLUDE, btree_gist)
--   altercpa_leads.decision / decided_by_altercpa_user / decided_at
--                            derived from the stored payload by
--                            trg_altercpa_leads_decision on every ledger write,
--                            backfilled below (~17.8k rows)
--   altercpa_lead_events     append-only phase/status history (the sync writes
--                            it — wired separately; the ledger row itself only
--                            keeps the CURRENT phase)
--   orders.sold_at / sold_by_person_id / sold_via / sold_by_ext
--                            WRITE-ONCE "who made this a sale". Deliberately
--                            NOT confirmed_at: altercpa-sync's untouched guard
--                            is `!confirmed_at`, so stamping it would freeze
--                            every lead the moment it was attributed.
--   trg_orders_stamp_sold    stamps sold_* for sales a CRM user (or an import
--                            naming its operator) creates; AlterCPA approvals
--                            and history are filled by
--                            scripts/backfill-order-deciders.mjs
--   v_sales_work             ONE row per human decision, CRM + AlterCPA
--
-- Security: people, identities, teams, memberships and events are readable by
-- BUSINESS OWNERS only (is_business_owner(), migration 20260934000000 — admin
-- does not bypass it); every writer is the service role (the api edge
-- function, the seed/backfill scripts, altercpa-sync).
--
-- Apply AFTER 20260935000000 (is_synthetic_product_name, orders.sale_source).
-- ============================================================================

-- Fail fast rather than queue other sessions behind this migration's locks.
-- Transaction-scoped. Lock order below: new tables → altercpa_leads (+ its
-- ~17.8k-row backfill) → orders LAST, so orders is held only for the tail.
SET LOCAL lock_timeout = '5s';

-- The one-primary-team rule is an EXCLUDE constraint over (uuid, daterange),
-- which needs btree_gist's uuid operator class. Available on this project
-- (pg_available_extensions, 2026-09-27: 1.7, not yet installed); Supabase
-- keeps extensions in the `extensions` schema. Default operator classes are
-- found by type, not by search_path, so nothing else needs qualifying.
CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA extensions;

-- ── 1. People ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.sales_people (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name text NOT NULL CONSTRAINT sales_people_display_name_check CHECK (btrim(display_name) <> ''),
  -- The CRM login, when the person has one. UNIQUE: one login is one person
  -- (a human with two logins keeps the one they work in; see the seed report).
  -- SET NULL: deleting a login must never delete the person who sold.
  user_id      uuid UNIQUE REFERENCES auth.users(id) ON DELETE SET NULL,
  is_active    boolean NOT NULL DEFAULT true,
  -- Management is shown on every board and never earns (owner rule).
  is_manager   boolean NOT NULL DEFAULT false,
  notes        text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.sales_people IS
  'One row per HUMAN who sells or decides leads (2026-09-27). A CRM login is optional: AlterCPA-only operators are people too. Named by sales_person_identities; placed in teams by sales_team_members. Owners-only read; service-role writes.';
COMMENT ON COLUMN public.sales_people.user_id IS
  'The person''s CRM login (auth.users), when they have one. Unique. orders.confirmed_by_agent_id resolves through it.';
COMMENT ON COLUMN public.sales_people.is_manager IS
  'Management: shown on the boards, never earns a bonus (owner rule 2026-09-27).';

-- ── 2. Identities — the handles that name a person ──────────────────────────
-- kind            value                      account_id
-- altercpa_user   '4429'  (their user id)    the AlterCPA account (ids are per install)
-- collabbox_author 'Сашка Симоновска'        NULL
-- order_name      'Saska Simonovska'         NULL   (orders.confirmed_by_name /
--                                                    assigned_agent_name, exactly
--                                                    as written — spaces included)
-- Values are stored and matched EXACTLY. Folding spellings onto one person is
-- a human-reviewed step in scripts/seed-sales-people.mjs, never SQL.
CREATE TABLE IF NOT EXISTS public.sales_person_identities (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id  uuid NOT NULL REFERENCES public.sales_people(id) ON DELETE CASCADE,
  kind       text NOT NULL
             CONSTRAINT sales_person_identities_kind_check
             CHECK (kind IN ('altercpa_user', 'collabbox_author', 'order_name')),
  account_id uuid REFERENCES public.altercpa_accounts(id) ON DELETE CASCADE,
  value      text NOT NULL CONSTRAINT sales_person_identities_value_check CHECK (value <> ''),
  note       text,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- An AlterCPA id only means something inside its account; a name never
  -- belongs to an account.
  CONSTRAINT sales_person_identities_account_check CHECK (
    (kind = 'altercpa_user' AND account_id IS NOT NULL AND value ~ '^[0-9]+$')
    OR (kind <> 'altercpa_user' AND account_id IS NULL))
);

-- One handle names at most one person.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_sales_person_identities
  ON public.sales_person_identities
     (kind, coalesce(account_id, '00000000-0000-0000-0000-000000000000'::uuid), value);
CREATE INDEX IF NOT EXISTS idx_sales_person_identities_person
  ON public.sales_person_identities (person_id);

COMMENT ON TABLE public.sales_person_identities IS
  'External handles that name a sales person: altercpa_user (their user id, per account), collabbox_author, order_name (orders.confirmed_by_name / assigned_agent_name as written). Matched EXACTLY in SQL; the cross-script fold is applied once, human-reviewed, by scripts/seed-sales-people.mjs.';

-- ── 3. Teams ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.sales_teams (
  key              text PRIMARY KEY CONSTRAINT sales_teams_key_check CHECK (key ~ '^[a-z][a-z0-9_]*$'),
  name             text NOT NULL,
  -- Which leaderboard mode the team plays in: prediction (ElyonCRM source) or
  -- pending (AlterCPA decisions). NULL = shown, never ranked (management).
  leaderboard_mode text CONSTRAINT sales_teams_leaderboard_mode_check
                   CHECK (leaderboard_mode IN ('prediction', 'pending')),
  created_at       timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.sales_teams IS
  'Sales teams (2026-09-27): crm_prediction (ElyonCRM cold calls, prediction board), altercpa_leads (AlterCPA lead operators, pending board), management (shown, never earns).';

INSERT INTO public.sales_teams (key, name, leaderboard_mode) VALUES
  ('crm_prediction', 'Prediction — ElyonCRM',    'prediction'),
  ('altercpa_leads', 'Pending — AlterCPA leads', 'pending'),
  ('management',     'Management',               NULL)
ON CONFLICT (key) DO NOTHING;

-- ── 4. Team memberships over time ───────────────────────────────────────────
-- People move between teams, so membership is dated. valid_to is the LAST day
-- (inclusive); NULL = still a member. At most one PRIMARY team per person per
-- day — the team column a board shows. A secondary row (is_primary = false)
-- can record e.g. a lead who also covers another team.
CREATE TABLE IF NOT EXISTS public.sales_team_members (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id  uuid NOT NULL REFERENCES public.sales_people(id) ON DELETE CASCADE,
  team_key   text NOT NULL REFERENCES public.sales_teams(key) ON UPDATE CASCADE,
  valid_from date NOT NULL,
  valid_to   date,
  role       text NOT NULL DEFAULT 'member'
             CONSTRAINT sales_team_members_role_check CHECK (role IN ('member', 'lead')),
  is_primary boolean NOT NULL DEFAULT true,
  note       text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sales_team_members_range_check CHECK (valid_to IS NULL OR valid_to >= valid_from),
  CONSTRAINT sales_team_members_one_primary
    EXCLUDE USING gist (person_id WITH =, daterange(valid_from, valid_to, '[]') WITH &&)
    WHERE (is_primary)
);

CREATE INDEX IF NOT EXISTS idx_sales_team_members_team
  ON public.sales_team_members (team_key, valid_from);

COMMENT ON TABLE public.sales_team_members IS
  'Person × team × dates (valid_to inclusive, NULL = current). At most one primary team per person per day (EXCLUDE sales_team_members_one_primary). Seeded from the owner-confirmed roster of 2026-09-27 by scripts/seed-sales-people.mjs; edited in Settings → Teams.';

-- ── 5. AlterCPA decisions on the ledger ─────────────────────────────────────
ALTER TABLE public.altercpa_leads
  ADD COLUMN IF NOT EXISTS decision                 text,
  ADD COLUMN IF NOT EXISTS decided_by_altercpa_user integer,
  ADD COLUMN IF NOT EXISTS decided_at               timestamptz,
  DROP CONSTRAINT IF EXISTS altercpa_leads_decision_check,
  ADD CONSTRAINT altercpa_leads_decision_check CHECK (
    decision IS NULL OR decision IN ('approved', 'cancel_other', 'cancelled', 'trashed'));

COMMENT ON COLUMN public.altercpa_leads.decision IS
  'AlterCPA''s CURRENT decision on the lead, derived from phase/reason by altercpa_decision(): approved (phase 3) · cancel_other (phase 4 whose reason has no CRM equivalent — the 2026-08-11 manager rule books it as confirmed) · cancelled (phase 4) · trashed (phase 5). NULL while the lead is open. Maintained by trg_altercpa_leads_decision.';
COMMENT ON COLUMN public.altercpa_leads.decided_by_altercpa_user IS
  'AlterCPA user id of the decider: phase 3 → payload.app, else payload.user; phase 4/5 → payload.user. Resolve to a person through sales_person_identities (kind altercpa_user, this row''s account_id).';
COMMENT ON COLUMN public.altercpa_leads.decided_at IS
  'When they decided: payload.done (their clock), sanity-checked exactly like altercpa.ts outcomeTimestamps (> 0, not before payload.time, not > 1 day ahead); otherwise phase_seen_at (when WE first saw the phase).';

-- Integer out of the stored payload, NULL for anything that is not a plain
-- non-negative integer — a derived column must never fail a ledger write.
CREATE OR REPLACE FUNCTION public.altercpa_payload_int(p_payload jsonb, p_key text)
RETURNS integer
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $fn$
  SELECT CASE WHEN (p_payload ->> p_key) ~ '^[0-9]{1,9}$' THEN (p_payload ->> p_key)::integer END;
$fn$;

CREATE OR REPLACE FUNCTION public.altercpa_payload_epoch(p_payload jsonb, p_key text)
RETURNS bigint
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $fn$
  SELECT CASE WHEN (p_payload ->> p_key) ~ '^[0-9]{1,12}$' THEN (p_payload ->> p_key)::bigint END;
$fn$;

-- KEEP IN STEP with resolveRemoteOutcome() in
-- supabase/functions/altercpa-sync/altercpa.ts (and the copy in
-- scripts/verify-altercpa-status.mjs): phase 3 = a sale; phase 4 whose reason
-- is > 0 and NOT a key of CANCEL_REASON_TO_CRM (2, 7, 8, 9, 10, 14) is the
-- 2026-08-11 manager rule — a confirmed sale awaiting fulfilment; reason 0
-- ("none recorded") stays a cancel; phase 5 = trash; 1/2 = still open.
CREATE OR REPLACE FUNCTION public.altercpa_decision(p_phase integer, p_reason integer)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $fn$
  SELECT CASE
           WHEN p_phase = 3 THEN 'approved'
           WHEN p_phase = 4 AND coalesce(p_reason, 0) > 0
                AND p_reason NOT IN (2, 7, 8, 9, 10, 14) THEN 'cancel_other'
           WHEN p_phase = 4 THEN 'cancelled'
           WHEN p_phase = 5 THEN 'trashed'
         END;
$fn$;

-- Phase 3: `app` is the approver (identical to `user` on every MK lead since
-- 2026-08-05, but app is the field that means "approved it"). Phase 4/5:
-- `user`, who handled and closed it. 0 means "nobody".
CREATE OR REPLACE FUNCTION public.altercpa_decided_by(p_phase integer, p_payload jsonb)
RETURNS integer
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $fn$
  SELECT CASE
           WHEN p_phase = 3 THEN coalesce(nullif(public.altercpa_payload_int(p_payload, 'app'), 0),
                                          nullif(public.altercpa_payload_int(p_payload, 'user'), 0))
           WHEN p_phase IN (4, 5) THEN nullif(public.altercpa_payload_int(p_payload, 'user'), 0)
         END;
$fn$;

-- Mirror of outcomeTimestamps() in altercpa.ts: `done` counts only when > 0,
-- not before `time` (creation) and not more than a day in the future.
-- STABLE, not IMMUTABLE: that last test reads now().
CREATE OR REPLACE FUNCTION public.altercpa_decided_at(p_phase integer, p_payload jsonb, p_phase_seen_at timestamptz)
RETURNS timestamptz
LANGUAGE sql
STABLE
PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $fn$
  SELECT CASE WHEN p_phase IN (3, 4, 5) THEN
           coalesce(
             CASE WHEN s.done > 0
                   AND (coalesce(s.created, 0) = 0 OR s.done >= s.created)
                   AND s.done <= extract(epoch FROM now())::bigint + 86400
                  THEN to_timestamp(s.done) END,
             p_phase_seen_at)
         END
    FROM (SELECT public.altercpa_payload_epoch(p_payload, 'done') AS done,
                 public.altercpa_payload_epoch(p_payload, 'time') AS created) s;
$fn$;

-- The three columns are a pure function of the stored record, so the ledger
-- keeps them itself: every insert, and every update that touches phase,
-- reason, payload or phase_seen_at (the sync writes payload on every
-- sighting), re-derives them. altercpa-sync therefore never has to write them.
-- A derivation problem must NEVER fail a ledger write (the lead would be lost
-- from the mirror): the handler leaves the previous values in place.
CREATE OR REPLACE FUNCTION public.tg_altercpa_leads_decision()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
DECLARE
  _phase  integer;
  _reason integer;
  _d      text;
  _by     integer;
  _at     timestamptz;
BEGIN
  BEGIN
    _phase  := coalesce(NEW.phase::integer,  public.altercpa_payload_int(NEW.payload, 'phase'));
    _reason := coalesce(NEW.reason::integer, public.altercpa_payload_int(NEW.payload, 'reason'));
    _d  := public.altercpa_decision(_phase, _reason);
    _by := public.altercpa_decided_by(_phase, NEW.payload);
    _at := public.altercpa_decided_at(_phase, NEW.payload, NEW.phase_seen_at);
  EXCEPTION WHEN OTHERS THEN
    RETURN NEW;
  END;
  NEW.decision                 := _d;
  NEW.decided_by_altercpa_user := _by;
  NEW.decided_at               := _at;
  RETURN NEW;
END;
$fn$;

COMMENT ON FUNCTION public.tg_altercpa_leads_decision() IS
  'BEFORE INSERT OR UPDATE OF phase, reason, payload, phase_seen_at on altercpa_leads: re-derives decision / decided_by_altercpa_user / decided_at from the stored record. Never fails the write.';

REVOKE ALL ON FUNCTION public.tg_altercpa_leads_decision() FROM PUBLIC, anon, authenticated;

-- Backfill (idempotent: only rows whose derived values differ are written).
-- Runs before the trigger exists so each row is written exactly once.
UPDATE public.altercpa_leads l
   SET decision                 = d.decision,
       decided_by_altercpa_user = d.decided_by,
       decided_at               = d.decided_at
  FROM (
        SELECT x.id,
               public.altercpa_decision(x.ph, x.rs)                    AS decision,
               public.altercpa_decided_by(x.ph, x.payload)             AS decided_by,
               public.altercpa_decided_at(x.ph, x.payload, x.seen_at)  AS decided_at
          FROM (SELECT l2.id, l2.payload, l2.phase_seen_at AS seen_at,
                       coalesce(l2.phase::integer,  public.altercpa_payload_int(l2.payload, 'phase'))  AS ph,
                       coalesce(l2.reason::integer, public.altercpa_payload_int(l2.payload, 'reason')) AS rs
                  FROM public.altercpa_leads l2) x
       ) d
 WHERE d.id = l.id
   AND (l.decision, l.decided_by_altercpa_user, l.decided_at)
       IS DISTINCT FROM (d.decision, d.decided_by, d.decided_at);

DROP TRIGGER IF EXISTS trg_altercpa_leads_decision ON public.altercpa_leads;
CREATE TRIGGER trg_altercpa_leads_decision
BEFORE INSERT OR UPDATE OF phase, reason, payload, phase_seen_at ON public.altercpa_leads
FOR EACH ROW
EXECUTE FUNCTION public.tg_altercpa_leads_decision();

-- The pending board reads decisions per operator per day.
CREATE INDEX IF NOT EXISTS idx_altercpa_leads_decided
  ON public.altercpa_leads (decided_by_altercpa_user, decided_at)
  WHERE decision IS NOT NULL;

-- ── 6. AlterCPA lead events — append-only ───────────────────────────────────
-- The ledger row keeps only the CURRENT phase, so an approval that AlterCPA
-- later turns into a cancel loses its approver. This table keeps every
-- observed change. Written by altercpa-sync (wired separately). Append-only
-- for every API role: no UPDATE / DELETE / TRUNCATE grants, not even for the
-- service role; only the table owner can repair it.
CREATE TABLE IF NOT EXISTS public.altercpa_lead_events (
  id               bigserial PRIMARY KEY,
  altercpa_lead_id uuid NOT NULL REFERENCES public.altercpa_leads(id) ON DELETE CASCADE,
  phase            smallint,
  status           smallint,
  reason           smallint,
  user_id          integer,
  app_id           integer,
  observed_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_altercpa_lead_events_lead
  ON public.altercpa_lead_events (altercpa_lead_id, observed_at);

COMMENT ON TABLE public.altercpa_lead_events IS
  'Append-only history of every observed AlterCPA phase/status/reason change (user_id = payload.user, app_id = payload.app). The ledger row keeps only the current phase. Written by altercpa-sync; no UPDATE/DELETE for any API role.';

-- ── 7. Who made each order a sale — orders.sold_* (write-once) ──────────────
-- Taken LAST so orders is locked only for the tail of this transaction.
-- Nullable, no default: catalog-only. The CHECK is validated in the same pass;
-- the FK validation reads an all-NULL column. The FK is NO ACTION on purpose:
-- a person who sold cannot be deleted — merge them by re-pointing first.
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS sold_at           timestamptz,
  ADD COLUMN IF NOT EXISTS sold_by_person_id uuid,
  ADD COLUMN IF NOT EXISTS sold_via          text,
  ADD COLUMN IF NOT EXISTS sold_by_ext       text,
  DROP CONSTRAINT IF EXISTS orders_sold_via_check,
  ADD CONSTRAINT orders_sold_via_check CHECK (
    sold_via IS NULL OR sold_via IN ('crm', 'altercpa', 'crm_push', 'collabbox', 'import')),
  DROP CONSTRAINT IF EXISTS orders_sold_by_person_id_fkey,
  ADD CONSTRAINT orders_sold_by_person_id_fkey
    FOREIGN KEY (sold_by_person_id) REFERENCES public.sales_people(id);

COMMENT ON COLUMN public.orders.sold_at IS
  'When the order became a SALE and by whose decision (with sold_by_person_id / sold_via / sold_by_ext). WRITE-ONCE per column (trg_orders_sold_write_once). Not confirmed_at: altercpa-sync''s untouched guard reads that. Set live by trg_orders_stamp_sold for CRM-made sales; AlterCPA approvals and history by scripts/backfill-order-deciders.mjs.';
COMMENT ON COLUMN public.orders.sold_by_person_id IS
  'sales_people.id of the decider. NULL when the decider is known only by sold_by_ext (e.g. an unnamed AlterCPA id) — adding the identity later lets the backfill fill it.';
COMMENT ON COLUMN public.orders.sold_via IS
  'Where the sale decision was taken: crm (a CRM user) · crm_push (a CRM decision pushed to AlterCPA; AlterCPA''s approval is its mirror) · altercpa (their operator, in their panel) · collabbox (the collabBox document author) · import (the 2026-08 history import).';
COMMENT ON COLUMN public.orders.sold_by_ext IS
  'The raw decider key the attribution was resolved from: AlterCPA user id (altercpa), operator name as written (crm, crm_push, import), collabBox author (collabbox). Kept even when no person matched.';

-- Per-person, per-day boards. Empty at creation (every row is NULL).
CREATE INDEX IF NOT EXISTS idx_orders_sold_by_person
  ON public.orders (sold_by_person_id, sold_at)
  WHERE sold_by_person_id IS NOT NULL;

-- Live stamping. Fires when a write names status or a confirmer column.
-- Stamps only a REAL SALE (confirmed/shipped/delivered/paid/returned, price
-- > 0, not a synthetic product — the same test mex-reconcile's isRealSale
-- uses) that names a decider:
--   * the moment the order FIRST becomes a sale (INSERT, or UPDATE from a
--     non-sale status) — the CRM status PATCH sets confirmed_by_* in that very
--     write;
--   * or, for an order that was already a sale, the write that FIRST sets its
--     confirmer — the bulk status path writes status and confirmer in two
--     separate UPDATEs. Never for an AlterCPA order: those become sales in
--     AlterCPA's panel (the sync writes `confirmed` with no confirmer, by
--     design), and a confirmer set afterwards is whoever moved the parcel on,
--     not who sold it. scripts/backfill-order-deciders.mjs credits them from the
--     ledger.
-- 'Import'/'System' are placeholder confirmers, not people; for imports the
-- handler (assigned_agent_name) stands in. sold_via follows the intake:
-- import rows → collabbox / import, everything else → crm.
-- SECURITY DEFINER: the people tables are owners-only under RLS, and an agent
-- session must still resolve the person. A lookup failure never blocks the
-- order write; it stamps without a person.
CREATE OR REPLACE FUNCTION public.tg_orders_stamp_sold()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  _name   text;
  _via    text;
  _person uuid;
BEGIN
  IF NEW.sold_at IS NOT NULL THEN
    RETURN NEW;                                   -- write-once
  END IF;
  IF NEW.status::text NOT IN ('confirmed', 'shipped', 'delivered', 'paid', 'returned')
     OR coalesce(NEW.price, 0) <= 0
     OR public.is_synthetic_product_name(NEW.product_name) THEN
    RETURN NEW;                                   -- not a real sale
  END IF;

  _name := nullif(btrim(NEW.confirmed_by_name), '');
  IF lower(_name) IN ('import', 'system') THEN
    _name := NULL;
  END IF;
  IF _name IS NULL AND NEW.source_type = 'import' THEN
    _name := nullif(btrim(NEW.assigned_agent_name), '');
  END IF;
  IF NEW.confirmed_by_agent_id IS NULL AND _name IS NULL THEN
    RETURN NEW;                                   -- nobody named: backfill / sync attribute it
  END IF;

  IF TG_OP = 'UPDATE'
     AND OLD.status::text IN ('confirmed', 'shipped', 'delivered', 'paid', 'returned') THEN
    IF NOT ((OLD.confirmed_by_agent_id IS NULL AND NEW.confirmed_by_agent_id IS NOT NULL)
         OR (OLD.confirmed_by_name     IS NULL AND NEW.confirmed_by_name     IS NOT NULL)) THEN
      RETURN NEW;
    END IF;
    IF NEW.source_type = 'altercpa' OR NEW.external_source = 'altercpa' THEN
      RETURN NEW;
    END IF;
  END IF;

  _via := CASE WHEN NEW.source_type = 'import'
               THEN CASE WHEN NEW.external_source = 'collabbox' THEN 'collabbox' ELSE 'import' END
               ELSE 'crm'
          END;

  BEGIN
    IF NEW.confirmed_by_agent_id IS NOT NULL THEN
      SELECT sp.id INTO _person
        FROM public.sales_people sp
       WHERE sp.user_id = NEW.confirmed_by_agent_id;
    END IF;
    IF _person IS NULL AND _name IS NOT NULL THEN
      SELECT i.person_id INTO _person
        FROM public.sales_person_identities i
       WHERE i.account_id IS NULL
         AND i.value = _name
         AND i.kind IN ('order_name', 'collabbox_author')
       ORDER BY (i.kind = CASE WHEN _via = 'collabbox' THEN 'collabbox_author' ELSE 'order_name' END) DESC
       LIMIT 1;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    _person := NULL;
  END;

  NEW.sold_at           := coalesce(NEW.confirmed_at, now());
  NEW.sold_via          := _via;
  NEW.sold_by_person_id := _person;
  NEW.sold_by_ext       := coalesce(_name, NEW.confirmed_by_agent_id::text);
  RETURN NEW;
END;
$fn$;

COMMENT ON FUNCTION public.tg_orders_stamp_sold() IS
  'BEFORE INSERT OR UPDATE OF status, confirmed_by_agent_id, confirmed_by_name on orders: stamps sold_* once, for a real sale a CRM user (or an import naming its operator) created. AlterCPA approvals are credited by scripts/backfill-order-deciders.mjs.';

REVOKE ALL ON FUNCTION public.tg_orders_stamp_sold() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_orders_stamp_sold ON public.orders;
CREATE TRIGGER trg_orders_stamp_sold
BEFORE INSERT OR UPDATE OF status, confirmed_by_agent_id, confirmed_by_name ON public.orders
FOR EACH ROW
EXECUTE FUNCTION public.tg_orders_stamp_sold();

-- Write-once, per column: NULL → value is a fill (allowed — e.g. the person
-- once an unnamed AlterCPA id is identified); a set value is KEPT, silently.
-- Silently, not RAISE: a second writer (a future altercpa-sync stamp, a
-- re-run) must never fail an order write, and the first decider always wins.
-- A deliberate correction runs with SET LOCAL elyon.allow_sold_change = 'on'.
CREATE OR REPLACE FUNCTION public.tg_orders_sold_write_once()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
BEGIN
  IF coalesce(current_setting('elyon.allow_sold_change', true), '') = 'on' THEN
    RETURN NEW;
  END IF;
  IF OLD.sold_at           IS NOT NULL THEN NEW.sold_at           := OLD.sold_at;           END IF;
  IF OLD.sold_by_person_id IS NOT NULL THEN NEW.sold_by_person_id := OLD.sold_by_person_id; END IF;
  IF OLD.sold_via          IS NOT NULL THEN NEW.sold_via          := OLD.sold_via;          END IF;
  IF OLD.sold_by_ext       IS NOT NULL THEN NEW.sold_by_ext       := OLD.sold_by_ext;       END IF;
  RETURN NEW;
END;
$fn$;

COMMENT ON FUNCTION public.tg_orders_sold_write_once() IS
  'BEFORE UPDATE OF sold_at, sold_by_person_id, sold_via, sold_by_ext on orders: each column is write-once (a set value is kept; NULL may be filled) unless SET LOCAL elyon.allow_sold_change = ''on''.';

REVOKE ALL ON FUNCTION public.tg_orders_sold_write_once() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_orders_sold_write_once ON public.orders;
CREATE TRIGGER trg_orders_sold_write_once
BEFORE UPDATE OF sold_at, sold_by_person_id, sold_via, sold_by_ext ON public.orders
FOR EACH ROW
EXECUTE FUNCTION public.tg_orders_sold_write_once();

-- ── 8. One work ledger: every human decision, CRM + AlterCPA ────────────────
-- CRM side (via 'crm'): order_history rows written by a PERSON — not
-- 'System (…)' (the AlterCPA mirror, mex-reconcile, repairs) and not an
-- annotated row ('<name> — Products synced …', merges) — where the status
-- actually changed into confirmed / cancelled / trashed / call_again.
-- AlterCPA side (via 'altercpa'): MK ledger decisions, test orders excluded,
-- EXCEPT a decision a person had already taken in the CRM (same order, a
-- compatible outcome, at most 15 min after the CRM row): that AlterCPA record
-- is the mirror of the CRM decision (Dragana's account mirrored the CRM work
-- of 16–20.08 by hand and signs every CRM push), not a second decision. A
-- trash pushed from the CRM arrives in AlterCPA as a cancel (status 5), which
-- is why a CRM trash also suppresses an AlterCPA cancel.
--   decision  CRM: confirmed | cancelled | trashed | call_again
--             AlterCPA: approved | cancel_other | cancelled | trashed
--   outcome   normalised: sale | cancel | trash | callback
--             (cancel_other is a SALE — the 2026-08-11 manager rule)
--   actor_ext the raw decider key when no person matched: CRM user id / name,
--             or the AlterCPA user id (the Settings → Teams "unmapped" queue)
-- security_invoker: callers see exactly the rows the underlying RLS gives them
-- (people resolve for business owners and the service role only).
CREATE OR REPLACE VIEW public.v_sales_work
WITH (security_invoker = true) AS
SELECT h.changed_at                                  AS at,
       coalesce(sp.id, idn.person_id)                AS person_id,
       'crm'::text                                   AS via,
       h.order_id,
       h.to_status::text                             AS decision,
       CASE h.to_status::text
         WHEN 'confirmed'  THEN 'sale'
         WHEN 'cancelled'  THEN 'cancel'
         WHEN 'trashed'    THEN 'trash'
         WHEN 'call_again' THEN 'callback'
       END                                           AS outcome,
       o.sale_source,
       coalesce(h.changed_by::text, h.changed_by_name) AS actor_ext
  FROM public.order_history h
  JOIN public.orders o ON o.id = h.order_id
  LEFT JOIN public.sales_people sp ON sp.user_id = h.changed_by
  LEFT JOIN public.sales_person_identities idn
         ON sp.id IS NULL
        AND idn.kind = 'order_name'
        AND idn.account_id IS NULL
        AND idn.value = h.changed_by_name
 WHERE h.to_status::text IN ('confirmed', 'cancelled', 'trashed', 'call_again')
   AND h.from_status IS DISTINCT FROM h.to_status
   AND (h.changed_by IS NOT NULL OR h.changed_by_name IS NOT NULL)
   AND coalesce(h.changed_by_name, '') NOT LIKE 'System (%'
   AND coalesce(h.changed_by_name, '') NOT LIKE '% — %'
UNION ALL
SELECT l.decided_at                                  AS at,
       idn.person_id,
       'altercpa'::text                              AS via,
       l.order_id,
       l.decision,
       CASE l.decision
         WHEN 'approved'     THEN 'sale'
         WHEN 'cancel_other' THEN 'sale'
         WHEN 'cancelled'    THEN 'cancel'
         WHEN 'trashed'      THEN 'trash'
       END                                           AS outcome,
       o.sale_source,
       l.decided_by_altercpa_user::text              AS actor_ext
  FROM public.altercpa_leads l
  LEFT JOIN public.orders o ON o.id = l.order_id
  LEFT JOIN public.sales_person_identities idn
         ON idn.kind = 'altercpa_user'
        AND idn.account_id = l.account_id
        AND idn.value = l.decided_by_altercpa_user::text
 WHERE upper(coalesce(l.geo, '')) = 'MK'
   AND l.decision IS NOT NULL
   AND l.skip_reason IS DISTINCT FROM 'test_order'
   AND NOT EXISTS (
         SELECT 1
           FROM public.order_history h
          WHERE l.order_id IS NOT NULL
            AND h.order_id = l.order_id
            AND h.from_status IS DISTINCT FROM h.to_status
            AND (h.changed_by IS NOT NULL OR h.changed_by_name IS NOT NULL)
            AND coalesce(h.changed_by_name, '') NOT LIKE 'System (%'
            AND coalesce(h.changed_by_name, '') NOT LIKE '% — %'
            AND h.changed_at <= l.decided_at + interval '15 minutes'
            AND h.to_status::text = ANY (CASE l.decision
                  WHEN 'approved'     THEN ARRAY['confirmed']
                  WHEN 'cancel_other' THEN ARRAY['confirmed', 'cancelled', 'trashed']
                  WHEN 'cancelled'    THEN ARRAY['cancelled', 'trashed']
                  WHEN 'trashed'      THEN ARRAY['trashed']
                END));

COMMENT ON VIEW public.v_sales_work IS
  'One row per HUMAN decision (2026-09-27): CRM order_history decisions (via crm) + MK AlterCPA ledger decisions (via altercpa) minus AlterCPA records that mirror a CRM decision taken first. Columns: at, person_id, via, order_id, decision (raw), outcome (sale|cancel|trash|callback; cancel_other = sale), sale_source, actor_ext. security_invoker.';

-- ── 9. RLS — owners read, the service role writes ───────────────────────────
ALTER TABLE public.sales_people            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sales_person_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sales_teams             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sales_team_members      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.altercpa_lead_events    ENABLE ROW LEVEL SECURITY;

-- Scalar sub-select: evaluated once per statement, not per row.
DROP POLICY IF EXISTS sales_people_select_owners ON public.sales_people;
CREATE POLICY sales_people_select_owners ON public.sales_people
  FOR SELECT TO authenticated USING ((SELECT public.is_business_owner(auth.uid())));

DROP POLICY IF EXISTS sales_person_identities_select_owners ON public.sales_person_identities;
CREATE POLICY sales_person_identities_select_owners ON public.sales_person_identities
  FOR SELECT TO authenticated USING ((SELECT public.is_business_owner(auth.uid())));

DROP POLICY IF EXISTS sales_teams_select_owners ON public.sales_teams;
CREATE POLICY sales_teams_select_owners ON public.sales_teams
  FOR SELECT TO authenticated USING ((SELECT public.is_business_owner(auth.uid())));

DROP POLICY IF EXISTS sales_team_members_select_owners ON public.sales_team_members;
CREATE POLICY sales_team_members_select_owners ON public.sales_team_members
  FOR SELECT TO authenticated USING ((SELECT public.is_business_owner(auth.uid())));

DROP POLICY IF EXISTS altercpa_lead_events_select_owners ON public.altercpa_lead_events;
CREATE POLICY altercpa_lead_events_select_owners ON public.altercpa_lead_events
  FOR SELECT TO authenticated USING ((SELECT public.is_business_owner(auth.uid())));

-- Default privileges hand every new public object to anon/authenticated in
-- full; take that back. authenticated keeps SELECT (filtered by the policies
-- above — without the grant RLS is never even consulted, the 2026-08-04 trap).
REVOKE ALL ON public.sales_people, public.sales_person_identities, public.sales_teams,
              public.sales_team_members, public.altercpa_lead_events
  FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.sales_people, public.sales_person_identities, public.sales_teams,
                public.sales_team_members, public.altercpa_lead_events
  TO authenticated;
GRANT ALL ON public.sales_people, public.sales_person_identities, public.sales_teams,
             public.sales_team_members
  TO service_role;

-- Append-only, for the service role too.
REVOKE ALL ON public.altercpa_lead_events FROM service_role;
GRANT SELECT, INSERT ON public.altercpa_lead_events TO service_role;
REVOKE ALL ON SEQUENCE public.altercpa_lead_events_id_seq FROM PUBLIC, anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.altercpa_lead_events_id_seq TO service_role;

REVOKE ALL ON public.v_sales_work FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.v_sales_work TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
