---
name: elyon-currency
description: Use when touching any price, total, cost, payout, commission, COD amount, revenue figure or money input in the Macedonian Elyon CRM. Money is STORED in EUR and shown in Macedonian denari, derived from a frozen constant. There is no lev and no dual display; the single euro exception is affiliate (CPA) payout, which partners invoice in euro. Read before writing any money UI, any money input, or any export column.
---

# Elyon Currency Skill — MACEDONIA

**Stored in EUR. Shown in денари. Never both, never euro.**

> Two corrections to older versions of this file, which described a different market:
> Macedonia is **not** euro-native (that was the Kosovo phase of this deployment), and the
> Bulgarian lev peg does not apply either. `formatEur` and `formatLev` no longer exist.

## The model

| | |
|---|---|
| **Database / API** | EUR, cent precision. This is an internal accounting unit. |
| **Everything a human sees** | Macedonian denari only — with ONE documented exception, below. |
| **Conversion** | `MKD_PER_EUR = 61.5` in `src/lib/currency.ts`, applied at render time. |

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

Two other copies of the constant must stay in step: `supabase/functions/api/index.ts` (webhook FX)
and `scripts/reprice-catalogue-mk.mjs`. Only the `src/lib` one is test-guarded — another reason not
to touch any of them.

## Helpers — `src/lib/currency.ts`

| Function | Returns | Use for |
|---|---|---|
| `formatMoney(eur)` | `"2.490 ден"` | **Every** money value shown to a user |
| `eurToDen(eur)` | `2490` (integer) | Prefilling a denar input; export columns |
| `denToEur(den)` | `40.49` (2dp) | Reading a denar input back before sending to the API |
| `codFor(eur)` | `{ amount, currency: 'MKD' }` | The courier COD figure — returns amount **and** currency together so they cannot be exported apart |
| `formatEurExact(eur)` | `"€40.49"` | **Affiliate/CPA partner surfaces only** — see below |

`formatPriceInline` is an alias of `formatMoney`, kept for old call sites.

## Rules

1. **Displaying money → `formatMoney`.** Never hand-format, never print a bare number, never add a
   currency symbol yourself.
2. **A money INPUT takes денари.** The field holds denars; convert with `denToEur` on the way to the
   API and `eurToDen` on the way in. Put a `ден` adornment on the field. This applies to product
   prices, order line prices and totals, courier rates, leaderboard bonus tiers, prediction value
   brackets, the Margin Lab target and simulator, and payout amounts — all already converted.
   *Never* label a field `ден` while it still writes a raw EUR number; that is a live money bug.
3. **Whole-denar values round-trip exactly** (verified for 1–20 000), so `denToEur(eurToDen(x))` is
   safe for anything an operator can type. Prefer whole denars; use `step={1}`.
4. **Export columns must name the currency** — `Total_Price_MKD`, `Revenue (MKD)`. A bare number in
   a CSV is the ambiguity `codFor()` exists to prevent.
5. **Calculations stay in EUR.** Convert only at the display or input boundary, never in the middle
   of a computation, or rounding compounds.

## The one legitimate exception: affiliates

`formatEurExact` and the `payout_eur` / `price_eur` fields under `src/components/affiliates/**` are
**deliberately EUR**. Affiliate and CPA partners are external companies on euro-denominated
contracts; their payouts are a real euro obligation, not Macedonian retail pricing. Leave those
surfaces alone — converting them would misstate what the partner is owed.

Everything else in the product is denar-only.

## Red flags (stop and correct)

- A `€` in any staff- or customer-facing string outside `src/components/affiliates/**`.
- Any `лв`, `BGN`, `1.95583`, `formatLev`, `eurToLev` — Bulgarian leftovers.
- An edit to `MKD_PER_EUR`, or a live FX fetch.
- A price input labelled `ден` that stores what the user typed without `denToEur`.
- Storing a denar amount in a price column (they are EUR columns).
- A money column in a CSV with no currency in its header.

## Commission tiers depend on the EUR unit price

`packageBonusRate` in the edge function reads `order_items.price_per_unit` **in EUR**:
`<25€ → 1€`, `25–35€ → 2€`, `≥35€ → 3€`. In denar terms the boundaries fall at **1.538 ден** and
**2.153 ден**. Re-pricing across one of those lines changes what every agent is paid per package —
check before moving a price near them. The tier table is duplicated in
`src/components/insights/MarginLabTab.tsx`; change both.
