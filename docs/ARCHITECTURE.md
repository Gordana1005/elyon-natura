# Architecture — the whole system on one page (Macedonia)

> Rewritten 29.09.2026. This is the Macedonian Elyon CRM (Natura Therapy MK), a hard fork of the
> Bulgarian system that shares nothing with it at runtime. Numbers are live figures of
> 29.09 ~05:00 Skopje (`docs/handoff/2026-09-29/FACTS.md`). Start here, then [DATABASE.md](DATABASE.md) and
> [OPERATIONS_RUNBOOK.md](OPERATIONS_RUNBOOK.md).

---

## 1. The business loop

Natura Therapy MK sells nutritional supplements to Macedonian customers, cash on delivery through
**MEX Poshta**. Sales come from six departments; the CRM is where they meet.

```
 affiliate networks ─► AlterCPA (their panel) ──altercpa-sync──────────────┐   Affiliate – Lead in
 our CRM agents (prediction lists, direct calls) ───────────────────────────┤   Affiliate – Lead out
 teleshop / social office ─► collabBox ERP ──collabbox-sync (15 min + 00:00)┤   Телешоп – Lead out / Lead in, Social
                                                                            ▼
                                                                   public.orders ──► MEX Poshta parcels
 naturatherapy.mk shop ──web-sync (15 min, read-only)──► web_orders (NOT orders)     (BIO NATURAL · NATURA)
                                                                            │              │
                                    mex-reconcile, both accounts, 15 min ◄──┴──────────────┘
                                    MEX status decides shipped · paid · returned
                                                                            ▼
                              Insights: ONE sale cohort, six departments, денари (owners see money)
```

- **Customers:** Macedonian phones (+389), matched on the last 8 digits. 111.270 distinct phones.
- **Money:** stored in **EUR**, shown in **денари** at the FROZEN `MKD_PER_EUR = 61.5` (never
  updated — re-price the catalogue instead). The only EUR on screen is the foreign affiliate payout.
- **Truth:** MEX alone decides shipped / paid / returned; AlterCPA decides only confirmed-or-dead;
  collabBox proves dispatch, not payment.
- **Time:** `Europe/Skopje` everywhere; pg_cron is UTC, so jobs gate themselves on Skopje hours.
- **Language:** Macedonian by default; sq / en also shipped (Bulgarian removed 02.10.2026). Each language is a lazy chunk.
- **Telephony:** deferred (Phase 2) — agents press Call / End in the CRM and talk on their own
  handsets.

## 2. Components and hosting

```
 Browser (React SPA) ──► Vercel "elyon-natura"  (https://naturall.mk — Pro team elyon-s-projects)
        │ fetch + JWT
        ▼
 Supabase bmfxhgznttcnnlqloqzp ─────────────────────────────────────────────────────────────
   Auth · Postgres (RLS everywhere) · Vault · pg_cron + pg_net
   Edge Functions:  api (the REST router)  ·  altercpa-sync  ·  mex-reconcile  ·  web-sync  ·  collabbox-sync
        │ pg_cron → invoke_*() → POST with a shared-secret header (secret from Vault)
        ▼
   api.cpa.moe (AlterCPA) · MEX JSON API ×2 · naturatherapy.mk DB (schema crm_export, read-only) · collabBox (plain HTTP, read-only)
```

| Layer | Tech | Notes |
|---|---|---|
| Frontend | React 18, TypeScript, Vite, React Router, TanStack Query, shadcn/ui, recharts | Vercel, GitHub-connected: push to `main` = production. i18n in four locales, parity enforced by `npm test` |
| API | Supabase Edge Function `api` (Deno, one router, `supabase/functions/api/index.ts` + helper modules) | authenticates the JWT itself (`verify_jwt = false`), role-gates in code, uses the service role; ONE deployable for every screen |
| Sync functions | `altercpa-sync`, `mex-reconcile`, `web-sync`, `collabbox-sync` | called by pg_cron with `x-…-sync-secret` headers (constant-time compare, fail closed) |
| Database | Postgres on Supabase (Pro, Small compute t4g.small 2 GB, daily backups) | RLS on every table; money tables owners-only (`is_business_owner()`); 260 migrations (latest `20260942001860`, 29.09 ~12:00) |
| Scripts | Node 22 ESM (`scripts/`) | imports, repairs, checkers — all pinned to Macedonia by `scripts/lib/repair-kit.mjs` |

## 3. Request paths

