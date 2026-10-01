# Elyon CRM — MACEDONIA edition (Natura Therapy MK)

This repository is the **Macedonian** instance of the Elyon CRM — a hard fork of the Bulgarian
system, run as a completely separate operation. It has its OWN infrastructure and shares
**nothing at runtime** with Bulgaria.

> **Naming note:** the deployment was stood up for Macedonia on 2026-06-30 and re-aimed at
> **Macedonia** on 2026-07-31. The Vercel project was renamed `elyon-macedonia` → `elyon-natura`
> on 2026-08-01, so the live URL is **https://elyon-natura.vercel.app**
> (`elyon-macedonia.vercel.app` still resolves to the same deployment and is kept as a legacy
> alias — both are in the edge function's CORS allowlist).
> The GitHub repo **was** renamed too and is now **`Gordana1005/elyon-natura`**
> (verified against `git remote -v`, 2026-08-13 — the old `elyon-macedonia` URL 404s, so a push
> to it fails with "Repository not found"). Only the **Supabase ref** (`bmfxhgznttcnnlqloqzp`)
> keeps its original name, on purpose: renaming the ref means rebuilding the project. Wherever
> you see "macedonia" in that one identifier, read it as "this project".
> **The market is Macedonia.**

## 🛑 GOLDEN RULE — never touch the Bulgarian system
This is the #1 rule. A mistake here already caused a live Bulgarian outage once (2026-06-30).
**Bulgaria is OFF LIMITS.** Never run any command against, deploy to, or edit:
- Supabase project `sxymaloycddnoxudxaqp`
- Domains `elyoncall.com` / `www.elyoncall.com`
- The Bulgarian repo folder `C:\Users\Mile\Desktop\elyoncrm`
- The Bulgarian Vercel project `elyoncrm` (`prj_965V2iBg793RmiJJw9m6Tl3djllX`)

Everything here targets **Macedonia only** (see Infra below). If you ever see
`sxymaloycddnoxudxaqp` or `elyoncall.com` in a command you're about to run → **STOP.**
That is the live BG system.

**The token in `.env` can write to BOTH projects.** Nothing but the command line protects
Bulgaria. Before ANY state-changing command (db push, functions deploy, secrets set, vercel
deploy), run the tripwire:

```
node scripts/assert-mk-target.mjs
```

It checks `supabase/config.toml`, `.env`, `.vercel/project.json` and the remote row counts, and
exits non-zero if anything points at Bulgaria.

## ⚠️ CLI safety (this is how the BG incident happened — read it)
The shell's working directory **silently resets between tool calls**. NEVER rely on the current
directory to choose which project a command acts on. For ANY state-changing command, pass the
target **explicitly** and verify it before running:
- **Vercel:** `vercel <cmd> --cwd "D:\Dev\archives\elyon-natura" --scope gordanas-projects-a53c0208`
- **Supabase:** confirm `supabase/config.toml` `project_id = "bmfxhgznttcnnlqloqzp"` before any link/push/deploy
- **Git:** `git -C "D:\Dev\archives\elyon-natura" …` (the repo folder is `elyon-natura`; there is no `elyon-macedonia` folder)
- Read the tool's echoed target (e.g. "to Project X"); if it's ever `elyoncrm`/BG → abort immediately.
- **Never pass a `--project-ref` copied out of `docs/`** — those pages were inherited from Bulgaria.
- **Vercel env vars:** prefer the Vercel REST API (JSON body) over `vercel env add` stdin — PowerShell
  piping injects a UTF-8 BOM ("non ISO-8859-1 code point" login error) and bash `printf` w/o newline
  sets empty. Always verify with `vercel env pull`.

## Infra (Macedonia only)
- **Supabase:** ref `bmfxhgznttcnnlqloqzp` → https://bmfxhgznttcnnlqloqzp.supabase.co
- **Vercel:** project `elyon-natura`, scope `gordanas-projects-a53c0208` → https://elyon-natura.vercel.app (GitHub-connected → auto-deploys on push to `main`)
- **GitHub:** `Gordana1005/elyon-natura` (renamed from `elyon-macedonia`; the old name 404s)
- **Secrets:** `docs/VAULT.md` (gitignored) — keys, webhook secret, admin logins
- **Status / done / TODO:** `MACEDONIA-STATUS.md` (repo root)
- **Migrations:** the DB password was never recorded, so `supabase db push` cannot open a direct
  Postgres connection. Use `node scripts/apply-migration-mk.mjs <file.sql>` (Management API, same
  `postgres` role). Record the DB password in VAULT §1 to restore the normal `db push` path.
  Finished-but-paused migrations live in `supabase/paused/` (never applied; see its README).
- **Edge functions:** `api` (one deployable — deploy only when `index.ts` holds finished work),
  `altercpa-sync`, `mex-reconcile`, `web-sync`, `collabbox-sync` (the live collabBox reader —
  read-only against collabBox; it creates an order only once the MEX parcel exists). Deploy with
  `npx supabase functions deploy <fn> --project-ref bmfxhgznttcnnlqloqzp` after the tripwire. If the CLI hangs
  (30.09: 20 min on `api`), kill it and add `--use-api` (server-side bundling, ~30 s).
- **Read-only SQL** (verification): POST `https://api.supabase.com/v1/projects/bmfxhgznttcnnlqloqzp/database/query`
  with `{query, read_only: true}`; checkers: `scripts/verify-attribution.mjs` (C1–C14),
  `verify-insights-ties`, `verify-assigner`, and since 01.10 `verify-shifts` (S1–S6), `verify-teams`
  (T1–T5), `verify-address-routing` (R1–R7) — all read-only, pinned to MK.

## Per-market rules (Macedonia ≠ Bulgaria) — these OVERRIDE the copied BG docs/skills
`.grok/skills/` and `docs/` were copied from Bulgaria and still describe BG specifics in places.
**Where they conflict with the list below, THIS LIST WINS** (and update the skill/doc):
- **Currency: MKD in the UI.** Prices are STORED in EUR; the denar is derived at display
  time from a **frozen** `MKD_PER_EUR` constant. The denar is a managed NBRM peg, not a legally
  fixed rate like the lev — **never "update" the constant**, because that silently re-prices every
  historical order, closed payout and already-collected COD. If the market moves, re-price the
  catalogue in EUR instead. No lev, no 1.95583, no dual display.
  **One documented exception (operator, 2026-08-10): affiliate/CPA payout renders in EUR**
  (`formatEurExact`) on both the partner portal and `/affiliates-admin` — `payout_eur_snapshot`
  is a euro debt to a foreign webmaster who invoices in euro, not a Macedonian retail price.
  The staff "Avg order value (confirmed)" tile stays денари. Do not "fix" this back — see
  `.grok/skills/elyon-currency` and `elyon-affiliates`.
- **Timezone:** `Europe/Skopje` (CET/CEST) — not Europe/Sofia (EET, one hour ahead).
- **Phone:** country code **+389** — not +359. Last-8 matching is unchanged.
- **Language:** default UI is Macedonian (`mk`); en/sq/bg also shipped.
- **VAT is PER PRODUCT, from Sigma (owner, 01.10.2026 — replaces the flat 18 % of 28.09; `docs/VAT.md`).**
  Every product carries the rate Natura's books charge for it — `products.vat_rate`: food supplements **5 %**,
  cosmetics / gels / creams / oils / devices / chia drinks **18 %** (Sigma `Item.VatId`; the 2026 invoices agree).
  Every report taxes each LINE at its product's rate (`insights_profit()` `vt`, migration `20260944000900`); a
  line with no rate (MEX-only parcel, no product, a new product = NULL) is taxed at 5 % and shown apart as
  "unclassified" — never silent. The rate is written only by the audited `products_set_vat_rate()` (owners,
  `POST /api/products/vat-rate`, the ДДВ chip on /products) and is shown to owners only. There is no `VAT_RATE`
  and no `VAT_CONFIRMED` any more — never reintroduce a flat rate.
- **Login email domain:** `elyon-mk.local` (placeholder — see TODO).
- **Couriers/cities:** MEX Poshta is the carrier. The /orders "MEX Import CSV" emits MEX's own
  8-column portal template (contract: `src/lib/mexImportCsv.ts` — Latin, integer denari, no
  quoted fields); courier outcomes come from the automated `mex-reconcile` cron. The BigArena
  status-upload button was removed 2026-08-18. `bg_settlements` is dead (0 rows) — Macedonian
  addresses live in `mk_settlements`/`mk_streets`/`mex_cities`. **ONE MEX-zone resolver in SQL
  (01.10, `20260943000500`–`0711`):** an order remembers the place the form PICKED
  (`orders.settlement_id`, `mex_zone_basis`); `mex_zone_for_settlement` / `mex_zone_for_name` decide
  the zone for the api AND `altercpa-sync` (the old LIMIT-1 name match sent 290/295 Skopje sales to
  "Skopje - Centar"). The order form (Create / Confirm / Edit): a confirmed order needs a place from
  the list, a district where the city is split (Скопје) and street + number (or quarter + building);
  the postcode always follows the place, "За курирот" =
  the MEX Opis, an internal note apart, no birthday / gift for new orders; the address is locked once
  the order has a MEX parcel. `customer_profile_merge` only fills, never blanks. Check:
  `node scripts/verify-address-routing.mjs`. MEX has no cancel — a wrong zone is a lost parcel.
- **Telephony:** deferred (Phase 2). `VITE_USE_REAL_VOIP=false`; PBX/DID values are BG placeholders.
  The VOIP minutes bundle is seeded at 0 — there is no MK carrier contract. Agents dial from their
  own handsets: /calls shows a `tel:` link on a phone (the number + copy on desktop) and **the
  outcome IS the call log** (01.10): the one-tap bar Не одговара (Undo) / Повторно / Откажа / Корпа /
  Потврди (keys 1–5) → `POST /calls/outcome` = status + ONE `call_logs` row `source='handset'` +
  obligation + list member. A cancel / trash with no open order is a disposition record carrying the
  customer's last purchase (`last_sale_product`, server-side). The VOIP banner does not poll while
  VOIP is off; /voip-health shows in the menu only when `useRealVoip`.
- **Trash is STICKY here (engine v3.7-mk, 2026-08-06)** and differs from Bulgaria in two ways on
  purpose: (1) a **paid order after the trash releases** the customer — BG deletes them forever,
  we keep them, because 2.391 Macedonian customers had already paid us *after* being trashed;
  (2) **`duplicate_order` is housekeeping**, so it never removes anyone from a calling band and
  never enters the Trash List. Do not "align with BG" on either.
- **Owners see money; every active admin is an owner (2026-09-28, `20260939000500`).**
  `public.is_business_owner()` gates every money figure and money tab. Managers are NOT owners:
  on shared operational surfaces (e.g. `/insights/overview`) they get the same payload with every
  money key **absent** (the `stripOverviewMoney` whitelist pattern in
  `supabase/functions/api/overview.ts`); owner-only surfaces (Settings → Teams / Integrations,
  `/insights/pivot`, `/management-insights` beyond `?scope=calls`, the presence day sheet) answer
  `403 owners_only`.
- **Sale sources are the SIX DEPARTMENTS (owner law, 28–29.09.2026, whole history)** — decided by
  the collabBox FOLDER (document type) and the MEX profile; **never** by the system an order was made
  in, never by the seller's team ("no need to mention Elyon-CRM or AlterCPA anymore"). Cohort keys,
  in display order (`cohort_order_source(sale_source, detail, mex_tracking_id)` /
  `cohort_parcel_source()`, migration `20260942001000`):
  - **Affiliate – Lead in** (`altercpa`): AlterCPA affiliate leads (pending → decided; an ad lead
    from an existing client is still a LEAD) + collabBox 10111 "Нарачка LEADS". BIO NATURAL 9110.
  - **Affiliate – Lead out** (`elyon_crm`): re-sales to affiliate customers — CRM-made sales
    (`prediction_list` / `direct`) + collabBox 10114 "LEADS-OUT". BIO NATURAL 9103.
  - **Телешоп – Lead out** (`teleshop_out`): collabBox 10050 "Нарачка out", affiliate-first
    customers included (the grey zone is teleshop out). NATURA 9102.
  - **Телешоп – Lead in** (`teleshop_other`): collabBox 10036 "Нарачка in", the TV lead-in. NATURA 9100.
  - **Социјални мрежи** (`social`): collabBox 10106 / 10055. NATURA 9108 / 1300. Its own department.
  - **Web** (`web`): the `web_orders` mirror of naturatherapy.mk — NOT orders; the live shop gets no
    changes. NATURA NTMK / M….
  - The TYPE decides (`orders.collabbox_doc_type`); the DocNumber series lies for ~1.100 documents. A
    CRM-made sale shipped on a NATURA parcel follows that parcel's series.
  - **The MEX PROFILE decides (owner, 29.09 ~12:05, `20260942001860`):** "every order sent via BIO
    NATURAL is affiliate IN and OUT; no teleshop order has ever gone via BIO NATURAL; teleshop — and the
    web shop — send via NATURA." A CRM-made sale (prediction_list / direct) on BIO NATURAL is Affiliate –
    Lead out whatever its series; on NATURA it goes by series (9100 → Lead in, 9108/1300 → social, else →
    Телешоп – Lead out); with no parcel yet it is Affiliate – Lead out until MEX shows the profile —
    `orders.dept_override` (set by `order_dept_override(…, mex_account, mex_tracking_id)`, re-decided when
    the parcel links) and the 4-argument `cohort_order_source(…, dept_override)` every report uses. A
    MEX-only BIO NATURAL parcel is always affiliate. The "crm_prediction team → Телешоп – Lead out" rule
    (`…1800`) was WITHDRAWN the same morning — never reintroduce a team rule for departments (teams
    became business lines on 30.09 and still never place a sale — `verify-teams.mjs` T3). The
    Prediction-lists tab holds the list sales of every department. A MEX parcel with no order
    goes by series (9110 → Lead in · 9103 → Lead out · 9102 → Teleshop out · 9100 → Teleshop in ·
    9108/1300 → Social · NTMK/M… → Web).
  - `collabbox_department(type, doc, person, at)` classifies at INSERT; a new collabBox type goes into
    it and into `collabbox_doc_role()`. Every later move of a row is logged in `sale_source_reclass`
    (`scripts/reclass-by-folder.mjs --rollback`). One order, one department: the row moves, it is
    never copied, never counted twice.
  - Superseded — never reintroduce: the AlterCPA-team override (`team_*` details, withdrawn by
    `20260942001100`), "Lead out = CRM + 9102 + 9103", the `crm_since` gate (information only).
  - The 10-day no-parcel rule keeps its population (AlterCPA approvals only).
  - **A dead order is revived only by its own folder's parcel** (`mayReviveWith`,
    `supabase/functions/mex-reconcile/match.ts`, 29.09): a cancelled / trashed AlterCPA lead by a
    9110 parcel, a CRM sale by a 9103 one — a teleshop / social / web parcel on the same phone is
    another department's sale (repair `a057bc52` reverted 145 such revivals).
  - Every order shows its department and seller: `order_departments(ids)` (the Orders list) and
    `order_origin(id)` (the order window's "Origin and proof": MEX profile, status, COD, receiver,
    collabBox document, AlterCPA decision). Display only — `confirmed_by_*` stay untouched.
