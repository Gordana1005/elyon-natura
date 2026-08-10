---
name: elyon-affiliates
description: Affiliate/CPA lead-intake system — webmaster API keys, offers/payouts, lead stages, postback delivery. Read before touching /cpa/* endpoints, affiliate tables, payout math, the postback queue, or the affiliate portal/admin pages.
---

# Elyon Affiliates — how the CPA program works

AlterCPA-Moe-style program shipped 2026-07-09 (operator decisions final; all live).

## The five decisions (do not re-litigate)

1. Affiliates have REAL Supabase logins with `app_role` **'affiliate'** — an EXTERNAL identity, excluded from `admin_grant_all_roles()`. Their S2S **api_key** (`affiliates.api_key`, `aff_`+64hex) is a separate credential.
2. **Leads-only** (no click tracking). Clicks live in the affiliate's own tracker.
3. **Payout is earned at the FIRST CONFIRMATION and is STICKY FOREVER** (operator decision 2026-08-10, reversing the old COD-buyout gate). Read off `orders.confirmed_at` (stamped once on the first flip into a real status, never overwritten, never NULLed) with a defensive `OR status ∈ REAL_ORDER_STATUSES` for legacy rows — see `affiliateEarned()`/`affiliateDisplayStage()` in the edge fn. A later cancel / trash / return NEVER removes it: the affiliate's job ended at confirmation, a failed delivery is our loss. Survives attribution corrections (that tool re-points WHO confirmed, never WHETHER/WHEN). Still `affiliate_leads.payout_eur_snapshot` (frozen at intake), NEVER `calcAgentBonus`/order price. **Agent commissions stay paid-gated** — the two gates now differ BY DESIGN. Display: `hold` renders "Approved". Money is shown in **EUR** to the partner (payout_eur_snapshot is euro), the one exception to this market's denari-only UI.
4. Portal shows the affiliate their own leads with **phone masked to last 4**.
5. **Managers are read-only** in `/affiliates-admin`; every mutation (create, rotate key, offers, payouts, retry) is admin-only server-side.

## Status map (single source of truth ×2 — keep in sync)

SQL `public.affiliate_stage()` (migration 20260801000200) ≡ TS `CPA_STAGE` (edge fn):
`pending/take/call_again→wait · confirmed/shipped/delivered→hold · paid→approve · cancelled→cancel · trashed→trash · returned→return`.
Same-stage transitions fire NO postback. Keitaro `{status}`: wait/hold→`lead`, approve→`sale`, cancel/trash/return→`rejected`.
A status with **no** stage (`duplicated`, anything added later) is intentionally silent — the trigger has an explicit `IF _event IS NULL` guard (20260904000020), not an exception.

**SCOPE (2026-08-10): this map is LOGISTICS truth and drives postbacks + the partner S2S `GET /cpa/leads` ONLY.** Every payment surface — the portal, `GET /affiliate/stats|leads`, the staff `GET /affiliates*` routes and the admin Dashboard tab — is decoupled from it and goes through `affiliateEarned()` / `affiliateDisplayStage()` / `applyAffiliateStageFilter()` instead. Changing one must never change the other. Consequence, by design: **the partner's own panel may show `return` on an order our portal still counts as Approved and earned.** Display stages are only `wait / hold / cancel / trash`; `approve`/`return` are legacy aliases folded onto `hold` (edge fn filter + `normalizeStage()` in the SPA) for one release.

## Two postback formats — `affiliates.postback_format`

`generic` (default) renders the partner's macro template. **`altercpa`** ignores macros and builds the AlterCPA advertiser-API query itself (20260904000200). Networks like cpa.toys / cashfactories.com are **not trackers** — they want numeric codes:

| event | params appended to `…/api/comp/edit.json?id=<token>` |
|---|---|
| `lead` | `oid=<ext_id>&status=2` |
| `hold` | `oid=<ext_id>&accept=1` ← **never** a status number |
| `ship` | `oid=<ext_id>&status=7` |
| `approve` | `oid=<ext_id>&status=10` |
| `return` | `oid=<ext_id>&status=11` |
| `cancel`/`trash` | `oid=<ext_id>&status=5&reason=<numeric>` |

`status.json` is auto-rewritten to `edit.json` (only `edit.json` carries numeric statuses/reasons). **`ship`** is an altercpa-only event — the stage model collapses confirmed/shipped/delivered, so confirmed→shipped otherwise fires nothing. Reason codes live in `affiliates.altercpa_reason_map` (per-affiliate: **each network configures its own table**; cpa.toys and cashfactories already diverge on 15/18/19). `rude`/`uncooperative` → `2`, deliberately **not** a trash code — operator decision, trash costs the webmaster their approve-rate. The unchanged-URL dedup is **skipped** in altercpa mode (status APIs are idempotent; dedup would swallow confirmed→cancelled→confirmed).

## HTTP 200 does NOT mean delivered

AlterCPA-family endpoints answer **200 with the verdict in the body**. `classifyPostbackBody()` decides: `{"status":"ok"}` and `error:"edit"` (their no-op) = delivered; `access-denied`/`orderid`/`no-id`/`key`/`func`/`security` = **failed immediately** (no retry); anything else retries. Non-JSON bodies stay delivered so generic trackers are unaffected. The portal's test-fire sends a bare URL on purpose — `orderid` back means *endpoint reached and token accepted* (a bad token answers `key`), so probe mode scores it a success. Always select `last_response_body` into any log UI; omitting it is what hid a 0% delivery rate behind green badges for 12 days.

## Partner never sees our order IDs

`orders.display_id` is one global sequence shared by **every** order in the CRM, so two of them reveal our exact order volume. Nothing affiliate-facing may emit it — not the intake reply, not `/cpa/leads`, not `{id}`/`{oid}`, not a dedupe response. **The single exception is the staff-only `GET /affiliates/:id/leads`** (plural — behind the hard wall, admin/manager only, added 2026-08-10 for the admin Dashboard tab); never copy that select into an `affiliate/*` or `/cpa/*` route. Partners key on `oid` = their own `ext_id`; where we must return something we return the opaque `affiliate_leads.id`. `{id}` has **no** display_id fallback (a fallback leaks for any lead sent without an ext_id). The phone-dedupe reply carries **no id at all** — the matched order may belong to any channel. That query also excludes `duplicated_from IS NOT NULL`: internal copies are our bookkeeping, and without the filter pressing Duplicate on an old order silently rejects that customer's genuine new lead for 24h.

## Data model

- `affiliates` (user_id→login, code = slug in `orders.external_source='affiliate:<code>'` — NEVER rename once leads exist, postback_url/enabled/events)
- `offers` (product_id, payout_eur, **price_eur**; retire via is_active=false, never DELETE). `price_eur` = customer price PER PACKAGE for this offer, NULL inherits `products.price` — never edit the product to price an affiliate deal (Snail Complex has 531 call-centre orders vs 7 affiliate). `payout_eur` is FLAT per earned (confirmed) order and is **never multiplied by quantity**: agents upsell to 2–3 packages and the partner still earns exactly one payout.
- `affiliate_offers` (approval + payout_override_eur; intake rejects unapproved)
- `affiliate_leads` (1:1 sidecar by order_id: ext_id/clickid/sub1-5/payout snapshot). **Orders table has ZERO affiliate columns** — linkage only via the sidecar + source_type='affiliate'.
- `affiliate_postbacks` (queue+log; service-role-only RLS like leaderboard tables)

## Intake — POST /api/cpa/lead (public zone, key-authed, AlterCPA-compatible)

Error envelope = HTTP 200 `{"status":"error","error":<code>}` with codes `security/ban/nooffer/offer/nophone/duplicate/traffic/db`. Dedupe: (a) `ext_id` unique per affiliate, (b) last-8 phone vs ALL orders within `app_settings.affiliate_dedupe_window_hours` (default 24, 0 disables). Lead lands as normal unassigned `pending` order + order_items + System note + history row. Affiliate handout: `docs/AFFILIATE-INTEGRATION.md`.

## Postbacks — the reliability contract

Capture = DB triggers on orders (swallow-all, burst-safe partial-unique pending rows). Delivery = `drainAffiliatePostbacks()` in the edge fn: claim via `claim_due_affiliate_postbacks` RPC (FOR UPDATE SKIP LOCKED lease), macro render (incl. `{stage:a|b|c|d|e|f}`), GET 10s timeout, backoff **1m→5m→15m→1h→6h→24h → failed at attempt 7**, unchanged-URL dedup, SSRF guard (`isSafePostbackUrl`). Wake-ups: `EdgeRuntime.waitUntil` nudges (intake + PATCH status) + every-minute pg_cron `affiliate-postback-drain` → pg_net → `POST /cpa/postbacks/process` gated by `x-postback-secret` = env `POSTBACK_DRAIN_SECRET` = vault `postback_drain_secret`. `event='test'` bypasses postback_enabled (portal test-fire).

## The HARD WALL (security-critical)

In the edge fn right after role flags: a login whose ONLY role is 'affiliate' gets 403 on EVERYTHING except `affiliate/*` and `GET /me`. Without it, generic authed routes (products, call-scripts…) leak internal data to partners. Never weaken it; new portal surface goes under `segments[0]==="affiliate"`.

## Frontend

- Admin: `/affiliates-admin` — FIVE URL-synced tabs (`?tab=`), Dashboard first: AffiliateDashboardTab / AffiliatesTab / OffersTab / PostbackLogTab / **Countries** (`MirrorTab`, the AlterCPA mirror — see `elyon-altercpa-bridge`; do not remove it). moduleKey `affiliates_admin`.
- Portal: `/affiliate`, `/affiliate/offers`, `/affiliate/integration` (moduleKey `affiliate_portal`).
- Shared by both surfaces (`src/components/affiliates/`): `affiliateStage.ts` (stages, badge classes, `approveRatePct`/`buyoutRatePct`, `normalizeStage`), `AffiliateKpiCards`, `AffiliateLeadsTable` (`staffColumns` adds real phone + ORD id + CRM status). Money is **injected** via an `fmtMoney` prop — pass `formatEurExact`. There is **no `formatEur`** in this repo and you must not add one.
- **Money: affiliate payout renders in EUR on every surface** (`formatEurExact`), because `payout_eur_snapshot` is a euro obligation to the webmaster. The staff-only "Avg order value (confirmed)" is Macedonian selling-side revenue and stays in денари (`formatMoney`). This is the documented exception to the MKD-only UI rule — see CLAUDE.md and `elyon-currency`; do not "fix" it back. Sidebar items render only when `user.isAffiliate` (admins pass module checks but shouldn't see partner nav). `ProtectedRoute` has the `isAffiliate→/affiliate` branch — removing it recreates an infinite redirect on login. AppLayout hides BreakButton/GlobalSearch for affiliates.

## Red flags

Payout math touching `calcAgentBonus` or order price · **multiplying payout by quantity** · new orders columns for affiliate data · renaming an affiliate `code` · DELETE on offers · postback capture in app code instead of the trigger · weakening the hard wall · exposing api_key to managers · full phone in the portal · re-litigating the confirmed-at-earn gate without the operator · **keying portal payout on `CPA_STAGE` or the order's current status** · **NULLing or re-stamping `confirmed_at` in any write path** · **emitting `orders.display_id` anywhere a partner can see it** (the staff-only `GET /affiliates/:id/leads` is the one place it may appear) · **treating HTTP 2xx as delivered** · repricing a product to change one offer's price · hardcoding one reason table for all networks · exposing `postback_format` on the affiliate's self-service route (admin-only).

## Related

RLS is not the hard wall — affiliates hold real Supabase logins and can query PostgREST directly. Any table readable by `authenticated` is readable by them. See `elyon-security` and migrations 20260802000200 / 20260904000010 (`is_internal_staff()`).
