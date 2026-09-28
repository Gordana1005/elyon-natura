# HANDOFF: continue the 27–28.09.2026 session (cloud)

This hands over a long local Claude Code session. Read this file, CLAUDE.md, and the other files in this folder before doing anything.

Owner: Mile. His instruction: finish everything below, push it live, update ALL docs on how the system works now, then talk to him about the Insights tabs. He is terse and wants results. Answer him in English.

## 0. Setup (first thing)
```bash
printenv | grep -E '^(SUPABASE_|VITE_|ALTERCPA_)' > .env   # .env is gitignored
npm ci
node scripts/assert-mk-target.mjs                            # must print "Target confirmed: Macedonia"
```
- **Before ANY state change** (migration, deploy, write SQL), run the tripwire and read its exit code.
- Pass `--project-ref bmfxhgznttcnnlqloqzp` explicitly on every deploy.
- The SUPABASE_ACCESS_TOKEN can also write the Bulgarian project `sxymaloycddnoxudxaqp`. Never touch it.

## 1. Hard rules
- **Bulgaria is off limits:** `sxymaloycddnoxudxaqp`, elyoncall.com, and the Vercel project `elyoncrm`.
- **The live web shop naturatherapy.mk gets NO changes.** Only the read-only `crm_export` schema + role `elyon_crm_reader` exist there.
- **Migrations:** `node scripts/apply-migration-mk.mjs supabase/migrations/<file>.sql` (`db push` is blocked). After each bundle, run `node scripts/engine-fixture-mk.mjs`.
- **Edge functions:** `npx supabase functions deploy <fn> --project-ref bmfxhgznttcnnlqloqzp`.
  - `api` is ONE deployable. Deploy it only when `supabase/functions/api/index.ts` holds finished work.
- **Frontend:** a push or merge to `main` = Vercel production. Gates: `npm test` and `npm run build`. `tsc` alone is a no-op here.
- **Money rules:**
  - MEX alone decides paid/returned; AlterCPA decides only confirmed-or-dead.
  - Prices are stored in EUR. `formatMoney` = EUR→MKD with the FROZEN peg 61.5; `formatDenari` = amounts that are already MKD (MEX COD).
  - NEVER change the peg.
- **Payouts, bonus and commission math: DEFERRED by the owner.** Do not touch.
- **Cron schedules and rules:** do not change them unless this file approves it.
- **Bulk writes:** prefer the quiet window after 20:55 Skopje. Check `pg_stat_activity` for `recompute_all_segments` first; it deadlocked a repair once.
- **Call Again uses `orders.updated_at` as last_call_at**, so bulk fixes must not bump it.
  - `SET session_replication_role` is NOT allowed inside functions.
  - Use the GUC `elyon.keep_updated_at='on'` instead. It lands with migration 20260939000300.
- **Read-only SQL:** POST to `https://api.supabase.com/v1/projects/bmfxhgznttcnnlqloqzp/database/query` with `{query, read_only:true}` and a Bearer SUPABASE_ACCESS_TOKEN.
- Never print secrets. Never commit `.env`, `exports/` or `docs/VAULT.md`. (VAULT is local only and not available to you.)

## 2. What is LIVE now
**Migrations applied (through `main` d91b0a9 plus 20260939000500):**
- **20260934\*** — owners gate, MEX parcel register (`mex_parcels`, both accounts), money guards (`paid_basis`, `no_parcel_7d`, `data_repair_*`).
- **20260935\*** — `sale_source` on every order; `sold_at` / `sold_by_person_id` / `sold_via`; `sales_people` / teams / identities / `v_sales_work`; presence (`agent_presence_days`, 30-min inactivity alerts).
- **20260936** — `insights_overview`.
- **20260937** — web-shop mirror `web_orders` + `web-sync` cron every 15 min (24.485 MK orders incl. OpenCart history).
- **20260938** — 7-day no-parcel rule.
  - **Now in APPLY mode** (owner, 28.09). The first real run is 28.09 21:10 Skopje and will cancel about 522 AlterCPA-confirmed orders with no MEX parcel.
  - 47 orders with an unlinked parcel on the same phone go to `needs_linking` and are never cancelled.
  - Ledger tables: `no_parcel_rule_runs` / `no_parcel_rule_items`.