- **One calculation everywhere (owner, 29.09):** Табла for admins IS the Insights Overview; Операции
  counts today from `insights_cohort` (the Skopje day) + `leaderboard_day_v2`; the TV leaderboard is
  `leaderboard_day_v2` (one row per agent split by department, managers shown not ranked, no bonus).
  Never add a figure that counts orders another way — read the cohort.
- **Every source refreshes at least every 15 minutes (owner, 29.09; `20260942001300`)**; MEX — both
  APIs, BIO NATURAL and NATURA — is the final proof of shipped / paid / returned. AlterCPA: new leads
  every 2 min, outcomes every 5 min 07:00–20:55. MEX: both accounts in one sweep every 15 min
  06:00–22:59 + a Sunday 60-day sweep. Web: every 5 min (`20260942001940`). collabBox: a full pass of yesterday + today
  every 15 min 07:00–22:59 + the nightly 00:00 (last 3 days); only one run at a time (409), so never
  leave a manual backfill running into 07:00. Freshness thresholds follow (`20260942001400`).
- **"Нарачки" = only real orders**: confirmed / packed / shipped / paid, plus returned (it
  shipped). Cancels and trash are never orders or order value — shown apart as Откажани (red dot) /
  Во корпа (grey); Вратени = pink dot; worked decisions = "Обработени".
