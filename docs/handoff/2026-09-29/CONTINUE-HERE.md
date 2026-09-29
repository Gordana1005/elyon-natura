# CONTINUE HERE — 29.09.2026 (written ~05:00 Skopje, before the 08:00 shift)

The owner's order (29.09, ~04:30), in his sequence:

1. Finish the open tasks first.
2. Make every source refresh at least every 15 minutes, with MEX (NATURA + BIO NATURAL) as the
   final proof.
3. Import everything from everywhere.
4. Verify everything live, then test again.
5. Only then rewrite the docs:
   - `CLAUDE.md` (= agents.md);
   - `MEMORY.md`;
   - `docs/`;
   - the skills.
6. Audit the Insights, Табла (Dashboard) and Операции tabs: synced, accurate, in the new style.
   Fix or remove the outdated parts.
7. Stock is NOT a focus: the placeholder of 1.000 stays until he sends the count.

Verified facts for the docs are in `docs/handoff/2026-09-29/FACTS.md`.

---

## ✅ Done and pushed

**Migrations (MK, 254 applied):**
- `20260942000900`: the collabBox sync, live.
- `20260942001000`: six departments.
- `20260942001100`: departments by folder, no team override.
- `20260942001300`: every source every 15 min.
  - MEX runs both accounts every 15 min, 06:00–22:59.
  - collabBox runs a full pass every 15 min, 07:00–22:59, plus the nightly at 00:00.
  - The headers-only `collabbox-live` job is retired.
- `20260942001400`: freshness follows the new schedules.
  - `collabbox_feed_state`: stale = the run that should have finished did not.
  - `integrations_health`: MEX expect `daytime_15m`; the collabBox card gets its run log.
  - `insights_overview`: the MEX window uses the new schedule.

**Commits:** `20ad77d`, `b073008`, `29a2ca1` and `d058832` (the CLAUDE.md department law + the 15-min rule).

**Data pulled by hand, 04:34–04:50:**
- MEX 60-day sweep, both accounts:
  - 17.986 parcels;
  - 32 → shipped;
  - 2 → paid.
- AlterCPA status sync: 755 scanned, 18 callbacks.
- AlterCPA weekly 90-day sweep: started 04:48. The `altercpa-sync-continue` cron works through it.
  - It is the first weekly since the resumable sweep. The Sunday runs had failed since 16.08.

**Checks, 01–28.09, 04:40:** all PASS:
- `engine-fixture-mk`;
- `verify-insights-ties`;
- `verify-tab-sales`, `-agents`, `-profit`, `-lists`, `-returns` and `-work`.

`verify-attribution` passes except C7 (37) and C8b (14), the known AlterCPA leftovers (owner items below).

**September 01–28 cohort by department** (sale day; includes MEX-only parcels and web):

| Department | Sales | Денари |
|---|---:|---:|
| Affiliate – Lead in | 2.391 | 7.153.500 |
| Affiliate – Lead out | 834 | 2.367.046 |
| Телешоп – Lead out | 2.172 | 4.987.661 |
| Телешоп – Lead in | 1.387 | 2.864.465 |
| Социјални мрежи | 225 | 424.560 |
| Web | 447 | 940.504 |
| **Total** | **7.456** | **18.737.736** |

## ✅ Done since (29.09, 05:00 → 09:10) — all applied, deployed and pushed

- **05:10 Leaderboard v2 LIVE** (`145645c`, migration `20260942001200`): one row per agent split by
  department; `verify-leaderboard-v2` 22–29.09 PASS on the live function; live smoke 28.09 → 65 people,
  109 sales (108 credited + 1 no seller). Integrations words for the 15-min schedules in the same commit.
