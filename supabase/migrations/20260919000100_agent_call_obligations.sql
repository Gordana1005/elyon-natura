-- Mandatory answer per opened client (operator rule 2026-08-13, ported from BG
-- f88f9a8 / 20260921000000): the moment a client lands on an agent's /calls
-- screen — from the queue, the search bar's "Open in Calls", the Personal List,
-- or a dial — that agent owes an outcome. The client stays first-in-line through
-- refreshes, re-logins and queue-list switches until an answer (no_answer /
-- cancel / confirm / …) is recorded.
-- One row per agent (PRIMARY KEY agent_id): the FIRST unanswered client wins;
-- attempts to open another client return the standing obligation instead.
-- Admins/managers/warehouse are exempt (enforced in the edge function).
--
-- Deny-all RLS on purpose: only the edge function (service role) reads/writes.
-- Every new table ships with REVOKE + RLS in the same migration — see the
-- 2026-08-04 security audit and the PII lockdown rule in .grok/skills/elyon-security.

CREATE TABLE IF NOT EXISTS public.agent_call_obligations (
  agent_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  customer_phone text NOT NULL,
  customer_name text NULL,
  source text NOT NULL DEFAULT 'unknown',
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.agent_call_obligations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.agent_call_obligations FROM PUBLIC;
REVOKE ALL ON public.agent_call_obligations FROM anon;
REVOKE ALL ON public.agent_call_obligations FROM authenticated;

NOTIFY pgrst, 'reload schema';