- **Money is a COHORT**: the sales made in the period (sale day = `sold_at`, else AlterCPA
  `decided_at`, else `confirmed_at`, else `created_at`, Skopje days), split into parts that sum
  EXACTLY to the total — Наплатено (MEX 2) · Кај курирот (MEX 1/4/10; problem 3/9/13 inside it) ·
  Спакувано (MEX 8) · Во магацин за пакување (confirmed, no parcel) · Вратено (MEX 7). **MEX status
  beats CRM status.** Value = parcel COD (`formatDenari`, already denari), else price × 61.5
  (`formatMoney`); web = shop total. The leads funnel and MEX cash-flow are separate, labelled
  figures. MEX alone decides paid/returned; AlterCPA decides only confirmed-or-dead.
- **The no-parcel rule is 10 DAYS, in APPLY mode (owner, 28.09; `20260938000000`,
  `app_settings.no_parcel_rule.days = 10` — was 7 until 28.09).** An AlterCPA approval with no MEX
  parcel 10 days later is cancelled nightly at 21:10 Skopje (reason code stays `no_parcel_7d`); a
  parcel that appears later sends it back to shipped and MEX takes over (rule C, and the 9110
  upsell revive). Same-phone unlinked parcel → `needs_linking`, never cancelled. **Two exemptions (owner,
  01.10, `20260944000960`):** `in_collab` (a collabBox sales document for the customer since the sale, not a
  storno / another order's) and `postponed` (a note postpones the DELIVERY — the regex is documented in the
  migration; "ќе се јави" never counts; ≤ `postpone_days` 45) are never cancelled either.
