# Port guide — Workable duplicated orders (MK)

**Written 2026-08-13 from the BG repo's shipped work (BG commit `cf4c966`, 2026-08-12,
migration `20260920000000`), after a line-by-line audit of THIS repo. All line numbers
below were verified in elyon-natura on 2026-08-13 — re-verify before editing, another
session is active in this repo.**

---

## 1. Goal (operator decision, 2026-08-12/13)

Reverse the "agents never see duplicates" rule here, same as BG:

- Admin/manager presses **Duplicate order** on /orders → a NEW order (own ORD number,
  status `duplicated`, permanent indigo "Duplicate of ORD-x" badge). **The source order
  is never touched** — if it's cancelled it stays cancelled, forever, regardless of
  what happens to the copy.
- The duplicate is a **normal open order**: superadmin/manager can set any status;
  **agents can open and settle it** (confirm / cancel / trash) like any open lead.
- Original and duplicate live fully independent lives under their own order ids.

### Explicitly OUT OF SCOPE (operator said so — do not build now)

- **MEX Poshta must NOT receive confirmed duplicates.** MEX currently gets orders from
  AlterCPA, not from this CRM. Wiring duplicates (or any CRM order) into MEX dispatch
  is future work. The hard requirement TODAY is only: confirming a duplicate must not
  cause any double-confirm reaching MEX through any existing pipe (see §5).
- Shipping/delivery flows for duplicates — future work, do not touch.

### Invariants that must survive the port (same as BG)

1. Nothing can ever be **set TO** `duplicated` (`updateStatusSchema` stays as-is).
2. Duplicates are always created `source_type: "manual"` with **no AlterCPA / inbound
   lead linkage copied** — that is what keeps partner sync and MEX out of the loop.
3. The duplicate endpoint stays admin/manager-only.
4. Lead queues stay clean: duplicates fail both the status filter
   (`pending|take|call_again`) and `LEAD_SOURCE_TYPES`, so they can't enter Pendings.
5. Assignment triple (`assigned_agent_id` / `assigned_agent_name` / `assigned_at`)
   always moves as one — never set the id alone.

---

## 2. Current state of this repo (audited 2026-08-13)

- **Base duplicate feature: PRESENT** (endpoint `api/index.ts:6589`, enum + columns in
  migrations `20260802000000/100`, frontend button/badge, `status.duplicated` in all
  4 locales). Works exactly like BG's July version.
- **Pendings hardening foundation: PRESENT** (ported 08-11): `OPEN_LEAD_STATES:6330`,
  `openStatuses:6345`, `bulk-disposition:5430` (`DISPOSABLE:5461`), `open-lead:5168`,
  anti-fork guard `:4605-4641`, `OUTCOME_TO_STATUS:764` + `applyOutcomeToOrder:798`,
  `GET /orders/:id` fallback `:6017-6026`.
- **Workable duplicates: ABSENT (0/16 pieces).** So this repo currently has the same
  three bugs BG had: blank status Select silently skipping the save (even for
  superadmin), agents getting nothing when clicking a duplicate, bulk actions
  silently skipping duplicates.

---

## 3. The changes

### 3.1 DB migration (apply FIRST)

New file `supabase/migrations/<NEXT>_duplicated_orders_agent_workable.sql`.
**Numbering:** must sort after the current tail. As of this audit the tail is
`20260918000300_mex_weekly_sweep.sql` and `20260917–18` belong to the in-flight
MEX/AlterCPA session — pick `20260919000000` or higher and **re-check the tail right
before creating the file**. Never reuse BG's `20260920000000` blindly.

Content (mirrors BG, but KEEP this repo's `prediction_leads` UNION branch from
`20260802000100:49-54` verbatim):

