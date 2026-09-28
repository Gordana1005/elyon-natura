# Connected Overview — shared contract (2026-09-28)

Owner: Mile. Goal: "the insights/overview page perfectly done with all metrics — a comprehensive
dashboard for admins/managers, so we know it all." Every denar by SOURCE, TEAM, PERSON, with
MEX-proven cash separated from claims. Money is owners-only (public.is_business_owner); the
operational blocks (teams/presence/work/calls/attention) are visible to any admin/manager.

## Data available (live on MK, 2026-09-28)
- orders.sale_source / sale_source_detail — altercpa(bridge|history) · elyon_crm(prediction_list|disposition|direct) ·
  collabbox(teleshop|social|leads|leads_out|<series>) · web · affiliate · legacy. Stamped at insert; all 105.470 filled.
- orders.sold_at / sold_by_person_id / sold_via (crm|altercpa|crm_push|collabbox|import) — who made the sale.
- orders.paid_basis (mex|operator_ruling|legacy_import|manual|unproven), orders.mex_* facts (mex_account, mex_status_id,
  mex_cod_mkd, mex_delivered_at, mex_returned_at, mex_last_update_at), orders.mex_tracking_id.
- mex_parcels — every parcel of both MEX accounts since 2026-04 (tracking_id, account bio_natural|natura, series,
  status_id 2=Delivered 7=Returned 13=Rejected…, status_name, cod_mkd, receiver_*, phone8, sender_reference (NTMK… =
  naturatherapy.mk web order), created_at_mex, last_update_at, delivered_at, returned_at, order_id, link_method).
  Unlinked delivered parcels = sales that exist only at MEX (teleshop/social/web/LEADS-OUT): ~7.142 since 01.08.
- sales_people / sales_person_identities / sales_teams (crm_prediction → board 'prediction', altercpa_leads → 'pending',
  management) / sales_team_members (valid_from/valid_to) / v_sales_work (one row per human decision: at, person_id,
  via crm|altercpa, order_id, decision, sale_source).
- altercpa_leads.decision / decided_by_altercpa_user / decided_at (MK ledger, 9.831 decisions).
- agent_presence_days (user_id, day, online/active/idle/break minutes, first/last active, last_state, idle_alerts) —
  starts 2026-09-28; shift_login_logs; shift_breaks.
- altercpa_sync_runs, mex_sync_runs (freshness); web-sync runs (new, see Web below).
- Existing: insights_channel_pl (20260932000000), insights_orders_rollup etc. — keep working; the new blocks are
  additive.

## Outcome buckets (the shop panel's rules, applied to CRM orders too)
awaiting = pending/take/call_again · preparing = confirmed (split: packed_at set → "packed", else "to pack") ·
courier = shipped · delivered = paid/delivered · returned · cancelled · trashed. Money: collected = delivered
(MEX COD when linked, else price) · to collect = preparing+courier · lost = returned+cancelled-after-confirm.
Day basis = created (Skopje) for placed/worked; sold_at for "confirmed that day"; MEX delivered_at for cash.

## API (owned by the backend agent) — GET /api/insights/overview?from=YYYY-MM-DD&to=YYYY-MM-DD&compare=1
Owners → full payload. Non-owner admin/manager → the same payload WITHOUT money fields (value/cod/cash/revenue keys
omitted or null; counts stay) — never a 403 for them. Everyone else 403.
{
  meta: { from, to, prev_from, prev_to, generated_at, money: boolean },
  freshness: [{ feed: 'altercpa'|'mex_bio_natural'|'mex_natura'|'web'|'collabbox', last_ok_at, status: 'ok'|'stale'|'failed'|'n/a', detail }],
  kpis: { placed, confirmed, at_courier, delivered, to_collect, lost, unproven_paid   // each {count, value_eur?, cod_mkd?}
          , prev: {same}, spark: { placed_value: [{d, v}], delivered_cash_mkd: [{d, v}] } },
  sources: [{ key: 'altercpa'|'elyon_crm'|'web'|'teleshop_other',
              buckets: { awaiting, preparing, packed, courier, delivered, returned, cancelled, trashed },  // {count, value_eur?, cod_mkd?}
              money: { collected_mkd?, to_collect_eur?, lost_eur? },
              worked, confirmed, conversion, aov_eur?,
              splits: [{ key, count, value_eur? }],   // altercpa: new|returning · elyon_crm: prediction_list|direct|disposition · teleshop_other: teleshop|social|leads|leads_out|mex_only_unlinked · web: shop|mex_only
              drill: { sale_source: [...], detail?: [...] } }],
  trend: { granularity: 'day'|'month', points: [{ bucket, by_source: { <key>: { placed_value_eur?, delivered_cash_mkd?, placed_count, delivered_count } } }] },
  teams: [{ team_key, name, mode, online_now, members: [{ person_id, name, user_id, online_state: 'online'|'idle'|'break'|'offline'|'n/a',
            online_min, active_min, idle_min, break_min, first_active, last_active, idle_alerts, worked, confirmed, conversion,
            sold_value_eur?, delivered_cash_mkd?, last_decision_at }] }],
  attention: [{ kind: 'approved_no_parcel_7d'|'mex_problem'|'cod_mismatch'|'unlinked_parcels'|'stale_feed'|'web_waiting_24h'|'night_approvals'|'burst_approvals',
                severity: 'warning'|'critical', count, value_eur?, by_person?: [{ person_id, name, count }], sample?: [{ display_id, note }] }]
}
Drill-down: GET /orders gains query params sale_source, sale_source_detail, outcome (bucket above), sold_by_person_id,
created_from/created_to (Skopje) — the Overview links every number to /orders?… that returns exactly those orders.
Pivot (lazy, separate): GET /api/insights/pivot?from&to&by=source,team,person|list|webmaster|stream|product|city →
rows [{ keys…, count, value_eur?, delivered_cash_mkd? }].

## Web shop (owned by the web agent)
Creates public.web_orders + public.web_order_items (mirror of naturatherapy.mk tenant-2 orders incl. legacy OC-…),
web_sync_runs, and SQL function public.insights_web_block(p_from text, p_to_end text) RETURNS jsonb:
{ buckets: {awaiting, preparing, courier, delivered, returned, cancelled, no_record} (shop rules, card_unpaid excluded),
  money: {collected_mkd, to_collect_mkd, lost_mkd, unrecorded_mkd}, placed: {count, value_mkd}, daily: [{d, placed_count,
  placed_value_mkd, delivered_mkd}] }. Until it exists the backend falls back to MEX-only web parcels (sender_reference NTMK…).

## UI (owned by the UI agent) — ManagementInsightsPage Overview tab, top to bottom
1 one filter row (Денес/Недела/Месец/Година/Прилагодено + compare + source chips + team chips) · 2 freshness strip ·
3 hero (MEX-proven cash) + KPI tiles with delta + sparkline · 4 "Од каде дојдоа парите": one row per source with the
shop-style outcome bar + money line + splits, every segment a link · 5 trend small multiples per source (one axis each)
· 6 teams side by side (online now, time, work, conversion, sold, cash) · 7 drill-down pivot · 8 "Треба внимание" rail.
dataviz rules: 4 source hues fixed order validated light+dark (scripts in the dataviz skill), ordinal ramp for pipeline
stages, status colors only for delivered/lost with icons, thin marks, tooltips, table-view twins, keep previous render
while refetching. All strings in mk/en/sq/bg (mk default). Money blocks render only when meta.money is true.
