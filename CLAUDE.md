# Natura Therapy HUB — the Elyon CRM, MACEDONIA edition (Natura Therapy MK) · https://naturall.mk

This repository is the **Macedonian** instance of the Elyon CRM — a hard fork of the Bulgarian
system, run as a completely separate operation. It has its OWN infrastructure and shares
**nothing at runtime** with Bulgaria.

> **Naming note:** the deployment was stood up for Macedonia on 2026-06-30 and re-aimed at
> **Macedonia** on 2026-07-31. The Vercel project was renamed `elyon-macedonia` → `elyon-natura`
> on 2026-08-01. **Since 02.10.2026 the CRM is "Natura Therapy HUB" on https://naturall.mk**
> (owner; `www.naturall.mk` 308-redirects to it). Since 02.10.2026 ~19:00 `elyon-natura.vercel.app` and the
> legacy `elyon-macedonia.vercel.app` **308-redirect to naturall.mk with the path kept** (old TV links
> `/tv?token=…` keep working); they stay in the edge function's CORS allowlist.
> On 02.10.2026 the Vercel project also **moved from the Hobby team `gordanas-projects-a53c0208`
> to the elyoncoding Pro team `elyon-s-projects`** (same project id; the BG `elyoncrm` stayed behind).
> The GitHub repo **was** renamed too and is now **`Gordana1005/elyon-natura`**
> (verified against `git remote -v`, 2026-08-13 — the old `elyon-macedonia` URL 404s, so a push
> to it fails with "Repository not found"). **Since 03.10.2026 the database is the Supabase project
> `naturall` = `oufoazmnbwugtfldkwsn`** (org `elyongroup`, Frankfurt). The old ref `bmfxhgznttcnnlqloqzp`
> (org `naturatherapykosovo`, Ireland) is RETIRED — read-only, cron off, kept only as the rollback copy.
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
- **Vercel:** `vercel <cmd> --cwd "D:\Dev\archives\elyon-natura" --scope elyon-s-projects --token <elyoncoding token>`
  — the machine's default CLI login (`gordana1005`) is the Hobby team that holds BG `elyoncrm` and
  can no longer see this project; never use it for MK. The REST API takes `teamId=team_fT756uoO13MD9jtimyq27JNy`.
- **Supabase:** confirm `supabase/config.toml` `project_id = "oufoazmnbwugtfldkwsn"` before any link/push/deploy
  (the retired `bmfxhgznttcnnlqloqzp` is refused by `scripts/lib/target.mjs`, like Bulgaria)
- **Git:** `git -C "D:\Dev\archives\elyon-natura" …` (the repo folder is `elyon-natura`; there is no `elyon-macedonia` folder)
- Read the tool's echoed target (e.g. "to Project X"); if it's ever `elyoncrm`/BG → abort immediately.
- **Never pass a `--project-ref` copied out of `docs/`** — those pages were inherited from Bulgaria.
- **Vercel env vars:** prefer the Vercel REST API (JSON body) over `vercel env add` stdin — PowerShell
  piping injects a UTF-8 BOM ("non ISO-8859-1 code point" login error) and bash `printf` w/o newline
  sets empty. Always verify with `vercel env pull`.

## Infra (Macedonia only)
- **Supabase:** project `naturall`, ref `oufoazmnbwugtfldkwsn` → https://oufoazmnbwugtfldkwsn.supabase.co — org `elyongroup`
  (Pro, Small compute, daily backups), **eu-central-1 Frankfurt**, session pooler `aws-0-eu-central-1.pooler.supabase.com:5432`.
  Moved on 03.10.2026 from `bmfxhgznttcnnlqloqzp` (org `naturatherapykosovo`, Ireland) — that project is RETIRED: read-only,
  cron off, the rollback copy until its deletion is signed off; never a target. How the move was done, the checks and the
  rollback: `scripts/db-move/README.md` (`preflight.mjs`, `cutover.mjs`, `sync-acls.mjs` after any schema restore).
- **Vercel:** project `elyon-natura` (`prj_cwxmm4jb74hUHmAb6YzbUG7PuDy3`), Pro team "Elyon's projects" `elyon-s-projects`
  (`team_fT756uoO13MD9jtimyq27JNy`, account elyoncoding) since 02.10.2026 → **https://naturall.mk** (+ elyon-natura.vercel.app);
  GitHub-connected → auto-deploys on push to `main`. Token: `D:\naturatherapy\vault.md` line 60 — never print it.