- **Phone + date links — owner law, 01.10.2026 (`20260944000950`):** the truth is MEX (+ collabBox), NEVER
  AlterCPA (a commercial artifact — the ~30 % confirmation guarantee); nothing is ever pushed to AlterCPA. An
  orphan 9110/9103 parcel is linked to the ONE order on its last-8 phone created −10 d … +1 d that holds no
  parcel and fits no other orphan parcel — amount ignored (up-sells); > 72 h apart the collabBox document must
  carry the product BY NAME. One definition: `link_lead_parcels_plan()`; cron `link-lead-parcels` 21:02 Skopje
  (switch `app_settings.link_lead_parcels`, seeded `report`); backfill `scripts/repair-link-lead-parcels.mjs`;
  every run undone by `scripts/rollback-repair.mjs --run <id>`; proof `node scripts/verify-parcel-link-rules.mjs`.
  Old September `credit_pending` LEADS documents: `scripts/collabbox-recredit.mjs`. See `docs/ALTERCPA-BRIDGE.md`.
- **Денари everywhere (owner, 28.09):** every staff-facing amount — screens, charts, exports,
  notifications — is shown in денари. The only EUR on screen is the foreign affiliate payout above.
- **COD ≠ CRM price → MEX is right** (owner): the CRM price follows the parcel COD, except when COD =
  price × 61.5 + 150 (the delivery fee) or COD is 0.
