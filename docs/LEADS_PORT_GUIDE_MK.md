# Lead handling — full port guide, BG → elyon-natura (MK)

> ## ✅ SHIPPED 2026-08-11 — and five things in here were wrong
>
> The port is live: migrations `20260917000000/000100/000200`, the `api` edge
> function, and the SPA. Verified after deploy: **0 stuck takes, 0 frozen
> call-agains, 0 open phantom owners, 0 non-lead rows in any queue, 924 open
> leads all `altercpa`.**
>
> Corrections found while executing — believe these over the body below:
>
> 1. **§3 "phantom owners" is a trap at this scale.** `assigned_agent_id IS NULL
>    AND assigned_agent_name IS NOT NULL` returns **67.069** rows here, and every
>    one is a *terminal-state legacy `import`* row holding historical
>    attribution (cancelled 29.328 · paid 24.134 · trashed 13.606). Exactly ONE
>    open row was affected. **Scope that repair — and check #14 — to
>    `status IN ('pending','take','call_again')`**, or you erase who sold and who
>    cancelled across the entire order history.
> 2. **`LEAD_SOURCE_TYPES` silently dropped 42 live leads.** They carried
>    `external_source='altercpa'` but `source_type='import'` (the history-import
>    path), and **41 were assigned to named agents**. Fixed by
>    `20260917000200`, which relabels them; verified segment-neutral, since every
>    engine predicate excludes `monadon_legacy` and never `import`.
> 3. **Every postback step is inert here, and one is forbidden.** `affiliates`,
>    `affiliate_leads`, `affiliate_postbacks` and `inbound_leads` are all empty
>    and `tg_enqueue_affiliate_postback` reads `affiliate_leads`. The bridge is
>    one-way by design. `bulk-disposition` must **not** nudge a postback drain —
>    that would open a channel to the partner this market does not have.
> 4. **The elevated fallback on `GET /orders/:id` needs a staff gate.**
>    Affiliates hold real Supabase logins here, so `hasInternalRole` is asserted
>    at the call site rather than inferred from the hard wall 3000 lines away.
> 5. **"11 `%last8%` write paths" is wrong — it is 5.** Three of the eight write
>    paths were already suffix-anchored. But three *reads that immediately drive
>    writes* were missed (take-lock candidates, the streak count, the auto-trash
>    target). **8 sites** needed fixing.
>
> §5's claim that the repair scripts "should find nothing, which is the point"
> was also wrong: the fork bug **did** bite here. `ORD-81308` lost its assignment
> to the take-lock, kept its owner's name, and its sale landed on a new
> `ORD-81367` — merged back on 2026-08-11. One ambiguous candidate
> (`ORD-81114` / `ORD-81328`) was deliberately left for a human: different price
> and a fuller name, so a phone match alone is not enough to act on.

Everything done in Elyon BG on **2026-08-10**, why it was done, and exactly how
to apply it to the Macedonian CRM. Both databases were inspected on that date; the
differences that will break a copy-paste port are in **§3 — read that first**.

BG commits: `5dbc15e` → `1976cd1`.
Supersedes `PENDINGS_HARDENING_PORT_GUIDE.md`, which covered only the first half.

---

## 1. The problem, in one paragraph

Affiliate leads were assigned to agents, then circulated between them on their
own. Confirming a lead on the second call created a **second order** instead of
completing the first, so the partner was told "cancelled" for deals we had won.
Agents could not find their own call-backs. Pulling that thread produced
**thirteen** distinct defects, listed below with the rule each one taught us.

---

## 2. The thirteen defects and their fixes

### D1 · The TAKE lock deleted the assignment
Opening a customer on `/calls` flips their `pending`/`call_again` orders to
`take`. Every revert wrote `assigned_agent_id = NULL`, because
`active_call_views` recorded only `taken_from_status`, never the prior
**assignee**. Since an agent may take their own lead, **merely looking at a lead
returned it to the unassigned pool.**
*Fix:* `active_call_views.taken_from_agent uuid[]`; the revert restores it.
*Proof it was real:* 8 orders bulk-assigned twice in one day, 6 to a different agent.

