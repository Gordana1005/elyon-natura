# Audit findings — weak spots, dead code, bugs, risks

> A full read of the repo on **2026‑05‑23**. Each item has a severity, evidence (file:line), and a
> **proposed** fix. Ordered by priority within each section.

> **✅ Fixed 2026‑05‑23 (this batch)**
> - **A1** `userId` bug → `user.id` in both lead‑distribution handlers (`api/index.ts`).
> - **A2** `orders/stats` now paginates (`.range()` loop) — Dashboard counts no longer truncate at 1000.
> - **B1/B2** CLAUDE.md corrected (fulfilment CSV = comma + no BOM; stock decrement = 2 endpoints/4 blocks, not `POST /orders`) + a pointer to `docs/`.
> - **C** dead code removed: `src/data/mockData.ts`, `src/pages/AdsPanelPage.tsx`, `src/components/calls/CallSearchPanel.tsx`.
> - **D4** `src/integrations/supabase/types.ts` regenerated (1462 → 1978 lines; now includes courier_offices, customer_profiles, segment members, shift_breaks, active_call_views, etc.).
>
> Verified: `npm run build` ✅ and `npm test` ✅. **The backend (A1/A2) requires an Edge‑Function deploy
> to reach production:** `npx supabase functions deploy api --project-ref bmfxhgznttcnnlqloqzp`.
> Not yet committed/pushed. Still open: A3 (atomic stock helper), A4 (dossier caps), D1/D2 (tests + lint‑in‑CI), D3 (split index.ts), the Ads decision (revive vs remove endpoints), permission‑fallback seeding.