- **Domain:** `naturall.mk` — registrar + DNS at MK-Host (`dns1/dns2.mk-host.mk`): apex A `216.150.1.1` + `216.150.16.1`,
  `www` CNAME `bcdc79c7195035f5.vercel-dns-017.com` (Vercel's records; no Cloudflare). No mail on the domain yet.
- **Speed (measured from Skopje, 02.10.2026):** Vercel serves the SPA from its Frankfurt edge (`fra1`); Supabase WAS in
  `eu-west-1` (Ireland; since 03.10.2026 it is `eu-central-1` Frankfurt — these numbers are the Ireland baseline, re-measure) — auth health ≈ 120–150 ms, the `api` edge function runs in `eu-central-2` (Zurich) by default
  (≈ 230 ms for a light call; forcing `x-region: eu-west-1` was SLOWER for it). DB healthy (cache hit 98,6 %, ~33/90
  connections). First load ≈ 344 KB gzipped (was ≈ 703 KB before the lazy locales). The region moved with the
  project on 03.10.2026.
- **GitHub:** `Gordana1005/elyon-natura` (renamed from `elyon-macedonia`; the old name 404s)
- **Secrets:** `docs/VAULT.md` (gitignored) — keys, webhook secret, admin logins
- **Status / done / TODO:** `MACEDONIA-STATUS.md` (repo root)
- **Migrations:** `node scripts/apply-migration-mk.mjs <file.sql>` (Management API, the `postgres` role; it records the
  file in `schema_migrations`). The new project's DB password is in VAULT §1b, so `supabase db push` could work again —
  keep ONE path (apply-migration-mk) unless the owner decides otherwise.
  Finished-but-paused migrations live in `supabase/paused/` (never applied; see its README).
- **Edge functions:** `api` (one deployable — deploy only when `index.ts` holds finished work),
  `altercpa-sync`, `mex-reconcile`, `web-sync`, `collabbox-sync` (the live collabBox reader —
  read-only against collabBox; it creates an order only once the MEX parcel exists), `collabbox-shops`
  (02.10 — the 22 shops' tills: read-only against collabBox with its OWN allow-list, the same login and
  secret, one run at a time and never alongside `collabbox-sync`; it never makes an order). Deploy with
  `npx supabase functions deploy <fn> --project-ref oufoazmnbwugtfldkwsn --no-verify-jwt` after the tripwire. If the CLI hangs
  (30.09: 20 min on `api`), kill it and add `--use-api` (server-side bundling, ~30 s).
- **Read-only SQL** (verification): POST `https://api.supabase.com/v1/projects/oufoazmnbwugtfldkwsn/database/query`
  with `{query, read_only: true}`; checkers: `scripts/verify-attribution.mjs` (C1–C14),
  `verify-insights-ties`, `verify-assigner`, and since 01.10 `verify-shifts` (S1–S6), `verify-teams`
  (T1–T5), `verify-address-routing` (R1–R7), since 02.10 `verify-stock-v2` (S1–S17; `--preview` while the
  switch is off) and `scripts/shops/verify-shops.mjs` (H1–H7) — all read-only, pinned to MK.

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
- **Purchase costs = Sigma, STORED IN DENARI (owner, 01.10.2026 — a deliberate exception to "store EUR": Sigma
  book values;
  `20260945000600` / `0800`, `docs/STOCK-V2.md`).** The purchase cost of EVERYTHING is Sigma `CalcBuyPrice`
  (Ф00001-04, MKD ex VAT) for the WHOLE history — BioNatural at Ф00001 production cost, never the АД Астра
  inter-company price. `stock_article_costs` (append-only, 1.362 articles, first load valid from `-infinity`) → a
  product's cost through its APPROVED recipe (`product_articles` → `product_cost_history`, rebuilt by
  `product_costs_rebuild()`; 153 products complete on 02.10) → `products.cost_price` (EUR) is a GUARDED mirror =
  cost_mkd / 61,5 (`tg_products_cost_guard` — never type a cost into it). The 69 old EUR placeholders are archived in
  `products_cost_legacy`. `insights_profit()` costs each line at its sale day since
  `app_settings.stock_v2.profit.cost_source = 'sigma'` (switched 02.10, audited); the packed-extras measure (gifts)
  waits behind `profit.extra_goods = false`. An uncosted product keeps the labelled estimate — never a silent 0.
  Costs are owners only. See `elyon-logistics-costs`, `elyon-stock-v2`.
- **Timezone:** `Europe/Skopje` (CET/CEST) — not Europe/Sofia (EET, one hour ahead).
- **Phone:** country code **+389** — not +359. Last-8 matching is unchanged.
- **Language:** default UI is Macedonian (`mk`); `sq` and `en` also shipped. **Bulgarian was removed on 02.10.2026
  (owner: "not needed")** — `bg.json` is gone; never add it back. Each language is its own lazy chunk
  (`src/i18n/index.ts`, an i18next backend over `import.meta.glob`, fallback `mk`): a session downloads only its
  language. Never import a locale JSON statically in app code — that puts every language back into the first load.
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
- **Money follows the ACCESS LEVEL (owner, 02.10.2026; `20260947001600`–`1630`, api `accessLevels.ts`) — not "every
  admin is an owner".** Roles decide pages; `user_access.level` (audited `access_set()`, super admins only) decides
  money. **super_admin** (Mile Stoev, Мики Митров, Lazar Delev, Radislava Maneska) · **owner** (Hedi) · **finance**
  (Ema) = everything, `can_see_margins()` (costs, VAT, profit, rate card, bonus, stock at cost, MEX cash tab) ·
  **administrator** (Mr Tony, Nina, Dragana, Dzenet Ramadani) = revenue + returns company-wide,
  `can_see_revenue()` = `is_business_owner()`, never a margin · **dept_admin** = revenue + наплата + returns of their
  departments only, `dept_scope()` — Тим Центар: Teodora Krstevska, Mirjana Stefanovski; Тим Маџари: Martina Bundova,
  Simona Krstevska, Kalina Tajkovska (`meta.dept_scope`) · everyone else: money keys ABSENT / `403 owners_only`.
  api: `canSeeMargins()` / `isBusinessOwner()` / `deptScopeOf()`; UI: `get_my_permissions()` `accessLevel`,
  `departments`, `canSeeMargins`, `canSeeRevenue`, `canSeeMexCash`, `mexCashDepartments`.
