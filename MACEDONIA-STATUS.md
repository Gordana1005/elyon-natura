# Elyon CRM — Macedonia (Natura Therapy MK)

This repo is a **hard fork** of the live Bulgarian Elyon CRM, run as a separate Macedonian
operation. It shares **nothing at runtime** with Bulgaria (own repo / own Supabase / own Vercel).

> **Why the infrastructure says "macedonia".** The fork was stood up on 2026-06-30 for Macedonia, then
> re-aimed at **Macedonia** on 2026-07-31 because that project was already clean. The Supabase
> ref, Vercel project and GitHub repo names were deliberately kept — renaming them buys nothing
> and breaks the deploy links. **The market is Macedonia.** (Supersedes `MACEDONIA-FORK-STATUS.md`.)

> 🛑 Never run any command in this repo against the live BG Supabase ref
> `sxymaloycddnoxudxaqp` or the domain `elyoncall.com`. Run
> **`node scripts/assert-mk-target.mjs`** before any state-changing command.

---

## 🟢 Current state

- **Frontend (Vercel):** https://elyon-natura.vercel.app (`gordanas-projects-a53c0208/elyon-natura`, GitHub-connected → **push to `main` auto-deploys production**)
- **Backend (Supabase):** `bmfxhgznttcnnlqloqzp` — **172 migrations applied**, edge function `api` deployed (v18, 2026-08-06), `WEBHOOK_SECRET` set, `pg_cron` on.
- **Data (2026-08-05): the historical order book is LOADED.** 80.360 orders · 47.231 customers ·
  56.807 prediction-list memberships. 0 call logs. **88 products** (67 + 21 created for the import),
  46 carrying a real unit cost.

  | | |
  |---|---|
  | Source | AlterCPA `api.cpa.moe`, 81.657 MK orders 2025-04-14 → 2026-08-05 |
  | Imported | 80.360 — paid **27.276** · cancelled 35.328 · trashed 17.714 · pending 42 |
  | Paid revenue | **€665k** (≈40,9M ден) across 16 months |
  | Excluded | 977 unusable phones · 314 AlterCPA smoke-test orders · 6 remaining ids |
  | Corrections | **2.609 orders proven paid by collabBox** and flipped from cancelled/trash |
  | Idempotency | `external_source = 'altercpa'`, `external_order_id` = the AlterCPA id. **Re-running the importer is a no-op** (verified: 600 re-posted → 600 duplicates, 0 created). |

  Scripts: `export-altercpa-mk.mjs` → `analyze-altercpa-mk.mjs` → `build-product-map.mjs` →
  `match-collabbox.mjs` → `import-altercpa-mk.mjs` → `verify-altercpa-import.mjs`.
  Raw export and every audit file live in `scripts/data/`.

  > ⚠️ **collabBox holds ~40.000 more paid orders we could not import.** Its export carries no
  > phone and no product, so only 10,8% of its 45.227 documents could be matched to AlterCPA by
  > name + date. The fix is a re-export with those two columns — the request is written and ready
  > to send at `docs/COLLABBOX-EXPORT-BARANJE.md`.
- **Logins (3, verified live 2026-08-05):**
  | Login | Role | Notes |
  |---|---|---|
  | `mile@elyon.com` | admin | typed in full |
  | `hedi@naturatherapy.mk` | admin ("Суперадмин") | typed in full |
  | `dragana@naturatherapy.mk` | manager | typed in full |

  Any address containing `@` is typed **in full** at the login box — the form only appends
  `elyon-mk.local` when the input has no `@`, and the field is labelled "Username".
  All three still use seeded/simple passwords — **rotate**.
- **Public signup is disabled** (2026-08-04). Accounts are created only by an admin, via the
  `/users` screen or `node scripts/create-user-mk.mjs`.
- **Secrets:** `docs/VAULT.md` (gitignored).

### Code parity with Bulgaria — done 2026-07-31

