**Plan: cohort KPI header for Insights → Overview (frontend)**

**0. What the live data shows (MK, read-only SQL, window 22.09–28.09 = the 7-day preset)**

- **Where "Наплатено 3.062.765" comes from.** It is the cash clock: CRM orders MEX proved delivered, 418 = 1.169.020 ден, plus parcels that exist only in MEX, 884 = 1.893.745 ден. Of those 884, 755 are teleshop/social (1.655.675) and 129 are web NTMK (238.070). So 62% of that figure is not CRM sales at all.
- **"Направени"** is on the created-day clock. The two figures cannot be compared. That is the owner's complaint, confirmed.
- **CRM sales in the period (sold clock)** = 464 / 1.208.036 ден. The parts sum exactly:
  - наплатено (MEX): 121 / 316.452 (MEX cash on delivery (COD) 355.510)
  - кај курир: 51 / 159.551
  - спакувано, чека курир: 31 / 97.181
  - во магацин за пакување: 260 / 632.862
  - вратено: 1 / 1.990
  - откажано по потврда: 0
  - платено без MEX доказ: 0
- **MEX-only teleshop/social, by the day the parcel was created:** 746 / 1.656.265 ден (556 delivered, 142 in transit, 35 label printed, 13 returned). Collabbox orders stop at 2026-09-18 07:00Z, so this week's teleshop exists only as MEX-only parcels.
- **Over 30 days:** 5.971 CRM sales. 54 of them are paid with no MEX proof (121.080 ден, all AlterCPA), 480 were cancelled after confirmation and 613 returned. The unproven bucket is real data.
- **"Спакувано, чека курир" cannot come from `packed_at`.** It has been set 0 times ever, and no confirmed order has a tracking id. The real signal is `status='shipped' AND mex_status_id=8` ("Shipment created"): 105 orders now, 31 in this week's cohort. Separately, 31 shipped orders have no MEX status at all.
- **One order is sold but reopened** (`sold_at` set, status pending-like). A `reopened` bucket must exist, shown only when it is above 0.
- **ElyonCRM "leads in"** would be 1.780 rows this week, of which 1.638 are 0-ден disposition rows. `leads_in` must exclude disposition, or ElyonCRM conversion reads 8% instead of 100% of real sales. AlterCPA: 831 in, 308 now sold (37%), 116 still waiting.

**1. Proposed `cohort` block (a new top-level key in GET /insights/overview)**

Buckets are an array with `key`. That way the non-owner whitelist only needs `key`/`count`/`drill`, not every bucket name.

```jsonc
"cohort": {
  "basis": "sold",
  "total":   { "count": 1210, "value_mkd": 2864301 },
  "buckets": [ // fixed order; Σ count = total.count, Σ value_mkd = total.value_mkd
    { "key": "collected",               "count": 677, "value_mkd": 1548267, "cod_mkd": 1587325, "drill": { "outcome": "delivered", "proof": "mex" } },
    { "key": "paid_unproven",           "count": 0,   "value_mkd": 0,       "drill": { "outcome": "delivered", "proof": "unproven" } },
    { "key": "at_courier",              "count": 193, "value_mkd": 469641,  "drill": { "outcome": "in_transit" } },
    { "key": "awaiting_pickup",         "count": 66,  "value_mkd": 179941,  "drill": { "outcome": "awaiting_pickup" } },
    { "key": "to_pack",                 "count": 260, "value_mkd": 632862,  "drill": { "outcome": "preparing" } },
    { "key": "returned",                "count": 14,  "value_mkd": 33590,   "drill": { "outcome": "returned" } },
    { "key": "cancelled_after_confirm", "count": 0,   "value_mkd": 0,       "drill": { "outcome": "cancelled_after_confirm" } },
    { "key": "reopened",                "count": 0,   "value_mkd": 0,       "drill": { "outcome": "awaiting" } }
  ],
  "by_source": [{
    "key": "altercpa", "in_total": true, "listable": "yes",          // "yes" | "partial" | "no"
    "sale_source": ["altercpa","affiliate"],
    "total": { "count": 322, "value_mkd": 817249 },
    "buckets": [ /* same keys and shape as above */ ],
    "mex_only": null,        // teleshop_other/web: { "count", "value_mkd", "buckets": [...] } — the unlinkable part
    "leads_in": { "count": 831, "confirmed": 308, "awaiting": 116, "conversion": 0.37 }
  }, /* elyon_crm, teleshop_other (partial), web (no) */],
  "leads_in":  { "count": 2611, "confirmed": 450, "awaiting": 116, "conversion": 0.x, "excluded_disposition": 1638 },
  "cash_flow": { "cod_mkd": 3062765, "parcels": 1302, "orders_parcels": 418, "orders_cod_mkd": 1169020,
                 "mex_only_parcels": 884, "mex_only_cod_mkd": 1893745 },
  "unproven_paid": { "count": 0, "cod_mkd": 0 },
  "prev": { "total": {…}, "leads_in": {…}, "cash_flow": {…}, "unproven_paid": {…} },
  "spark": { "sold_value_mkd": [{ "d": "…", "v": 0 }] },   // owners only
  "sold_count_series": [{ "d": "…", "n": 0 }]               // everyone
}
```