- **🔁 THE SELLER'S TEAM DECIDES THE DEPARTMENT — a LEAD excepted (owner, 02.10.2026, whole history; supersedes the
  folder-only wording below and the 29.09 withdrawal of the team rule; `20260947000400`).** Owner: "од сега сметиме по
  агенти, за дашбордот и за Insights, и за пресметките … ако агентот е од телешоп Out, порачката се смета кај телешоп
  Out … различно е само за affiliate, затоа што тука е приоритет лидот, ако е lead(pending) тогаш е дефинитивно
  affiliate lead in … Affiliate out е тимот од affiliate IN, истите луѓе но порачките не се од leads." ONE rule,
  `order_dept_by_team(sale_source, seller, sale time)`: a LEAD (sale_source altercpa — an AlterCPA lead or a 10111 LEADS
  document) → Affiliate – Lead in, whoever decided it; else the seller's LINE team on the Skopje sale day
  (`sales_person_line_at`): teleshop:out → Телешоп – Lead out (also its LEADS-OUT / BIO NATURAL sales) · teleshop:in →
  Телешоп – Lead in · teleshop:social → Социјални · affiliate → Affiliate – Lead out; Менаџмент / legacy team / no seller
  → the folder + MEX-profile rules below. Stored in `orders.dept_override` by `order_dept_decide` (team → a CRM sale's
  MEX profile → its own booking → NULL = the mapping; stored only where it changes the department), kept by
  `zzz_orders_dept_override`, `tg_sales_team_members_dept` (a team change re-decides the person's orders) and the
  15-minute `crm-sale-booking-dept` pass; **since 02.10 evening the team decides from 01.01.2026** (`20260947000900`:
  memberships dated back, Slobodanka Petrova Тим Центар Out to 31.05 by her own folders, former staff placed by theirs)
  and **Менаџмент is its own, 7th category** (`20260947001000`, key `management`: a Менаџмент seller's non-lead sale is
  never Тим Центар / Тим Маџари; counted in every total, shown apart; on the TV board only under its own team filter;
  a lead stays Тим Маџари In); a BOOKING follows its author's team in `insights_sale_rows` /
  `leaderboard_day_v2`. 3.130 orders moved (Sept: 760 Affiliate – Lead out → Телешоп – Lead out, 2,11 М ден), each in
  `dept_by_team_backfill` (old → new). The raw `sale_source` / detail (folder, list, intake) never change. Proof:
  `node scripts/verify-teams.mjs` T3.
- **NAMES: Тим Центар / Тим Маџари (owner, 02.10.2026)** — Телешоп → **Тим Центар**, Affiliate → **Тим Маџари**, ALWAYS
  with "Тим" ("Тим Маџари, Тим Центар, никогаш само центар или маџари"); departments **Тим Маџари In · Тим Маџари Out ·
  Тим Центар Out · Тим Центар In** · Социјални мрежи · Веб-продавница; lanes **In / Out / Социјални мрежи** (en "Team
  Centar / Team Madžari", sq "Ekipi …", bg "Екип …"). DISPLAY ONLY — keys (`teleshop`, `affiliate`, `altercpa`,
  `elyon_crm`, `teleshop_out`, `teleshop_other`), list names and URLs never change; `sales_teams.name` renamed (audited).
  "Affiliate / Афилијат / Партнер" for the AlterCPA CPA partners (webmasters, payouts, guarantee) is a different thing
  and stays. Where older text below says Телешоп / Affiliate (– Lead in/out), read the new names.
- **Sale sources are the SIX DEPARTMENTS (owner law, 28–29.09.2026, whole history)** — the raw record: the
  collabBox FOLDER (document type) and the MEX profile, never the system an order was made in ("no need to mention
  Elyon-CRM or AlterCPA anymore"); since 02.10 the SELLER'S TEAM decides first (above). Cohort keys,
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
    (`…1800`) was WITHDRAWN the same morning; on 02.10 the owner made the SELLER'S LINE TEAM the first decider
    (above, `20260947000400`) — the old crm_prediction-team rule itself stays dead. The
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
- **The Overview / Табла is the CALL CENTRE; MEX cash has its own tab (owner, 02.10.2026; `20260947001300`).**
  Order: the sales made in the period → Кој колку продал → Најпродавани производи → leads → teams → departments.
  "Прилив од MEX" (cash on the MEX delivery day) is NOT on the Overview, Prediction lists or Операции — it read
  as money received that day, while MEX pays out later in lumps. It lives on **Insights → Наплата (MEX)**
  (`insights_mex_cash`: per day × account, returns, MEX's half-month settlement periods 1–15 / 16–end — its fee
  invoices bill exactly the delivered parcels — and what MEX holds now), visible to `can_see_mex_cash()` =
  `can_see_margins()` (super_admin / owner / finance — the access levels, 02.10.2026; `app_settings.mex_cash.viewers`
  is no longer read) and, ONLY for their own MEX account, a dept_admin (`can_see_mex_cash_dept()`: Тим Маџари →
  BIO NATURAL, Тим Центар → NATURA, which also carries the web shop); an administrator gets 403. MEX payout dates are in no data we hold (no bank statements in
  the Sigma export) — the bank export is awaited. The cohort's own parts (Наплатено / Кај курирот / …) stay.
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
- **REAL TIME, then 10 DAYS (owner, 03.10.2026; `20260947001850` / `1851`, `cohort_unshipped_since()`).** Owner:
  "реал-тајм да се гледат сите нарачки … без разлика дали ги има или нема во collab, но после 10 дена се одзимат …
  тие што не се доставени и тие што не се пуштени никогаш; return-от се брои како return." Every sale counts at once
  (AlterCPA approvals with no document / parcel too). A 10111 LEADS booking counts at once on its booking day (Тим
  Маџари In, its author) when the customer's phone is known and it is not the copy of a living Тим Маџари In sale on
  that phone (−30 d … +1 d, amount ignored) — a phoneless LEADS document waits for its parcel (the backtest
  double-counted 236 / 767k без телефон). After 10 Skopje days a sale MEX never took stops counting EVERYWHERE (TV,
  Табла, Insights, Операции, /orders drills) — (a) a booking with no parcel, (b) any sale with no MEX parcel, (c) a
  parcel still at MEX 8; counting only, the order is never cancelled by this. A parcel in transit / problem keeps
  counting until MEX says paid / returned (owner: "ДА ТАКА НЕКА БИДИ"); returns stay returns (the monthly bonus
  return-% cut). A MEX-only parcel counts on its collabBox document's booking day. **Komitent phones:** the
  collabBox card lookup (read-only search, the operators' "Барај") was fixed and only the MISSING phones were loaded
  from the 01.10 register (`collabbox_customers.source = 'register_20261001'`, 12.473; owner: "само тоа што
  недостасува", never the whole register). **A revived dead order counts on the reviving document's BOOKING day**
  (`20260947001800`–`1810`, `sale_day_revive_*`, cron every 15 min, whole 2026; undo `sale_day_revive_undo(run[,
  actor, basis])`). **A late document / parcel is a NEW order (owner 03.10 "ДА"):** lead still open → Lead in;
  cancelled / trashed ≤ 10 days before → that order's own sale (revived, booking day); otherwise (> 10 days, or the
  old order already sold) → a NEW order on the booking day, the seller's team decides (Маџари people → Тим Маџари
  Out), the old order untouched.
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
  carry the product BY NAME. **Rule 2b (`20260944000980`):** before the uniqueness check, a candidate cancelled /
  trashed AS A DUPLICATE (`duplicate_order`, the bridge's "duplicate — …" trash note, the mirror's trashed reason 7 —
  never free text) and an AlterCPA lead created after the parcel's collabBox booking (`collabbox_sale_at`; a date-only
  import by Skopje day) are dropped. One definition: `link_lead_parcels_plan()`; cron `link-lead-parcels` 21:02 Skopje
  (switch `app_settings.link_lead_parcels`, now `apply`); backfill `scripts/repair-link-lead-parcels.mjs`;
  every run undone by `scripts/rollback-repair.mjs --run <id>`; proof `node scripts/verify-parcel-link-rules.mjs`.
  Old September `credit_pending` LEADS documents: `scripts/collabbox-recredit.mjs`. See `docs/ALTERCPA-BRIDGE.md`.
- **A LEADS document becomes an order when MEX delivered or returned its parcel (owner, 01.10.2026 —
  `20260944000970`):** *"If there is delivery from MEX too or return, then of course we will import them, that way
  we know that MEX really tried to deliver that order."* A 9110 parcel at MEX 2 / 7 that no order holds + its 10111
  document (`credit_pending`) → ONE order in the writer's branch-E shape (`external_order_id` = the DocNumber →
  Affiliate – Lead in, the parcel's own MEX-only department), seller credited by the LIVE writer re-applying the
  document. Never a twin: the phone + date linker has no row for it, no living Affiliate sale on the phone
  (−30 d … +1 d), the writer's twin rule does not fit. In transit = not yet. One definition
  `leads_parcel_orders_plan()`; cron `leads-parcel-orders` 21:06 Skopje (switch `app_settings.leads_parcel_orders`,
  now `apply`); backfill `scripts/repair-leads-parcel-orders.mjs`; undo its own `--rollback <run>`.
- **The collabBox folder decides — ALL cases (owner, 01.10.2026: "Yes, the collabBox folder decides"):** an
  AlterCPA order holding a NATURA 9102 / 9100 / 9108 / 1300 parcel loses it to its collabBox document, which
  becomes its own Телешоп / Социјални order credited to the author; the AlterCPA order goes back to its
  pre-parcel cancel / trash, or — never cancelled — is cancelled by the system (reason `other` + note, never a
  person's cancel). `scripts/repair-folder-decides.mjs` (one sub-transaction per parcel, the live writer must
  answer `created`); undo its own `--rollback <run>`. Proof for both: `node scripts/verify-folder-orders.mjs`.
  Inside Affiliate In / Out the first decider / confirmer keeps the leaderboard credit (unchanged).
- **A CRM sale: its collabBox BOOKING decides before the parcel (owner, 02.10.2026; `20260947000300`) + the 5-DAY
  collabBox entry rule for EVERY sale (owner, 03.10.2026 "ГО"; `20260947001900` / `1905` / `1910`, LIVE in `apply`).**
  For a seller in Менаџмент / no line team (the team decides everyone else — above): a confirmed CRM sale with no parcel
  takes its OWN booking's department at once (`crm_sale_booking_dept`, the cohort's booking department; trigger + cron
  `crm-sale-booking-dept` every 15 min); no booking yet = provisional Affiliate – Lead out. Owner: "ако порачката ја нема
  во collab 5 дена, тогаш одиме cancel со причина, нема внесено порачка во Collab … се додека не почнат од кај нас да
  испраќаат со пошта." ANY sale made outside collabBox (confirmed / shipped, no MEX parcel, priced — CRM of every
  department, AlterCPA approvals, partners; never collabBox-made, web, dispositions, test phones, paid) with no evidence
  of a collabBox entry (`sale_collab_evidence`: a MEX push success · `crm_sale_collab_doc` · the phoneless booking of the
  same value + name word · an unlinked parcel on the phone · a postponed-delivery note) `days` (5) Skopje days after its
  sale day is cancelled at 21:20 — reason `other`, note **"Нема внесено порачка во Collab"**, code `not_in_collab_5d` in
  the ledger, a SYSTEM cancel, `keep_updated_at` — and the SELLER gets the bell `not_in_collab` (the evening before
  `not_in_collab_warning`; a sale > 14 days old is cancelled silently). `apply_collab_entry_rule`, ledger
  `collab_entry_rule_runs/_items`, undo `collab_entry_rule_undo(run)`, switch `app_settings.collab_entry_rule` (owner
  key). It fades out by itself once "Испрати до MEX" ships (a push success is evidence). The 10-day AlterCPA no-parcel
  rule (21:10) is unchanged. A CRM sale cancelled by it is not revived to shipped by mex-reconcile (rule C is AlterCPA /
  `no_parcel_7d` only). Check: `node scripts/verify-collab-entry-rule.mjs --list [--backtest FROM TO]`. See
  `elyon-departments-and-sources` §3c.