Brought forward 28 migrations and ~33 files that shipped upstream after the fork: segment engine
v3.4 → v3.6, assigner truth RPCs + mass-unassign, `shipped_at`/`paid_at` + agent "My Orders",
call-listened mark + recording reconciler, the **affiliate/CPA system**, duplicated-order status,
agent payouts, the RLS lockdown set, `notifications.meta` + unpaid-delivery chase, Macedonian
locale, VOIP minutes + live agent state.

Merged 3-way against the fork point (BG@`25561ef`): 69 fast-forwards, 21 merges, 33 new files,
**3 conflict hunks**. The fork's own delta survived intact.

**Deliberately NOT ported:** the BigArena stock-sync upload — its parser reads the Bulgarian
fulfilment panel's Cyrillic headers (`Свободна наличност`, `Баркод`) and MK uses a different
provider. Its parser lib (`src/lib/bigarenaStock.ts`) is still present for the products
stock-sync path. (`BigArenaStatusSync` itself was deleted 2026-08-18 — statuses come from the
MEX reconcile cron.)

### Pendings queue + sticky trash + full stock — done 2026-08-06

Ported BG's `875abaa` (trash reasons everywhere, Pendings queue on /calls) and rewrote its engine
v3.7 for Macedonia. Migrations `20260913000000` … `20260913000300`, edge function v18.

- **Pendings are visible in the /calls queue strip.** A virtual entry, **always first**,
  auto-selected, fed by the new `GET /my-pendings-summary` (own book only, no `agent_id` param).
  Picking a prediction list pins it; waiting leads then show as an amber badge instead of hijacking
  the screen. No segment list was created — the entry is synthetic (`PENDINGS_QUEUE_ID`).
- **Trash is STICKY (engine v3.7-mk).** Every reason now removes the phone from every calling band,
  and a later pending/cancel/return no longer releases it. **Two deliberate deviations from BG:**
  a **paid order after the trash releases** the customer, and **`duplicate_order`** is housekeeping
  (stays callable, never in the Trash List). Live impact: calling members **38.307 → 35.812**,
  Trash List **9.528 → 11.398**. `not_reachable` still parks only 21 days.
- ⚠️ **`orders.trashed_at` needed a correction migration** (`20260913000300`). The generic backfill
  chain is `order_history → updated_at → created_at`, and all 17.714 imported trashes have zero
  history rows, so they all collapsed onto the import timestamp — which would have silently
  disabled the paid-release test for the entire historical book. Any future bulk import must stamp
  `trashed_at` from the real order date.
- **Warehouse: all 88 products set to 1.000 packages** via `scripts/set-stock-mk.mjs` (absolute set
  + one paired `inventory_logs` row each; the additive `POST /api/restock` cannot do this). Snapshot
  for rollback: `scripts/data/stock-before-2026-08-06.json`.
- **Cancel list needed no change** — the 14-day park and the automatic return to the band computed
  from last-paid date + order count already worked; verified live (`0 overdue`, cron `0 0 * * *`
  active) and pinned by the new fixture.
- New verifier: **`node scripts/verify-sticky-trash-mk.mjs`** (8 behavioural cases). Live↔shadow
  parity **0**.
- **Zero-price paid orders: 1.199 → 738** (`scripts/recover-zero-prices-mk.mjs`, +€6.896 revenue,
  audit check 705 → 461 members). AlterCPA recorded no price on these; every source was exhausted
  first (raw export, its line items, CRM `order_items`, collabBox — all empty or not sale prices).
  461 were recovered where the source **did** record a quantity and the same offer+quantity sold at
  one settled price (≥90% of ≥10 paid peers, ±1 month); each carries a `System (Price Recovery)`
  note so a reconstructed figure is never mistaken for a recorded one. The remaining **738 stay at
  0 on purpose** — they recorded neither price nor quantity (662 are Alpha Male, whose
  1.490/3.000/4.000 ден "spread" is pack size 1/3/4, so there is nothing to price). Audit is
  therefore **13/14** by design. Rollback: `scripts/data/zero-price-recovery-2026-08-06.json`.

### Market layer (Macedonia)