### D2 · Phantom owner
The same revert left `assigned_agent_name` behind, so rows displayed an owner
while counting as unassigned. **This is why nobody noticed D1 for weeks.**
*Rule:* `assigned_agent_id` / `assigned_agent_name` / `assigned_at` move as one
triple. A NULL id must never leave a name behind.

### D3 · Orphaned takes froze forever
The orphan sweep forced stuck takes to `call_again` **without**
`call_again_since`, and `expire_call_again_window()` only releases rows where it
is set. 14 orders were frozen, the oldest since 2023.

### D4 · A `call_again` lead was invisible to confirm → forked orders
The queue asked for `status='pending'` only, so after the first no-answer the
lead left the queue and the phone match that supplies `existingOrderId` found
nothing — Confirm created a second order. **24 pairs in two days.**

### D5 · `POST /call-logs` wrote across agents, and matched phones by substring
No `assigned_agent_id` filter, so one agent's "didn't answer" parked or trashed a
colleague's lead. `%last8%` instead of `%last8` could hit a **different customer**.

### D6 · Prediction work leaked into Pendings
Widening the queue to `call_again` dragged in prediction-list work.
*Rule:* **Call Again is a LEAD state, not a call outcome.** A prediction client
who isn't reached is a *no answer* on their member row; their order is untouched.

### D7 · Counting disagreed with itself
`assigned_pending_counts()` counted `pending` only while
`agent_workloads().orders_open` counted all three — a lead called once was in
neither the unassigned pool nor the per-agent chip.

### D8 · Ownership was too hard for deliberate human actions
An agent handed a client by the manager could not touch that client's
`call_again`: `GET /orders/:id` reads through RLS (invisible) and the PATCH guard
403'd it — so she made a second order, recreating D4.
*Rule:* **ownership governs distribution, not human action.** Whoever is on the
client may resolve the open lead, whoever held it before. Credit follows the work.

### D9 · "Take" read as "delivered"
`status.take` was `Взета`/`Земена`; agents read it as *taken by the courier*.
Renamed to **In progress / В обработка / Во обработка / Në përpunim**.

### D10 · The Call Again page was unreadable
Everyone's queue with no filters, and the source only inferable by reading the
list column row by row — with 654 prediction rows against 18 lead ones, the leads
were buried.

### D11 · Prediction call-agains could not be redistributed
No surface to hand them out repeatedly until somebody gets through.

### D12 · The paced retry hid leads from their own agent
`next_call_after` (2 calls/day, resume 09:00) plus a `ready_only` queue filter
meant a lead the agent had already rung **vanished until the next morning**. One
agent had 4 call-agains and could see 1.
*Rule:* the paced schedule is for **cold prediction outreach**. On a lead the
customer is waiting for *us* — no cooldown, no auto-trash, always visible. When
they called is in `call_logs`; the pacing was guidance, the log is the fact.

### D13 · The Assigner's "Pending leads" row showed nothing
It asked for `status='pending'` while the chip counted the whole lifecycle, so it
said "2 pendings" and "No pending orders to assign" at the same time.

---

## 3. ⚠ BG vs MK — verified 2026-08-10, this is what breaks a copy-paste

Both databases were queried directly. **The single most dangerous difference is
`source_type`.**

| | **BG** (`sxymaloycddnoxudxaqp`) | **MK** (`bmfxhgznttcnnlqloqzp`) |
|---|---|---|
| Lead source value | `affiliate` | **`altercpa`** |
| Bulk legacy import | `monadon_legacy` | **`import`** (80,360 rows) |
| Other sources | `manual`, `opencart`, `opencart_abandoned`, `inbound_lead` | `manual` (1 row only) |
| Partner sidecar | `affiliate_leads.order_id` | **`altercpa_leads.order_id`** (2,217 rows; `affiliate_leads` is EMPTY) |
| Extra partner tables | — | `altercpa_accounts`, `altercpa_offer_map`, `altercpa_sync_runs` |
| Open leads today | 18 call_again | **860 pending, 1 call_again** (821 unassigned) |
| Prediction members in call-again | 654 | **0** (47,124 members total) |