- **Test phones 070123456 / 23123123** are never in any report (owner, 28.09): their CRM orders are
  deleted (snapshot first); their web orders and MEX parcels stay in the shop/register but are
  excluded from every figure.
- **Bulk writes must not bump `orders.updated_at`** (GET /call-agains reads it as last_call_at):
  `SET LOCAL elyon.keep_updated_at = 'on'` (honoured by `update_updated_at_column()` since
  `20260939000300`). `session_replication_role` cannot be set inside functions on MK. Run bulk work
  in the quiet window after 20:55 Skopje and never while `recompute_all_segments` runs.
- **Web orders count from the moment they are placed (owner, 29.09; `20260942001965`)**: a web order the shop
  has not confirmed yet ("чека потврда") is a sale in the cohort's `to_pack`, exactly like the shop's own panel;
  `card_unpaid` never counts, `cancelled` is shown apart. The TV board's web view (`leaderboard_web_live`) = the
  cohort's web part on every day since 01.01.2026 — the days 30.07–03.09.2026 (the old shop was never migrated)
  come from the MEX-only web parcels. See `elyon-web-shop-bridge`.
- **A collabBox sale counts on the day the operator BOOKED it (owner, 01.10; `20260944000500`/`0600`)**:
  collabBox dates a document on its DISPATCH day; `collabbox_documents.booked_at` (+ basis seen /
  sequence / doc, decided once) and THE sale time `collabbox_sale_at(doc_at, booked_at)` feed the board,
  the cohort, Операции and the orders the sync makes (sold / confirmed / created). Closed months never
  move (`collabbox_booking_day_since()` = 01.10.2026 — September only with the owner). The frequent pass
  reads the documents dated up to 14 days ahead; a booking stays a booking until an ORDER holds its
  parcel. History: `scripts/backfill-collabbox-booked-at.mjs` (dry run → owner → `--apply`); check
  `node scripts/verify-booking-day.mjs`. See `elyon-collabbox-sync` "The booking day".
