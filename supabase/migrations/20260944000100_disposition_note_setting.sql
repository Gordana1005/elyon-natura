-- The written note behind every cancel / trash a PERSON makes (owner 01.10.2026, plan "Фаза 2").
--
--   "Опис од најмалку 5 знаци при откажување или корпа, секаде каде тоа го прави човек."
--
-- app_settings.disposition_note_min = the minimum length (Unicode characters, after trimming and
-- collapsing whitespace) of the note the api demands whenever a person moves an order INTO cancelled
-- or trashed: POST /calls/outcome, POST /call-logs, PATCH /orders/:id/status, POST /orders,
-- POST /orders/bulk-disposition (supabase/functions/api/dispositionNote.ts). System writers never ask
-- for it: the no-parcel rule (no_parcel_7d), the 9-no-answers auto-trash (not_reachable),
-- altercpa-sync, collabbox-sync, mex-reconcile, POST /orders/import.
--
-- SEEDED AT 0 = THE ROLLOUT WINDOW: a browser still running the previous bundle sends no note, and 0
-- lets it through the evening of the deploy (the reason 'other' still needs a note, as before). Once
-- D1 of scripts/verify-disposition-notes.mjs is clean an admin sets it to 5 —
-- PATCH /api/app-settings {"disposition_note_min": 5} (admin-only, audited). The CODE default is 5:
-- a missing or invalid value means 5, and the frontend always enforces 5.
--
-- Deliberately NO NOT NULL / CHECK on orders.cancellation_reason_notes / trash_reason_notes: the
-- system writers above keep writing without a note.
--
-- ON CONFLICT DO NOTHING: re-running never overwrites a value an admin has already set.

INSERT INTO public.app_settings (key, value)
VALUES ('disposition_note_min', '0'::jsonb)
ON CONFLICT (key) DO NOTHING;