**Therefore, in MK:**

```ts
// edge function
const LEAD_SOURCE_TYPES = ["altercpa", "inbound_lead", "opencart", "opencart_abandoned"];
```
```sql
-- SQL twin
SELECT coalesce(_source,'') IN ('altercpa','inbound_lead','opencart','opencart_abandoned');
```

`import` must **never** be a lead source — it is 80k rows of legacy data and would
flood every agent's Pendings queue. Confirm the list against live data before
shipping:
`select source_type, count(*) from orders group by 1 order by 2 desc;`

**Any logic that follows the partner sidecar must use `altercpa_leads` in MK.**
That affects the anti-fork guard, the merge script and the postback reasoning.
The postback triggers exist (`trg_affiliate_postback_insert`,
`trg_affiliate_postback_status`) — check which table they read before relying on
"moving the sidecar moves the postback".

### What MK already has (no work needed)
`orders` carries every column the BG work depends on: `next_call_after`,
`call_again_since`, `trashed_at`, `trash_reason`, `duplicated_from`,
`assigned_agent_name`, `assigned_at`, `shipped_at`, `paid_at`, `waybill`,
`external_source`. RLS on `orders` is identical to BG (agents scoped to
`assigned_agent_id = auth.uid() AND duplicated_from IS NULL`). Functions
`expire_call_again_window`, `cleanup_expired_active_call_views`,
`assigned_pending_counts`, `assignment_matrix`, `agent_workloads`,
`affiliate_stage`, `recompute_customer_segments` all exist.

### What MK is missing (all of it)
| Check | MK state |
|---|---|
| `active_call_views.taken_from_agent` | **absent** → D1/D2/D3 live |
| `cleanup_expired_active_call_views()` | old body, no version comment |
| `assigned_pending_counts()` | still `WHERE status = 'pending'` → D7 live |
| `is_lead_source()` | **does not exist** |
| `CallsPage.tsx:145` | `status:'pending', ready_only:true` → D4/D12 live |
| `AgentPendingLeadsRow.tsx:45` | `status:'pending'` → D13 live |
| `CallAgainPage.tsx` | 0 filters → D10 live |
| `CallAgainsPanel.tsx` | missing → D11 live |
| `%${last8}%` write paths | **11** occurrences → D5 live |
| `LEAD_SOURCE_TYPES`/`open-lead`/`bulk-disposition`/anti-fork guard | none |
| `status.take` | `Земена` / `Взета` → D9 live |
| Both repair scripts | missing |

**MK is early — 860 leads still `pending`, only 1 `call_again`.** Fixing it now
means the fork bug never produces the mess BG had to clean up.

### MK repo traps
- **Migration numbers collide.** MK has **182** migrations on its own timeline;
  `20260913`–`20260916` are taken by AlterCPA and MK-settlement work. **Start at
  `20260917000000`.**
- `npx tsc --noEmit` is a **no-op** — use `-p tsconfig.app.json` and compare
  against the existing error count.
- `supabase db push` is blocked (no DB password). Apply through the Management
  API `POST /v1/projects/{ref}/database/query`, dry-running each migration
  wrapped `BEGIN … ROLLBACK` first.
- Pushing needs the **VAULT §4 PAT**, not the cached `elyoncoding` credentials.
- MK `.env` has `SUPABASE_ACCESS_TOKEN` and `SUPABASE_SERVICE_ROLE_KEY` — both work.

---

## 4. The rules (port these, not just the diffs)

1. The assignment triple moves together; a NULL id never leaves a name.
2. One customer, one open order — a lead is never forked.
3. Call Again is a lead state, not a call outcome.
4. Pendings = inbound leads only (`is_lead_source`), never agent-created work.
5. Ownership governs distribution, not deliberate human action.
6. Queue, agent badge and manager chip use ONE definition of "pending".
7. Phone matching on any WRITE path is a suffix `%last8`.
8. No order is junked without a reason — bulk paths included.
9. **Leads are never auto-trashed and never throttled.** The 9-strike Unreachable
   rule and the paced retry apply to prediction outreach only.
