---
name: elyon-agent-commissions
description: Use when building, changing, or explaining agent bonus / commission / payout calculations in Elyon CRM. Sacred rules — the bonus is earned on EVERY PAID order (the only gate is status=paid; source — prediction list, pending, or manual — does NOT matter), counted PER PACKAGE (not per order), tiered by each line's unit price (<25€→1€, 25–35€→2€, ≥35€→3€), every package earns with NO minimum, credited to the ONE first-confirming AGENT (super-admins earn nothing). Two duplicated calc sites must always change together — prefer the shared helpers.
---

# Elyon Agent Commissions & Payouts — Sacred Rules

Operator-defined per-package pay for the agents. This skill exists so the bonus math is never re-derived from memory or split-brained between the two endpoints that report it.

## The Rule (current spec — 2026-06-04, clarified by operator)

A bonus is earned when:

1. **Status is `paid`.** COD cash actually collected. Confirmed/shipped/returned/cancelled earn nothing. **This is the ONLY gate.**
2. **Source does not matter.** Prediction-list, pending-queue, and manually-created orders all earn equally. There is **no prediction-list gate and no agent-role gate** on the bonus. (The `prediction_list_id` attribution still exists, but it only drives the separate "which list made the money" analytics — it does **not** affect the bonus.)

The bonus is credited to **exactly ONE owner per order** = the first agent who confirmed it (`confirmed_by_agent_id`), falling back to the assignee (`assigned_agent_id`) only for legacy rows that never recorded a confirmer. Use the shared `salesOwnerId(o)` / `salesOwnerName(o)` helpers — **never** attribute an order to both its assignee and its confirmer (that double-counts the sale + bonus). The bonus is **per package**, tiered by **that line item's unit price**:

| Package unit price | Bonus per package |
|--------------------|-------------------|
| `< 25€`            | **1€**            |
| `25€ – 35€` (`>25` and `<35`) | **2€** |
| `>= 35€`           | **3€**            |

- **Quantity multiplies.** A line of 3 units at 35€ = `3 × 3€` = **9€**.
- **Every package earns. There is NO minimum package count.** (The old "≥2 packages per order" gate was removed on 2026-06-04.)
- A whole order is just the sum of its line items' package bonuses.
- **Legacy orders with no `order_items`**: fall back to `unit = price / quantity` and bonus = `rate(unit) × quantity`.

### Only AGENTS get paid — super-admins earn nothing (2026-06-05)

The recipient must be a real agent (`agent` / `pending_agent` / `prediction_agent`). A super-admin earns **€0**. **A super-admin = anyone with the `admin` OR `manager` role — and they earn nothing EVEN IF they also hold an agent role.** (Founders like Miki hold *every* role: `admin, manager, agent, pending_agent, …` — so the gate must be "has agent role AND NOT (admin or manager)", never just "has agent role", or they leak back onto the payout.) Two protections, both required:

1. **Credit is immutable once an agent holds it.** When a super-admin (Mile/Miki) edits an agent's order and re-confirms it, `confirmed_by_*` is **not** overwritten — the status-PATCH guard only sets it when it's still empty (`!order.confirmed_by_name`). So the first agent keeps the sale + bonus.
2. **Payout is gated on agent role.** `payout_earned` is 0 for non-agents, and the Pure Profit `agent_commissions` / per-list `bonus_paid` cost only counts orders whose `salesOwner` is an agent (a super-admin-confirmed order costs the business nothing because nothing is paid out). The escape hatch to move credit is the admin-only `POST /orders/:id/attribution`.

### Worked examples

| Order | Packages | Bonus |
|-------|----------|-------|
| 3 × 35€ (one line, qty 3), paid | 3 | 3 × 3€ = **9€** |
| 1 × 35€, paid | 1 | **3€** (no minimum) |
| 2 × 30€ + 1 × 20€, paid | 3 | 2×2€ + 1×1€ = **5€** |
| 3 × 35€, paid, manual / pending-origin / prediction — all the same | 3 | **9€** (source is irrelevant) |
| 3 × 35€, status `shipped` (not yet paid) | 3 | **0€** (not paid) |

## Where it lives (CHANGE BOTH — they must never diverge)

