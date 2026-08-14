-- ============================================================================
-- order_operator_names() — the historic operators the Agents tab already shows
-- ============================================================================
-- WHY: /api/agent-performance credits an order to `salesOwnerId()` (confirmer ??
-- assignee) and, when BOTH ids are null, falls back to the operator's NAME. The
-- imported AlterCPA history is almost entirely name-only — 26 operators who
-- never had a CRM login — so the Agents tab renders ~64 "virtual" rows that have
-- no `profiles` row behind them.
--
-- The agent filter on that same tab was fed by /api/users/agents, which reads
-- `profiles` alone. Result: the operator could SEE "Saska Simonovska" (5.279
-- orders) and "Zaklina Denik" (3.601) in the table but could not select either
-- one in the dropdown — 64 of the 70 owners in the table were unfilterable.
--
-- This function is the cheap half of the fix: the edge function needs the set of
-- DISTINCT operator names, and streaming 87k order rows through an edge function
-- just to build a dropdown is absurd. Postgres groups them into ~100 rows.
--
-- Deliberately returns the RAW name, not a normalised one. `normAgentName()`
-- lives in the edge function and merges variants ("Елена Т." → "Елена"); keeping
-- normalisation in exactly one place is what stops the dropdown key from
-- drifting out of sync with the table key, which would silently produce a filter
-- option that matches zero rows.
--
-- The WHERE clause mirrors ownerKeyOf() in /api/agent-performance exactly:
--   * both owner ids null      → only then does the name decide the owner
--   * a name is actually present
--   * monadon_legacy excluded  → those never reach the table
--   * same status set          → so no option can match zero rows
-- ============================================================================

create or replace function public.order_operator_names()
returns table (operator_name text, order_count bigint)
language sql
stable
security definer
set search_path = public
as $$
  select
    coalesce(o.confirmed_by_name, o.assigned_agent_name) as operator_name,
    count(*)::bigint                                     as order_count
  from public.orders o
  where o.confirmed_by_agent_id is null
    and o.assigned_agent_id is null
    and coalesce(o.confirmed_by_name, o.assigned_agent_name) is not null
    and coalesce(o.source_type, '') <> 'monadon_legacy'
    and o.status in (
      'take', 'call_again', 'confirmed', 'shipped',
      'delivered', 'returned', 'paid', 'trashed', 'cancelled'
    )
  group by 1
  order by 2 desc;
$$;

comment on function public.order_operator_names() is
  'Distinct operator names on orders that carry NO owner user id — the "virtual" '
  'agents the Insights > Agents table shows for the imported AlterCPA history. '
  'Feeds the agent filter on that tab so every row in the table is selectable. '
  'Returns RAW names; normalisation stays in the edge function (normAgentName).';

-- Staff-only: the edge function calls this with the service role, but an
-- authenticated grant keeps it consistent with the other reporting RPCs.
-- No anon grant — this is an internal staff roster.
revoke all on function public.order_operator_names() from public, anon;
grant execute on function public.order_operator_names() to authenticated, service_role;