- **20260939000000** — `leaderboard_day`.
- **000100** — `customer_timeline` (Customer 360).
- **000200** — Settings → Teams + Integrations health, plus the `collabbox_feed_state()` stub.
- **000500** — **every active admin = owner** (`is_business_owner`): sees all money and tabs. Managers don't.

**Deployed:** `api` (= `main` d91b0a9), `altercpa-sync`, `mex-reconcile`, `web-sync`, and `collabbox-sync` (a PROBE only: one GET).

**Repairs done 27.09:**
- ghost MEX links undone;
- the 18.09 AlterCPA "paid" catch-up proven or cancelled (345 cancelled as `no_parcel_7d`);
- parcels moved back to the order they were shipped for.

**Checker:** `node scripts/verify-attribution.mjs --from YYYY-MM-DD --to YYYY-MM-DD`, checks C1–C14, read-only.

## 3. Owner decisions (law)
- **Four sources:**
  - AlterCPA — lead intake; an ad lead from an existing client is still a LEAD.
  - ElyonCRM — an order created FIRST in Elyon = ours, even if it's at MEX. Don't use the MEX series to decide an order's source.
  - Web shop — `web_orders` mirror; not orders.
  - Teleshop/Other — collabBox orders plus MEX parcels with no order.
  - Unlinked BIO NATURAL 9110/9103 parcels = the neutral split "Elyon account — unlinked".
- **"Нарачки" = ONLY real orders:** confirmed / packed / shipped / paid, plus returned (it shipped). Cancels and trash are NEVER counted as orders or order value; show them separately as Откажани (RED dot) / Во корпа (grey). Вратени = PINK dot. Worked decisions = "Обработени".
- **Money view = COHORT:**
  - TOTAL = sales made in the period (sale day = sold_at, else AlterCPA decided_at, else confirmed_at, else created_at; Skopje).
  - The parts sum exactly to the total: Наплатено (MEX 2) · Кај курирот (MEX 1/4/10; problem 3/9/13 shown inside it; 13 is still at the courier) · Спакувано (MEX 8) · Во магацин за пакување (confirmed, no parcel) · Вратено (MEX 7).
  - MEX status wins over CRM status.
  - Value = parcel COD, else price×61.5 (web: shop total).
  - Leads funnel and MEX cash-flow are separate, clearly labelled figures.
- **7-day rule:** no parcel 7 days after an AlterCPA approval → cancelled. When the parcel appears later, the order must go to IN TRANSIT (shipped) and then follow MEX. The 11.08 "cancel-other before Aug = paid" set stays (report only).
- **Test phones** 070123456 and 23123123: DELETE their CRM orders (snapshot first). Exclude their web orders and MEX parcels from all reports; you can't touch the shop.
- **COD ≠ CRM price:** MEX is right. Set the CRM price to the MEX COD when it differs.
  - Not when COD = price×61.5+150 (delivery fee), and not when COD is 0.
  - Dry-run list first; keep order_items consistent.
- **Duplicates:** keep both orders on the 3 parcels held by two orders (they may be identical but both are accurate). Add a checker C8a exception.
- **Lazar Delev** = owner: sales_people row, management team, is_manager, never earns.
- **Unmapped collabBox authors** (15 spellings, about 1.364 orders in 90 days): create sales_people exactly as the name is shown (placeholder, no login), attach a `collabbox_author` identity, fill the empty sellers.
- **AlterCPA #4531:** leave aside. **VAT / costs / lead cost:** the owner sets them later.
- **collabBox daily sync: PAUSED by the owner.** Don't build it now; see `collabbox-*.md` here. Local `collab_out` data exists on Mile's PC.
- **Later, only after talking to the owner:** the Insights tab rebuild (WP1–6 in `audit-critic.md`), payouts/bonus, collabBox.

## 4. TODO, in order
1. **Seller stamping cron** — `supabase/migrations/20260939000300_stamp_deciders_cron.sql` (written, NOT applied).
   - Parity with `scripts/backfill-order-deciders.mjs` was 0 diffs (`stamp-build-report.md`).
   - First fix `stamp-review.md` defects 1–4:
     - count only approval pushes and credit the "Agent: <name>" from the comment, never the manager who pressed it;
     - `FOR NO KEY UPDATE`, `p_limit` 1000;
     - nightly full sweep;
     - a run log.
   - Re-check parity, apply, and confirm the first cron runs. Also switch `sales_backstamp_orders` (migration 000200) to `elyon.keep_updated_at`.