| Area | State |
|---|---|
| Currency | **MKD only** in the UI. Stored EUR; `MKD_PER_EUR = 61.5` is **frozen** (see below). `formatMoney` is the money formatter; `formatLev`/`eurToLev`/`BGN_PER_EUR` are deleted. |
| COD | `codFor()` returns amount **and** currency together; rounds once to the nearest 10 ден. |
| Timezone | `Europe/Skopje` throughout (DB functions, edge fn, frontend). |
| Phone | `+389`, 8 subscriber digits (national `0`+8=9, E.164 `389`+8=11). `normalizeMkPhone`. |
| VAT | **18%** — ⚠️ unconfirmed, see below. |
| Language | Default `mk`; `en`/`sq`/`bg` also shipped. Call-script + promo base language = `mk`. |
| Login | `elyon-mk.local` |
| Webhook | Accepts **EUR or MKD only** — anything else is a 400. |
| Couriers/cities | **Still Bulgarian** (Speedy/Econt + `bg_settlements`) — deferred. |
| Telephony | Deferred (Phase 2). `VITE_USE_REAL_VOIP=false`; A1-Bulgaria DIDs left in place, marked `TODO(mk)`. VOIP minutes bundle seeded at **0** (no MK carrier contract). |

Search for `TODO(mk)` to find every spot still needing a real value.

---

## ⚠️ The frozen peg — read before touching money

`MKD_PER_EUR = 61.5` in `src/lib/currency.ts` is an **internal accounting constant, not a rate to
keep current.** The Bulgarian lev is legally fixed to the euro forever, so deriving it at render
time is safe. The denar is a *managed* NBRM peg. The moment someone "updates it to today's rate",
every historical order, every closed agent payout, every past revenue report and every COD already
collected from a customer silently re-prices — with no audit trail and no way to tell which figure
was actually quoted on the phone.

**If the market moves, re-price the CATALOGUE in EUR** (`scripts/reprice-catalogue-mk.mjs`).
`src/lib/currency.test.ts` pins the constant so an edit fails CI.

---

## ⏳ Before go-live

**Needs your input:**
1. ~~**Denar shelf prices.**~~ **Done 2026-08-04** — the catalogue was re-priced off the Bulgarian
   EUR points onto clean denar shelf prices (2.490 / 1.890 / 1.490 / 1.290 / 950 / 790 / 590 / 450 /
   150 ден). Every price now ends in 0, so the COD collected equals the advertised figure. Map kept
   at `scripts/data/reprice-2026-08.json`, pre-change state at `…-before.txt`.
   **Still open:** the **29 products with no price at all.** They are not free in practice — the
   order form silently defaults them to `max(cost × 3, €15)`. Price them or deactivate them.
   **Also open (2026-08-05):** the **21 products created for the AlterCPA import** were given a
   flat **180 ден (€2,93)** unit cost on request, so gross margin on the paid history reads 77,9%
   instead of 100%. It is a placeholder, not a measurement — and those 21 carry 49.190 of the
   80.360 orders, including the three biggest earners ProstaFix, GlucoFix and ArthroFix. Replace it
   with real per-product costs before trusting any profit figure. Mapping and proposed shelf prices:
   `scripts/data/altercpa-product-map.json`, reviewed in `…-review.md`.
2. **VAT rate.** 18% is Macedonia's standard rate, but food supplements may fall under the
   preferential 5%/10% band. `VAT_RATE` (edge fn) feeds every profit report.
3. **Commission tiers.** Still `<25€→1, 25–35€→2, ≥35€→3`. Note the hero band is now **tier 3**:
   twelve products sit at 2.490 ден (€40.49), i.e. €3/package, not the €2 assumed when this was
   written. A comp-plan decision, not a port decision. `MarginLabTab.tsx` duplicates the tier
   logic — change both.
4. **Macedonian couriers + city list**, replacing Speedy/Econt and `bg_settlements`.
5. **Confirm the imported unit costs.** `products.cost_price` was populated on 2026-08-04 from the
   Bulgarian catalogue (46 of 67 matched by name; the other 21 have no cost recorded in BG either).
   These are **Bulgarian sourcing figures** — check them against real Macedonian supplier invoices,
   because they now drive Pure Profit, Margin Lab and the floor-price calculator.
   Re-run with `node scripts/import-costs-from-bg.mjs` (dry run) to see the current mapping.