- **Login and landing:** `/login` → `/start` (waits for the session, the profile and THIS login's
  permissions) → `homePath()` (`src/lib/homePath.ts`): admins / managers / owners → `/insights`,
  call agents → `/calls`, warehouse → `/warehouse`, ads admin → `/webhooks`, else the first page the
  login may open, else a no-access screen with Sign out. Every `ProtectedRoute` bounces through the
  same function, never to the page it is on; `AppErrorBoundary` turns a render error into a Reload
  button and `main.tsx` reloads once when a lazy chunk of an older deploy is gone (`6fbbcd5`). The
  app frame and `<main>` are `position: relative`, so absolutely positioned elements stay inside the
  scrolling content (`81f4182`).
- **App request:** browser → `supabase-js` session → `fetch(…/functions/v1/api/<path>)` with the
  JWT → the api reads `user_roles` / `is_business_owner` → service-role queries → JSON (money keys
  stripped for non-owners). CORS echoes only allow-listed origins (`ALLOWED_ORIGINS` in the api —
  a new domain needs an edit AND a deploy). The browser talks to PostgREST directly only for auth,
  `get_my_permissions` and a few reads.
- **Feeds:** pg_cron → `invoke_altercpa_sync` / `invoke_mex_reconcile` / `invoke_web_sync` /
  `invoke_collabbox_sync` → `net.http_post` to the function with the secret from Vault → the
  function writes its ledger / run table. No Vault row = a silent no-op.
- **Inbound webhooks** (HMAC `x-webhook-signature`, `WEBHOOK_SECRET`) for landing pages —
  [WEBSITES_WEBHOOKS.md](WEBSITES_WEBHOOKS.md) (BG-inherited); Macedonian leads arrive through
  AlterCPA.
- **The TV board** (`/tv/leaderboard?key=…`, token-checked, no login) → `GET /api/leaderboard?v=2`
  → `leaderboard_day_v2`: one row per agent, the day split over the six departments, managers
  shown not ranked, no bonus (`.grok/skills/elyon-presence-and-leaderboard`).
- **One calculation everywhere:** Табла for admins renders the Insights Overview; Операции counts
  today from `insights_cohort` (the Skopje day) + `leaderboard_day_v2`; the TV board reads the
  same cohort rows ([INSIGHTS_ANALYTICS.md](INSIGHTS_ANALYTICS.md) §1).

## 4. The data spine