- **The Assigner (redesigned 30.09, `20260942001950`–`001970`)**: a live board of ALL profiles on top (5 s poll +
  Realtime broadcast `assigner`), lists split by the BUYER's department (`customer_departments` = the department of
  the customer's LAST PURCHASE, refreshed every 10 min), distribution chosen ON THE SERVER (`assigner_distribute`:
  count, split total/per agent, newest/oldest/random, dry-run preview). List names/descriptions are translated for
  display only — NEVER rename a list. Each agent tile shows the team + lane badge (01.10). An agent's own
  call-agains are a view of /calls: **`/call-again` redirects to `/calls?queue=call-again`** (`GET /calls/call-again`).
  See `elyon-assigner`; check with `node scripts/verify-assigner.mjs`.
- **Shifts are the LOGIN GATE (owner kept it, 30.09):** `GET /shifts/check-login` refuses every non-admin/manager
  with no shift covering "now" today (Skopje) — codes `no_assignment` / `no_shift_today` / `zero_shift` /
  `outside_hours`, and it writes the login log itself. A missing roster locks the whole floor out at 07:00 (the
  September roster ended 30.09; October was rolled forward the same night, 33 agents). Keep the **runway** ≥ 5 days:
  `shifts_runway(5)`, the cron `shifts-runway-alert` at 17:05 Skopje notifies admins + managers, and
  `shifts_roll_forward` (Смени → "Пренеси го месецот": preview → owner sees the list → apply). One "Смени" page
  (`/shifts`; `/my-shifts` redirects), one shift per person per day (`20260943001000`), login history survives a
  deleted shift. Check: `node scripts/verify-shifts.mjs`. See `elyon-presence-and-leaderboard` §1b.
- **Teams are BUSINESS LINES (owner, 30.09, whole history; `20260943000900`/`0950`):** **Телешоп** (ships via NATURA;
  lanes in / out / social), **Affiliate** (ships via BIO NATURAL; lanes in / out), **Менаџмент** (shown, never
  ranked). Labels: Телешоп лидови · Телешоп предикција · Социјални мрежи · Affiliate лидови · Affiliate предикција.
  `sales_team_members.lane`; the old keys `crm_prediction` / `altercpa_leads` stay as legacy aliases (old TV links);
  one filter function `sales_team_filter_matches` (`team:lane`). The owner confirms people in Settings → Teams →
  **Предлог** (`sales_team_line_proposal` → `sales_team_lines_apply`; 82 re-keyed, 17 wait for him). A team groups
  people — it **NEVER decides a department**.
- **The PRODUCT LINE decides the MEX profile when the CRM itself ships (owner, 30.09):** `products.brand_line` —
  Bio Natural / Dr.Becker → BIO NATURAL, Natura Therapy / Ad Astra → NATURA (`mex_profile_for_line()`); a mixed
  basket needs a person's pick (the exact rule is still the owner's). **Everything on naturatherapy.mk is Natura
  Therapy or Ad Astra** (the Ad Astra page is `/adastra-nutrition`); **Bio Natural never appears on the web.**
  `products.kind` = product / bundle / gift / other; /products opens on active products of kind "product". Both
  columns are written only by the audited `products_set_brand_line` / `products_set_kind` (guard triggers). See
  `elyon-products-catalogue`.
- **MEX 8 = ЗА ПАКУВАЊЕ, never shipped (owner, 30.09; live 01.10):** a parcel at MEX 8 "Shipment created" keeps the
  order confirmed (+ `orders.mex_sent_at`); only 4 / 10 / 9 / 1 / 3 ship it, 2 = paid, 7 = returned — in
  mex-reconcile, the collabBox writer (`…1210`) and the Overview's "Спакувано" (`…1220`). ~260 orders still `shipped`
  at MEX 8 wait for the owner's OK before `scripts/repair-shipped-at-mex8.mjs` is applied. **/warehouse = Испрати до
  MEX · За пакување · Залихи · Попис · Движења; no printing** (the MEX portal prints). **"Испрати до MEX" (the CRM's
  own `add_shipment.php` push, `mexPush.ts`, ledger `mex_push_attempts`) is built and SWITCHED OFF** —
  `app_settings.mex_push.enabled = false`; the 11:00 auto-send is built, not scheduled. Never switch either on
  without the owner. See `elyon-warehouse-incoming`, `elyon-fulfilment-csv`.