- **Денари everywhere (owner, 28.09):** every staff-facing amount — screens, charts, exports,
  notifications — is shown in денари. The only EUR on screen is the foreign affiliate payout above.
- **COD ≠ CRM price → MEX is right** (owner): the CRM price follows the parcel COD, except when COD =
  price × 61.5 + 150 (the delivery fee) or COD is 0.
- **The parcels ANOTHER COURIER carried are judged by collabBox's own courier flag (owner, 03.10.2026 night;
  `scripts/repair-courier-outcomes.mjs`, run `8acbad3e-7ac7-4c93-9666-8c11d2c3a7fe`).** MEX did not carry everything:
  **Колпортер Пост** (Sigma `001308`) took the teleshop parcels on 101 days of 22.01–27.11.2024, **Еко Логистик**
  (`000404`) the LEADS parcels 09.10.2025–22.01.2026, **Јон Експрес** (`000360`) 12 days of May–June 2026 — on such a day
  a whole folder went to that courier, so those orders hold no MEX parcel. collabBox keeps the outcome per document
  (attributes "Delivered" / "Return to sender", read-only through the search form's attribute columns —
  `scripts/collabbox-delivery-attrs.mjs`; equal to MEX's final status on 98,4 % of 38.412 MEX-carried documents).
  Applied to orders with NO MEX parcel: 25.344 paid are proven (`paid_basis = 'operator_ruling'` = "the collabBox
  courier flag", the order's note names the document), 4.249 paid → returned, 5.694 cancelled / trashed AlterCPA
  history leads → paid (shipped and collected — the self-cancel-then-ship pattern), 1.772 → returned; 936 left for
  review (no flag, twins, duplicates, MEX has something). **MEX still beats everything — never judge an order that
  holds a MEX parcel, or a MEX day, by the collabBox flag.** Prices were not changed (the document amount is in the
  run's CSV). Input: `scripts/history/courier_outcomes_build.py` (private sources). Undo:
  `node scripts/rollback-repair.mjs --run 8acbad3e-7ac7-4c93-9666-8c11d2c3a7fe --apply`.
- **History: paid in the CRM, "Return to sender" at MEX → returned (owner "ДА", 03.10.2026 23:20;
  `scripts/repair-mex-history-returns.mjs`, run `7d891eeb-8f19-4832-a169-e40410831774`).** The history audit compared
  every order with the whole MEX register (453.204 parcels since 18.03.2020; the CRM's own `mex_parcels` only starts
  10.11.2025). 21.597 paid orders — mostly the teleshop history import, written as paid by default — became returned
  (650.513 €; 20.139 by the order's own document number = the MEX tracking id, 1.430 by phone + date, 28 that held the
  parcel). Left for review: 282 with a re-send MEX delivered afterwards that no order owns, 192 whose parcel the live
  register knows unlinked (link them, never flip — the return would count twice), 3 held by another order. The parcel
  is named in the order's note and the ledger; it is NOT linked (the register has no row for it). Undo:
  `node scripts/rollback-repair.mjs --run 7d891eeb-8f19-4832-a169-e40410831774 --apply`.
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
  the cohort, Операции and the orders the sync makes (sold / confirmed / created). The booking day applies to the
  whole ledger (`collabbox_booking_day_since()` = 01.03.2026 since `20260944000610` / `0620`, the owner's 01.10
  evening ruling "тоа што е направено вчера си останува во вчерашниот ден"). The frequent pass
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
  **Предлог** (`sales_team_line_proposal` → `sales_team_lines_apply`; 82 re-keyed, 17 wait for him). Since 02.10 the
  seller's LINE team DECIDES the department (a lead excepted — `order_dept_by_team`, above); Менаџмент never does.
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
  MEX · За пакување · Залихи · Пратки · Движења · Попис (the last four = Stock v2, 01–02.10); no printing** (the MEX
  portal prints). **"Испрати до MEX" (the CRM's
  own `add_shipment.php` push, `mexPush.ts`, ledger `mex_push_attempts`) is built and SWITCHED OFF** —
  `app_settings.mex_push.enabled = false`; the 11:00 auto-send is built, not scheduled. Never switch either on
  without the owner. See `elyon-warehouse-incoming`, `elyon-fulfilment-csv`.
- **Stock v2 — exact stock per Sigma ARTICLE × warehouse × moment (owner, 01.10.2026; `20260945000100`–`0900`,
  `docs/STOCK-V2.md`) — built, IN PREVIEW.** One append-only ledger `stock_moves` (event time; a change is a
  correction row, never an edit). The opening = the **22.09 MORNING count** (the owner thinks Sigma 04; Sigma holds
  no count document — his count sheet is awaited). **Every MEX parcel created from 22.09 00:00 Skopje is deducted at
  its MEX label** (`created_at_mex`); a **MEX 7 return goes back on the shelf** (also for a parcel created before the
  count); gifts are deducted; test phones move nothing. A parcel's contents, first source wins: an override → its
  **collabBox document goods lines** (Sigma codes) → the web order → the CRM orders through **APPROVED recipes**
  (`product_articles`). Sigma documents feed everything that is not a parcel — **never** the MEX invoices
  (`000217`), АД Астра (`000549`), the 04↔08 transfers or a document dated before the opening. **A count is a rule**
  (at its moment the balance IS the counted figure; back-datable; only the counted articles move).
  **`app_settings.stock_v2.enabled = false` (preview) until the owner hands over the count sheet and approves the
  opening** — `stock_v2_set` refuses ON without an approved opening; /warehouse shows the computed figures under the
  banner "Преглед — пресметано од пратките, ништо не е запишано"; the preview workbook is in `exports/stock/preview`
  (gitignored). Mapping loaded 02.10: 1.507 articles, 122 kits, recipes for 316 products (154 high = approved, 162
  proposed for the owner's review), 155 aliases (78 approved). **The v1 regime and the status-driven deduction are
  RETIRED** (`…0700`: `stock-mex-apply` unscheduled, `restock` / `stock/count` / `stock/mex-movements` → 410) — never
  bring them back; `products.stock_quantity` is a guarded mirror of the ledger (cron `stock-v2-mirror`).
  `mex_parcels.picked_up_at` (`…0900`, write-once) splits за пакување / кај курирот. Switch-on procedure and
  never-rules: `elyon-stock-v2`.
- **Sigma (Natura's ERP) has NO live link yet (02.10.2026).** The data is a CSV dump
  (`D:\naturatherapy\_salesforce-plan\05-sigma-export\raw-export\`, 17–30.09) → `docs/stock/build_sigma_stock.py`
  (articles, costs, openings, kits, recipes, the Sigma batch) → `stock_sigma_ingest` staging (versions kept, nothing
  deleted; `stock_v2.sigma.ingest = false`). The office connector `tools/sigma-connector` (read-only, a SELECT-only
  SQL login, HMAC to `POST /api/stock/sigma/ingest`) is built, NOT installed: it needs an always-on office PC, the
  login from Sigma-СБ and the secret `SIGMA_CONNECTOR_SECRET` (not set yet). **Sigma 04 / 08 balances are NEVER the
  stock truth for COD parcels:** Sigma books MEX COD monthly as a hand-typed lump to `000217` (+17 % against delivered,
  Apr–Aug; weeks late; September not at all) and never books gifts or returns
  (`scripts/stock/sigma-month-check.mjs`). Warehouse 08 and the courier-invoice vs COD gap are under investigation in
  an INTERNAL report (`exports/magacin/`, gitignored) — never published, its numbers and names never in the repo.
- **Shops (Продавници) — the collabBox shops reader (owner, 02.10.2026; `20260946000100`–`0400`, `docs/SHOPS.md`).**
  The 22 shops of НАТУРА ТЕРАПИ СТОРЕС ДООЕЛ run their tills on collabBox. Edge function `collabbox-shops` is LIVE
  (`app_settings.shops_reader.enabled = true`, an owner key): receipts 10022 + returns 10010 every 15 min 07–23, the
  goods / transfer / count documents hourly, at 23:30 the infollc stock snapshot per shop + the 10018 / trade-book
  controls; history from 01.01.2026 in the night backfill (00:30–05:30). **/shops: owners everything, managers the
  same WITHOUT money (every `*_mkd` absent), everyone else 403.** Never add 10018 to 10022 or 10016 to 10042; ПОЕН
  lines and trade-book corrections (ПОЕН-350 at a huge negative price after a count) are never goods; a 10005 count
  difference **plus = shortage**; top sellers = shelf goods only (`…0400`). Natura's own margin on goods to the shops
  ≈ 30 % (Sigma list 07); the TV re-invoicing to Stores (≈ 1,6 М ден a month) is shown apart. Group cost = Stock v2's
  Sigma cost, NULL until every unit is costed. See `elyon-shops`.
- **Targeted call scripts (owner, 02.10.2026; `20260947000100`, `docs/CALL-SCRIPTS.md`) — built, NOT live.** One script
  per LIST GROUP (lead_new / lead_callback by the lead's status; newcomers · d21 · d57 · m4_6 · m6_12 · y1_2 · y2plus ·
  cancels · never_converted · trash by the list NAME — `groupOfListName` only reads it, never renames a list; Current
  Returns / Due to Reorder / uploaded lists = no group), optionally per product; sections Отворање · Презентација ·
  Приговори · Затворање + quick answers, **mk + sq only**. The matcher (`callScriptMatch.ts`, shared with the UI): tier
  group&product → group → product → general, primary product first, then priority, then newest. Writes ONLY through the
  audited SQL writers (`call_script_save` / `_duplicate` / `_bulk` / `_restore` / `_delete`; admins + managers write
  and publish, **only admins delete**; every change a restorable version in `call_script_versions`); agents read
  published rows only (RLS). **`app_settings.call_scripts.mode = 'off'`** (owner key, admins switch: off | preview | on) —
  off = /calls shows today's panel. Never write `call_scripts` with the service role from a script (the BG import and
  translate scripts are retired). Check: `node scripts/verify-call-scripts.mjs`. See `elyon-call-scripts`.
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
- **Deferred by the owner — do not touch:** payouts / bonus / commission math; lead cost (he sets it
  later). **No longer deferred (owner, 01.10.2026):** the stock count and the purchase costs — they are Stock v2
  and the Sigma costs above (the 29.09 "don't focus on stock now" is superseded). Sellable products keep the
  placeholder 1.000 only until Stock v2 is switched on and the mirror writes the ledger's stock.
- Search the code for `TODO(mk)` to find every unfinished real-value spot.

## Grok Skills System

**This project has a first-class skills system** located in `.grok/skills/`. Check `/skills`
before non-trivial work on money, phones, warehouse, stock, shops, Sigma, webhooks, or fulfilment.
**But apply the Macedonian per-market overrides above** — several skills still teach BG rules
(lev peg, +359, Sofia). When a skill conflicts with the overrides, the overrides win; fix the skill.

- `elyon-currency` — ⚠️ inherited BG/Macedonia rules. The currency override above wins.
- `elyon-phone-normalization` — Last-8-digits search + E.164 storage + pollution protection.
- `elyon-fulfilment-csv` — How an order becomes a MEX parcel: the portal-import CSV contract (rewritten 2026-08-18) and its twin, the "Испрати до MEX" `add_shipment.php` push (01.10 — claim, existence check, one-success ledger, double-parcel guard, account from the product line; switched OFF).
- `elyon-warehouse-incoming` — /warehouse since 01–02.10: Испрати до MEX · За пакување · Залихи · Пратки · Движења · Попис (the last four on Stock v2, the preview banner, who sees / counts / switches), the queue, MEX 8 = за пакување (and the not-applied ~260-order repair), no printing, the old routes' guards.
- `elyon-webhook-and-lead-ingestion` — Inbound pipeline, HMAC, per-product slugs.
- `elyon-stock-v2` — **THE LAW for stock (01.10.2026):** one append-only ledger per Sigma article × warehouse × moment, the 22.09 opening, parcels deducted at the MEX label, MEX 7 returns back, the resolver priority (override → collabBox goods lines → web → CRM via approved recipes), Sigma for everything else (never 000217 / 000549 / 04↔08), a count is a rule, preview mode and the owner-only switch-on procedure, the scripts and `verify-stock-v2`.
- `elyon-stock-and-bigarena` — HISTORY: the retired v1 regimes (status-driven deduction, the 20260942000100 count + MEX ledger) and the Bulgarian BigArena import rules. Stock today = `elyon-stock-v2`.
- `elyon-shops` — The 22 shops (НАТУРА ТЕРАПИ СТОРЕС ДООЕЛ) via the `collabbox-shops` reader: its own allow-list and request budget, the schedule and `shops_reader` switch, the document types that are never added up (10018 + 10022, 10016 + 10042), ПОЕН and trade-book corrections, 10005 plus = shortage, /shops money access (owners all, managers no money), `verify-shops`.
- `elyon-agent-commissions` — Per-package agent bonuses on every PAID order (only gate is paid; source irrelevant), tiered 1/2/3€ by unit price, no minimum, credited to the confirmer. Read before touching any payout/commission math.
- `elyon-notifications` — The bell, the 6 notification types, the English-in-DB + `meta.i18n` translation contract, owner = confirmer, and the unpaid-delivery chase job.
- `elyon-segments-and-prediction` — The name-construction engine (**v3.7-mk, sticky trash**), the exclusivity rule, holding pens (Current Cancels 14d, NEWCOMERS 21d, Trash List), carry-over, the nightly recompute, and the /calls outcome bar (`POST /calls/outcome` — the outcome IS the call log; the disposition's last product). Law for anything touching prediction lists.
- `elyon-assigner` — Distribution + the Unassign tab, agent workload truth, the live board with team + lane badges, the agent's call-agains on /calls (`/call-again` redirects), and the stopped lead-distribution engine.
- `elyon-voip-and-pbx` — The A1 trunk, Asterisk/FreePBX, the WebRTC softphone and recordings. BG-specific; MK telephony is deferred.
- `elyon-i18n` — MK/SQ/EN (Bulgarian removed 02.10.2026): every user-visible string goes through i18n in all three locales, no exceptions; the owner's terminology (предикција, лидови, "На чекање" only for pending).
- `elyon-security` — RLS, HMAC, permissions, audit and secrets; Settings writes only through audited api routes (01.10), the guard-trigger writer pattern. Never write an `authenticated`-wide read policy.
- `elyon-affiliates` — The CPA/partner system and the hard wall that keeps external logins out of staff surfaces.
- `elyon-altercpa-bridge` — The AlterCPA lead mirror: ledger-first, callable geos, offer mapping, and why foreign leads must never reach `orders`. Read before touching `altercpa_*` or multi-country intake.
- `elyon-logistics-costs` — Courier rate card, return round-trip loss, Pure Profit actuals, VAT per product from Sigma (taxed per line; `docs/VAT.md`), and the purchase costs from Sigma in denari (live since 02.10: `cost_source = 'sigma'`, approved recipes, `product_cost_history`).
- `elyon-presence-and-leaderboard` — Shifts as the login gate (runway, roll-forward, the Смени page), presence minutes + the 30-min idle alert, sales people / identities / teams = business lines + lanes (Settings → Teams → Предлог), the write-once `orders.sold_*` stamps (who is credited with a sale, the stamping cron), the TV leaderboard v2 (`leaderboard_day_v2`, one row per agent split by department, `?team=team:lane`).
- `elyon-web-shop-bridge` — The read-only naturatherapy.mk mirror (`web_orders`, web-sync every 15 min, `crm_export` on the shop side). Web orders are NOT CRM orders; the live shop gets no changes.
- `elyon-customer360-and-integrations` — Customer 360 (`customer_timeline`, last-8 matching, money stripped for non-owners) and Settings → Integrations health (freshness thresholds kept in step with the Overview, the 7-day rule's owner switch).
- `elyon-departments-and-sources` — The six departments (collabBox folder + MEX profile), `cohort_order_source`, the parcel split, `sale_source_reclass` and its rollbacks; since 02.10 the SELLER'S LINE TEAM decides first (a lead is always Affiliate – Lead in, Менаџмент never decides — `order_dept_by_team`), the product line only picks the account of a CRM push. Law for anything that says where a sale belongs.
- `elyon-collabbox-sync` — The live collabBox reader of the teleshop documents: folders/types and roles, the document ledger, orders only once the MEX parcel exists, seller credit, the 15-minute + nightly crons, one run at a time. (The shops' tills are a separate reader — `elyon-shops`.)
- `elyon-call-scripts` — Targeted call scripts (02.10): one script per list group (+ products), the matcher shared with the UI, the variables (segments, never HTML), the audited writers + versions (admins delete), RLS published-only for agents, the `call_scripts.mode` switch (off), GET /calls/scripts, coverage, `verify-call-scripts`.
- `elyon-products-catalogue` — Product kinds (product / bundle / gift / other) and brand lines (Natura Therapy / Bio Natural / Ad Astra / Dr.Becker → the MEX profile), the web-catalogue rule, the audited writers behind guard triggers, the machine-text cleanup, /products (the Рецепт drawer and "Набавна (Сигма)" for owners — only an approved recipe moves stock and cost), and the catalogue scripts.

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