```sql
-- Reversal of the 2026-08-02 rule (20260802000100): agents now SEE and WORK
-- duplicated orders like open leads (operator decision 2026-08-13, ported
-- from BG cf4c966 / 20260920000000).

DROP POLICY IF EXISTS "Agents can view assigned orders" ON public.orders;
CREATE POLICY "Agents can view assigned orders" ON public.orders
  FOR SELECT TO authenticated
  USING (assigned_agent_id = auth.uid());

DROP POLICY IF EXISTS "Agents can update assigned orders" ON public.orders;
CREATE POLICY "Agents can update assigned orders" ON public.orders
  FOR UPDATE TO authenticated
  USING (assigned_agent_id = auth.uid());

-- check_phone_duplicates: recreate the LATEST version (20260802000100:25) changing
-- ONLY the non-admin order branch:
--   from: (caller_is_admin OR (o.assigned_agent_id = auth.uid() AND o.duplicated_from IS NULL))
--   to:   (caller_is_admin OR o.assigned_agent_id = auth.uid())
-- Keep everything else (incl. the prediction_leads branch) byte-identical.

NOTIFY pgrst, 'reload schema';
```

Validate by running the whole file wrapped in `BEGIN; … ROLLBACK;` through the
Management API before applying, then apply and record in
`supabase_migrations.schema_migrations` (use dollar-quoting `$mig$…$mig$` for the
statements array — JSON-style quoting breaks).

### 3.2 Edge function `supabase/functions/api/index.ts` (deploy right after 3.1)

**A. Additive status-list changes** (each adds `"duplicated"`):

| Where | Line (audited) | Change |
|---|---|---|
| `OUTCOME_TO_STATUS` | `:765-770` | add `"duplicated"` to the `from` arrays of `confirmed`, `cancelled`, `trash`, `wrong_number`, `call_again` (leave `no_answer`/`interested`/`not_interested` null) |
| Anti-fork guard | `:4612` | `.in("status", ["pending","take","call_again","duplicated"])` and DELETE the `.is("duplicated_from", null)` on `:4614` |
| `GET /orders/open-lead` | `:5177-5178` | add `"duplicated"` to `.in(...)`, delete the `.is("duplicated_from", null)` |
| `DISPOSABLE` (bulk-disposition) | `:5461` | `["pending","take","call_again","duplicated","confirmed"]` |
| `GET /orders/:id` non-admin fallback | `:6022-6023` | add `"duplicated"` to the status list, delete the `.is` filter |
| `OPEN_LEAD_STATES` | `:6330` | add `"duplicated"` |
| `openStatuses` | `:6345` | add `"duplicated"` (fixes agent 403 via `isOpenDisposition` and the completeness gate via `isOpenCancel`) |
| Auto-trash workable lookup | `:9523-9540` and `:9652-9672` | the `workable` orders lookup gains `"duplicated"` in its status list (the LIVE-LEAD check with `LEAD_SOURCE_TYPES` stays unchanged) |

**B. Remove the non-admin `duplicated_from` filters** (only after A — these are the
visibility change). `duplicated_from` is PERMANENT, so leaving any of these in place
would hide an agent's own settled duplicates from their Confirmed/Paid tabs forever:

| Where | Line | Change |
|---|---|---|
| Orders list | `:5057` | delete `if (!isAdminOrManager) query = query.is("duplicated_from", null);` |
| Worklist buckets | `:7334` | delete the same |
| Search | `:13037` | delete the same |
| Customer intelligence | `:14254` | delete the same |
| Orders stats | `:7608` | `p_exclude_duplicated: false` always (keep the RPC parameter itself) |

**Do NOT touch** the AlterCPA intake dupe check at `:2173` — internal bookkeeping,
must keep rejecting nothing incorrectly. Do NOT touch `:11041`
`const DEAD = new Set(["cancelled","trashed","duplicated"])` (upsell bonus) — it keys
on CURRENT status, so a duplicate that gets confirmed leaves the set naturally;
verify that claim by reading how it's applied, then leave it.

**C. Claim-on-action** — a PLAIN agent (not admin/manager/warehouse) settling an
unassigned open order becomes its owner. Two insertion points:

