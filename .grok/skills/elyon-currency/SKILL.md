---
name: elyon-currency
description: Use when touching any price, total, cost, payout, commission, COD amount, revenue figure or money input in the Macedonian Elyon CRM. Prices are STORED in EUR and shown in Macedonian denari via formatMoney (the frozen 61.5 peg); amounts that are ALREADY denari — MEX COD, *_mkd fields, web-shop totals — are shown with formatDenari and never converted again. There is no lev and no dual display; the single euro exception is affiliate (CPA) payout, which partners invoice in euro. Read before writing any money UI, any money input, or any export column.
---

# Elyon Currency Skill — MACEDONIA

**Stored in EUR. Shown in денари. Never both, never euro.** Two sources of money, two formatters:
EUR prices go through the peg (`formatMoney`); denari that already exist (MEX COD, the web shop)
do not (`formatDenari`).

> Two corrections to older versions of this file, which described a different market:
> Macedonia is **not** euro-native (that was the Kosovo phase of this deployment), and the
> Bulgarian lev peg does not apply either. `formatEur` and `formatLev` no longer exist.

## The model

| | |
|---|---|
| **Database / API — CRM prices** | EUR, cent precision (`orders.price`, `order_items.price_per_unit`, payouts). An internal accounting unit. |
| **Database / API — denari-native money** | MEX cash-on-delivery (`orders.mex_cod_mkd`, `mex_parcels.cod_mkd`) and the web shop (`web_orders.total`, `currency` = MKD) are denari as recorded by MEX / the shop; **purchase costs from Sigma** (`stock_article_costs.cost_mkd`, `product_cost_history.cost_mkd`, ex VAT — owner 01.10.2026, Sigma book values) and the shops' collabBox amounts (`shop_*`, with VAT) too. `products.cost_price` (EUR) is only a guarded mirror = cost_mkd / 61,5. Payload keys carrying them end in `_mkd`. |
| **Everything a human sees** | Macedonian denari only — with ONE documented exception, below. |
| **Conversion** | `MKD_PER_EUR = 61.5` in `src/lib/currency.ts`, applied at render time to EUR values only. |

### The one exception: affiliate (CPA) payout is shown in EUR

Operator decision, 2026-08-10. **Affiliate payout figures render in euro via `formatEurExact`**,
on the partner portal *and* on the staff `/affiliates-admin` surfaces. This is not a leftover
from the euro-native phase and must not be "corrected" to `formatMoney`:

- `affiliate_leads.payout_eur_snapshot` **is** euro. It is a debt we owe a foreign webmaster who
  invoices us in euro — not a Macedonian retail price, and never collected as COD in denari.
- Converting it to denari at display time would show partners a number they cannot reconcile
  against their own network panel, and would make the frozen peg part of a cross-border payable.

Everything else on those pages stays denari. In particular the staff-only **"Avg order value
(confirmed)"** tile is Macedonian selling-side revenue and uses `formatMoney`. The shared
components (`src/components/affiliates/AffiliateKpiCards|AffiliateLeadsTable`) take money as an
injected `fmtMoney` prop precisely so the two can differ per tile. See `elyon-affiliates`.

### The constant is FROZEN — never "update it to today's rate"

The Bulgarian lev is legally fixed to the euro, so deriving it at display time is safe forever.
The denar is a *managed* NBRM peg, which is not the same promise. The moment someone edits
`MKD_PER_EUR`, every historical order, closed agent payout, past revenue report and already-collected
COD silently re-prices — with no audit trail, and no way to tell what was actually quoted on the
phone. `src/lib/currency.test.ts` pins the value so an edit fails CI.

**If the market moves, re-price the catalogue in EUR instead** — `scripts/reprice-catalogue-mk.mjs`
takes the denar shelf prices you actually advertise and stores `denar / 61.5`.