| Table | 29.09 | What |
|---|---|---|
| `orders` | 354.048 | every CRM order: AlterCPA leads and history, CRM sales and call outcomes, collabBox teleshop / social / LEADS-OUT orders. `sale_source` / `sale_source_detail` (how it arrived → its department), `dept_override` (a CRM sale's department by its MEX profile), `sold_*` (who sold, write-once), `paid_basis`, `mex_*`, `collabbox_doc_type` |
| `mex_parcels` | 60.853 (BIO NATURAL 17.995 · NATURA 42.858) | the MEX register, both accounts; `series`, `phone8`, `cod_mkd`, `status_id`, `order_id` |
| `web_orders` | 24.531 | the naturatherapy.mk mirror — never orders |
| `altercpa_leads` | 18.2k | the AlterCPA ledger: every lead, every geo |
| `collabbox_documents` | every document since 01.03.2026 (growing) | the collabBox sync ledger: one row per document |
| `teleshop_import_documents` / `_customers` | 258.705 / 71.669 | the ledger of the 28.09 teleshop history import |
| `prediction_segment_members` | 112.320 | the calling lists (engine v3.7-mk), one rule list per phone + additive statics |
| `products` / `product_aliases` | 706 (261 active) / 1.744 | catalogue and the name folding for reports |
| `sales_people` / `sales_person_identities` / `sales_teams` | 110 people (47 with a login) | who sold — owners-only |

- **No `customers` table.** A customer is every order / lead sharing a phone (last 8 digits);
  `customer_profiles` keeps per-phone details (imports only insert or fill empty fields); Customer 360
  (`customer_timeline`) assembles one phone's orders, web orders, leads, parcels, calls and lists.
- **Prediction lists are computed**, never imported: a trigger recomputes a phone on every order
  change, a cron recomputes all phones nightly. Every department's customers are in the lists.

## 5. The order lifecycle

```
 pending ──(an agent, or AlterCPA's operators)──► confirmed ──(packing: packed_at)──► shipped ──► paid      (MEX 2)
   │  ├─ take (someone has the customer open)                    ▲  MEX registers        └──► returned  (MEX 7)
   │  └─ call_again                                              │  the parcel
   └─ cancelled / trashed (reasons; trash is STICKY)             │
                                                                 └─ collabBox orders are created straight from their parcel
 confirmed AlterCPA approval with no parcel after 10 days ─► cancelled 'no_parcel_7d' (21:10) ─► reopened (rule C) if the parcel appears
```

`order_status`: `pending · take · call_again · confirmed · shipped · delivered · returned · paid ·
trashed · cancelled · duplicated` (`delivered` is a BG leftover read as paid; `duplicated` = a
housekeeping copy, excluded from every figure). Packing is a sub-state of `confirmed`, not a
status. MEX status beats CRM status in every report.

## 6. The six departments

| Department | key | Orders | MEX series |
|---|---|---|---|
| Affiliate – Lead in | `altercpa` | AlterCPA leads (bridge + history), collabBox 10111 LEADS | BIO NATURAL 9110 |
| Affiliate – Lead out | `elyon_crm` | sales made in our CRM that ship on BIO NATURAL (or have no parcel yet), collabBox 10114 LEADS-OUT | BIO NATURAL 9103 |
| Телешоп – Lead out | `teleshop_out` | collabBox 10050 "Нарачка out" | NATURA 9102 |
| Телешоп – Lead in | `teleshop_other` | collabBox 10036 "Нарачка in" (+ unclassified) | NATURA 9100 |
| Социјални мрежи | `social` | collabBox 10106 / 10055 | NATURA 9108 / 1300 |
| Веб-продавница | `web` | `web_orders` | NATURA `NTMK…` / `M…` |

Decided by the collabBox folder (document type) and the MEX profile / series — never by the system
an order was made in, the seller or her team. A sale made in our CRM follows its parcel's MEX
profile (owner 29.09, `20260942001860`): BIO NATURAL → Affiliate – Lead out whatever the series,
NATURA → by series (9100 Lead in · 9108 / 1300 Social · else Телешоп – Lead out) —
`orders.dept_override` and the 4-argument `cohort_order_source` every report calls; a MEX-only BIO
NATURAL parcel is always affiliate. A cancelled / trashed order is revived by MEX only with its
own folder's parcel (AlterCPA 9110, CRM 9103). Every order shows it: the Orders list names each
order's department and seller (`order_departments`), the order window shows "Origin and proof"
(`order_origin`: department, intake, seller, AlterCPA decision, collabBox document, MEX parcel;
its money for owners only),
and Customer 360 badges each order with its department (`customer_timeline`).
`.grok/skills/elyon-departments-and-sources`.

## 7. Cross-cutting conventions (do not break)

1. **EUR stored, денари shown, 61,5 frozen.** `formatMoney(eur)` for stored prices,
   `formatDenari(mkd)` for amounts already in денари (MEX COD, `*_mkd`, web totals) — crossing them
   shows 61× the money.
2. **Phones:** `+389` + 8 digits, matched on the last 8. `normalizeMkPhone` REWRITES any number into
   +389 — never route foreign or unvalidated data through it; imports use a strict 8-digit
   Macedonian check.
3. **Skopje days.** A naked `YYYY-MM-DD::timestamptz` is UTC midnight = 02:00 Skopje; use the Skopje
   day helpers.
4. **MEX decides money;** status and paid are never set from AlterCPA or collabBox.
5. **One order, one source;** `sale_source` is write-once (a deliberate move needs
   `elyon.allow_source_change` and is logged in `sale_source_reclass`).
6. **Bulk writes keep `orders.updated_at`** (`elyon.keep_updated_at`) — it is Call Again's
   `last_call_at`.
7. **Owners see money** (`is_business_owner()`, every active admin + the owners list); managers get
   the same payload with the money keys absent.
8. **The owner's test phones** (`report_excluded_phones`) are in no report.
9. **PostgREST returns ≤ 1.000 rows** — paginate or aggregate in SQL.
10. **Bulgaria is off limits** — run `node scripts/assert-mk-target.mjs` before any write.

*Next: [DATABASE.md](DATABASE.md) for the schema, [INSIGHTS_ANALYTICS.md](INSIGHTS_ANALYTICS.md)
for the numbers, [OPERATIONS_RUNBOOK.md](OPERATIONS_RUNBOOK.md) for deploys, crons and repairs.*
