---
name: elyon-logistics-costs
description: Use for any shipping/return/courier cost, the Pure Profit (Чиста добивка) P&L, the Margins (Маржи) tab, the courier rate card, VAT (per product from Sigma since 01.10.2026 — products.vat_rate, taxed per line), product cost (COGS) coverage, or how delivery & return losses are charged. Covers the MEX rate card (150 ден per delivered parcel, 0 on return), the per-product VAT (5 % supplements / 18 % cosmetics, unclassified at 5 % shown apart), the two P&L clocks (cohort vs cash), the cost-share estimate for uncosted packages, and today's commission line. Read before touching GET /api/insights/profit, insights_profit(), courier_rates, loadCourierRates or anything that totals what we pay to ship.
---

# Elyon Logistics Costs & Pure Profit — Macedonian rules (29.09.2026; VAT per product 01.10.2026)

**Macedonia ships with MEX Poshta only.** The Speedy / Econt table further down
is the inherited Bulgarian calibration — history, never a Macedonian cost.

## The rate card (`courier_rates`, Settings → Courier Rates)

| courier | service | deliver_cost (EUR) | return_cost (EUR) | = денари |
|---|---|---|---|---|
| mex | door | 2.439 | 0 | **150 ден per delivered parcel · 0 per return** |
| mex | office | 2.439 | 0 | same |

- The api reads it through `loadCourierRates()` (index.ts). Its fallback for an
  order with no recorded courier is the **`mex` row** (critic C5, 2026-09-28) —
  never the old BG blend (€3.50 / €6.00, which charged 440.902 ден of phantom
  cost in September 2026).
- The P&L charges the rate **per MEX parcel**, rounded to whole денари
  (2,439 € × 61,5 = 150 ден): `deliver` on every parcel MEX DELIVERED,
  `return_cost` on every parcel MEX RETURNED. `return_cost = 0` means a return
  costs nothing on the rate card — **owner decision pending**: does MEX bill
  the delivery fee on returned parcels? The tab shows it as "0 — to confirm".
- A parcel two orders share (owner-ruled accurate) is ONE parcel: charged once.
- The goods of a returned parcel come back to stock: **never charge product
  cost (COGS) on a return** — only the courier.

## Pure Profit = TWO clocks (GET /api/insights/profit, migration 20260941000300)

Both clocks read the insights foundation (20260940000000) — never
created_at + status, never order prices as "cash":

| clock | what it is | revenue |
|---|---|---|
| **cohort** (default) — "Продажби во периодот" | the sales MADE in the period (sale day, Skopje; `insights_sale_rows`) and what MEX collected on them | value of the collected part: MEX Delivered (`paid`) + `paid_legacy` (operator ruling / legacy import). Returned / open / unproven are shown apart, never revenue |
| **cash** — "Пари што пристигнаа" | the MEX money DELIVERED in the period, any sale day (`insights_cash_rows`) | parcel COD + the card money of a card-paid web order |

The cohort strip ties to `insights_cohort` bucket by bucket; cash ties to its
`cash_flow`. `scripts/verify-tab-profit.mjs` proves both (read-only).

```
+ revenue        (above; денари, parcel COD / price × 61,5 / shop total)
− VAT            PER LINE (owner 01.10.2026, docs/VAT.md — the flat 18 % of 28.09 is withdrawn):
                 Σ line value × r / (1 + r), r = the line's product rate from Sigma
                 (products.vat_rate: 5 % supplements, 18 % cosmetics / devices); a line with
                 no product or no rate at 5 % (DEFAULT_VAT_RATE) and reported as unclassified
− COGS known     Σ packages × products.cost_price (> 0 only) × 61,5
− COGS estimated uncosted revenue × (known COGS ÷ costed revenue) of the same view — LABELLED
− courier        delivered parcels × 150 ден
− returns        returned parcels × the rate card's return fee (MEX: 0)
− lead cost      the slot stays wired at 0 — "not configured" until per-webmaster rates exist
− commission     TODAY'S rule, unchanged (see elyon-agent-commissions): orderPackageBonus()
                 on every order whose status is paid, only when its owner
                 (confirmed_by_name ?? assigned_agent_name, normAgent) is an agent who is
                 not admin / manager. Shown as a cost line, labelled — payout math untouched.
= net profit, margin % of revenue
```

- **Lines.** Every sale is split into its lines (order_items · web_order_items ·
  one pseudo line for a MEX parcel with no order = "contents unknown"); the sale's
  value is split by price weight (ppu × qty, else total_price; all zero → by
  packages), so Σ lines = the sale value to the denar.