1. `applyOutcomeToOrder` (`:798+`): add optional `claimIfUnassigned?: boolean` to its
   args interface; widen the order select to include `assigned_agent_id`; before the
   update, when `claimIfUnassigned && !order.assigned_agent_id && agentId`, fetch the
   agent's `profiles.full_name` and merge the full triple into the update:
   ```ts
   update.assigned_agent_id = agentId;
   update.assigned_agent_name = prof?.full_name ?? null;
   update.assigned_at = new Date().toISOString();
   ```
   At the `POST /call-logs` call site (`:9352`) pass
   `claimIfUnassigned: !isAdminOrManager && !isWarehouse`.
2. `PATCH /orders/:id/status`: just before the final `update` is applied (this repo
   has MK-specific structure — the `isWarehouse` branch `:6348-6350`, `mex_office` in
   the completeness check `:6389`, `isPostShipmentAdminEdit` `:6380` — slot AROUND
   these, do not replace anything):
   ```ts
   if (!isAdminOrManager && !isWarehouse
     && !order.assigned_agent_id
     && OPEN_LEAD_STATES.includes(order.status)) {
     update.assigned_agent_id = user.id;
     update.assigned_agent_name = profile?.full_name || user.email;
     update.assigned_at = new Date().toISOString();
   }
   ```
   (reuse the `profile` the handler already fetches for `confirmed_by_name`).

### 3.3 Frontend

1. **`src/components/OrderModal.tsx`** (`ORDER_STATUS_OPTIONS` at `:84-95`) — the
   actual superadmin bug. Add above the component:
   ```ts
   // Shown only while the order actually IS a duplicate, so the Select can render
   // its current value; the backend rejects setting any order TO 'duplicated'.
   // Without this the trigger rendered blank and a save that didn't re-pick a
   // status silently skipped the status PATCH.
   const DUPLICATED_STATUS_OPTION = {
     value: 'duplicated',
     labelKey: 'status.duplicated',
     color: 'bg-indigo-100 text-indigo-800 border-indigo-200 dark:bg-indigo-500/15 dark:text-indigo-300 dark:border-indigo-500/30',
   };
   ```
   and where `statusOptions` is computed:
   ```ts
   const statusOptions = isLead
     ? LEAD_STATUS_OPTIONS
     : (data?.status === 'duplicated' ? [DUPLICATED_STATUS_OPTION, ...ORDER_STATUS_OPTIONS] : ORDER_STATUS_OPTIONS);
   ```
2. **`src/pages/Orders.tsx:471`** — `DISPOSABLE_STATUSES` gains `'duplicated'`.
   **Keep this to the single line**: the surrounding selection model is shared with
   the MEX fulfilment CSV export the other session is editing.
3. **`src/pages/Orders.tsx:851`** (optional, same pass): the `'duplicated'` filter
   chip is gated on `isAdmin` only while everything server-side is
   `isAdminOrManager` — align it so managers can filter for duplicates.
4. **`src/components/CreateOrderModal.tsx:164`** — stop swallowing a failed
   existing-order fetch (today a 404 silently opens a BLANK CREATE form, which forks
   a second order):
   ```ts
   existingOrderId ? apiGetOrder(existingOrderId).catch(() => '__load_failed__') : Promise.resolve(null),
   ```
   and first thing inside the `.then`:
   ```ts
   if (existingOrderId && existingOrder === '__load_failed__') {
     toast({ title: t('createOrder.loadExistingFailed'), variant: 'destructive' });
     onClose();
     return;
   }
   ```
5. **i18n — ALL FOUR locales** (`src/i18n/__tests__/parity.test.ts` enforces key
   parity and will fail otherwise). Add inside the `createOrder` block, key-based
   (mk.json has different line offsets — never patch by line number):
   - en: `"loadExistingFailed": "Could not load the order — please try again"`
   - bg: `"loadExistingFailed": "Поръчката не можа да се зареди — опитайте отново"`
   - mk: `"loadExistingFailed": "Нарачката не можеше да се вчита — обидете се повторно"`
   - sq: `"loadExistingFailed": "Porosia nuk u ngarkua dot — provoni përsëri"`

---

## 4. Files you must NOT touch (in-flight session + future work)