**✅ Resolved (2026-08-18):** the fulfilment CSV is now the **MEX Poshta client-portal import
file** — MEX's own 8-column template (`Kod na pratka … Tezina`), Latin, integer denari, contract
in `src/lib/mexImportCsv.ts` (+ pinned tests). The BigArena Status upload button was removed from
/orders and /warehouse (courier outcomes come from the `mex-reconcile` cron). Validate with a
small real import into the MEX portal before the first big batch.

**Also pending:** rotate the seeded admin passwords and the credentials in `docs/VAULT.md`
(**still open — see H2 in the security audit**); a real production domain (the `elyon-mk.com`
placeholders were *removed* from the CORS allowlist on 2026-08-04 because we do not own that
domain — a real one must be **added** when registered, and it also replaces `EMAIL_DOMAIN`);
Phase-2 telephony.

---

## 🔐 Security — audit of 2026-08-04

Full findings, evidence and verification: **`docs/SECURITY-AUDIT-2026-08-04.md`**.

**Fixed:** manager→admin privilege escalation via PostgREST (`user_roles` had a `FOR ALL` policy
with no `WITH CHECK`); customer phone numbers readable by any logged-in account, affiliates
included (`personal_list_holds`); **public self-registration, which was enabled**; affiliate API
keys readable by managers; the CORS allowlist (legacy alias was missing, unowned placeholder was
present); admin/manager logins now recorded in `admin_login_logs`; webhook slug-enumeration oracle;
missing REVOKEs on service-role-only tables; and a full set of HTTP security headers including CSP.

**Knowingly accepted:** the live admin password committed in `scripts/create-superadmin-mile.mjs`
(H2). Rotating it is a one-line change whenever you want it — note that rotation does not scrub
git history.

**Deferred:** webhook replay protection, durable rate limiting, SSRF hardening on affiliate
postback URLs, server-side shift enforcement, MFA, and an RLS conformance test in CI. That last one
is the recommended next project — three lockdown sweeps have each missed tables the next one found.

⚠️ **Adding a column to `public.affiliates`** now requires adding it to the explicit column GRANT in
`20260909000000_security_quickwins_lockdown.sql`, or it will be invisible to PostgREST readers.
⚠️ **Adding a custom domain or a second Supabase project** requires updating `connect-src` in
`vercel.json`, or every API call will fail silently in the browser.

---

## 🧩 What we still lack (consolidated, 2026-08-04)

Everything above is the *market* layer. These are the gaps found while auditing the whole system —
mostly small, but each one bites somebody eventually.

**Role and permission plumbing**
- **`inbound_agent` cannot be assigned through the API.** It is missing from `validRoles` in both
  `createUserSchema` and `PUT /users/:id/roles`, although the enum has it and both original accounts
  hold it (granted by the admin trigger, not by the API).
- **The admin UI's role list omits `agent`, `inbound_agent` and `affiliate`** — three of the nine
  enum values are invisible on the `/users` screen.
- **Hardcoded module fallbacks were never seeded** into `module_settings`: `calls`, `missed_calls`,
  `segments`, `recordings`, `products`, `webhooks`. The code comment says to remove them once the
  seed lands; they still ship. Side effect: `warehouse` and `ads_admin` see call surfaces that were
  never granted to them.

**Documentation that actively misleads**
- `.grok/skills/elyon-currency/SKILL.md` documents the **opposite of the shipped code** — it says
  "Macedonia is euro-native, display EUR only" and references `formatEur`/`formatLev`, none of which
  exist. Anyone following it would break the denar display. **Rewrite before relying on it.**
- `.grok/skills/elyon-logistics-costs/SKILL.md` teaches **VAT 20%** and the lev peg (Bulgarian).
  The code is 18%.
- `docs/USERS_ROLES_PERMISSIONS.md` describes "the 7 roles" (there are nine) and the Bulgarian
  `@elyoncrm.local` login domain.