- **Keys.** `product_key()` (the line's product_id, else a `product_aliases` row —
  ANY row: `reviewed_by` is never read, so an applied alias counts at once; all
  1.744 aliases are unreviewed on 29.09), else the catalogue product whose
  `product_alias_norm(name)` is exactly the line's (case / spaces ignored), else
  `n:<name>`. The comments in the SQL still say "reviewed alias" — the bodies do
  not filter on it.
- **Kinds.** An alias's `kind` decides. Without one, the obvious collabBox / CRM
  non-product lines are recognised by name — `поен…` loyalty points, `достав…`
  delivery charge, `забелешк…` note, `флаер…` flyer — and are NOT packages;
  a web GIFT line is a gift. A product / gift line with no price weight in a
  priced sale is a FREE package.
- **Cost coverage.** In September 2026 only ~33 % of packages had a
  `cost_price` (the teleshop / Bionatural catalogue has none; the AlterCPA
  offers all carry €2,93, which looks like a placeholder). The owner sets cost
  prices later; every product created on 28.09 (the 8 AlterCPA offers and the
  325 of `complete-catalogue.mjs`) has cost 0. The tab therefore
  shows THREE honest numbers: net with uncosted packages estimated (headline,
  hatched), net on the costed packages alone, and the upper bound with
  uncosted at 0. **Never invent a cost** and never let an uncosted product
  read "above target".
- **Margins (Маржи)** reads the same payload: per-package economics per product
  (its own VAT, known cost, courier share, commission share) and the floor price
  `P = (1+r)(target + cost + courier + tier(P) × 61,5 × γ)`, r = **the product's** Sigma
  rate (`productVatRate`), γ = the share of the product's packages today's rule actually
  pays commission on. No cost → no floor. The simulator starts at the product's rate.

## VAT per product (owner decision 01.10.2026 — `docs/VAT.md`)

- **There is no flat rate.** `products.vat_rate` (0 / 0.05 / 0.10 / 0.18; NULL = unclassified)
  from the Sigma ERP (`Item.VatId`: 2 = 5 % food supplements, 1 = 18 % cosmetics / gels /
  creams / oils / devices / chia drinks), backfilled for all 706 products by
  `20260944000900_product_vat_rate.sql` from `docs/vat/crm_products_vat.json` (the table holds
  the CORRECT rate even where Sigma is wrong; `vat_source` / `vat_evidence` keep every row
  traceable). Written only by `products_set_vat_rate()` (guard trigger, audited, owners via
  `POST /api/products/vat-rate`).