- `supabase/functions/altercpa-sync/**` (incl. `altercpa.ts:103,105` where
  `duplicated: 9` / `CRM_TERMINAL` live) — belongs to the AlterCPA session. The
  safety analysis in §5 makes changing it unnecessary for this port.
- `supabase/functions/mex-reconcile/**` (incl. the `duplicated_conflict` skip at
  `index.ts:222`) — MEX is not wired to CRM confirms yet; future work.
- Any migration in the `20260917*`–`20260918*` range, `scripts/audit-collabbox-paid.mjs`
  (modified in the working tree), and the untracked `.xls` files.
- The MEX CSV export logic in `Orders.tsx` beyond the single `DISPOSABLE_STATUSES` line.

---

## 5. MEX / AlterCPA double-confirm safety (verify, don't build)

The operator's hard requirement: confirming a duplicate must never reach MEX (which
today receives orders from AlterCPA), so no client ever gets two parcels.

Verify these two facts in code and state them in your report:

1. The duplicate endpoint (`:6589+`) copies via an explicit allowlist and does NOT
   copy any AlterCPA/lead linkage (no `inbound_lead_id`, no external/AlterCPA ids,
   `source_type` forced to `"manual"`). → Confirm by reading the insert payload.
2. `altercpa-sync` selects orders to sync **by their AlterCPA linkage** — a manual
   duplicate with no linkage can never be picked up, so its `confirmed` never reaches
   AlterCPA and therefore never reaches MEX. → Confirm by reading the sync's order
   query. If either fact does NOT hold, STOP and report before deploying anything.

---

## 6. Deploy order & verification

Deploy: **migration → `supabase functions deploy api` → SPA** (git push; check how
this repo deploys — BG auto-deploys Vercel on push to main).

Working-tree rules: another session is active here. `git status` first; stage ONLY
your explicit paths (never `git add -A` / `commit -a`); if HEAD moves mid-work it's
the other session, rebase yours on top.

E2E on prod (BG ran the same 11 checks, 11/11 — mirror them):

1. Admin duplicates an order → new ORD number, status `duplicated`, unassigned;
   **source order's status unchanged**.
2. Superadmin opens the duplicate → status Select shows the indigo "Duplicated" pill
   (not blank) → set Confirmed → save → status really changes, history rows
   `duplicated → confirmed`.
3. Agent (use a decommissioned/test login, NOT an active agent) `GET /orders/:id` on
   a duplicate → 200 (was 404).
4. Same agent PATCHes `duplicated → trashed` with `trash_reason: 'duplicate_order'`
   → 200; claim triple set to that agent.
5. Negative: PATCH any order TO `duplicated` → 400.
6. Agent search finds the duplicate's ORD number (route here is `search-prediction`).
7. Agent Pendings queue + `my-pendings-summary` unaffected (duplicates never enter
   lead queues).