- **05:10 cross-channel parcels** (`3ed28e4`): mex-reconcile guard deployed (a dead lead is revived
  only by its own folder's parcel — AlterCPA 9110, CRM 9103) + repair run `a057bc52`: 145 AlterCPA
  leads the old reconcile had revived on NATURA teleshop / social parcels went back to cancelled /
  trashed. **08:46: their 125 collabBox documents re-applied** (run `4cdb427f`) → each is now its own
  teleshop / social order with its seller (16 more were created by the backfill). Listed for the owner:
  47 same-day + 84 imported links (CSV `exports/repairs/cross-channel-parcels-2026-09-29T03-04-29-167Z.csv`).
- **AlterCPA weekly 90-day sweep** done 05:11; **collabBox history backfill 06.04 → 26.09** done 08:03
  (0 errors); crons every 15 min running since 06:07 (MEX) / 07:00 (collabBox, AlterCPA status).
- **08:53 Orders list** (`6e8bd8f`, migration `20260942001500` order_departments): every order shows its
  SELLER (the sold_* stamp — a collabBox order was "confirmed by System (collabbox-sync)") and its
  DEPARTMENT as the source chip (intake under it). confirmed_by_* untouched (payouts deferred).
- **Operations day boundary** fixed (Skopje day, same commit).
- **09:00 Табла for admins = the Insights Overview** (`981051b`): the old CEO view (CRM statuses by
  created UTC day, "revenue" = shipped + paid, assigned-agent rankings, paging all orders) is gone.
- **09:02 Операции** (`3463311`): today = the sale cohort of the Skopje day (sales by department, to
  pack, MEX money collected), MEX returns today; per agent the day's credited sales + worked decisions
  from leaderboard_day_v2. Money tiles only for owners.
- **09:06 Order window "Origin and proof"** (`b406bc4`, `703976b`, migration `20260942001600`
  order_origin): department, intake, seller, sold at, AlterCPA decision, collabBox document, CRM price
  vs MEX COD, MEX profile / tracking / status / created / delivered / returned / receiver.
- **Pure Profit cache** force-refreshed (6 months) after the backfill.
- **09:18 collabBox nightly-mode run** (26–28.09, ok) — every feed green (AlterCPA, MEX ×2, web, collabBox).
- **09:25 Customer 360** (`b19a069`, migration `20260942001700`): order badges show the department.
- **Checks 09:00:** September + July — engine fixture, insights-ties, tab sales / agents / profit /
  returns / work, leaderboard-v2: PASS. verify-attribution: only the known C7 (Sep 37; Jul 655 = the
  11.08 "cancel(other) before August = paid" ruling, report only) and C8b (Sep 14, Jul 1).
  tab-lists L8 off by 1 member = the live recompute (flicker).

## ✅ Done 29.09 afternoon (after the second usage limit; all pushed + deployed)
- **09:25–09:40** layout grey void fixed (`81f4182`); login lands agents on /calls, admins/managers on
  /insights — the permission-loading race that sent every agent to /assigned (and prediction agents
  into a white redirect loop) fixed; /start + homePath + no-access screen + AppErrorBoundary + chunk
  reload; "Assigned to me" retired → /calls (`6fbbcd5`).
- **11:40 → 12:20 department rule, final: the MEX PROFILE decides.** The agent-team rule (`c7c6e42`,
  `…1800`) was WITHDRAWN once the owner saw the CRM sales ship 98% via BIO NATURAL: BIO NATURAL = affiliate
  in/out, NATURA = teleshop / social / web. `…1850` reset the overrides; `…1860` (`1f4d928`): a CRM-made
  sale follows its parcel profile (BIO NATURAL → Affiliate – Lead out, NATURA → by series, no parcel →
  Affiliate – Lead out until MEX), MEX-only BIO NATURAL parcels always affiliate. The Prediction-lists tab
  holds the list sales of every department (kept from `…1800`). September: Affiliate – Lead out 842 /
  2.393.446 ден, Телешоп – Lead out 2.292 / 5.246.701 ден, total unchanged.
- **11:45** order origin money owner-only (`edfa901`).

- **12:05 docs + skills** (`1726025`): CLAUDE.md (MEX-profile law, one calculation, 15-min rule,
  collabbox-sync live, stock deferred), new skills `elyon-departments-and-sources` + `elyon-collabbox-sync`,
  8 skills and 7 docs brought to 29.09. Integrations collabBox card reads like the other feeds (`4e3ad2e`).
- **12:20 owner questions** (`8d9efb8`, `PRASHANJA-ZA-MILE.md`): + 1ж, the seller names with no person
  (Dance Krstevska 188, Simona Krstevska 132 — old AlterCPA, collabBox names another author; Kristina
  Ilievska 122 social). The stamping-gap probe found NO gap in the LEADS / LEADS-OUT credit.
- **12:40 hygiene** (`5cd01e9`, migration `20260942001870`, applied): 14.674 paid orders with their own
  delivered MEX parcel now carry `paid_basis = 'mex'` — the DO block refused on any bucket move; none
  moved. Left NULL on purpose: 3 web-claimed + 4 fact-less parcels (their basis decides their bucket).
  C8a: a date-narrowed run no longer calls the 3 owner-accepted August pairs "stale".

- **13:05 collabBox BOOKINGS count the moment they are booked** (`aabc5f5`, migration `…1900`, api
  deployed first): a document booked without its MEX parcel is a cohort sale (kind 'booking', to pack,
  folder's department, its author, document amount, ≤ 14 days old, never a CRM/AlterCPA sale's copy — phone
  + amount within 14 days back / 2 forward, or the author's own sale within 10 min). `total.orders` stays
  real orders, so /orders drills stay exact. Today 275 sales / 675.081 ден of which 138 booked; September
  7.973 / 19.977.478 ден of which 140 booked. Remaining risk: a no-phone LEADS-OUT copy booked > 10 min
  after its CRM sale counts twice until the parcel (~180 of 685 since 15.08) → owner question А6.
- **13:30 Call activity lists booking authors** (`e7db35f`, migration `…1910`): a seller whose only sales
  are bookings gets her row (Sofija Kuculovska, 5 bookings, no team).
- **Checks after 1900/1910:** engine fixture, insights-ties, every tab-* (Sep + today), leaderboard-v2
  22–28, attribution C1 01–28: PASS. Today-window failures were live races by one decision (W2/W8/L1/C1)
  and pass on closed days. Open: C7 37 / C8b 14 (owner items А1 / М3).
- **13:20 the owner's questions by department** — PDF `exports/prashanja/Prashanja-po-oddeli-2026-09-29.pdf`
  (17 pages, 45 questions: Affiliate · Телешоп · Социјални · Магацин · Финансии · Надворешни · За тебе),
  generated from `scratchpad/prashanja/content.mjs` + `gen.mjs` together with its Markdown twin
  `PRASHANJA-ZA-MILE.md`; the review lists per question in `exports/prashanja/Prilozi-prashanja-2026-09-29.xlsx`
  (customer PII — gitignored).

## 🏃 Running at ~13:35
- **Overview fixes from the Insights audit** (agent; code + migration `…1920` written, NOT applied): the
  Prediction-lists tie note, hide the old-model drill-down, the source-trends "placed" line and the teams
  board onto the cohort / Agents data, skip the wasted compare query, drop the old fallback tiles, attention
  amounts in MEX COD + collabBox judged by its live feed state, dead files, stale comments.
- **Attachment workbook** for the questions PDF (agent, read-only).

## 🔜 STILL TO DO

1. Review the Overview fixes → tripwire → dry-run + apply `…1920` → deploy `api` if touched → build + test →
   commit/push → verify-insights-ties + tab-* for September and today.
2. Check the attachment counts against the PDF (47 / 84 split, 63, 23, 10, 14, 30, 36, 130); regenerate the
   PDF + Markdown if a number moved (`node gen.mjs` in `scratchpad/prashanja`); commit the Markdown.
3. `MACEDONIA-STATUS.md`: bookings + 1910 + the audit fixes.
4. Final report to the owner (Macedonian) with the PDF and the Excel.

## 🧑‍💼 Open owner items (decisions only he can make)

**AlterCPA orders**
- **C7: 74 AlterCPA "paid" without MEX proof.**
  - 68 are "manual": the phone's parcels belong to another order and the COD does not fit.
  - 6 now have a parcel. A dry run exists: `exports/repairs/altercpa-unproven-paid-2026-09-29T02-40-46-103Z.csv`, script `scripts/repair-altercpa-catchup-paid.mjs --population unproven-paid`.
  - The Insights show them as `paid_unproven`, never as cash.
- **AlterCPA "cancelled, then shipped by MEX": 73 September sales have no seller.**
  - The operator cancelled the lead in AlterCPA and MEX then shipped it.
  - The seller rule is pending (Александра Христовска case).
  - The backfilled collabBox LEADS documents may credit some of them; re-check after the backfill.
- **C8b: 14** orders point at a tracking id MEX never reported. 17 parcels are listed for a human.

**People and teams**
- Teams for the Lead-in callers: Чима, Ристеска, Кипровска.
- 5 logins have no team.
- AlterCPA #4531: who is it?
- Is Milijana = "Милјана Тодоровска н."?
- Should the manager accounts (Nina / Dragana) appear on the board?

**Catalogue and costs**
- 16 unsure catalogue groups.
- ~53 older aliases map to a product of the wrong pack size.
- Cost prices, the lead price per webmaster, the MEX return fee.
- The stock count (deferred).

**collabBox**
- The komitent-card lookup returns 0. Phones come from the parcel.
- Social history before March has no MEX data and was not imported.