- **Units:** `value_mkd` everywhere, computed server-side as round(price×61.5), the frozen peg the RPC already uses. CRM, MEX-only and web share one unit that way. Render with `f.den`, never `f.eur`.
- **Web and MEX-only, either way the backend decides:**
  - If they count in the total, their `by_source` row has `in_total: true` and `listable` set to "partial" or "no".
  - If they don't, the row has `in_total: false`, and the frontend puts it in a separate "Продажби надвор од CRM" strip with its own small bar.
  - The header total is always Σ of the `in_total` rows.
- **`prev` has no bucket deltas, on purpose.** An older cohort always has less "to pack" left, so bucket deltas would mislead. Deltas go only on total, leads_in, cash_flow and unproven_paid.

**2. Components**

*New files* (types stay local, because `src/lib/api.ts` is being edited by other agents):
- **`cohortTypes.ts`** – `OverviewCohort` etc. Read `data.cohort` through a cast `OverviewResponse & { cohort?: OverviewCohort }`. Move the types to `api.ts` (~line 2221, `OverviewResponse`) once it is free.
- **`cohortModel.ts`** – pure functions, plus `cohortModel.test.ts`:
  - `COHORT_ORDER`
  - `cohortOf(cohort, selectedKeys)`: re-sums total and buckets from the chosen `by_source` rows when a source filter is on, like `deriveKpis` at model.ts:249.
  - `cohortSumOk(total, buckets)`
  - `cohortBucketHref(bucketKey, rows, range)`, rules in §3
  - `cohortPartHref(...)`, rules in §3
  - `leadsInHref`, `cashHrefs`
- **`CohortHeader.tsx`** – hero plus bar plus tiles:
  - Hero: "Продадено во периодот" with count and денари (owners), a delta vs `prev.total`, and a sparkline.
  - Directly under it, one `OutcomeBar` built from the cohort buckets. Owners' bar is weighted by `value_mkd`, non-owners' by count.
  - A tile grid. The 6 core buckets always show, including zeros; `paid_unproven` and `reopened` show only when above 0. Each tile has a label, an icon, the value (a link when exact), its share of the total, and money for owners. The "Наплатено" tile adds a line "MEX откуп {cod}".
  - Under the tiles, a composition line ("во CRM 464 · само во MEX 746 · веб …") and a visible sum check "= 1.210". If Σ ≠ total, render a warning and `console.error` in dev.
- **`CohortSecondary.tsx`** – below a divider with the heading "Друго во периодот", three cards, each stating its clock:
  - leads_in: count, of which confirmed, %, and awaiting.
  - cash_flow: денари or parcels, of which MEX-only.
  - The unproven alarm. `UnprovenStatus` moves here from KpiRow.tsx:174.

*Changed files:*
- **`OverviewTab.tsx`**
  - Replace `<KpiRow>` (lines 212–215) with `<CohortHeader>` + `<CohortSecondary>` when `data.cohort` exists. Keep KpiRow as the fallback, so the frontend can ship before the backend.
  - Build `cohortView` inside the existing `view` memo (125–151), using the filtered `by_source`; `prevQ` (91–97) already provides the filtered previous period.
  - `tileHrefs` (240–269) stays only for the fallback.
  - Update the skeleton (271+).