8. **MEX/AlterCPA safety**: after confirming a test duplicate, verify no
   altercpa-sync row/log/queue entry exists for it (per §5.2's query shape).
9. `npx tsc -p tsconfig.app.json --noEmit` — no NEW errors vs this repo's baseline;
   i18n parity test passes.

Note the MK trash nuance: `trash_reason='duplicate_order'` is non-sticky here
(`20260913000200`), unlike BG — trashing a duplicate keeps the customer callable.
That is acceptable; just don't "fix" it as part of this port.

---

## 7. Paste-ready prompt for the elyon-natura session

```
Read docs/DUPLICATES_WORKABLE_PORT_GUIDE_MK.md and implement it exactly.

Goal: duplicated orders become workable open leads (the BG CRM shipped this as
commit cf4c966 on 2026-08-12; this guide is the audited MK port map). Admins
duplicate from /orders; the copy gets its own ORD id; the ORIGINAL order is never
touched; agents and superadmins can then confirm/cancel/trash the duplicate freely.

Hard constraints:
- Do NOT touch altercpa-sync, mex-reconcile, any 20260917*/20260918* migration,
  scripts/audit-collabbox-paid.mjs, or the MEX CSV export logic — another session
  owns those, and MEX must stay unwired from CRM confirms for now.
- First VERIFY the §5 safety facts (duplicates carry no AlterCPA linkage; the sync
  picks orders by linkage) — if either fails, stop and report instead of deploying.
- Re-verify every line number in the guide before editing; re-check the migrations
  tail and number the new migration ABOVE it (20260919000000 or higher).
- Stage by explicit path only (no git add -A). Deploy order: migration (validated
  BEGIN…ROLLBACK first) → edge function → frontend.
- Nothing can ever be SET to status 'duplicated'; duplicates stay source_type
  'manual'; the new i18n key goes into all four locales (parity test enforces).

Finish by running the §6 verification (use a decommissioned/test agent login for
the agent-side checks, never an active agent) and report each check's result.
```

---

## 8. Addendum 2026-08-13 — lessons from the BG rollout (port these too)

Three defects surfaced in BG production AFTER the main port. Include all of
them or MK will hit the same reports.

### 8.1 The modal save died before the status PATCH (BG `803d725`)

Agents got "Operation failed" when saving a duplicate. `PATCH /orders/:id/customer`
and the item routes (`POST/PUT /orders/:id/items`, `PATCH/DELETE /order-items/:id`)
fetched and wrote through the **RLS-scoped client**, and agent RLS only matches
orders assigned to the caller — so every UNASSIGNED duplicate was invisible and
the write 400'd.

Fix: those five routes use `adminClient` behind one shared guard defined next to
`canMutateOrders`:

```ts
const OPEN_ORDER_STATES = ["pending", "take", "call_again", "duplicated"];
const orderOwnershipBlocked = (order: { status: string; assigned_agent_id: string | null }) =>
  !isAdminOrManager && !isWarehouse
  && !OPEN_ORDER_STATES.includes(order.status)
  && !!order.assigned_agent_id && order.assigned_agent_id !== user.id;
```

Note the order-items routes had **no ownership guard at all** before this (an
IDOR gap) — check whether MK shares it and close it in the same pass.

### 8.2 The take-lock was DEAD in prod (BG `803d725`)

BG's `5dbc15e` had moved `.ilike` BEFORE `.select` on the heartbeat's candidates
query. The bare query builder has no `.ilike`, so **every first heartbeat threw
500**: no take flip, no assignment-on-open, no live-activity row — silently, for
three days. **Check MK's `active-call-views/heartbeat` for the same ordering**
(MK ported that commit on 08-11). Chain order must be `.from().select().ilike()`.

Also add (operator rule): the heartbeat CLAIMS unassigned duplicates for the
opening agent — a sticky real assignment (full triple), status stays
`duplicated`, NOT recorded in `taken_order_ids`, never reverted on release.
Select-then-update; `.ilike` does not exist on update builders either.

### 8.3 Two open orders → the wrong one got confirmed (BG `ff3ab52`)

Once duplicates are workable a customer can have a pending lead AND a duplicate
open at once. Confirm-from-call resolved to the QUEUE ROW, so an agent "editing
the duplicate" silently confirmed the ORIGINAL (a real incident: BG ORD-43660 /
ORD-43774; the affiliate partner got a confirmed postback for the original).

Port all three parts:
1. `GET /orders/open-lead` returns `leads` — ALL open orders for the phone,
   newest first, limit 5, including `duplicated_from_display` — beside the
   legacy single `lead`.
2. `/calls` asks WHICH order when `leads.length > 1`, for confirm **and** cancel
   **and** trash (a small dialog: ORD number, status, duplicate badge, owner).
   Exactly one → unchanged zero-click path. Zero → the existing create-record
   fallback.
3. The complete-existing modal header must NAME the order it is completing
   (ORD number + a Duplicated chip). MK i18n keys needed in all four locales:
   `callsPage.whichOrderTitle`, `callsPage.whichOrderDesc`.

### 8.4 Settled orders are manager-only (operator rule 2026-08-13)

Agents may change status ONLY while the order is open
(`pending|take|call_again|duplicated`). The existing allowlist checks the TARGET
status only, so an agent could flip their OWN `cancelled`/`paid` order back to
`confirmed`. Add, right after the ownership guard in `PATCH /orders/:id/status`:

```ts
if (!isAdminOrManager && !isWarehouse
  && !OPEN_LEAD_STATES.includes(order.status)
  && newStatus !== order.status) {
  return json({ error: "Forbidden — only a manager can change a settled order" }, 403);
}
```

(Same-status saves stay allowed so reason corrections still work. Warehouse
keeps its fulfilment path — check MK's `isWarehouse` branch, which BG lacks.)
Mirror it in the UI: `OrderModal` renders settled orders read-only for agents,
so tapping a Paid/Cancelled pill opens the order to LOOK at, never to rewrite.

### 8.5 Also worth porting

`OrderModal`: confirming no longer requires a call-outcome click (operator rule)
— cancel/trash still require outcome + reason; the lead flow is unchanged.
Both the `handleSave` gate and the Save button's `disabled` need it.

### 8.6 Verification additions

Add to §6: two open orders both listed by open-lead; agent confirms ONLY the
duplicate and the original stays pending; agent 403s changing their own
confirmed / paid / cancelled order; superadmin still passes; heartbeat returns
200 and claims the duplicate. **Synthetic e2e leads need city + address +
delivery_type**, or the completeness gate 400s the confirm and the next
assertion silently tests the wrong state.

---

## 9. Addendum 2026-08-13 (later) — mandatory answer per opened client

Shipped in BG as `f88f9a8` + migration `20260921000000`. Operator rule: the
moment a client lands on an agent`s /calls screen (queue, search "Open in
Calls", Personal List, dial) the agent owes an answer — No Answer counts —
before opening anyone else. Holds until answered; survives refresh, re-login
and queue-list switches. Admins/managers/warehouse exempt.

Port pieces (copy the BG implementation):
1. Migration: `agent_call_obligations` table — PK `agent_id` (ONE debt per
   agent, first unanswered client wins), `customer_phone`, `customer_name`,
   `source`, `created_at`; **deny-all RLS + REVOKE in the same migration**.
2. Edge fn: `POST /call-obligations` (register, returns the STANDING obligation
   when one exists — the mismatch is the snap-back signal), `GET
   /call-obligations/mine`, `DELETE /call-obligations/:agentId` (admin release
   valve, audited). Module helper `clearCallObligation(client, agentId, phone)`
   (last-8 match) called from: `POST /call-logs` (any outcome incl. no_answer),
   `PATCH /orders/:id/status`, `POST /orders`, `POST /personal-list`.
3. CallsPage: react-query `['call-obligation', userId]`; central effect
   registers every `selectedPhone` (ref-guarded); standing-mismatch → toast +
   snap back to the owed client; fresh-load restore when a debt exists; amber
   banner; every outcome success invalidates the query. In-call Confirm uses
   the §8.3 which-order chooser; delete the old single-lead resolver if it
   goes dead.
4. i18n ×4: `callsPage.finishCurrentFirst`, `callsPage.finishCurrentFirstDesc`,
   `callsPage.mustAnswerBanner`.
5. Verify (BG ran 10/10): register → first-wins → refresh persistence →
   no_answer release → unrelated outcome no-op → order-settle release → admin
   exempt → admin release → deny-all direct PostgREST reads.

### 9.1 CORRECTION (same day, BG `7818033`) — register on the CALL, not on display

§9 point 3 as first shipped registered the obligation when a client was merely
DISPLAYED. That locked agents out of the search bar the moment the queue
auto-served the next customer ("finish this client first" with no way to even
call anyone) — reverted in BG within the hour, all standing rows purged.

**Port the refined rule instead:** browsing is free (search, queue, Personal
List all display without commitment). Registration happens in the DIAL
handlers only (`handleDial` + the topbar manual dial), and both handlers
REFUSE to start a call to a DIFFERENT client while an answer is owed. No
snap-back-on-browse effect; keep only the restore-on-load effect (empty screen
+ standing obligation → owed client comes back). Banner shows only when the
displayed client IS the owed one. Backend from §9 is unchanged and correct.
