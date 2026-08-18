-- Dedicated write identity for the manual CPA push (operator decision
-- 2026-08-18): AlterCPA shows the API token's ACCOUNT as the order's operator
-- and has no API param to set an operator name, so the Send-to-CPA edit goes
-- out with a colleague's token (the person who works these orders on their
-- panel) instead of the admin merchant token. Name-only column, same pattern
-- as token_secret_name — the secret VALUE lives on the api edge function and
-- in VAULT §2, never in the database or the repo. NULL → the push falls back
-- to the main account token. Read paths (sync/status crons, the post-push
-- read-back) are unaffected and stay on token_secret_name.
alter table public.altercpa_accounts
  add column if not exists push_token_secret_name text;

update public.altercpa_accounts
   set push_token_secret_name = 'ALTERCPA_PUSH_TOKEN_DRAGANA'
 where is_active = true;