The math is centralized in **shared module-level helpers** at the top of `supabase/functions/api/index.ts`:

- `packageBonusRate(unitPrice)` — the 1 / 2 / 3 tier function.
- `orderPackageBonus(order)` — per-package bonus for one order (returns 0 unless `status === 'paid'`).
- `calcAgentBonus(orders)` — sum across a set of orders, rounded to the cent.

Two endpoints consume them and **must always agree**:

1. `GET /api/agent-performance` → per-agent `payout_earned` (shown on `AgentPerformancePage.tsx`).
2. `GET /api/management-insights` → per-agent `payout_earned`, Pure Profit `special_agent_commissions` (= sum of all agents' per-package bonus), and per-list `bonus_paid` in the Prediction Lists tab (`ManagementInsightsPage.tsx`).

If you change the tiers or the rule, change **`packageBonusRate` / `orderPackageBonus` only** — both endpoints inherit it automatically. Never reintroduce a local per-handler copy of the calculator.

## Required data on the order objects

Any query feeding the calculator MUST select: `status` and `order_items(price_per_unit, quantity)` (plus `price`, `quantity` for the legacy fallback). If `price_per_unit` is missing from the select, bonuses silently read as 1€/package — a classic bug.

## Bonus vs. prediction-list attribution (keep them separate)

`prediction_list_id` is snapshotted onto orders at creation by `resolvePredictionAttribution(phone)` and drives the **"which list made the money" analytics** (Prediction Lists tab). It is **independent of the bonus** — do NOT gate the bonus on it. (Earlier drafts of this skill gated the bonus on attribution; the operator clarified on 2026-06-04 that every paid order earns regardless of source.) See [[elyon-segments-and-prediction]].

## Red Flags (stop and correct)

- A flat bonus per **order** instead of per **package**.
- Any `pkgs < 2` / minimum-package check.
- Attributing one order to **both** assignee and confirmer (double-counts sale + bonus). One owner only — use `salesOwnerId`.
- Paying a **super-admin** (admin/manager, not an agent) any bonus, or letting a super-admin re-confirmation overwrite the first agent's `confirmed_by_*`.
- Gating the bonus on `prediction_list_id` / source, or on whether the order is `paid` — the gate is `status === 'paid'` (every source earns). The *recipient* must still be an agent.
- Paying out on non-`paid` statuses.
- A second copy of the tier logic inside a handler (must use the shared helpers).
- Selecting orders without `price_per_unit`.

## Money display

Payout/bonus amounts are stored in EUR and shown to staff in денари with `formatMoney` (the frozen 61.5 peg) — see [[elyon-currency]]; the only EUR display is affiliate (CPA) payout. There is no lev in this market. (The Agents tab's bare-EUR `fmt()` is a known display bug from the 28.09 audit; the payout/bonus math itself is deferred by the owner — do not touch it.)

## Packages sold vs awaiting (2026-07)

- **`packages_sold`** = units on **`status = paid` only** (COD collected). Never include confirmed/shipped.
- **`packages_awaiting`** = units on confirmed / shipped / delivered.
- **`packages_returned`** = units on returned orders (report next to returned *order* count).
- Earnings windows prefer **`paid_at`** (fallback `created_at` if null).

Shared helpers (module-level in `api/index.ts`): `unitsOf`, `packagesSoldOf`, `packagesAwaitingOf`, `packagesReturnedOf`, `paidRevenueOf`, `inPaidWindow`.

Surfaces that must agree: `/api/agent-performance`, `/api/dashboard-stats`, `/api/management-insights` (agent `packages_sold`), Discord `perf.ts`, Insights → Agents, Pure Profit agent table, My Performance dashboard.

## Settlement ledger (mark paid)

Tables: `agent_payouts` + `agent_payout_items`. History is **never deleted** — void only.

- Unpaid = paid packages **not** on a `status=paid` settlement item.
- Admin UI: Insights → **Payout** tab. Endpoints under `/api/agent-payouts/*`.
- Agents see own earnings on Dashboard + self-scoped Agents tab (`performance` module view).

**This rule has shifted before and may shift again (a separate pending strategy may come later). Treat this skill as the single source of truth and update it in the same change that updates `packageBonusRate` / `orderPackageBonus`.**
