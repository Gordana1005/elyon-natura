---
name: elyon-departments-and-sources
description: The six sales DEPARTMENTS (owner law 28–29.09.2026, whole history) — Affiliate – Lead in, Affiliate – Lead out, Телешоп – Lead out, Телешоп – Lead in, Социјални мрежи, Веб-продавница — and how every order, MEX-only parcel and collabBox document is placed in exactly one. Covers orders.sale_source / sale_source_detail (the stored vocabulary), classify_sale_source + tg_orders_sale_source_fill at insert, the write-once lock, cohort_order_source(sale_source, detail, mex_tracking_id) with the NATURA exception for CRM-made sales, the MEX PROFILE rule for CRM-made sales (BIO NATURAL = affiliate, NATURA = teleshop / social / web: orders.dept_override, order_dept_override(…, mex_account, mex_tracking_id), the 4-argument cohort_order_source every report calls — 20260942001860; the agent-team rule of 20260942001800 was withdrawn the same morning), cohort_parcel_split / cohort_parcel_source, collabbox_department(type, DocNumber, person, at) and collabbox_doc_role, orders.collabbox_doc_type, sale_source_reclass and the two reclass scripts with --rollback, the TS twin in insightsCommon.ts, the mex-reconcile folder guard (mayReviveWith — a dead order is revived only by its own folder's parcel) and the cross-channel repair a057bc52, where the department is shown (order_departments(ids) on the Orders list, order_origin(id) in the order window), and how to add a new collabBox document type. Also: since 30.09 a TEAM is a business line (Телешоп / Affiliate + lanes) and still NEVER decides a department (verify-teams T3); since 01.10 the PRODUCT LINE picks the MEX account when the CRM itself pushes a parcel ("Испрати до MEX", switched off) — the department then follows that parcel's profile like any other. Read before touching sale_source, any "source"/"channel"/"department" figure in Insights, GET /orders?cohort_source=, the collabBox folder map, the MEX phone+COD match, or anything that decides where a sale is counted.
---

# Departments (sale sources) — six, by FOLDER

**Owner law, 28.09.2026 ~23:55 and 29.09, for the whole history:**
"We never mix our CRM with affiliate lead out — it doesn't matter in which system an order was
made, we look by departments … affiliate lead in / affiliate lead out / teleshop lead in /
teleshop lead out / social / web."

A department is decided by the **collabBox FOLDER (the document TYPE)** and the **MEX profile /
series** of the parcel. It is **never** decided by the system an order was made in, **never** by
the seller, and **never** by the seller's team. Everything below implements that sentence.

**The MEX profile is the tie-breaker (owner, 29.09 ~12:05, whole history):** "every order sent via
BIO NATURAL comes from affiliate IN and OUT; no teleshop order has ever been sent via BIO NATURAL —
teleshop sends via NATURA"; "web e-commerce is entirely via NATURA". So a sale made in our CRM
follows its parcel's profile (§3b), and a MEX-only BIO NATURAL parcel is always affiliate. A team
rule tried the same morning (`20260942001800`: the `crm_prediction` team's sales → Телешоп – Lead
out) was **withdrawn** two hours later, once the owner saw those agents' CRM sales ship 98% via
BIO NATURAL 9103.

Migrations, in order: `20260942000500` (five sources, social its own) → `20260942000700`
(departments by series + an AlterCPA-team override — the override is **withdrawn**) →
`20260942000900` (`collabbox_department()` by TYPE, `orders.collabbox_doc_type`) →
`20260942001000` (**six** departments, `cohort_order_source` 3-arg, 9102 / 9103 split apart,
Pure Profit cache version 3 → 4) → `20260942001100` (the AlterCPA-team override withdrawn from
`tg_orders_stamp_sold`; the stamp never touches `sale_source`) → `20260942001500`
(`order_departments`), `20260942001600` (`order_origin`) and `20260942001700` (Customer 360),
display only → `20260942001800` (an agent-team rule: `orders.dept_override`, the 4-argument
`cohort_order_source`, 15 report functions re-emitted from their live bodies — the rule itself
**withdrawn** by `…1850`, the machinery kept) → **`20260942001860`** (the MEX profile decides a
CRM-made sale; `cohort_parcel_split` tests BIO NATURAL first — §3b). On 29.09 the MEX reconcile
learned the folder law too (`mayReviveWith`, below). CLAUDE.md carries the law in short.

## The six, in display order

| # | key (cohort source) | UI label (mk) | What it is | Stored as (`sale_source/sale_source_detail`) | MEX profile · series |
|---|---|---|---|---|---|
| 1 | `altercpa` | **Affiliate – Lead in** | New affiliate leads: AlterCPA leads that were pending and then decided (bridge + history), and collabBox 10111 "Нарачка LEADS" | `altercpa/bridge` · `altercpa/history` · `altercpa/collabbox_leads` · `affiliate/partner` | BIO NATURAL, 9110 |
| 2 | `elyon_crm` | **Affiliate – Lead out** | Re-sale to affiliate customers: every sale made in our CRM that ships on BIO NATURAL (or has no parcel yet), and collabBox 10114 "LEADS-OUT" | `elyon_crm/prediction_list` · `elyon_crm/direct` · `elyon_crm/collabbox_leads_out` (+ `elyon_crm/disposition` rows, which are never sales) | BIO NATURAL, 9103 (any BIO NATURAL series for a CRM sale) |
| 3 | `teleshop_out` | **Телешоп – Lead out** | collabBox 10050 "Нарачка out" — teleshop's own repeat customers, including teleshop-out calls to customers who first came from affiliate (the folder decides); plus a CRM-made sale shipped on NATURA outside 9100 / 9108 / 1300 (§3b) | `collabbox/teleshop_out` (legacy stored values `elyon_crm/collabbox_out`, `altercpa/team_collabbox_out` map here too) | NATURA, 9102 |
| 4 | `teleshop_other` | **Телешоп – Lead in** | collabBox 10036 "Нарачка in" — the TV lead-in; plus everything the rule cannot place | `collabbox/teleshop`, and any `legacy/*`, `collabbox/leads`, `collabbox/leads_out`, a bare series, NULL | NATURA, 9100 |
| 5 | `social` | **Социјални мрежи** | collabBox 10106 "Нарачка Социјални Мрежи" and 10055 "Нарачка С. Мрежи-Продавница" | `collabbox/social` · `collabbox/1300` | NATURA, 9108 / 1300 |
| 6 | `web` | **Веб-продавница** | The naturatherapy.mk shop — the `web_orders` mirror, **not** orders | `web_orders` rows; `orders.sale_source = 'web'` only for a CRM-entered web order (0 rows) | NATURA, `NTMK…` / `M…` |

Keys never change; labels live in the app (`insights.common.source.*` and `overview.source.*` in
all four locales — the Lead-in label's i18n key is `teleshopOther`). The key `elyon_crm` now means
"Affiliate – Lead out", and `teleshop_other` means "Телешоп – Lead in" — do not rename keys to
match labels.

To see how `orders` splits today: `select sale_source, sale_source_detail, count(*) from orders
group by 1, 2 order by 3 desc;` (read-only). After the 28.09 reclasses there should be no `team_*`
row left (the details stay mapped only for safety); `verify-attribution` C12 fails on any NULL
`sale_source`.

September 01–27 by department (orders only, cohort): Affiliate – Lead in 2.132 / 6.348.156 ден ·
Телешоп – Lead out 2.162 / 4.959.661 · Телешоп – Lead in 1.382 / 2.854.065 · Affiliate – Lead out
736 / 2.072.845 · Social 152 / 284.460.

The whole cohort 01–28.09 (sale day; orders + MEX-only parcels + web; measured 29.09 04:55, after
the MEX 60-day sweep): Affiliate – Lead in 2.391 / 7.153.500 ден · Affiliate – Lead out 834 /
2.367.046 · Телешоп – Lead out 2.172 / 4.987.661 · Телешоп – Lead in 1.387 / 2.864.465 ·
Социјални мрежи 225 / 424.560 · Веб-продавница 447 / 940.504 · **total 7.456 / 18.737.736 ден**
(before the cross-channel repair below, which moved ~10 parcels). Use these as a sanity reference
for "did a change move money between departments?" — not as fixed numbers (late MEX facts and
backfills move them).

After the MEX-profile rule (`20260942001860`, 29.09 ~12:00), September reads **Affiliate – Lead
out 842 / 2.393.446 ден** and **Телешоп – Lead out 2.292 / 5.246.701 ден**, total **7.696 /
19.297.997 ден** — the same total as under the withdrawn team rule of `…1800` (which had moved 712
sales / 1.996.989 ден of 01–28.09 the other way for two hours); backfills had grown the total
since 04:55. Neither rule moves the total, only the split.

## The evidence behind the folder map (28.09 night)

- **10114 LEADS-OUT is affiliate out:** 97% of its customers had an AlterCPA lead first, 77% buy
  BIONATURAL products, 97% ship on the BIO NATURAL profile since 02.04.2026.
- **10050 Нарачка out is teleshop out:** 94% of its customers have teleshop history, 7,7% buy
  BIONATURAL products, 18.861 of 18.862 ship on NATURA.
- **CRM-made sales are affiliate out:** 580 of 606 September CRM parcels are BIO NATURAL 9103;
  98,5% of those customers had an AlterCPA lead first.
- **The series lies, the type does not:** ~1.100 documents carry a series against their type —
  703 LEADS-OUT numbered 9102, 286 "Нарачка out" numbered 9100, 99 "Нарачка in" numbered 9102.
- The BIO NATURAL MEX profile exists only since **02.04.2026**; older history can only be
  classified by TYPE.

## How an ORDER gets its department

### 1. At INSERT — `tg_orders_sale_source_fill()` (BEFORE INSERT on `orders`)

1. An explicit `sale_source` in the INSERT stands.
2. A duplicate (`duplicated_from`) inherits its original's source and detail; a copy of an
   `elyon_crm` order re-derives its detail from its OWN price/product
   (`elyon_crm_sale_detail`, 20260942000400).
3. Otherwise `classify_sale_source(source_type, external_source, external_order_id,
   prediction_list_id, price, product_name)` (20260935000000) — by intake path:
   `monadon_legacy` → `legacy/monadon_legacy` · `source_type altercpa` → `altercpa/bridge` ·
   `external_source altercpa` → `altercpa/history` · `affiliate` → `affiliate/partner` ·
   `opencart`/`opencart_abandoned`/`inbound_lead`/`naturatherapy%` → `web/<…>` ·
   `external_source collabbox` → `collabbox/<series word>` · `manual`/`prediction_lead` →
   `elyon_crm/<elyon_crm_sale_detail>` · else `legacy/<source_type>`.
   `elyon_crm_sale_detail(list, price, product)`: price ≤ 0 or a synthetic product →
   `disposition`; a prediction list → `prediction_list`; else `direct`.
4. For `collabbox` rows: `collabbox_department(orders.collabbox_doc_type, external_order_id,
   sold_by_person_id, coalesce(sold_at, created_at))` overrides — **by TYPE** when the writer
   knows it, else by the DocNumber series (below).

### 2. Write-once — `tg_orders_sale_source_lock()`

`sale_source` and `sale_source_detail` are write-once (NULL → value allowed; changing a set value
raises `check_violation`). The one deliberate door is transaction-local
`SET LOCAL elyon.allow_source_change = 'on'` — used only by the reclass scripts and migrations,
and every such move is logged in `sale_source_reclass` (below).

The **only** automatic change after insert: an `elyon_crm/disposition` row that becomes a real sale
(sale status, price > 0, a real product) is upgraded to `prediction_list` / `direct`
(`tg_orders_sale_detail_upgrade`, 20260942000400) — never back, never another source.
`tg_orders_stamp_sold` (the seller stamp) never touches `sale_source` since 20260942001100. The
MEX-profile rule of 29.09 does not touch it either: it lives in its own column (§3b).

### 3. The mapping — `cohort_order_source(sale_source, sale_source_detail, mex_tracking_id)`

Pure, `IMMUTABLE`, inlinable (20260942001000). Every report calls the **4-argument** form, which
puts `orders.dept_override` in front of this mapping (§3b). First match wins:

| Rule | → department |
|---|---|
| CRM-made sale (`elyon_crm` + `prediction_list`/`direct`, or legacy `altercpa` / `affiliate` + `team_prediction`) whose OWN `mex_tracking_id` is `___-9102-%` | `teleshop_out` |
| … on `___-9100-%` | `teleshop_other` |
| … on `___-9108-%` or `___-1300-%` | `social` |
| `collabbox/teleshop_out`, `elyon_crm/collabbox_out`, `altercpa` / `affiliate` + `team_collabbox_out` | `teleshop_out` |
| `altercpa` / `affiliate` + `team_prediction` / `team_collabbox_leads_out` (withdrawn team rule) | `elyon_crm` |
| any other `altercpa` / `affiliate` | `altercpa` |
| any other `elyon_crm` (incl. `collabbox_leads_out`, `disposition`) | `elyon_crm` |
| `web` | `web` |
| `collabbox` + `social` / `1300` | `social` |
| everything else (`collabbox/teleshop`, `collabbox/leads`, `collabbox/leads_out`, `legacy/*`, NULL) | `teleshop_other` |

**The NATURA exception for CRM sales.** A sale made in our CRM belongs to Affiliate – Lead out —
unless its parcel was booked in a NATURA teleshop / social folder (series 9102 / 9100 / 9108 /
1300): then it is that department's sale. The series is the tracking id's second segment
(`NNN-SSSS-…`), written as `LIKE '___-9102-%'` so the PostgREST twin
(`mex_tracking_id.like.___-9102-*`) is exact. 9103, 9110, `NTMK…` or no parcel: stays
Affiliate – Lead out. The exception applies ONLY to CRM-made sales; a `collabbox_leads_out`,
`disposition`, AlterCPA or collabBox row never moves by its parcel. **The order's OWN
`mex_tracking_id` decides, everywhere** (sale rows, leads, cash, parcels, pivot, profit, returns,
stock). Since `20260942001860` the parcel's PROFILE sits on top of this for a CRM-made sale
(§3b): here the series is only the fallback while the order has no `mex_account` yet.

The 2-argument `cohort_order_source(text, text)` delegates with a NULL parcel and exists only for
outside callers; step 17 of 20260942001000 proves no function body calls it. Never use it in a
report — it files a CRM sale on a NATURA parcel under Affiliate – Lead out without an error. The
same goes for the 3-argument form since 29.09: a report that calls it loses the MEX-profile rule
(e.g. a CRM sale on a BIO NATURAL 9102 number lands in Телешоп – Lead out by its series), silently.

### 3b. A CRM-made sale follows its MEX PROFILE — `orders.dept_override` (20260942001860)

Owner, 29.09.2026 ~12:05–12:10, after seeing the `crm_prediction` agents' CRM sales ship 98% via
BIO NATURAL 9103: "Every order sent to MEX via BIO NATURAL comes from affiliate IN and OUT; no
teleshop order has ever been sent via BIO NATURAL — teleshop sends via NATURA. Agents placed in
teleshop who send via BIO NATURAL are not teleshop, they are affiliate out or in"; "web e-commerce
is entirely via NATURA". Earlier the same morning: "if an affiliate agent makes an order in our CRM
first, it counts in Affiliate out, and we look at MEX — BIO NATURAL or NATURA — and decide by that".

- **The rule, in one place:** `order_dept_override(sale_source, detail, person, at, mex_account,
  mex_tracking_id)` (6 arguments, `IMMUTABLE`) — only for a CRM-made sale (`elyon_crm` +
  `prediction_list` / `direct`):

  | The order's parcel | → `dept_override` |
  |---|---|
  | `mex_account = 'bio_natural'` | `elyon_crm` (Affiliate – Lead out), **whatever the series** |
  | `natura`, tracking `___-9100-%` | `teleshop_other` (Телешоп – Lead in) |
  | `natura`, `___-9108-%` / `___-1300-%` | `social` |
  | `natura`, anything else (9102, 9103 …) | `teleshop_out` (Телешоп – Lead out) |
  | no MEX profile yet, but **its own collabBox booking** (02.10, `20260947000300`) | the booking's department — `crm_sale_booking_dept(order)` = `cohort_order_source(collabbox_department(type, doc, author, at))`, the cohort's own booking department: 10050 → Телешоп – Lead out · 10036 → Телешоп – Lead in · 10106/10055 → social · 10114 → Affiliate – Lead out · 10111 → Affiliate – Lead in |
  | no MEX profile and no booking yet | NULL → the mapping of §3 (Affiliate – Lead out) — **provisional**; /orders marks it, and the 2-day collabBox rule (§3c) cancels it if it is never booked |

  Every other order is NULL: the collabBox folder decides, so a LEADS-OUT (10114) stays Affiliate –
  Lead out and a 10050 stays Телешоп – Lead out whoever booked it. `person` and `at` are unused.
- **Stored** in `orders.dept_override` (CHECK: one of the six keys or NULL). Never write it by
  hand: `zzz_orders_dept_override` (BEFORE INSERT OR UPDATE OF `sale_source`,
  `sale_source_detail`, `sold_by_person_id`, `sold_at`, `mex_account`, `mex_tracking_id`) keeps it
  — so the department moves the moment mex-reconcile links the parcel. Live ~12:05: 661 set — 651
  `elyon_crm` (BIO NATURAL: 648 list sales, 3 direct) and 10 `teleshop_out` (NATURA list sales);
  105 priced CRM sales had no MEX profile yet.
- **The department** = `cohort_order_source(sale_source, detail, mex_tracking_id, dept_override)` =
  `coalesce(dept_override, the mapping of §3)`. The 15 functions `20260942001800` re-emitted with
  the override passed read it (drift-guarded): `insights_sale_rows`, `insights_leads_rows`,
  `insights_cash_rows`, `insights_parcel_rows`, `insights_overview`, `insights_pivot`,
  `insights_profit`, `insights_returns`, `insights_stock`, `insights_lists`, `insights_lists_cash`,
  `leaderboard_day_v2`, `order_departments`, `order_origin`, `customer_timeline`.
- **What it changes against the plain NATURA exception:** BIO NATURAL wins over the series (the 6
  September list sales on a BIO NATURAL 9102 number moved from Телешоп – Lead out to Affiliate –
  Lead out), and a CRM sale on NATURA 9103 is Телешоп – Lead out.
- **`sale_source` / `sale_source_detail` do not change** and nothing is logged in
  `sale_source_reclass` — it is not a reclass. The Prediction-lists tab finds list sales by their
  detail and holds the list sales of every department (`docs/INSIGHTS_ANALYTICS.md`).
- **The withdrawn team rule (`20260942001800` → `…1850`, 29.09 ~11:36 → ~12:00).** For two hours
  a CRM sale or LEADS-OUT whose seller was on `crm_prediction` that day was Телешоп – Lead out (1.126
  orders over the history, 712 September sales / 1.996.989 ден). `…1850` reset every override and
  made the 4-argument `order_dept_override(sale_source, detail, person, at)` return NULL (kept, inert
  — the triggers now call the 6-argument form); `…1860` dropped `tg_sales_team_members_dept_override`.
  **Never reintroduce a team rule for departments** — a team groups people, it never places a sale.
- **Pure Profit:** these writes keep `updated_at`, so the monthly cache does not notice them —
  refresh the closed months after a department rule changes (§ "Moving existing rows"). Measured
  after `…1860`: against the plain mapping the rule moves 7 orders, all September (the open month),
  plus 1 MEX-only BIO NATURAL `M…` waybill of July with COD 0 (web → Affiliate – Lead out, 0 ден);
  the closed months cached at 08:40 (before `…1800`) therefore still hold.

### 3c. Teams are business lines; the product line picks the MEX account — neither places a sale (30.09–01.10)

- **Teams = business lines** (owner 30.09, `20260943000900` / `000950`; `elyon-presence-and-leaderboard`
  §5): Телешоп (ships via NATURA; lanes in / out / social), Affiliate (ships via BIO NATURAL; lanes
  in / out), Менаџмент. The words match the departments on purpose, but a team only GROUPS PEOPLE (the
  boards, Insights → Agents, the Assigner, Смени). A Телешоп agent's CRM sale shipped on BIO NATURAL is
  still Affiliate – Lead out (§3b). `scripts/verify-teams.mjs` **T3** fails if `cohort_order_source`,
  `order_dept_override`, `classify_sale_source`, `collabbox_department`, `cohort_parcel_source`,
  `cohort_parcel_split` or `tg_orders_dept_override` ever mentions `sales_team_members`,
  `sales_teams` or `sales_person_in_team`.
- **The product line picks the account of a CRM push** (owner 30.09; `elyon-products-catalogue`,
  `elyon-fulfilment-csv`): when the CRM itself creates the parcel ("Испрати до MEX", built 01.10,
  `app_settings.mex_push` OFF), `mex_profile_for_line()` maps Bio Natural / Dr.Becker → BIO NATURAL
  and Natura Therapy / Ad Astra → NATURA; a mixed basket, a basket with no line or a disagreeing
  department / team needs a person's pick. The line is an INPUT to the parcel, not a department rule:
  the push links the parcel through `mex_link_parcel(…, 'push')` (sets `mex_account` +
  `mex_tracking_id`), `zzz_orders_dept_override` fires, and §3b places the sale by the parcel's
  profile like any other.
- ⚠ **Check before the push goes on:** a pushed parcel carries OUR order number as its tracking id
  (no 9100 / 9102 / 9103 / 9108 series), so under today's §3b table a pushed CRM sale is Affiliate –
  Lead out on BIO NATURAL and **Телешоп – Lead out on NATURA, whatever the lane** (a 9100 "Lead in"
  needs the series). Fine for today's CRM sales (prediction / re-sale); decide with the owner before
  Lead-in or social sales are pushed.

### 3b+. 🔁 THE SELLER'S TEAM DECIDES — a lead excepted (owner, 02.10.2026 afternoon; `20260947000400`)

Supersedes the folder-first wording of this skill, the 29.09 withdrawal of the team rule and the 02.10
morning "a team is not a department" (§3c header). Owner, after seeing 18 of 22 Телешоп Out agents also
book LEADS-OUT: "од сега сметиме по агенти, за дашбордот и за Insights, и за пресметките … ако агентот е
од телешоп Out, порачката се смета кај телешоп Out … Тие што се телешоп out, имаат право да праќаат и
leads-out, и телешоп Out … различно е само за affiliate, затоа што тука е приоритет лидот, ако е
lead(pending) тогаш е дефинитивно affiliate lead in тимот, Affiliate out е тимот од affiliate IN, истите
луѓе но порачките не се од leads." Whole history.

| The sale | → department |
|---|---|
| a LEAD — `sale_source = altercpa` (AlterCPA intake, or a 10111 "Нарачка LEADS" document) | Affiliate – Lead in, **whoever** decided it |
| seller on `teleshop:out` on the Skopje sale day | Телешоп – Lead out (its "Нарачка out", its LEADS-OUT / BIO NATURAL, its "Нарачка in" — all) |
| seller on `teleshop:in` | Телешоп – Lead in |
| seller on `teleshop:social` | Социјални мрежи |
| seller on `affiliate:*` (not a lead) | Affiliate – Lead out |
| seller in Менаџмент / a legacy team (crm_prediction) / no seller | the old rules: a CRM sale → MEX profile (§3b) → own booking (§3c); anything else → its folder (§3) |
| a MEX-only parcel (no seller) | by profile then series (unchanged) |

- **One place:** `order_dept_by_team(sale_source, person, at)` over `sales_person_line_at(person, at)` (kind
  `line` teams, primary first, latest `valid_from`). `order_dept_decide(…, order_id)` = nullif(coalesce(team,
  `order_dept_override` profile, `crm_sale_booking_dept`), the 3-arg mapping) → `orders.dept_override`
  (sparse: stored only where it changes the department; the /orders PostgREST filter reads it unchanged).
- **Kept by:** `zzz_orders_dept_override` (insert / source / seller / sale time / parcel),
  `tg_sales_team_members_dept` (AFTER INSERT/UPDATE/DELETE on `sales_team_members` →
  `orders_dept_recompute(person)` — a team change in Settings → Teams re-decides that person's orders),
  the 15-minute `crm_sale_booking_dept_sync`.
- **Bookings** (collabBox documents with no order yet) follow their AUTHOR's team: `insights_sale_rows`
  (bkr: `coalesce(order_dept_by_team(dep[1], author, sale_at), cohort_order_source(dep…))`) and
  `leaderboard_day_v2`'s uncounted CRM twins — both re-emitted from the live body by one exact
  replace each (drift-guarded).
- **Backfill 02.10:** 3.130 orders moved, each in `dept_by_team_backfill` (old_dept → new_dept,
  old_dept_override). September: 760 Affiliate – Lead out → Телешоп – Lead out (2,11 М ден), 132
  Телешоп – Lead in → Lead out, 27 Lead out → Социјални. Set-based (a per-row decide over 360k orders
  exceeds the statement timeout) — `verify-teams.mjs` T3 re-checks the stored value against
  `order_dept_by_team` for every real sale of 60 days.
- **Never:** let a team decide a LEAD; let Менаџмент decide a department; change `sale_source` /
  detail for this (they stay the raw record); bring back the crm_prediction-team rule of `…1800`.

### 3c. The booking decides before the parcel + the 2-day collabBox rule (owner, 02.10.2026)

Owner 02.10 (Milјана's CRM list sale sat in Affiliate – Lead out with no parcel; /orders showed 0
Телешоп – Lead out while the board counted the bookings): "телешоп внесуваат само преку НАТУРА …
само тие ордерс што се во папката и се преку натура тие се од телешоп оут, а афилиејт оут праќаат само
преку био натура". (Superseded the same afternoon by §3b+: the seller's team decides; what follows now applies to sellers in Менаџмент / without a line team.) The folder + MEX profile, never the product. The
evidence (last 10 days): every folder ships on ONE profile (out / in / social → 100 % NATURA, LEADS /
LEADS-OUT → 100 % BIO NATURAL); the Телешоп Out TEAM books 82 % on NATURA and 18 % in LEADS-OUT on BIO
NATURAL — the 18 % are their CRM prediction-list sales (197 of 236), so those ARE Affiliate – Lead out.
**A team is not a department** (Frosina 56 % LEADS-OUT, Maja 42 %, Milјана 1 %).

- **When:** `20260947000300` — a confirmed CRM sale with no parcel takes its OWN booking's department
  (`crm_sale_booking_dept`: the document from `crm_sale_collab_doc`, and it must be linked to the
  order or booked by the sale's seller — a customer's other booking is never borrowed). Kept by
  `zzz_orders_dept_override` (UPDATE only — on INSERT the row does not exist) and the cron
  `crm-sale-booking-dept` (`7,22,37,52 * * * *`, `crm_sale_booking_dept_sync()`, ≤ 60 days, updated_at
  kept). The parcel's profile (§3b) still wins once MEX has it.
- **The 2-day rule:** `20260947000200` — owner: "ако некоја порачка ја нема внесено во наредните 2 дена
  во collab, тогаш оди cancel, Агентот добива известување". `apply_collab_entry_rule()` (cron
  `collab-entry-rule` `20 * * * *`, acts at 21:xx Skopje once a day): a confirmed `elyon_crm`
  prediction_list / direct sale, no parcel, no collabBox evidence (`crm_sale_collab_doc`: the writer's
  link · a living sales document on the customer's phone or komitent from the sale − 2 days · the
  phoneless twin), no unlinked parcel on the phone, `days` (2) Skopje days after its sale day →
  cancelled (reason `other` + note `not_in_collab_2d: …`, history, system note, `keep_updated_at`) and
  the confirmer (else the assignee) gets the bell `not_in_collab`; the evening before,
  `not_in_collab_warning`. Ledger `collab_entry_rule_runs` / `_items`; undo
  `collab_entry_rule_undo(run_id)`. Switch `app_settings.collab_entry_rule` (owner key) — seeded
  **report** (02.10: 44 would be cancelled, 4–46 days old, €2.043,61; 3 warnings). A booking made after
  the cancel is no twin (the writer's twin rule reads living sales), so it becomes its own order with
  the parcel — counted once. Proof: `node scripts/verify-collab-entry-rule.mjs [--list]`.

### 4. The TS twin — change them together

`supabase/functions/api/insightsCommon.ts`: `INSIGHTS_SOURCES` (the six keys in order),
`SOCIAL_DETAILS`, `CRM_PARCEL_SERIES`, `COHORT_SOURCE_TERM`, `cohortSourceOrFilter()` →
`GET /orders?cohort_source=<csv of keys>` (every drill from Insights). Since 20260942001800
`departmentTerms()` puts the override first: `dept_override.in.(<keys>)` OR
`and(dept_override.is.null, or(<the mapping's terms>))` — it reads the column whatever rule fills
it (`1f4d928`, the MEX-profile rule, changed SQL only). The six terms partition every order
(`insightsCommon.test.ts`). Checks that restate the rule: `scripts/verify-attribution.mjs`
C1/C2/C3/C12, `scripts/verify-insights-ties.mjs` T2/T3/D2 (its PostgREST replay knows
`dept_override`), `verify-leaderboard-v2` (its own truth reads `dept_override`, `40f1425`), and the
install-time proof table in the migration (step 18 of 20260942001000). A rule change is a
migration + the TS twin + the checkers in one commit.

## MEX parcels with no order — by PROFILE, then SERIES

`cohort_parcel_split(account, series, tracking, sender_ref)` → `cohort_parcel_source(split)`,
first match wins (`20260942001860`):

| Parcel | split | department |
|---|---|---|
| BIO NATURAL, series 9110 | `mex_leads` | `altercpa` |
| BIO NATURAL, any other series (and whatever its sender reference) | `mex_leads_out` | `elyon_crm` |
| `NTMK…` tracking or sender reference, or an `M<digits>` waybill (and any parcel a live web order claims — the cohort checks claims first) | `mex_web` | `web` |
| 9110 | `mex_leads` | `altercpa` |
| 9103 | `mex_leads_out` | `elyon_crm` |
| 9102 | `mex_out` | `teleshop_out` |
| 9100 | `mex_in` | `teleshop_other` |
| 9108, 1300 | `mex_social` | `social` |
| anything else | `mex_other` | `teleshop_other` |

A BIO NATURAL parcel is affiliate before any other test — never web, never teleshop (owner 29.09:
"web e-commerce is entirely via NATURA"). On NATURA the series names the channel. The old neutral
split "Elyon account — unlinked" is gone.

## collabBox documents — by TYPE

`collabbox_department(p_doc_type, p_external_order_id, p_person, p_at) → text[]`
(20260942000900, called at INSERT by `tg_orders_sale_source_fill` and by the sync's ledger):

| Type | Folder (collabBox name) | → `{sale_source, detail}` | Department |
|---|---|---|---|
| 10111 | Нарачка LEADS | `altercpa / collabbox_leads` | Affiliate – Lead in |
| 10114 | LEADS-OUT Нарачка | `elyon_crm / collabbox_leads_out` | Affiliate – Lead out |
| 10050 | Нарачка out | `collabbox / teleshop_out` | Телешоп – Lead out |
| 10036 | Нарачка in | `collabbox / teleshop` | Телешоп – Lead in |
| 10106, 10055 | Нарачка Социјални Мрежи · Нарачка С. Мрежи-Продавница | `collabbox / social` | Социјални мрежи |
| unknown / record-only type | — | by DocNumber series: 9110 · 9103 · 9102 · 9100 · 9108/1300 as the matching row above; anything else NULL (the classifier's value stands) | — |

- `p_person` / `p_at` are **unused** (kept so a person- or date-based rule could return without
  touching callers). There is no team override: a LEADS-OUT is Affiliate – Lead out whoever booked
  it (the team rule of `…1800` that briefly moved a `crm_prediction` author's LEADS-OUT is
  withdrawn). The 3-argument compatibility form
  `collabbox_department(DocNumber, person, at)` = the series fallback, for
  `import-leads-out-collabbox.mjs` / `reclass-department-sources.mjs`.
- What a type DOES in the sync is `collabbox_doc_role(type)` — see `elyon-collabbox-sync`.
- `orders.collabbox_doc_type` (text, `^[0-9]{3,8}$`, NOT VALID check) holds the type an order IS:
  written by the sync on insert, filled once on orders it re-reads, history filled by
  `scripts/backfill-collabbox-doc-types.mjs` (255.243 typed on 28.09). A stored type that differs
  from a later read is flagged `type_changed:<old>><new>` in the ledger, never overwritten.

## Moving existing rows — `sale_source_reclass`

`public.sale_source_reclass(order_id PK → orders, from_source, from_detail, to_source, to_detail,
reason, moved_at)` (20260942000600). **One row per order.** `from_*` = the source the order had
**before its FIRST move ever**; a later move overwrites `to_*`, `reason` and `moved_at` and keeps
`from_*`. RLS on, service role only. 170.478 rows on 29.09: 165.639 tagged by-folder (the 165.571
by type + the 68 `team_prediction` sales moved back), 4.838 still tagged department-by-series, 1
from 20260942000600.

| Script | What it moved | Run |
|---|---|---|
| `scripts/reclass-department-sources.mjs` | collabBox 9102/9103/9110 orders by SERIES + the (withdrawn) team rule — 168.564 rows, 28.09 | `node scripts/reclass-department-sources.mjs` (dry run) · `--apply [--chunk 20000] [--outside-quiet-window]` · `--rollback [--apply]` |
| `scripts/reclass-by-folder.mjs` | every collabBox order (`sale_source` altercpa / elyon_crm / collabbox) to its department by TYPE (`TARGET` map, types from `exports/collabbox/merged-2026-09-28/…/orders_combined.csv` + every `exports/collabbox/*.json` fetch) — 165.571 rows; plus the 68 `team_prediction` CRM sales back to Affiliate – Lead out, 28.09 night | `node scripts/reclass-by-folder.mjs` (dry run) · `--apply [--outside-quiet-window]` · `--rollback [--apply]` |

Both write ONLY `sale_source` / `sale_source_detail`, under `SET LOCAL elyon.allow_source_change`,
`elyon.keep_updated_at` and `elyon.bulk_repair`, refuse to start while `recompute_all_segments` or
the no-parcel rule runs, and (apply) want the quiet window. **Rollback semantics:** `--rollback`
returns the rows still carrying THAT script's tag to `from_*` — the **original arrival source**,
not the intermediate state — and deletes their log rows. Because the by-folder run re-tagged most
rows, rolling it back returns ~165k orders to their pre-28.09 classification (e.g.
`collabbox/teleshop` for a 10050 document, which the cohort then counts as Телешоп – Lead in);
`reclass-department-sources --rollback` now only sees its own 4.838 rows.

**After any reclass apply:** refresh the Pure Profit monthly cache (the cached months' per-source
blocks move but `orders.updated_at` does not, so the nightly job will not notice —
`POST /api/insights/profit/refresh` or `insights_profit_refresh(month)`), then run
`verify-insights-ties`, `verify-attribution` and the `verify-tab-*` checkers.

## MEX revivals respect the folder — `mayReviveWith` (29.09)

`mex-reconcile` links a fresh parcel to an order on the same phone (last 8) by COD
(`phone_cod`, `pickCandidate` in `supabase/functions/mex-reconcile/match.ts`), and a linked parcel
moves the order to shipped / paid / returned (rule C revives a cancel or a trash). Before 29.09
that match revived July AlterCPA leads on September teleshop parcels: the money landed in
Affiliate – Lead in and the teleshop seller was never credited.

Since `3ed28e4` (deployed 29.09 05:05) **a cancelled or trashed order fits only its OWN folder's
parcel** (`mayReviveWith(order, parcel)`):

| Dead order | May be revived by |
|---|---|
| an AlterCPA lead (`source_type` or `external_source` = `altercpa`) | a series **9110** parcel ("Нарачка LEADS", either account — NATURA carried the LEADS series before BIO NATURAL existed) |
| any other order (a CRM sale) | a series **9103** parcel (LEADS-OUT) |

A teleshop (9102 / 9100), social (9108 / 1300) or web (`NTMK…` / `M…`) parcel on the same phone is
another department's sale and never revives the dead order. Open and settled orders are not
affected — the usual rules decide (`match.test.ts`). The narrow `upsell_revive` (a lone
`no_parcel_7d` AlterCPA cancel + a BIO NATURAL 9110 parcel with COD > 0) is unchanged.

**The repair of the existing links** — `scripts/repair-cross-channel-parcels.mjs` (key
`cross-channel-parcels`, repair-kit protocol): AlterCPA orders holding a NATURA 9102 / 9100 / 9108 /
1300 parcel that the reconcile had flipped out of a cancel / trash, the parcel more than 2 days from
the lead. Run **`a057bc52`** (29.09): **145 leads** went back to the status they had before the
flip (cancelled → cancelled/other, trashed → the `not_reachable` park, each with a note) and their
parcels were unlinked. At 08:46 their **125 collabBox documents were re-applied** by the sync (run
`4cdb427f`): each is now its own teleshop / social order with its seller (16 more had already been
created by the history backfill). Same-day parcels (47) and imported links (84) were only listed
for the owner (`exports/repairs/cross-channel-parcels-2026-09-29T03-04-29-167Z.csv`), never
touched. Undo: `node scripts/rollback-repair.mjs --run a057bc52 [--apply]`. Orders in
`agent_payout_items` are excluded (payouts deferred).

**The rest of the class — "the collabBox folder decides", ALL cases (owner, Mile, 01.10.2026: "Yes, the
collabBox folder decides").** Every AlterCPA order (`sale_source 'altercpa'`) that still holds a NATURA
9102 / 9100 / 9108 / 1300 parcel — same-day ones and imported links included — gives the parcel to its
collabBox document, which becomes its OWN Телешоп / Социјални order credited to the document's author.
`scripts/repair-folder-decides.mjs` (key `folder-decides`; pure rules `scripts/lib/folder-decides.mjs`,
tests `src/lib/folderOrders.test.ts`): per parcel ONE sub-transaction — the AlterCPA order goes back to
what it was before the parcel made it a sale (its first history row INTO shipped / paid / returned names
it: a cancel / trash is restored; never cancelled — an AlterCPA approval or an import straight as paid —
→ cancelled by the SYSTEM, reason `other` + note, dated by the AlterCPA decision; never a person's cancel,
so the written-note rule does not apply), the parcel unlinked, then the LIVE writer re-applies the document
(`collabbox_apply_documents` → `collabbox_apply_one` branch E, unchanged) and must answer `created`, else the
unit rolls back whole. Listed, never moved: payout orders, LEADS-document orders (`altercpa / collabbox_leads`
holding a teleshop parcel — their own 9110 parcel is not in the register), a parcel the writer would not turn
into an order (COD 0 → replacement), a label stuck at MEX 8 for > 14 days. Dry run **`b3c20364`**
(01.10 ~22:56): 134 → **127 move** (292.350 ден: 87 Телешоп – Lead out, 36 Телешоп – Lead in, 4 Социјални;
106 never cancelled, 21 restored cancels) + 7 listed; September −10 / +10. Undo:
`node scripts/repair-folder-decides.mjs --rollback <run> [--apply]` (it deletes the made order — NOT
rollback-repair.mjs, which refuses the key). Proof: `node scripts/verify-folder-orders.mjs` (A1, C1, L1).

## Where the department is shown (29.09)

The three order surfaces below call THE department, `cohort_order_source(sale_source, detail,
mex_tracking_id, dept_override)` (re-emitted by 20260942001800) — never a TS re-implementation —
and are display only (SECURITY DEFINER, EXECUTE for `service_role` + the read-only verification
role).
`confirmed_by_*` stay untouched: payout math reads them and is deferred by the owner, so a
collabBox order keeps its system confirmer `System (collabbox-sync)` and SHOWS its seller.

- **`order_departments(p_ids uuid[])`** (`20260942001500`) → `(id, department, seller_name)` for
  one page of `GET /orders`. The Orders list, the expanded row, the mobile card and the export
  show the seller first and the department as the source chip, with the intake (Увоз / AlterCPA /
  …) under it (`src/lib/orderSource.ts`). `seller_name` = the `sold_by_person_id` person's display
  name, else `sold_by_ext` (a collabBox author as collabBox writes it) — never a bare numeric
  AlterCPA operator id.
- **`order_operators(p_ids uuid[])`** (`20260943002000`, owner 01.10.2026) →
  `(id, operator_name, operator_basis, operator_auto)`: the **"Оператор"** column of /orders and of
  the customer window (search) = who produced the order's CURRENT status, for every status. A sale
  → the seller (as above, else the confirmer; basis `sale`). Anything else → (a) the latest PERSON
  in `order_history` who moved the order into its current status (a transition before a same-status
  edit; System actors never; basis `history`), (b) else the assignee (orders from before 01.08,
  when order_history did not exist — what the column showed until 0740693; basis `assigned`),
  (c) else the AlterCPA operator — `decided_by_altercpa_user`, or for their callback (status 3 →
  our call_again) `payload.user` (basis `altercpa`), (d) else NULL ("—"). `operator_auto` = the
  last transition into the status was an automatic rule (no-parcel, a repair; not the AlterCPA
  mirror) → the list adds "автоматски". Names go through `sales_people.user_id` and the
  `order_name` / `collabbox_author` / `altercpa_user` identities, so one human has one spelling.
  The api calls it next to `order_departments` (`orderPeopleById`); the frontend reads it through
  `src/lib/orderOperator.ts`. Display only — no writer, no status rule. The /orders **seller
  filter stays a seller filter** (`sold_by_person_id`), labelled "Продавач (продажби)": filtering
  by operator would need the history lookup per row, which PostgREST cannot express.
- **`order_origin(p_id uuid)`** (`20260942001600`) → jsonb for the order window's **"Origin and
  proof"** panel (`src/components/OrderOriginPanel.tsx`): department, `sale_source` / detail,
  `collabbox_doc_type`, intake (`source_type`), seller + `sold_at` / `sold_via`, `paid_basis`, CRM
  price in денари; the MEX parcel of the order's tracking id (profile BIO NATURAL / NATURA, series,
  status, COD, receiver name + city, created / delivered / returned, `linked_here`); the collabBox
  document with that DocNumber (folder, author, time, amount); the AlterCPA decision (decision,
  time, operator as a person or `#id`). `GET /orders/:id` attaches it for **admin / manager** only;
  the receiver name / city follow the role's PII switches, and its three money keys — `price_mkd`,
  `parcel.cod_mkd`, `collabbox.amount_mkd` — reach **business owners only** (`edfa901`: deleted for
  a manager, the panel then shows "—"). The panel flags a COD that differs from the CRM price and a
  `paid` with no MEX parcel.
- **Customer 360** (`customer_timeline`, `20260942001700`, override passed since `…1800`): every
  `order` event carries `department` (the same call) and its badge shows the department label
  (`departmentLabel`, `src/lib/orderSource.ts`); the stored source words stay only as the fallback
  for non-order events (`elyon-customer360-and-integrations`).
- **Insights → Предикциски листи** (was "Прогнозни списоци" until the owner's terminology of 01.10)
  holds the list sales of EVERY department since `…1800` (a list
  sale shipped on NATURA counts in its NATURA department and stays on the tab); its footer is the
  Affiliate – Lead out card and its `/orders` links select by `sale_source` + detail.

## Never

- **Never decide by the seller's team, the seller, or the system an order was made in.** Two team
  rules were tried and withdrawn: the AlterCPA-team override (20260942000700: a CRM sale of an
  `altercpa_leads`-team agent → `altercpa/team_prediction`, withdrawn by 20260942001100; `team_*`
  details survive only as mappings in `cohort_order_source` / the TS twin for safety, 0 rows) and
  the `crm_prediction` team → Телешоп – Lead out rule (`…1800`, withdrawn by `…1850` the same
  morning). Do not reintroduce either — and making teams business lines (30.09) changed nothing here
  (§3c; `verify-teams.mjs` T3).
- **Never decide a department by the product line** either: the line only picks the MEX account of a
  CRM push; the parcel's profile then decides (§3c).
- **Never write `orders.dept_override` by hand**, and never call the 3-argument
  `cohort_order_source` in a report (§3) — the 4-argument form is THE department.
- **Never decide by the series when the type is known** (the series lies for ~1.100 documents).
  The MEX profile decides only where §3b and the parcel split say so — a CRM-made sale and a
  MEX-only parcel; it never overrides a collabBox folder.
- **One order, one source:** a department move changes the SAME row; never copy an order into
  another source. Web orders are never orders.
- **Never classify with the 2-argument `cohort_order_source`** in a report.
- **Never let a phone + COD match revive a dead order on another folder's parcel** — keep
  `mayReviveWith` in every new match path (a repair script included).
- **Never re-implement the mapping** in TS or a new SQL function for display: call
  `cohort_order_source` (as `order_departments` / `order_origin` do) or the TS twin that the
  checkers prove.
- `sales_people.crm_since` / `crm_until` (who works in the CRM, 20260942000600) are information,
  not a gate — `collabbox_prediction_detail()` that gated on them was dropped in 20260942000700.
- The no-parcel rule keeps its population: it reads `sale_source IN (altercpa, affiliate)` minus
  `team_prediction` in its three twins (`apply_no_parcel_rule`, the Overview's `anp`,
  `overview.ts attentionFilter`). A department change must not widen it to collabBox or CRM sales.
- Payout / bonus / commission math is not touched by any of this (deferred by the owner).

## Adding a new collabBox document type (checklist)

1. **Evidence first** — what the folder is: its series, MEX profile, customers' history
   (AlterCPA lead first? teleshop history?), products; then the owner's decision.
2. **Role** — `collabbox_doc_role()` (SQL) AND `DOC_ROLES` in
   `supabase/functions/collabbox-sync/collabbox.ts`: `order` · `order_unless_held` · `credit` ·
   `record`. `collabbox.test.ts` reads the migration's CASE and fails when the two differ.
3. **Department** — `collabbox_department()` by type (a new migration re-emitting it). If it is a
   NEW department: `cohort_order_source` (both forms), `cohort_parcel_split/source`, every
   insights function's source list (re-emit from the live bodies with a drift guard, as
   20260942001000 did), `INSIGHTS_SOURCES` + terms in `insightsCommon.ts` (+ test), the i18n
   labels (`insights.common.source.*`, `overview.source.*`) in all four locales,
   `insights_profit_cache_version()` +1, and the checkers
   (`verify-attribution` C2, `verify-insights-ties`). `order_dept_override()` (the MEX-profile
   rule) covers only CRM-made sales (`prediction_list` / `direct`) — a collabBox type never joins
   it; its folder decides.
4. **Sync reads it** — add the id to `NIGHTLY_TYPES` in `collabbox.ts` (and `KNOWN_TYPE_NAMES`
   when the login's form does not list it). The day's bookings have their own hard-coded list of
   five types (10036 · 10050 · 10111 · 10114 · 10106) in `collabbox_booked_today()` AND in its
   copy inside `leaderboard_day_v2` (the `bkd` CTE; `day_totals.checks.bookings_filter_drift` must
   stay 0) — a new type that sellers book during the day goes into both. The board counts a booking
   only when `collabbox_doc_role()` = `order` (see `elyon-presence-and-leaderboard`). A collabBox
   sale's DAY is its booking day (`collabbox_sale_at(doc_at, booked_at)`, owner 01.10.2026 — never
   `doc_at` directly, that is the dispatch day); the department is still the folder's
   (`elyon-collabbox-sync` "The booking day").
5. **Existing orders** — type them (`backfill-collabbox-doc-types.mjs`), extend
   `reclass-by-folder.mjs` `TARGET`, dry run, apply in the quiet window, refresh the profit cache,
   run the ties.
6. **Ship** — tripwire, `apply-migration-mk.mjs`, deploy `collabbox-sync`, `engine-fixture-mk.mjs`.

## Open with the owner (29.09)

Process "every lead out entered in the CRM first" (then nothing needs importing); social history
before March 2026 (no MEX) is not imported; the 47 same-day + 84 imported cross-channel links the
repair only listed; 73 September AlterCPA sales that the operator cancelled and MEX then shipped
have no seller (the seller rule waits for the owner); 16 unsure catalogue groups and ~53
wrong-size aliases affect product figures per department (see `docs/PRODUCTS_STOCK_WAREHOUSE.md`).
The full list, in Macedonian: `docs/handoff/2026-09-29/PRASHANJA-ZA-MILE.md`.

## Companion skills

`elyon-collabbox-sync` (what the sync does per type) · `elyon-altercpa-bridge` (Affiliate –
Lead in intake) · `elyon-web-shop-bridge` (web) · `elyon-currency` (денари) ·
`elyon-segments-and-prediction` (every department's customers are in the lists) ·
`elyon-presence-and-leaderboard` (the TV board splits each agent's day by department) ·
`docs/INSIGHTS_ANALYTICS.md` (the cohort).