- **`insights_profit()` taxes each LINE** (`rv` × r/(1+r)): agg measures `vt` (VAT), `vc` (VAT of
  the costed part — the waterfall's costed basis), `vu` (value with no rate, at 5 %),
  `v00`/`v05`/`v10`/`v18` (value by rate); products `vt`/`vr`/`vd`; `vat_mode: 'per_line'`.
  `insightsProfit.ts` uses them (`vatOf`); an older body answers `flat_default` (5 % on all,
  labelled). P&L rows carry `vat_split`, `vat_unclassified`, `vat_costed_mkd`; `meta.vat` =
  `{mode, default_rate, by_rate, effective_rate, unclassified}`; the quality rail item
  `vat_unclassified`.
- **Cache version 5** since `20260944000900` (nothing cached with the flat 18 % is merged); the
  cache signature includes every `vat_rate`, so an owner's change invalidates the months.
- **September 2026 (cohort):** VAT 2.393.066 ден at the flat 18/118 → **764.811** per product
  (−1.628.255; effective 5,13 % of net revenue). Proof: `node scripts/vat/compare-vat.mjs`.
- The legacy `/management-insights` blocks: VAT per product NAME (`vatRates.ts`
  `vatRateByName` / `vatOfNamedRevenue`); channel rows get the window's VAT share of their cash.
- Red flag: any `× 0.18 / 1.18`, `VAT_RATE`, `VAT_CONFIRMED` or other flat rate on a sale.

## The monthly cache for long windows (migration 20260942000200)

- A window over **62 days** reads whole CLOSED months from
  `insights_profit_monthly` (one row per month × clock = exactly what
  `insights_profit()` returns for that month, granularity month) and computes
  only the partial first month and the current month live; `insightsProfit.ts
  loadProfitClocks / mergeProfitRpcs` add the pieces. Every block is a sum per
  key, so the result is IDENTICAL to one live call — proven by
  `node scripts/verify-tab-profit.mjs --cache --from … --to …` (a year and
  01.04–27.09.2026: identical). Year window: ~5 s → ~1,5 s.
- What keeps it additive (do not undo): a shared parcel counts 1/holders over
  ALL its holders; sums leave SQL with 9 decimals; the api rounds to denars
  once, snapped to 0,0001; product name / kind = byte-order minimum (COLLATE "C").
- Freshness: a row is used only while `version` = `insights_profit_cache_version()`
  (bump it when the P&L logic changes) and `sig` = `insights_profit_cache_sig()`
  (catalogue names / cost prices / VAT rates, every alias row, test phones — entering
  a cost price, changing a VAT rate or applying an alias invalidates every month).
  **Version is 5** since `20260944000900` (per-product VAT); it was 4 since
  `20260942001000` (six departments: a month cached with five sources had no
  `teleshop_out` block); the cache was refreshed by hand at v4 on 29.09, and the
  last 6 months again after the collabBox history backfill. The cache
  sums per SOURCE, and a department reclass (`reclass-by-folder.mjs`,
  `reclass-department-sources.mjs`) moves `sale_source` without touching
  `orders.updated_at` — the nightly job cannot see it, so refresh the affected
  months by hand after any reclass. Closed months still move (late MEX, repairs):
  the nightly cron `insights-profit-monthly` (03:40 Skopje, DST-proof gate)
  refreshes the last 3 closed months, every month `insights_profit_touched()`
  flags since its refresh, stale version / sig, and missing months of the last
  24; owners refresh a window by hand (POST /api/insights/profit/refresh). The
  tab says "cached until dd.mm HH:mm".

## Money display

Денари only (elyon-currency): the api sends whole денари (`*_mkd`), rendered with
`formatDenari`. EUR exists only as the stored catalogue prices, cost prices, the
rate card and the bonus tiers, converted once at the FROZEN 61,5 peg.

## Where it lives (keep in sync)

- SQL: `insights_profit(p_from, p_to_end, p_clock, p_granularity, p_detail)` —
  migration `20260941000300_insights_profit.sql` (read-only, service_role).
- API: `supabase/functions/api/insightsProfit.ts` (+ `.test.ts`), route
  `GET /api/insights/profit` in index.ts (owners only; 403 owners_only otherwise).
- UI: `src/components/insights/profit/*` (Pure Profit), `src/components/insights/margins/MarginLabTab.tsx`,
  client `src/lib/insightsApi/profit.ts`.
- Rate editor: `CourierRatesTab` in `src/pages/SettingsPage.tsx` → `GET/PATCH /api/courier-rates`.
- The old `/api/management-insights` `pure_profit` / `margin_lab` / `channel_pl`
  blocks and their SQL twins (`insights_orders_rollup`, `insights_paid_basis`,
  `insights_channel_pl`) still feed the Payout tab and the parity harness — do not
  change them; the Pure Profit tab no longer reads them.

## Red flags (stop and correct)

- "Cash" = order prices of rows the CRM calls paid, windowed by created_at.
- Any courier cost for Macedonia that is not the `mex` row (Speedy / Econt / a blend).
- Charging COGS on a returned parcel.
- An uncosted product at 0 cost presented as real margin, or as "clears the target".
- Revenue from `paid_unproven` (CRM paid, no delivered parcel) in the profit.
- Mixing the two clocks in one number, or a figure without its clock caption.
- Changing the commission formula or its gate here (deferred by the owner).
- Hardcoding a courier rate in code instead of reading `courier_rates`.
- A flat VAT rate on a sale (`× 0.18 / 1.18`, a `VAT_RATE` constant) — VAT is per product (`docs/VAT.md`).

---

## Inherited Bulgarian calibration (history — NOT Macedonian costs)

Calibrated 2026-06-05 from BigArena's per-order fee ledger (155 orders). Speedy /
Econt do not operate for Natura Therapy MK.

| Courier | Service | Deliver | Return (round-trip) |
|---|---|---|---|
| econt | office | 3.05 | 5.32 |
| econt | door | 4.56 | 7.36 |
| speedy | office | 2.48 | 4.24 |
| speedy | door | 3.21 | 5.70 |
| *unknown* | *BG fallback* | 3.50 | 6.00 |

`orderLogisticsCost()` / `resolveCourierService()` in index.ts still carry this
logic for the old /management-insights blocks (terminal status → exactly one
bucket: shipped / delivered / paid → deliver, returned → return round-trip).