10. Fresh leads are served before call-backs; call-backs stay visible regardless.

---

## 5. What to build

**Migrations** (renumber from `20260917000000`):
1. `active_call_views.taken_from_agent uuid[]`; rewrite
   `cleanup_expired_active_call_views()` to restore the prior assignee and their
   real name, matching on `(recorded id, status='take')` — **not** on the taking
   agent, or a colleague's taken lead sticks in `take` forever. Orphans: leads →
   `call_again` **with** `call_again_since`; everything else → `pending`.
2. `public.is_lead_source(text)` with the **MK** source list; widen
   `assigned_pending_counts()` to `pending|take|call_again` **and** lead sources.

**Edge function** (`supabase/functions/api/index.ts`):
- `LEAD_SOURCE_TYPES` (MK values) and `CALL_AGAIN_FETCH_CAP = 2000`.
- `revertTakenOrders()` shared by both release paths; the take records
  `taken_from_agent`, claims a colleague's open lead, and never overwrites
  `assigned_at` on an order already assigned.
- No-answer block: scoped to `assigned_agent_id IS NULL OR = caller`; claims an
  unassigned lead; **leads get `next_call_after = null`**; the 9-strike
  auto-trash is skipped entirely when the customer has a live lead (`hasLiveLead`
  guard, which also stops a synthetic "Not reachable" order being invented beside
  one); all phone matches suffix-only.
- `GET /orders?lead_only=1`; `my-pendings-summary` uses the same status+source pair.
- `GET /orders/open-lead?phone=` — finds the open lead with **no agent filter**.
- `GET /orders/:id` — elevated-client fallback for **open leads only**.
- `PATCH /orders/:id/status` — open leads exempt from the ownership guard;
  confirmed and beyond stay locked.
- `POST /orders` — **409 `open_lead_exists`** (unassigned leads included).
- `POST /orders/bulk-disposition` — bulk trash/cancel with a mandatory reason.
- `GET /call-agains` + `POST /call-agains/assign` — prediction call-agains as a
  redistributable pool, keyed by `(list_id, customer_phone)`.
- `call-again-queue`: return `call_again_since` on both sources.

**Frontend:**
- `CallsPage` — queue `pending,take,call_again` + `lead_only`, **no `ready_only`**;
  order fresh → due → parked; badge and auto-pick use `open`; `resolveOpenLeadId`
  via the server; a banner explaining a call-again on screen.
- `CallAgainPage` — source + agent filters, Source badge, "Waiting since" column.
- `CallAgainsPanel` — the Assigner's Call Agains tab.
- `AgentPendingLeadsRow` — fetch `pending,take,call_again` + `lead_only`; header
  "N to call / N call again"; untouched first; status badge on worked ones.
- `Orders.tsx` — bulk Trash/Cancel bar on the existing selection.
- `status.take` → In progress / В обработка / Во обработка / Në përpunim.
- Every string in **all four** locales; `parity.test.ts` enforces it.

**Scripts** (dry-run default, `--apply` to write) — port only if MK ever forks:
`resolve-orphaned-lead-outcomes.mjs`, `merge-forked-lead-orders.mjs`.
With 1 call_again in MK today they should find nothing, which is the point.

---

## 6. Verification

1. `npx tsc --noEmit -p tsconfig.app.json` → no NEW errors vs baseline.
2. `npx vitest run` → green, i18n parity included.
3. `npx vite build`.
4. Parse the edge function before deploy: `esbuild.transformSync(src,{loader:'ts'})`.
5. Dry-run each migration `BEGIN … ROLLBACK`, then apply.
6. `select source_type, count(*) from orders group by 1` → confirm the lead list
   matches reality and `import` is excluded.
7. **Take-lock:** assign a lead to A → open on `/calls` (must read *In progress*)
   → navigate away → still A's, not in `unassigned-pending`. Repeat with a hard
   tab close and with a second agent heartbeating.