- **Settings writes go through the api, audited (01.10, `20260943001500`):** `/settings/:section`, grouped (Луѓе и
  пристап · Правила · Систем · Напредно · Лично); modules / role permissions / privacy via `PUT /api/settings/*`
  (admins); the browser write policies are dropped, and `app_settings` / `courier_rates` writes are admin-only. The
  MEX courier rate is saveable (owners). See `elyon-security` §11.
- **TODAY is the default period (owner, 01.10):** Insights (Табла included) and /orders open on today, with ← / →
  stepping a day (a longer period by its own length; → stops at today) — one `stepRange` + `PeriodStepper`.
  /orders opens on the "Нарачки" chip (Нарачки · Отворени лидови · Откажани · Во корпа · Сите), filters in the URL
  (department, seller, MEX status), Skopje days, phone search by the last 8 digits.
- **Terminology (owner, 30.09 / 01.10):** in Macedonian prediction = **"предикција" / "предикциски"** — never
  "прогноза"; a leads team or queue = **"лидови"** — never "на чекање" / "пендинзи"; **"На чекање" is ONLY the order
  status `pending`**. `grep -c рогноз src/i18n/locales/mk.json` must be 0. See `elyon-i18n`.
- **Hidden pages (owner audit, 30.09):** out of the menu, routes kept (old links work): /missed-calls, /voip-health
  (shown only when `useRealVoip`), /inbound-leads, /webhooks, /lead-distribution (engine stopped since 16.09),
  /affiliates-admin. Redirected: /import-orders → /orders (`POST /orders/import` stays for scripts — the page never
  made a real order and a blank status became PAID), /search-prediction → /, /predictions → /segments, /my-shifts →
  /shifts, /call-again → /calls?queue=call-again. Dead page files deleted. Do not bring them back without the owner.
- **UI law (owner, 29–30.09): every page in the Insights style and perfect on EVERY screen** — below md a table
  becomes cards, the page never scrolls sideways, no clipped or overlapping labels; on a phone the sidebar is a ☰
  drawer. Take Playwright screenshots at 360 / 390 / 768 / 1024 / 1280 / 1920 px (zero overflow) before a UI push.
  Rebuilt 30.09–01.10: the Assigner, /users, /orders, /calls, /warehouse, /settings, /shifts, /products and the order
  form. The rest of the CRM follows page by page.
- **Deferred by the owner — do not touch:** payouts / bonus / commission math; costs and lead cost
  (he sets them later); the stock count (owner, 29.09: "don't focus on stock now" — sellable products
  carry the placeholder 1.000 until his count arrives; keep stock working, add no detail).
- Search the code for `TODO(mk)` to find every unfinished real-value spot.

## Grok Skills System

**This project has a first-class skills system** located in `.grok/skills/`. Check `/skills`
before non-trivial work on money, phones, warehouse, stock, webhooks, or fulfilment.
**But apply the Macedonian per-market overrides above** — several skills still teach BG rules
(lev peg, +359, Sofia). When a skill conflicts with the overrides, the overrides win; fix the skill.