- `docs/SECURITY.md` describes the **Bulgarian** Supabase project's auth settings, not this one —
  which is exactly how the open-signup misconfiguration went unnoticed for a month.
- `docs/VAULT.md` is still titled "Kosovo" and its §3 lists three accounts that do not exist.
- `CLAUDE.md` says a repo-root `MEMORY.md` is loaded each session; **no such file exists** here.
- `RESUME.md` was retired on 2026-08-04 — it was the pre-fork Bulgarian handoff doc and instructed
  the reader to run commands in the forbidden BG folder.
- `.grok/memory/INITIAL_PROJECT_MEMORY_SEED.md` is Bulgarian-era content and describes live A1
  two-way calling as "what's live". It is not.

**Product data**
- 29 products have **no shelf price** and 8 have neither price nor cost.
- Several product names are still **Bulgarian**, not Macedonian — e.g. `CHIA THERAPY - с вкус на
  диня`, `IMMUNO BOOST - с вкус на къпина, лимон и лайм`, `Whey Protein 1.5 kg с вкус на ванилия`.
  They are customer-visible on the agent screen and in the fulfilment CSV.
- A few names carry typos that matter only because matching is by name:
  `ELIXY-Дневенкрем снаил 50ml` and `ELIXY Серум со 20%снаил екстракт` are missing spaces.

**Telephony (Phase 2, deferred)**
- `docs/SIP-TRUNK-PLAN.md` holds the decision (build our own Asterisk PBX) and the ready-to-send
  Macedonian procurement emails. The one gating unknown is whether A1 sells a bare SIP trunk.
- Nine Bulgarian values are still hardcoded in the edge function, including
  `REC_HOST = pbx.elyoncall.com` and 20 Sofia DIDs. Latent while `VITE_USE_REAL_VOIP=false`, but
  they contradict "shares nothing at runtime with Bulgaria" and must be resolved before Phase 2.

---

## Operating notes

- **Migrations:** the DB password was never recorded, so `supabase db push` cannot open a direct
  Postgres connection. Use `node scripts/apply-migration-mk.mjs <file.sql>` (Management API, same
  `postgres` role). Recording the password in VAULT §1 restores the normal path.
- **`npx tsc --noEmit` is a NO-OP here** — the root `tsconfig.json` has `"files": []`. The real
  gate is `npm run build`.
- **After any migration bundle**, run `node scripts/engine-fixture-mk.mjs`. The segment engine
  resolves its target list by exact name match and deletes memberships *before* resolving, so a
  drifted list name wipes members silently, with no error.
- Legacy one-off scripts in `scripts/` (`import-monadon-csv`, `import-cpa-xlsx`,
  `cost-report-since-18may`, `finance/build-finance-pdfs`, …) are **Bulgarian** tooling carried
  over with the fork. They still hardcode the lev peg and 20% VAT. They are dormant — do not run
  them against Macedonia without converting them first. (`import-cpa-xlsx.mjs` in particular is
  **not** the AlterCPA importer — that is `import-altercpa-mk.mjs`.)
- **Before any bulk order load, go through `scripts/segment-trigger-mk.mjs --disable`.** Six
  `FOR EACH ROW` triggers on `orders` make a large import wrong, not just slow:
  `trg_orders_segments_insert` recomputes a customer's whole band membership per row (80k inserts
  = 80k recomputes, all but the last per phone discarded), and the four `orders_set_*_at` triggers
  stamp `now()` on insert — which would date every historical order to the day of the import and
  leave the real history blank. Finish with `--backfill-timestamps`, `--enable`, `--recompute`.
  The `--status` output is deliberately loud, because a trigger left disabled fails silently.

### Migration replay fixes (kept — never take BG's versions of these)
Guarded the `missed_calls` trigger in `20260604130000` + recreated it in `…0614120000`; dropped
the colliding `4-6m` rows before the rename in `…0605120000`; renamed two duplicate-version files
(`…0710000001`/`…0711000001` → `…0710010000`/`…0711010000`). BG never replays from scratch, so it
never hit these.