**The constant has many copies — all must stay 61.5, and only the `src/lib` one is
test-guarded:** `supabase/functions/api/index.ts` (webhook FX ~2245, AlterCPA push `base` rate
~7744), `supabase/functions/altercpa-sync/altercpa.ts` (`MKD_PER_EUR`, ~286),
`supabase/functions/mex-reconcile/match.ts` (`MKD_PER_EUR`, ~17 — the COD-fit match),
SQL literals in `20260936000000_insights_overview.sql` (and the WIP
`20260940000000_insights_foundation.sql`), the `order_paid` bell
(`20260940000400_denari_notifications.sql` `tg_notify_order_paid`), and scripts (`reprice-catalogue-mk.mjs`,
`scripts/lib/altercpa.mjs`, `scripts/lib/repair-kit.mjs`, `verify-attribution.mjs`, …).
Another reason not to touch any of them.

## Helpers — `src/lib/currency.ts`

| Function | Takes | Returns | Use for |
|---|---|---|---|
| `formatMoney(eur)` (:56) | stored **EUR** | `"2.490 ден"` | **Every** EUR value shown to a user |
| `formatDenari(mkd)` (:64) | amount **already in denari** | `"4.000 ден"` | MEX COD, every `*_mkd` key, web-shop totals — **never ×61.5 again** |
| `eurToDen(eur)` | EUR | `2490` (integer) | Prefilling a denar input; export columns |
| `denToEur(den)` | denari | `40.49` (2dp) | Reading a denar input back before sending to the API |
| `codFor(eur)` | EUR | `{ amount, currency: 'MKD' }` | The courier COD figure (nearest 10 ден) — amount **and** currency together so they cannot be exported apart |
| `formatEurExact(eur)` | EUR | `"€40.49"` | **Affiliate/CPA partner payouts** — see the exception above |

`formatPriceInline` is an alias of `formatMoney`, kept for old call sites. `formatDenari`
rounds to whole denars, prints `0 ден` for null/garbage and keeps a minus sign (four MEX
parcels carry a negative COD — money flowing back; 20260934000100 keeps the sign).

### Which formatter — decide by the UNIT of the value, not by the page

| The value is… | Examples | Formatter |
|---|---|---|
| a stored EUR price / cost / payout / bonus | `price`, `price_per_unit`, `amount_eur`, `value_eur`, `sold_value_eur`, `price_eur`, `paid_orders_eur`, leaderboard `revenue`/`bonus` | `formatMoney` |
| denari recorded by MEX or the shop | `mex_cod_mkd`, `cod_mkd`, `delivered_cash_mkd`, `lifetime_delivered_mkd`, `amount_mkd` (web total), insights / cohort `*_mkd`, `web_orders.total` | `formatDenari` |

- `formatMoney(mkd)` shows 61.5× the real figure — the "61× bug". `formatDenari(eur)` shows
  1/61.5 of it. Both are silent.
- The api payloads follow the suffix: `*_eur` = stored EUR, `*_mkd` = denari
  (`src/lib/api.ts` Customer 360 / Overview contract comments,
  `src/components/insights/shared/cohortTypes.ts`). The Overview hooks expose `eur()` →
  `formatMoney` and `den()` → `formatDenari` (`useOverviewFormat.ts`, `useInsightsFormat.ts`).
- Web totals are denari only while `web_orders.currency = 'MKD'` (every MK order today;
  `insights_web_block.non_mkd_count` would show otherwise).

## Rules

1. **Displaying money → `formatMoney` for EUR, `formatDenari` for denari.** Never hand-format,
   never print a bare number, never add a currency symbol yourself.
2. **A money INPUT takes денари.** The field holds denars; convert with `denToEur` on the way to the
   API and `eurToDen` on the way in. Put a `ден` adornment on the field. This applies to product
   prices, order line prices and totals, courier rates, leaderboard bonus tiers, prediction value
   brackets, the Margin Lab target and simulator, and payout amounts — all already converted.
   *Never* label a field `ден` while it still writes a raw EUR number; that is a live money bug.
3. **Whole-denar values round-trip exactly** (verified for 1–20 000), so `denToEur(eurToDen(x))` is
   safe for anything an operator can type. Prefer whole denars; use `step={1}`.