Health snapshot: **build ✅** (`npm run build`, ~8 s) · **tests ⚠️** (1 trivial test passes — no real
coverage) · **lint ❌** (`npm run lint`: 643 errors / 35 warnings, ~623 `no-explicit-any`; **CI doesn't run
lint** so it doesn't block).

---

## A. Real bugs (fix these)

### A1 — `lead-distribution-config` PATCH & `auto-assign` reference an undefined `userId` → 500  · **HIGH** · ✅ FIXED 2026‑05‑23
The handler scope defines `user` (`{id,email}`), not `userId`; referencing `userId` threw a
`ReferenceError` → **500**. Both handlers now use `user.id`.

**Superseded 2026‑08‑13.** Fixing the 500 only revealed that the engine had never actually worked:
`is_active` was read by nothing, no scheduler existed, `round_robin` dropped the rest of a batch once
one agent hit the cap, the candidate query had no lead‑source filter (it would have handed out the
80.360 legacy `source_type='import'` rows), and both the candidate pull and the load tally were
silently truncated at 1000 rows. In the whole 87k‑row `orders` table only **80** rows had ever been
assigned, all in one manual burst on 2026‑08‑06. The engine was rewritten in SQL — migration
`20260921000000_lead_distribution_engine.sql`; see [BACKEND_API.md](BACKEND_API.md#lead-distribution)
and `.grok/skills/elyon-assigner`.

### A2 — `GET /orders/stats` is not paginated → 1000‑row truncation  · **MEDIUM**
`index.ts:2475‑2483` does a single `from('orders').select(...)` with **no `.range()` loop**, unlike every
other analytics endpoint. It's **live** — [../src/pages/Dashboard.tsx:168](../src/pages/Dashboard.tsx#L168)
calls `apiGetOrderStats()`. Over a date range with >1000 orders the status/agent/day counts under‑count
silently.
**Fix:** wrap the read in the same `paginate()` `.range(from, from+999)` loop the other handlers use (or
compute counts with `count: 'exact'` head queries per status).

### A3 — Stock loops are N+1  · **LOW now / MEDIUM at scale**
In `PATCH /orders/:id/status` and `bulk-status-update`, each item triggers two `products` selects + an
update + a log insert in a loop (e.g. `index.ts:1718‑1775`, `1403‑1475`). Fine for today's small orders;
a large bulk ship will be slow and is non‑transactional (a mid‑loop failure leaves partial deductions).
**Fix:** batch‑fetch products by id once, compute, then batch‑update; ideally wrap in an RPC/transaction so
stock + log + status flip are atomic.

### A4 — `customer-intelligence` dossier caps  · **LOW**
`index.ts:6295‑6308` limits orders/leads to 100 and co‑purchase scans to 500/1000. A very heavy repeat
customer's lifetime totals/recommendations will be computed from a truncated set.
**Fix:** paginate the per‑phone reads (the candidate set is small, so it's cheap).

---

## B. Documentation drift (the docs disagree with the code)

> These are why this doc set exists. The new docs in `docs/` reflect the **code**; the items below are
> places the older docs ([../CLAUDE.md](../CLAUDE.md), [how-it-works.md](how-it-works.md),
> [CALLING_PLAN.md](CALLING_PLAN.md), [../README.md](../README.md)) are now wrong.

| # | Drift | Reality | Sev |
|---|---|---|---|
| B1 | CLAUDE.md & how‑it‑works: "Fulfilment CSV = **semicolon + UTF‑8 BOM**, never change" | The fulfilment export is **comma + NO BOM** (`Orders.tsx` → `toCsv(eligible, [...], ',', false)`). Only the *generic* `toCsv` defaults to `;`+BOM. | MED (could cause a wrong "fix") |
| B2 | CLAUDE.md: "Stock decrement lives in **4 places incl. `POST /orders`**" | `POST /orders` does **not** touch stock (can't create as shipped). It's **2 endpoints / 4 blocks** (PATCH status + bulk, shipped+returned). | LOW |
| B3 | CALLING_PLAN.md: carrier undecided (A1 Cloud PBX vs Zadarma vs WebRTC); A1 answers "TBD" | A1 **"Business Voice" SIP trunk is signed** (2026‑05‑20): 4 channels, 10 DIDs, 5000 min/mo, €160.03/mo. Path II locked. | MED (superseded by [CALLING_PLAN_SIP.md](CALLING_PLAN_SIP.md)) |
| B4 | README.md: "35 migrations / 26 pages"; types.ts described as schema source | ~70 migrations, ~30 page files; **types.ts is stale** (missing ~10 tables + many columns). | LOW |
| B5 | RESUME.md "to‑harden" list (HMAC, CORS, code‑split, RQ defaults) | All **done**. (Re‑verify the `notifications` INSERT policy + config‑table read locks.) | LOW |

**Fix:** update CLAUDE.md's "Things NOT to break" (CSV delimiter, stock count) and retire/redirect the old
`CALLING_PLAN.md` and `how-it-works.md` to the new docs. Regenerate `types.ts`.

---

## C. Dead / unused code (safe‑to‑remove candidates)

> Verify each with a project‑wide search before deleting (a couple are only *probably* unused). None of
> these are loaded by the app's routes today.

| Item | Evidence | Verdict |
|---|---|---|
| [../src/data/mockData.ts](../src/data/mockData.ts) | `export const mockData` has **no importers** anywhere in `src` | **Dead** — Lovable scaffolding leftover. Remove. |
| [../src/pages/AdsPanelPage.tsx](../src/pages/AdsPanelPage.tsx) | **Not routed** in `App.tsx`; `/ads` redirects to `/webhooks` | **Dead page.** The `ads-campaigns`/`ads_audit_logs` tables + endpoints still exist but no UI renders them. Decide: revive Ads or remove the page + endpoints. |
| [../src/components/calls/CallSearchPanel.tsx](../src/components/calls/CallSearchPanel.tsx) | No importers found | **Probably dead** (superseded by the topbar dial input on the Calls page). Verify, then remove. |
| `scripts/analyze-*.mjs`, `test-raw-read.mjs`, `find-outbound-section-headers.mjs`, `cpa-analysis.json`, `*-import-*.txt` logs | One‑shot import scoping aids; logs are gitignored | **Archival** — keep in a `scripts/_archive/` or delete. Not used by anything live. |
| Legacy `POST /webhook/leads` | `index.ts:435` | **Intentional back‑compat** — keep unless you confirm no page posts to it. |
| `/predictions` route + PredictionListsPage (XLSX upload) | `App.tsx:84‑85`, hidden from sidebar | **Intentional legacy** — superseded by `/segments` ("Prediction Lists" in the UI). Keep or formally retire. |

**Dead routes/endpoints:** every `api.ts` wrapper maps to a live endpoint; the main orphan is the **Ads
module UI** (B/C above). Recommend a one‑off `ts-prune`/`knip` pass to catch unused exports across `src`.

**Dead webhooks (data):** `scripts/audit-webhooks.mjs` flags webhooks whose slug no longer maps to an active
product; `delete-stale-webhooks.mjs --commit` removes them. Run periodically (re‑run `create-webhooks-for-products`
after catalogue changes).

---

## D. Maintainability & quality

| # | Item | Detail | Sev |
|---|---|---|---|
| D1 | **No real test coverage** | Only `src/test/example.test.ts`. Stock decrement, `applyOutcomeToOrder`, segment rules, the fulfilment CSV, phone normalisation, and HMAC are all untested. | MED |
| D2 | **Lint is red & ungated** | 643 errors (≈623 `no-explicit-any`) + hook‑dep warnings; CI runs build+test only. | MED |
| D3 | **7,325‑line `index.ts`** (~14,900 as of 2026‑07‑28 — the finding has doubled, not aged out) | One file, path‑dispatched; hard to navigate, easy to merge‑conflict. Stock logic duplicated 4×. | LOW |
| D4 | **Stale `types.ts`** | App uses untyped `apiFetch`, so unbroken — but regenerate to restore type safety. | MED |
| D5 | **Bundle size** | Main `index` chunk ~526 kB (>500 kB warn); `xlsx` 429 kB, recharts `AreaChart` 413 kB (both lazy/own‑chunk). | LOW |
| D6 | **In‑memory rate limits** | Reset on cold start; don't coordinate across instances. | LOW |
| D7 | **Hardcoded permission fallbacks** | `calls/recordings/segments/products/webhooks` aren't seeded in `module_settings`; `PermissionsContext` short‑circuits them. | LOW |

**Proposed fixes:** add a vitest suite for the pure logic (currency, phone normalise, outcome→status,
segment‑rule cases, CSV columns) and a couple of endpoint integration tests; add `npm run lint` to CI as a
**warning** first, then tighten the worst `any`s in `lib/api.ts`; consider extracting the stock logic into
one helper (touch all 4 blocks at once) and splitting `index.ts` by domain when convenient; regenerate
types; seed the permission fallbacks and remove the short‑circuits.

---

## E. Operational risks (not bugs, but watch them)

- **`WEBHOOK_SECRET` fail‑open** if unset (`index.ts:7195`) — it's set today; consider failing **closed** in
  production so a misconfig can't silently accept unsigned leads.
- **Single carrier / single PBX** for telephony — fine to launch; plan a fallback (Zadarma was the parallel
  option) and a 2nd VPS only if volume grows ([CALLING_PLAN_SIP.md](CALLING_PLAN_SIP.md)).
- **Founding accounts** seeded with `12345678` — confirm rotated.
- **Manual Edge‑Function deploy** — a schema/role change that isn't redeployed silently diverges from the
  frontend. Keep deploy + migrate in the same change.

---

## F. What's solid (so you don't "fix" it)
- HMAC on all webhooks, locked CORS, append‑only `audit_log`/`order_history`, sanitised DB errors, zod
  validation, last‑8 phone matching, the segment trigger engine, paginated analytics (except A2), the
  EUR/BGN peg discipline, and the deliberate VOIP mock seam. These are working as designed — leave them.

---

## G. Suggested order of work (when you greenlight changes)
1. **A1** (`userId` → `user.id`) — quick, unblocks Lead Distribution. 
2. **A2** (paginate `orders/stats`) — quick, fixes Dashboard accuracy.
3. **B1/B2** (correct CLAUDE.md; retire old CSV/calling docs) — prevents future wrong "fixes".
4. **C** (delete `mockData.ts`, decide Ads, prune dead components) — reduces noise.
5. **D4** (regenerate types) → **D1/D2** (tests + lint in CI) — restores guardrails.
6. **A3** (atomic stock helper) before call/order volume scales.
