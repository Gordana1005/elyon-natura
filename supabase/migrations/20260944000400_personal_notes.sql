-- ============================================================================
-- Личен дневник — personal notebooks and notes (plan "Фаза 6", owner 01.10.2026)
--
-- An operator keeps several notebooks ("тетратки") under Личен список
-- (/personal-list?tab=notes), each with several notes ("белешки"). The OPERATOR
-- writes; admins and managers may READ (a manager never an admin's). Deleted
-- notebooks and notes are hidden, restorable for 30 days, then purged.
--
-- Deny-all, api only: RLS on with NO policies and every privilege revoked from
-- PUBLIC / anon / authenticated — the browser can neither read nor write these
-- rows; only the edge function (service role) does, through the routes
-- personal-notes/* in supabase/functions/api/index.ts, which apply the read /
-- write rules (supabase/functions/api/personalNotes.ts, vitest) and the audit.
--
-- A note's (notebook_id, owner_id) is a composite FK to the notebook's
-- (id, owner_id), so a note can never sit in another person's notebook.
--
-- A notebook's notes hide and return WITH it: deleting a notebook sets only the
-- notebook's deleted_at (its notes keep theirs), and every read filters on the
-- notebook being alive. The purge hard-deletes a notebook deleted > 30 days ago
-- and its notes go with it (ON DELETE CASCADE).
--
-- Rollback:
--   SELECT cron.unschedule('personal-notes-purge');
--   DROP FUNCTION public.personal_notes_purge(), public.personal_notebooks_overview(uuid),
--                 public.personal_notes_authors();
--   DROP TABLE public.personal_notes, public.personal_notebooks;
-- ============================================================================

CREATE TABLE public.personal_notebooks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title text NOT NULL CONSTRAINT personal_notebooks_title_check CHECK (char_length(btrim(title)) BETWEEN 1 AND 80),
  color text CONSTRAINT personal_notebooks_color_check CHECK (color IS NULL OR color IN ('slate','sky','emerald','amber','rose','violet')),
  position integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT personal_notebooks_id_owner_key UNIQUE (id, owner_id)
);

CREATE TABLE public.personal_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notebook_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  title text NOT NULL DEFAULT '' CHECK (char_length(title) <= 120),
  body  text NOT NULL DEFAULT '' CHECK (char_length(body) <= 20000),
  pinned boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT personal_notes_notebook_owner_fkey FOREIGN KEY (notebook_id, owner_id)
    REFERENCES public.personal_notebooks (id, owner_id) ON DELETE CASCADE ON UPDATE CASCADE
);

COMMENT ON TABLE public.personal_notebooks IS
  'Личен дневник: an operator''s notebooks. Deny-all RLS — read/written only by the api (personal-notes/*). Soft delete, purged after 30 days.';
COMMENT ON TABLE public.personal_notes IS
  'Личен дневник: the notes in a notebook. Deny-all RLS — api only. version = optimistic lock for autosave (409 version_conflict).';

-- Indexes: the live notebooks of an owner in their order; a notebook's live notes
-- (pinned first, newest first); an owner's live notes (search, authors). The plain
-- (notebook_id, owner_id) index serves the composite FK's cascade, which also has
-- to reach soft-deleted notes the partial indexes leave out.
CREATE INDEX personal_notebooks_owner_position_idx
  ON public.personal_notebooks (owner_id, position) WHERE deleted_at IS NULL;
CREATE INDEX personal_notes_notebook_live_idx
  ON public.personal_notes (notebook_id, pinned DESC, updated_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX personal_notes_owner_live_idx
  ON public.personal_notes (owner_id, updated_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX personal_notes_notebook_owner_idx
  ON public.personal_notes (notebook_id, owner_id);

DROP TRIGGER IF EXISTS update_personal_notebooks_updated_at ON public.personal_notebooks;
CREATE TRIGGER update_personal_notebooks_updated_at
  BEFORE UPDATE ON public.personal_notebooks
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
DROP TRIGGER IF EXISTS update_personal_notes_updated_at ON public.personal_notes;
CREATE TRIGGER update_personal_notes_updated_at
  BEFORE UPDATE ON public.personal_notes
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- RLS deny-all (the pattern of 20260919000100_agent_call_obligations): no policies.
ALTER TABLE public.personal_notebooks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.personal_notes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.personal_notebooks FROM PUBLIC;
REVOKE ALL ON public.personal_notes FROM PUBLIC;
REVOKE ALL ON public.personal_notebooks FROM anon, authenticated;
REVOKE ALL ON public.personal_notes FROM anon, authenticated;
GRANT ALL ON public.personal_notebooks TO service_role;
GRANT ALL ON public.personal_notes TO service_role;

-- ── read helpers for the api (counts in SQL: PostgREST caps a read at 1.000 rows) ──

-- An owner's live notebooks in their order, with the live-note count and the last change.
CREATE OR REPLACE FUNCTION public.personal_notebooks_overview(p_owner uuid)
RETURNS TABLE (
  id uuid, title text, color text, "position" integer,
  created_at timestamptz, updated_at timestamptz,
  note_count integer, last_updated timestamptz
)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT b.id, b.title, b.color, b.position, b.created_at, b.updated_at,
         count(n.id)::integer,
         greatest(b.updated_at, max(n.updated_at))
    FROM public.personal_notebooks b
    LEFT JOIN public.personal_notes n
      ON n.notebook_id = b.id AND n.deleted_at IS NULL
   WHERE b.owner_id = p_owner AND b.deleted_at IS NULL
   GROUP BY b.id
   ORDER BY b.position, b.created_at;
$$;

-- Everyone with at least one live notebook: counts and the last change (names,
-- the active flag and the manager-never-sees-admins rule are applied by the api).
CREATE OR REPLACE FUNCTION public.personal_notes_authors()
RETURNS TABLE (owner_id uuid, notebook_count integer, note_count integer, last_updated timestamptz)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT b.owner_id,
         count(DISTINCT b.id)::integer,
         count(n.id)::integer,
         greatest(max(b.updated_at), max(n.updated_at))
    FROM public.personal_notebooks b
    LEFT JOIN public.personal_notes n
      ON n.notebook_id = b.id AND n.deleted_at IS NULL
   WHERE b.deleted_at IS NULL
   GROUP BY b.owner_id;
$$;

REVOKE ALL ON FUNCTION public.personal_notebooks_overview(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.personal_notes_authors() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.personal_notebooks_overview(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.personal_notes_authors() TO service_role;

-- ── the purge: soft-deleted > 30 days → gone ─────────────────────────────────
-- A notebook's notes go with it (cascade); a note deleted on its own goes on its
-- own clock. Runs as the cron's owner; nobody else may call it.
CREATE OR REPLACE FUNCTION public.personal_notes_purge()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_notes integer;
  v_notebooks integer;
BEGIN
  DELETE FROM public.personal_notes
   WHERE deleted_at IS NOT NULL AND deleted_at < now() - interval '30 days';
  GET DIAGNOSTICS v_notes = ROW_COUNT;
  DELETE FROM public.personal_notebooks
   WHERE deleted_at IS NOT NULL AND deleted_at < now() - interval '30 days';
  GET DIAGNOSTICS v_notebooks = ROW_COUNT;
  RETURN jsonb_build_object('notes', v_notes, 'notebooks', v_notebooks, 'at', now());
END;
$$;

REVOKE ALL ON FUNCTION public.personal_notes_purge() FROM PUBLIC, anon, authenticated, service_role;

-- 01:40 GMT (cron.timezone) = 03:40 Skopje in summer, 02:40 in winter — the quiet window.
SELECT cron.unschedule('personal-notes-purge')
 WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'personal-notes-purge');
SELECT cron.schedule('personal-notes-purge', '40 1 * * *', $$SELECT public.personal_notes_purge();$$);

NOTIFY pgrst, 'reload schema';