- `elyon-currency` — ⚠️ inherited BG/Macedonia rules. The currency override above wins.
- `elyon-phone-normalization` — Last-8-digits search + E.164 storage + pollution protection.
- `elyon-fulfilment-csv` — How an order becomes a MEX parcel: the portal-import CSV contract (rewritten 2026-08-18) and its twin, the "Испрати до MEX" `add_shipment.php` push (01.10 — claim, existence check, one-success ledger, double-parcel guard, account from the product line; switched OFF).
- `elyon-warehouse-incoming` — /warehouse since 01.10: Испрати до MEX · За пакување · Залихи · Попис · Движења, the queue, MEX 8 = за пакување (and the not-applied ~260-order repair), no printing, the old routes' guards, stock safety.
- `elyon-webhook-and-lead-ingestion` — Inbound pipeline, HMAC, per-product slugs.
- `elyon-stock-and-bigarena` — Stock movements, import rules, and historical operator decisions.
- `elyon-agent-commissions` — Per-package agent bonuses on every PAID order (only gate is paid; source irrelevant), tiered 1/2/3€ by unit price, no minimum, credited to the confirmer. Read before touching any payout/commission math.
- `elyon-notifications` — The bell, the 6 notification types, the English-in-DB + `meta.i18n` translation contract, owner = confirmer, and the unpaid-delivery chase job.
- `elyon-segments-and-prediction` — The name-construction engine (**v3.7-mk, sticky trash**), the exclusivity rule, holding pens (Current Cancels 14d, NEWCOMERS 21d, Trash List), carry-over, the nightly recompute, and the /calls outcome bar (`POST /calls/outcome` — the outcome IS the call log; the disposition's last product). Law for anything touching prediction lists.
- `elyon-assigner` — Distribution + the Unassign tab, agent workload truth, the live board with team + lane badges, the agent's call-agains on /calls (`/call-again` redirects), and the stopped lead-distribution engine.
- `elyon-voip-and-pbx` — The A1 trunk, Asterisk/FreePBX, the WebRTC softphone and recordings. BG-specific; MK telephony is deferred.
- `elyon-i18n` — EN/BG/SQ/MK: every user-visible string goes through i18n in all four locales, no exceptions; the owner's terminology (предикција, лидови, "На чекање" only for pending).
- `elyon-security` — RLS, HMAC, permissions, audit and secrets; Settings writes only through audited api routes (01.10), the guard-trigger writer pattern. Never write an `authenticated`-wide read policy.
- `elyon-affiliates` — The CPA/partner system and the hard wall that keeps external logins out of staff surfaces.
- `elyon-altercpa-bridge` — The AlterCPA lead mirror: ledger-first, callable geos, offer mapping, and why foreign leads must never reach `orders`. Read before touching `altercpa_*` or multi-country intake.
- `elyon-logistics-costs` — Courier rate card, return round-trip loss, Pure Profit actuals, and VAT per product from Sigma (taxed per line; `docs/VAT.md`).
- `elyon-presence-and-leaderboard` — Shifts as the login gate (runway, roll-forward, the Смени page), presence minutes + the 30-min idle alert, sales people / identities / teams = business lines + lanes (Settings → Teams → Предлог), the write-once `orders.sold_*` stamps (who is credited with a sale, the stamping cron), the TV leaderboard v2 (`leaderboard_day_v2`, one row per agent split by department, `?team=team:lane`).
- `elyon-web-shop-bridge` — The read-only naturatherapy.mk mirror (`web_orders`, web-sync every 15 min, `crm_export` on the shop side). Web orders are NOT CRM orders; the live shop gets no changes.
- `elyon-customer360-and-integrations` — Customer 360 (`customer_timeline`, last-8 matching, money stripped for non-owners) and Settings → Integrations health (freshness thresholds kept in step with the Overview, the 7-day rule's owner switch).
- `elyon-departments-and-sources` — The six departments (collabBox folder + MEX profile), `cohort_order_source`, the parcel split, `sale_source_reclass` and its rollbacks; a team never decides a department, the product line only picks the account of a CRM push. Law for anything that says where a sale belongs.
- `elyon-collabbox-sync` — The live collabBox reader: folders/types and roles, the document ledger, orders only once the MEX parcel exists, seller credit, the 15-minute + nightly crons, one run at a time.
- `elyon-products-catalogue` — Product kinds (product / bundle / gift / other) and brand lines (Natura Therapy / Bio Natural / Ad Astra / Dr.Becker → the MEX profile), the web-catalogue rule, the audited writers behind guard triggers, the machine-text cleanup, /products, and the catalogue scripts.

New skills should be added to `.grok/skills/` whenever you find yourself re-explaining the same
complicated rule or workflow. Use `/skillify` right after completing a complex piece of work;
prefer **project scope** so the skill is committed to the repo.

## Engine regression check
The segment engine resolves its target list by **exact name match**, and it deletes existing
memberships *before* resolving. A drifted list name therefore wipes members silently, with no
error. After any migration bundle, run:

```
node scripts/engine-fixture-mk.mjs
```

## Memory
This Macedonian workspace has its OWN memory store, separate from Bulgaria. `MEMORY.md` is loaded
each session. Keep only Macedonian facts there; never write BG facts into this project's memory,
and never let a recalled BG fact send you to touch the BG system.

---

*Fork stood up 2026-06-30 from `deploy-kit/`; re-aimed from Macedonia to Macedonia and brought to
Bulgarian code parity on 2026-07-31 (28 migrations + ~33 new files). This file is the Macedonian
constitution (Claude.md + Skills + Memory = the Elyon Agent OS, Macedonian instance).*
