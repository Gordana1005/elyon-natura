# Elyon CRM — documentation hub

> **Read me first.** This folder is the complete operating manual for Elyon CRM: how every part
> works, what connects to what, where the weak spots are, what's live vs. pending, and how to hand
> the whole thing to someone else (or resell it). It was written from a full read of the source on
> **2026-05-23** and last refreshed against the code on **2026-07-28** — when the docs and the code
> disagree, the code wins, and the [Audit](AUDIT_FINDINGS.md) lists the places they currently disagree.

Elyon CRM is a Bulgarian e‑commerce **call‑centre CRM**. Agents in Strumica, North Macedonia call
Bulgarian customers on Bulgarian mobile numbers, talk them through nutritional‑supplement orders, and
a Bulgarian warehouse ships COD via Speedy/Econt. The whole loop — leads → calls → confirm → ship →
cash — lives in this system.

- **Frontend:** React + Vite on Vercel → `https://elyoncall.com`
- **Backend:** one Supabase Edge Function (`api`) → `…/functions/v1/api`
- **Database:** Postgres on Supabase (project `oufoazmnbwugtfldkwsn`), RLS everywhere
- **Telephony:** Asterisk + FreePBX on a Sofia VPS (`pbx.elyoncall.com`), A1 "Business Voice" SIP trunk **live in production**; browser softphone (sip.js), recordings, VOIP Health dashboard

---

## How to read this set

Start at **[ARCHITECTURE](ARCHITECTURE.md)** for the 10,000‑ft view, then dive into whichever area
you're working on. Every doc is standalone but cross‑links the others.

| Doc | What's inside | Read it when… |
|---|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | The whole system on one page: components, data flows, hosting, domains, what talks to what | You're new, or onboarding someone |
| [DATABASE.md](DATABASE.md) | Every table, column, enum, function, trigger, RLS policy; storage; the segment engine | You touch data, write a query, or plan a migration |
| [BACKEND_API.md](BACKEND_API.md) | All ~130 Edge‑Function endpoints, auth model, CORS, HMAC, rate‑limits, stock logic | You change the API or call it |
| [FRONTEND.md](FRONTEND.md) | Routes, contexts, RBAC wiring, the design system, page catalogue | You change the UI |
| [ORDERS_AND_CLIENTS.md](ORDERS_AND_CLIENTS.md) | Order lifecycle & statuses, the (virtual) customer model, phone matching, prediction lists/segments, queues, the Assigner | You work on orders, leads, or distribution |
| [CALLS.md](CALLS.md) | How calling works (live softphone, queue auto‑pick, outcome picker, telemetry, recordings) | You work on the Calls page |
| [CALLING_PLAN_SIP.md](CALLING_PLAN_SIP.md) | The A1 SIP trunk **go‑live record** (architecture + what was built) | You touch the trunk/PBX or the softphone |
| [PRODUCTS_STOCK_WAREHOUSE.md](PRODUCTS_STOCK_WAREHOUSE.md) | Catalogue, SKU/barcode rules, stock decrement, inventory log, the Daily Fulfilment CSV (real format), couriers/offices | You work on products, stock, or warehouse hand‑off |
| [INSIGHTS_ANALYTICS.md](INSIGHTS_ANALYTICS.md) | Dashboard, CEO stats, Agent Performance, Management Insights, Operations Center, Shifts — with exact metric definitions | You read or change a number/report |
| [USERS_ROLES_PERMISSIONS.md](USERS_ROLES_PERMISSIONS.md) | Auth, the 7 roles, the module/role/financial permission matrix, account creation, shifts & breaks, presence | You manage users or access |
| [IMPORT_EXPORT.md](IMPORT_EXPORT.md) | Every `scripts/*.mjs`: xlsx imports, CSV exports, price sheets, courier/settlement scrapers, audits | You import data or run a script |
| [WEBSITES_WEBHOOKS.md](WEBSITES_WEBHOOKS.md) | How new "pendings" arrive: landing‑page webhooks (HMAC) and the naturatherapy.bg OpenCart bridge | You wire a new site or debug missing leads |
| [SECURITY.md](SECURITY.md) | RLS model, HMAC, CORS, audit log, rate limiting, secret handling, known gaps | You do a security pass |
| [OPERATIONS_RUNBOOK.md](OPERATIONS_RUNBOOK.md) | Deploy, migrate, env vars, CI/CD, hosting, common ops, troubleshooting | You deploy or something breaks |
| [AUDIT_FINDINGS.md](AUDIT_FINDINGS.md) | Weak spots, dead code/routes, real bugs, doc drift, test/lint state, prioritised fixes | You want to know what to fix next |
| [RESELLER_GUIDE.md](RESELLER_GUIDE.md) | How to stand this up for another business/country, onboard clients from CSV, white‑label, and pitch it | You want to sell or clone the product |
| [VAULT.md](VAULT.md) | **All secrets, tokens, passwords, endpoints in one place. Git‑ignored.** | You need a credential (keep it local) |

> Two pre‑existing docs live alongside this set and remain authoritative for their topics:
> **[../CLAUDE.md](../CLAUDE.md)** (conventions for AI/dev sessions) and **[../PBX-SETUP.md](../PBX-SETUP.md)**
> (PBX server ops). `how-it-works.md` and `CALLING_PLAN.md` here are the **older** versions that this
> set supersedes — see the note at the bottom.

---

## The one‑paragraph mental model

A **lead** (imported, landing‑page webhook, or website order) becomes a **pending order**. A manager
**assigns** it to an agent (Assigner / segments / auto‑distribution). The agent **calls** the customer
from the Calls page; the outcome is logged and the order flips **pending → confirmed** (or cancelled /
call‑again / trashed). Confirmed orders are exported as a **Daily Fulfilment CSV** to the warehouse,
which flips them to **shipped** (stock auto‑decrements). Courier delivers, customer pays cash, order is
marked **paid**. Every paid/cancelled/returned order re‑classifies the customer into rule‑driven
**prediction lists (segments)** for future re‑marketing. Analytics read all of this back as revenue,
conversion, returns, and per‑agent performance.

---

## Status at a glance (2026‑07‑28)

| Area | State |
|---|---|
| CRM web app (orders, calls UI, products, insights, shifts, segments) | ✅ Live in production |
| Inbound landing‑page webhooks (55 seeded) | ✅ Live, HMAC‑enforced |
| naturatherapy.bg → CRM OpenCart bridge | ✅ Built & deployed; awaiting install + first import on the store |
| Telephony PBX (Asterisk + FreePBX, Sofia) | ✅ Provisioned, TLS, WSS endpoint live |
| A1 "Business Voice" SIP trunk | ✅ **Live** in production (Path II — our PBX registers A1's trunk) |
| In‑browser softphone (real audio) | ✅ Live — `RealVoipEngine` (sip.js) behind `VoipContext`; per‑agent extensions + caller‑ID |
| Call recordings | ✅ Live — Asterisk MixMonitor; browsable on the Recordings page (signed URLs) |
| VOIP Health dashboard + missed‑call inbox | ✅ Live (`/voip-health`) |
| Live agent call status ("In call" on Assigner + Operations Center) | ✅ Live — `profiles.voip_state`, reported by the browser softphone via `presence/heartbeat` (not PBX‑derived) |

See [AUDIT_FINDINGS.md](AUDIT_FINDINGS.md) for the bug/risk list and [CALLING_PLAN_SIP.md](CALLING_PLAN_SIP.md)
for the telephony roadmap.

---

*Maintained by hand. When you ship something that changes a flow, update the relevant doc in the same
PR — these only stay useful if they track the code.*