8. **Cross-agent:** B logs a no-answer on A's lead → A's row unchanged.
9. **No fork:** take a lead to `call_again`, then confirm → the **same**
   `display_id` becomes confirmed, no new `manual` row.
10. **Hand-over:** give B a client whose lead is A's → B can open the status pill
    and set confirmed/cancelled/trashed on that order.
11. **Visibility:** a lead rung twice today still shows in its agent's Pendings.
12. **No auto-trash on leads:** 9 no-answers on a lead → still `call_again`.
13. A prediction customer who doesn't answer never appears in Pendings.
14. `select count(*) from orders where assigned_agent_id is null and assigned_agent_name is not null`
    → stops growing. `select count(*) from orders where status='take'` → 0 at rest.

---

## 7. Operational note that is not code

Mid-rollout the BG project went fully dark — every user stuck on a loading
spinner. It looked like the deploy. It was not: the database was **idle** (19
connections, 1 active query, 3 txn/sec, no locks) while PostgREST, auth, realtime
and storage all failed their health probes. Supabase's status page said all
systems operational — the project instance had wedged.

**Diagnosis order:** check `pg_stat_activity` for load/locks → check
`/v1/projects/{ref}/health` per service → check status.supabase.com. If the DB is
idle and the services are unhealthy, it is not your code.
**Remedy:** `POST /v1/projects/{ref}/restart`. Recovery took 3 minutes.

---

## 8. Handoff prompt

Paste into a fresh session opened on the `elyon-natura` repo.

````text
Port the Elyon BG lead-handling work into this Macedonian CRM. It is a separate
project with its own database - nothing is shared.

Read docs/LEADS_PORT_GUIDE_MK.md in this repo first. It lists all 13 defects,
the 10 rules behind them, everything to build, and the verification steps.

I have already verified against BOTH live databases. The critical difference:
in THIS project leads arrive as source_type='altercpa', not 'affiliate', and the
partner sidecar is altercpa_leads (2,217 rows) - affiliate_leads is empty. The
80,360-row 'import' source must NEVER be treated as a lead. So:

  LEAD_SOURCE_TYPES = ["altercpa", "inbound_lead", "opencart", "opencart_abandoned"]

Confirm that against live data before you ship it:
  select source_type, count(*) from orders group by 1 order by 2 desc;

Every defect in the guide is present here and none of the fixes are - I checked:
active_call_views has no taken_from_agent, assigned_pending_counts() still counts
status='pending' alone, CallsPage asks for status:'pending' with ready_only,
AgentPendingLeadsRow asks for status:'pending', CallAgainPage has no filters,
there is no CallAgainsPanel, 11 write paths still use %last8%, and status.take is
still "Земена"/"Взета".

Work in this order, verifiable at each step:
  1. The two migrations. RENUMBER - this repo has 182 migrations and
     20260913-20260916 are taken by the AlterCPA and MK settlement work. Start at
     20260917000000.
  2. The edge function.
  3. The frontend, including status.take in all four locales.
  4. The repair scripts, dry-run only - with 1 call_again in this database they
     should find nothing, and that is the expected result.

Constraints here:
  - npx tsc --noEmit is a no-op; use -p tsconfig.app.json and compare to the
    existing error count.
  - supabase db push is blocked (no DB password). Apply migrations via the
    Management API database/query endpoint, dry-running each wrapped
    BEGIN ... ROLLBACK first.
  - Pushing needs the VAULT section 4 PAT, not the cached elyoncoding creds.
  - Read .grok/skills/ first - elyon-assigner, elyon-segments-and-prediction,
    elyon-i18n, elyon-security, elyon-affiliates all apply.
  - Every user-visible string goes through i18n in all four locales.

Show me the typecheck delta, the test run, the production build and the dry run
of each migration BEFORE deploying anything. I will tell you when to apply.

Finish with the section 6 verification list and tell me which checks passed.
````

---

*Written 2026-08-10 from the BG rollout, with both databases inspected the same
day. If a rule in §4 changes, change it in both repos and in
`.grok/skills/elyon-assigner` on the same day.*