4. **Export columns must name the currency** — `Total_Price_MKD`, `Revenue (MKD)`, `Price MKD`. A
   bare number in a CSV is the ambiguity `codFor()` exists to prevent.
5. **Calculations stay in their own unit.** EUR prices are computed in EUR and converted only at
   the display or input boundary, never in the middle, or rounding compounds. MEX COD and web
   totals stay denari. When one report must mix them (the Overview, the cohort), the SQL converts
   the EUR price ONCE (`round(price * 61.5)`) and names the result `*_mkd`, or divides denari by
   61.5 into a `*_eur` key — COD is what MEX collects and is never multiplied
   (`20260936000000_insights_overview.sql` header: "61.5 … used only to express a price in denari
   next to a COD, never to re-price anything"; same rule in the WIP cohort header). Keep the
   suffix honest.

## The one legitimate exception: affiliates

`formatEurExact` and the `payout_eur` / `price_eur` fields under `src/components/affiliates/**` are
**deliberately EUR**. Affiliate and CPA partners are external companies on euro-denominated
contracts; their payouts are a real euro obligation, not Macedonian retail pricing. Leave those
surfaces alone — converting them would misstate what the partner is owed.

Everything else in the product is denar-only — owner order 2026-09-28: *"everywhere Денари
instead of euro"*. The three old EUR displays outside affiliates are gone: `MirrorTab.tsx` shows a
foreign lead's raw amount in its own currency plus `≈ formatMoney(...)`; the `order_paid` bell
prints денари and carries `meta.amountMkd` (`20260940000400`; pre-migration `€NN.NN` rows are
re-rendered in денари by `NotificationsDropdown`). The LeadDistribution high-value threshold and
the affiliate offer **sell price** are денари inputs that store EUR through
`denInputToEur(text, storedEur)` — an untouched field saves the stored EUR exactly (a plain
round trip is not exact: 34.90 € → 2.146 ден → 34.89 €). Only affiliate PAYOUT (payout,
override, partner-portal catalogue) stays EUR. No /insights chart plots an EUR series any more:
they draw денари (`*_mkd`) with `f.compact` axes (the old EUR `moneyAxis()` helper,
`insights/shared/tabFormat.ts`, was deleted 29.09 with its last user). Segment list names keep their EUR band ("57d ≤26 (3+ orders)"
— the engine matches by exact name); `predictionListLabel()` shows "≤ 1.599 ден" on screen only.
`orders.price` / `prediction_leads.price` are ORDER TOTALS — never × quantity (`orderTotal()`).

## Red flags (stop and correct)

- A `€` in any staff- or customer-facing string outside the affiliate surfaces and the three
  known spots above.
- `formatMoney(...)` on a `*_mkd`, COD or web total, or `* 61.5` applied to a COD.
- `formatDenari(...)` on a EUR price.
- Any `лв`, `BGN`, `1.95583`, `formatLev`, `eurToLev` — Bulgarian leftovers.
- An edit to `MKD_PER_EUR` (any copy), or a live FX fetch.
- A price input labelled `ден` that stores what the user typed without `denToEur`.
- Storing a denar amount in a price column (they are EUR columns).
- A money column in a CSV with no currency in its header.

## Commission tiers depend on the EUR unit price

`packageBonusRate` in the edge function (`api/index.ts` ~1011) reads `order_items.price_per_unit`
**in EUR**: `≤25€ → 1€`, `>25€ and <35€ → 2€`, `≥35€ → 3€` (exactly 25 € earns 1 €). In denar
terms the boundaries fall at **1.538 ден** and **2.153 ден**. Re-pricing across one of those lines changes what every agent is paid per package —
check before moving a price near them. The tier table is duplicated in
`src/components/insights/MarginLabTab.tsx`; change both. The TV leaderboard's daily-game
projection uses the SAME `packageBonusRate`, injected into `api/leaderboard.ts` (see
`elyon-presence-and-leaderboard`).