- **`OutcomeBar.tsx`** – make it generic: optional props `order`, `tone`, `icon`. The defaults stay `BAR_ORDER`/`BUCKET_TONE`/`BUCKET_ICON` (lines 12–21, 50, 117), so SourceRows is untouched until §6.
- **`palette.ts`** – add `COHORT_ORDER` and `COHORT_TONE`. Reuse the colours already validated at palette.ts:53+, in the same neighbour order:

  | Cohort bucket | Existing tone reused |
  |---|---|
  | collected | delivered |
  | at_courier | courier |
  | awaiting_pickup | preparing (#4f46e5) |
  | to_pack | awaiting (#818cf8) |
  | returned | returned |
  | cancelled_after_confirm | cancelled |
  | reopened | trashed |

  Only `paid_unproven` is new: emerald with a diagonal hatch plus the OctagonAlert icon. It needs one validator run for its two neighbours.
- **`KpiRow.tsx`** – once the fallback is dropped, move `DeltaBadge` (142–171) to `DeltaBadge.tsx`; it is only used inside KpiRow today.
- **`useOverviewFormat.ts`** – add `cohortLabel(k)`.
- **`OrdersDrillBanner.tsx:9-11`** – add to `OUTCOME_LABEL`: `in_transit`, `awaiting_pickup` and `cancelled_after_confirm` map to `overview.cohort.bucket.*`. Without this, `cancelled_after_confirm` shows the raw key, because no `overview.bucket.cancelled_after_confirm` exists.

**3. Drill links (only when exact)**

A bucket link is:
```
/orders?sale_source=<union of contributing rows' sale_source>&sold_from=<from>&sold_to=<to>&outcome=…[&proof=…]
```
- **No link at all when:**
  - the bucket's `drill.outcome` is missing (this also guards against the non-owner strip), or
  - any contributing row has `listable` other than "yes", or has `mex_only` count above 0 in that bucket.
- **Partial case:** the tile number stays plain text, and a sub-link "{n} во Нарачки" opens only the listable part.

What GET /orders already supports (index.ts:5505–5569 parse, 5620–5646 apply; clauses in overview.ts:250–263):
- `sale_source`, `sold_from`/`sold_to` (sold-window filter at overview.ts:296, the twin of the RPC's `sale_at`)
- outcomes `delivered`, `preparing`, `returned`, `cancelled_after_confirm`, `awaiting`
- `proof=mex|unproven`, `cash_from`/`cash_to`, `created_from`/`created_to`

The backend must add these to OUTCOME_CLAUSES and to the RPC CASE:
```
awaiting_pickup: ["and(status.eq.confirmed,packed_at.not.is.null)", "and(status.eq.shipped,mex_status_id.eq.8)"]
in_transit:      ["and(status.eq.shipped,or(mex_status_id.is.null,mex_status_id.neq.8))"]
sale:            is_sale twin (not disposition AND (sold_at not null OR status in sale statuses))
```
`sale` is needed so "од нив потврдени" under leads_in is a link (`created_from`/`created_to` + `outcome=sale`). Without it, that number renders without a link.

Other links:
- cash_flow: the orders part → `cash_from`/`cash_to&proof=mex`; the MEX-only part has no link.
- unproven: the existing `cash_from`/`cash_to&proof=unproven` (OverviewTab.tsx:267).

**4. Non-owners (`meta.money=false`)**

- The hero reads "Продадени нарачки во периодот": count only, delta on count, sparkline from `sold_count_series`.
- Tiles show count and share. The bar is weighted by count. No MEX-COD line, no cash денари. The cash card shows parcels, and the unproven card shows only its count.

⚠ **Backend blocker.** `stripOverviewMoney` is a whitelist (overview.ts:170–196). It must add:
`cohort, by_source, in_total, listable, leads_in, cash_flow, parcels, orders_parcels, mex_only_parcels, awaiting, excluded_disposition, outcome, proof, sold_count_series, d, n`

`outcome`, `proof`, `d` and `v` are not whitelisted today. Without that:
- every bucket's `drill` reaches non-owners as `{}`, and a naïve link would widen to all sales;
- spark points arrive empty.

The frontend guard in §3 covers the first case, but the whitelist is the actual fix.

**5. Tests and fixtures to change**

- **`__fixtures__/overview.sample.json`** – add a `cohort` block (the 7-day numbers above) that satisfies Σ buckets = total, Σ `in_total` rows = total, and prev present.
- **`cohortModel.test.ts`** (new):
  - the sum invariants
  - subset sums under a source filter
  - href cases: exact, partial (sub-link only), unlistable (null), drill without outcome (null)
  - `COHORT_ORDER` is stable
- **Server strip test** – run the server's `stripOverviewMoney` (overview.ts; dependency-free, so vitest can import it) over the fixture. Assert that no `_mkd` key survives and that `drill.outcome` does. The frontend `stripMoney` (model.ts:420) is a blacklist and would not catch the whitelist bug.
- **`OverviewTab.test.tsx`**:
  - Line 53: the hero becomes the cohort total. The "never unproven" assertion (54) moves to the cash card, which still shows proven 3.036.660.
  - Line 80: `+2,8%` came from the placed tile → assert the cohort-total delta instead.
  - Line 84: `formatMoney(94614.87)` (the placed tile) → remove it, or assert the leads_in card.
  - Line 97: `heroLabelNoMoney` → the new key.
  - Line 105: '1.285' → the cash card's parcels.
  - Add: a cohort tile link, e.g. `sale_source=altercpa%2Caffiliate&sold_from=…&outcome=delivered&proof=mex`; a teleshop tile shown without a link plus its "{n} во Нарачки" part-link; the no-money render has no "ден".
- **`overviewModel.test.ts`** – the tests around lines 72–100 ("Σ sources = tiles") stay valid while KpiRow is the fallback. Delete them together with `deriveKpis`.

**6. What the Sources section ("Од каде дојдоа парите") should switch to**

- **Basis:** each source row uses `by_source[i]` from the cohort, with the same bar and tiles as the header in a compact variant. Today it uses created-day buckets that include `awaiting`, pre-sale `cancelled`, `trashed` and `no_record` (SourceRows.tsx:50–68). Those are not sales; they move to one line per row: "дојдени 831 · потврдени 308 (37%) · чекаат 116".
- **Subtitle:** "Продажби во периодот по извор и каде е секоја сега".
- **Row header:** "{n} продажби · {value}".
- **MoneyBlock (152–164)** re-based on the cohort:
  - наплатено = collected
  - се очекува = at_courier + awaiting_pickup + to_pack
  - изгубено = returned + cancelled_after_confirm
  - The three add up to the row total.
- **Rates (170–177):** delivery and returns stay; "Откажани" becomes cancelled_after_confirm / total.
- **Splits (179–202):** use the existing `sold_count`/`sold_value_eur`. `splitDrill` (model.ts:153) needs a clock argument that emits `sold_from`/`sold_to`.
- **MEX-only / web:** the teleshop row shows orders plus MEX-only parcels as one cohort with the note "од нив N само во MEX — не се во Нарачки". The web row has no links, as today (web_block).
- **Clocks elsewhere:** `insights_pivot` and SourceTrends remain on the created/cash clocks. Label them explicitly, or add `clock=sold` later.

**7. Recommended mk labels (`overview.cohort.*`, all four locales, after the i18n freeze lifts)**

| Key | mk |
|---|---|
| title | Продадено во периодот |
| titleNoMoney | Продадени нарачки во периодот |
| sub | Потврдени продажби и каде е секоја сега |
| salesN | {{n}} продажби |
| bucket.collected | Наплатено |
| bucket.paid_unproven | Платено без MEX доказ |
| bucket.at_courier | Кај курир |
| bucket.awaiting_pickup | Спакувано, чека курир |
| bucket.to_pack | Во магацин за пакување |
| bucket.returned | Вратено |
| bucket.cancelled_after_confirm | Откажано по потврда |
| bucket.reopened | Вратено во обработка |
| codLine | MEX откуп {{value}} |
| sumCheck | Збир на деловите = {{total}} |
| partLink | {{n}} во Нарачки |
| notListable | Само во MEX / веб-продавница — не се во листата Нарачки |
| composition | во CRM {{crm}} · само во MEX {{mex}} · веб {{web}} |
| outside.title | Продажби надвор од CRM |
| secondary | Друго во периодот |
| leadsIn.title | Дојдени во периодот |
| leadsIn.line | од нив потврдени {{n}} · {{pct}} |
| leadsIn.awaiting | чекаат {{n}} |
| cashFlow.title | Прилив по ден на достава |
| cashFlow.hint | Парите што MEX ги наплати во периодот, за продажби од кој било ден |
| cashFlow.mexOnly | од нив {{n}} само во MEX · {{value}} |
| clock.sold | Бројано по денот на продажбата (скопско време) |

Unproven tile: reuse `kpi.unproven_paid`, `unprovenOk` and `unprovenBad`.

**8. Rollout order**

1. Backend: whitelist keys, the three new outcome clauses (plus RPC twins), `cohort` in the RPC.
2. Frontend: ships behind `data.cohort` feature detection; KpiRow is the fallback.
3. Once the i18n, api.ts and Orders agents are done: locales, the move of types into api.ts, and the OrdersDrillBanner labels.

Only the three areas in step 3 touch files that are frozen right now. No project files were edited; the queries are in `C:\Users\Mile\AppData\Local\Temp\claude\d--Dev-archives-elyon-natura\ba6c6515-0d2a-4518-b77a-a3e01748e84d\scratchpad\fe\c1.sql`–`c9.sql`.