2. **AlterCPA nightly (7 d) / weekly (90 d) sweeps** in `supabase/functions/altercpa-sync` never finish. Every run since 18.09 ends "stale: still running after 10 minutes" (edge wall clock).
   - Measured: about 88 ms per lead of processing plus 0.5 s fixed.
   - Approved fix: batch the per-lead DB work, and/or make sweeps resumable (day chunks, cursor on `altercpa_sync_runs`, a ~100 s budget, continuation cron calls that do nothing without an open sweep).
   - Do NOT change rolling/status behaviour, `import_scope` (must stay `pending_only`) or the money guards. Add tests, deploy, and check the next nightly run.
3. **mex-reconcile upsell revive** (`supabase/functions/mex-reconcile/match.ts`).
   - 8.3% of 9110 parcels have COD ≠ price (upsells). A `no_parcel_7d` cancel whose parcel appears with a non-fitting COD currently stays cancelled.
   - Add a narrow path, used only when ALL of these hold:
     - the parcel is `bio_natural` series 9110;
     - it is inside the ship window;
     - exactly ONE real sale is on that phone;
     - that sale is status cancelled with reason `no_parcel_7d` and it is an AlterCPA order.
   - Then link it and apply rule C, which moves it to the MEX target.
   - Check the `link_method` allow-list in `mex_link_parcel` / `mex_parcels` (migration 20260934000100) before adding a method. Add tests, deploy.
4. **Insights foundation + new Overview totals (WP0).** Contract: `wp0-cohort-contract.md` (+ `research-cohort-numbers.md`, `research-kpi-ui.md`).
   - **Frontend shell DONE on this branch:** one Skopje filter bar with dd.mm.yyyy dates and calendar presets, tabs split into files, shared Cohort components, the false page note removed.
   - **Backend PARTIAL and unverified:** `supabase/migrations/20260940000000_insights_foundation.sql`, `supabase/functions/api/insightsCommon.ts` (+ test), and new code in `index.ts` (GET `/insights/cohort`, a cohort embed in `/insights/overview`, `/orders` `cohort_bucket` + `sold_from`/`sold_to`, courier fallback = the MEX rate).
   - **Overview UI PARTIAL:** `overview/CohortSources.tsx`, `CohortTiles.tsx`, `cohortOverview.ts`.
   - Finish it, apply section 3's rules (incl. neutral unlinked 9110/9103 and test-phone exclusion), and verify with real numbers. For 22–28.09 the cohort was about 1.343 sales / 3,24M ден; the parts must sum exactly.
   - Then apply the migration, deploy `api`, run `npm test` and `npm run build`, merge to `main`, and check the live page.
5. **The owner's leftover answers:** see section 3 (test phones, COD→price, duplicates, Lazar, collabBox authors).
   - Also look deeper in MEX for the 47 `needs_linking` orders and link only what's provable.
   - Also check whether the 3.176 NATURA "M…" parcels with COD 0 are card-paid web orders (compare to `web_orders` by phone/date/payment).
6. **Update ALL docs** to how the system works now: `CLAUDE.md` (per-market rules: admins=owners, cohort, sources, 7-day rule), `MACEDONIA-STATUS.md`, `docs/how-it-works.md`, `docs/ALTERCPA-BRIDGE.md`, and `.grok/skills/*`.
   - Add new skills for money attribution + cohort, presence + leaderboard, the web-shop bridge, and Customer 360 + integrations health.
   - Also correct the elyon-security, elyon-notifications and elyon-currency skills (formatDenari).
7. Merge to `main` (production), then report to Mile briefly: what's live, the numbers, what's next (the Insights tabs).

## 5. Files in this folder
- `audit-critic.md` + `audit-per-tab.md` — full audit of every Insights tab and the work packages WP0–WP6.
- `wp0-cohort-contract.md` — the cohort API contract.
- `research-cohort-numbers.md` — definitions + real numbers.
- `research-kpi-ui.md` — the header UI plan.
- `stamp-*.md` — the stamping build and its review.
- `overview-contract-v1.md` — the original Overview contract.
- `collabbox-*.md` — paused.
