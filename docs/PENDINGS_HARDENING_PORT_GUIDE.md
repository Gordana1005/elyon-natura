# Pendings hardening — what broke, what we did, and how to port it

> ## ⚠️ SUPERSEDED — read `LEADS_PORT_GUIDE_MK.md` instead
>
> This file covers only the first **9** defects. The same-day follow-up covers
> all **13** (it adds the Call Again page filters, the redistributable Call
> Agains tab, the paced-retry trap that hid leads from their own agent, and the
> Assigner's empty "Pending leads" row) and was written with both databases
> inspected.
>
> **The MK port shipped on 2026-08-11 against that guide, not this one.**
> Section 4 below ("State of the MK fork") is now historical — every defect it
> lists is fixed. Its two numbers that were wrong: the `%last8%` write paths were
> **5**, not 11, and the phantom-owner count here is dominated by 67k legacy
> import rows that must never be "repaired". See the corrections banner at the
> top of `LEADS_PORT_GUIDE_MK.md`.

**Origin:** Elyon BG (`elyoncrm`), 2026-08-10. Commits `5dbc15e` → `342e560`.
**Purpose:** a complete record of the incident, and a ready handoff for any other
market fork (`elyon-natura` / MK, and anything forked after it) so the same
failures are never rebuilt.

Companion documents: [PENDINGS_INCIDENT_2026-08-10.md](PENDINGS_INCIDENT_2026-08-10.md)
(the incident + the production numbers), its Macedonian twin `…_MK.md`, and
[AFFILIATE-LEADS-09-10-08-2026-MK.md](AFFILIATE-LEADS-09-10-08-2026-MK.md).

---

## 1. What actually went wrong

One customer-facing symptom — *"our affiliate leads keep circulating between
agents and the partner is told we cancelled deals we won"* — turned out to be
**nine** independent defects that compounded.

### D1 — The TAKE soft-lock deleted the assignment

Opening a customer on `/calls` flips their `pending`/`call_again` orders to
`take` and stamps the viewing agent. Every revert path then wrote
`assigned_agent_id = NULL`, because `active_call_views` recorded only
`taken_from_status` — never the prior **assignee**. Since the take deliberately
allows an agent to take their *own* lead, **merely looking at a lead returned it
to the unassigned pool**.

*Proof:* 8 orders bulk-assigned twice in one day, 6 to a different agent
(one to Slave at 09:20:45, to Verica at 09:20:53).

### D2 — Phantom owner

The same revert left `assigned_agent_name` behind. Rows displayed an owner while
counting as unassigned. **This is why nobody spotted D1 for weeks** — the Orders
list looked correct. 13 open leads were in that state; 6,804 rows overall.

### D3 — Orphaned takes froze forever

The orphan safety net forced every stuck take to `call_again` **without**
`call_again_since`, and `expire_call_again_window()` only releases rows where it
is set. 14 orders were frozen, the oldest since 2023.

### D4 — A `call_again` lead was invisible to the confirm path → forked orders

The `/calls` queue asked for `status='pending'` only. After the first no-answer
the lead became `call_again`, dropped out of the queue, and the phone match that
supplies `existingOrderId` found nothing — so **Confirm created a second order**.
ORD-43138 (€34.90 lead) sat in `call_again` while the real €140 sale became
ORD-43204. **24 such pairs in two days.** The affiliate sidecar stayed on the
dead lead, so the partner got `cancel` for customers who had bought.

### D5 — `POST /call-logs` wrote across agents, and by phone *substring*

The no-answer park and the 9-strike auto-trash matched on phone alone with no
`assigned_agent_id` filter — one agent's "didn't answer" parked or trashed a
colleague's lead. Both used `%last8%` (contains) instead of `%last8` (ends
with), so they could hit a **different customer** entirely.

### D6 — Prediction work leaked into Pendings

Widening the queue to `call_again` (the D4 fix) dragged in prediction-list work:
a prediction customer who didn't answer had their `manual` order flipped to
`call_again` too. **Call Again is a LEAD state, not a call outcome.** A
prediction client who isn't reached is simply a *no answer* on their member row.

### D7 — Counting disagreed with itself

`assigned_pending_counts()` counted `status='pending'` only, while
`agent_workloads().orders_open` counted `pending|take|call_again`. A lead that
had been called once was in **neither** the unassigned pool nor the per-agent
chip — invisible work.

### D8 — Ownership was too hard for deliberate human actions

After locking ownership, an agent *handed a client by the manager* could not
touch that client's `call_again`: `GET /orders/:id` reads through RLS (invisible),
and the PATCH guard 403'd it. So she created a second order — recreating D4.
**Operator rule: whoever is on the client resolves the order that already
exists, whoever held it before.** Ownership governs *distribution*, not human
action.

### D9 — "Take" read as "delivered"

`status.take` was `Взета` / `Земена`, which agents understood as *taken by the
courier*. Cosmetic, but it drove real mistakes.

---

## 2. The rules that came out of it

These are the invariants. Port the rules, not just the diffs.

1. **The assignment triple moves as one.** `assigned_agent_id`,
   `assigned_agent_name` and `assigned_at` are written together. A NULL id must
   never leave a name behind.
2. **A lead is never forked.** One customer, one open order. Every disposition
   updates the order that exists.
3. **Call Again is a lead state.** Only an inbound lead is parked in
   `call_again`. A prediction client who doesn't answer is a *no answer*.
4. **Pendings = inbound leads only.** `affiliate | inbound_lead | opencart |
   opencart_abandoned`. Agent-created `manual` work never appears there.
5. **Ownership governs distribution, not action.** Queues and automation are
   per-agent; a deliberate disposition by whoever is on the client is always
   allowed on an open lead. Credit follows the work (`confirmed_by_*`).
6. **The queue, the badge and the manager's chip use one definition.** Same
   statuses, same sources — or they will disagree and nobody will trust them.
7. **Phone matching on any WRITE path is a suffix.** `%last8`, never `%last8%`.
8. **No order is junked without a reason.** Bulk paths included.

---

## 3. What was built

### Migrations (3)

| BG file | Does |
|---|---|
| `20260913000000_take_lock_preserves_assignment.sql` | `active_call_views.taken_from_agent uuid[]`; rewrites `cleanup_expired_active_call_views()` to restore the prior assignee; stamps `call_again_since` on orphans; widens `assigned_pending_counts()` |
| `20260914000000_pendings_are_leads_only.sql` | `public.is_lead_source(text)`; orphan net splits leads → `call_again` / everything else → `pending`; `assigned_pending_counts()` scoped to lead sources |
| `20260915000000_take_lock_releases_colleague_leads.sql` | take-lock **v4**: revert matches `(recorded id, status='take')` and no longer keys on the taking agent, so a taken colleague's lead is released back to its real owner with their real name |

### Edge function (`supabase/functions/api/index.ts`)

- `revertTakenOrders()` — one shared release used by both paths; restores the
  prior assignee + their real name, or clears the whole triple.
- The take records `taken_from_agent`, claims a colleague's open lead, and does
  **not** overwrite `assigned_at` on an order already assigned.
- `LEAD_SOURCE_TYPES` — the single definition of an inbound lead.
- No-answer block: scoped to `assigned_agent_id IS NULL OR = caller`, **claims**
  an unassigned lead so worked leads stop free-running, parks **lead sources
  only**, and every phone match is a suffix.
- `GET /orders?lead_only=1`; `my-pendings-summary` counts the same status+source
  pair as the queue.
- `GET /orders/open-lead?phone=` — finds the customer's open order with **no
  agent filter** (this is what stops the fork).
- `GET /orders/:id` — falls back to the elevated client for **open leads only**,
  so a colleague's lead can be opened and resolved.
- `PATCH /orders/:id/status` — open leads exempt from the ownership guard;
  everything past confirm stays locked.
- `POST /orders` — **409 `open_lead_exists`** when the phone already has an open
  lead (unassigned ones included). The anti-fork backstop for every surface.
- `POST /orders/bulk-disposition` — bulk trash/cancel with a mandatory reason,
  skips-and-reports anything past confirm, syncs `inbound_leads` and nudges the
  postback drain.

### Frontend

- `CallsPage.tsx` — queue is `pending,take,call_again` + `lead_only`;
  `resolveOpenLeadId()` backs Confirm/Cancel/Trash with the server lookup; the
  order modal refreshes every surface on save.
- `CustomerHistoryTabs.tsx` — the status pill is a button: press it to open that
  order and record what happened.
- `Orders.tsx` — bulk **Trash** / **Cancel** bar on the existing row selection,
  reusing the shared reason pickers.
- `status.take` → **In progress / В обработка / Во обработка / Në përpunim**.

### Repair scripts (dry-run by default, `--apply` to write)

| Script | Does |
|---|---|
| `scripts/resolve-orphaned-lead-outcomes.mjs` | Moves a cancel/trash recorded on a fork back onto the lead, copying reason, note, actor and timestamp verbatim. Skips and lists anything with a sale attached. |
| `scripts/merge-forked-lead-orders.mjs` | Collapses lead + fork into ONE order (the lead survives) with address, courier, items, price, agent and status incl. `shipped_at`; re-points recordings and notes; trashes the copy as `duplicate_order`. |

**Production result:** 7 orphaned outcomes resolved (all postbacks delivered
`{"status":"ok"}`), 5 forked pairs merged, 0 stuck takes, 0 failed postbacks.

---

## 4. State of the MK fork (`elyon-natura`) — verified 2026-08-10

Checked at `D:/Dev/archives/elyon-natura`. **Every defect is present and none of
the fixes are.**

| Check | Result |
|---|---|
| `20260615120000_fix_stuck_takes.sql` | present, still `assigned_agent_id = NULL` — **D1, D2, D3** |
| Edge fn take/release (~lines 9888–9998) | still `{ status: froms[i], assigned_agent_id: null, assigned_at: null }`, no `taken_from_agent` — **D1** |
| `CallsPage.tsx:145` | `status: 'pending'` only — **D4** |
| `%${last8}%` substring matches | **11** (BG had 9) — **D5** |
| `LEAD_SOURCE_TYPES` / `is_lead_source` / `open_lead_exists` / `orders/open-lead` / `bulk-disposition` | **0 occurrences** — D6, D8 and the bulk bar all missing |
| `assigned_pending_counts()` | still `status = 'pending'` — **D7** |
| `Orders.tsx` bulk disposition | absent |
| `status.take` | `Земена` (mk) / `Взета` (bg) — **D9** |
| Locales | same four: `en`, `bg`, `mk`, `sq` |

### Fork-specific traps

- **Migration numbers collide.** The fork has diverged to **182** migrations with
  its own timeline, including `20260913000200`, `20260914000000_altercpa_bridge`,
  `20260915000000_mex_cities` … `20260916000000_altercpa_pending_only`. **Do not
  reuse the BG filenames.** Start at `20260917000000`.
- The fork has its own AlterCPA bridge and MK settlement/city work — read those
  before touching intake or delivery fields.
- `npx tsc --noEmit` is a **no-op**; use `-p tsconfig.app.json` and compare
  against the pre-existing error count.
- `supabase db push` is blocked (no DB password on file). Apply migrations via
  the Management API `POST /v1/projects/{ref}/database/query`, wrapped
  `BEGIN … ROLLBACK` for a dry run first.
- Pushing needs the **VAULT §4 PAT**, not the cached `elyoncoding` credentials.

---

## 5. Verification ritual (both repos)

1. `npx tsc --noEmit -p tsconfig.app.json` → no NEW errors vs the baseline count.
2. `npx vitest run` → all green, including i18n parity (all four locales).
3. `npx vite build`.
4. Parse the edge function before deploying:
   `esbuild.transformSync(src, {loader:'ts'})`.
5. Dry-run every migration against production wrapped `BEGIN … ROLLBACK`, then
   apply.
6. **Take-lock:** assign a lead to agent A → open it on `/calls` (status must
   read *In progress*) → navigate away → the lead is still A's and does **not**
   appear in `GET /orders/unassigned-pending`. Repeat with a hard tab close
   (2-min expiry) and with a second agent heartbeating (orphan sweep).
7. **Cross-agent:** agent B logs a no-answer on A's lead → A's status and
   assignment unchanged.
8. **No fork:** take a lead to `call_again`, then confirm → the **same**
   `display_id` becomes `confirmed`, no new `manual` row, and a `hold` postback
   is queued for it.
9. **Hand-over:** give agent B a client whose lead belongs to A → B can open the
   status pill and set confirmed/cancelled/trashed on that same order.
10. **No leakage:** a prediction-list customer who doesn't answer never appears
    in anyone's Pendings queue.
11. `select count(*) from orders where assigned_agent_id is null and assigned_agent_name is not null`
    → must stop growing.
12. `select count(*) from orders where status='take'` → returns to 0 when nobody
    is on a call.

---

## 6. Handoff prompt for the MK session

Paste this into a fresh session opened on the `elyon-natura` repo.

````text
Port the Elyon BG "pendings hardening" work into this Macedonian CRM
(elyon-natura). It is a separate project with its own database — nothing is
shared. I want the same class of bugs gone here before they bite us.

Read this first, it is the full write-up of what broke and what was built:
  <paste the contents of docs/PENDINGS_HARDENING_PORT_GUIDE.md from the BG repo,
   or copy that file into this repo's docs/ and read it there>

I have already verified that THIS repo has every one of those defects and none
of the fixes:
  - supabase/migrations/20260615120000_fix_stuck_takes.sql still nulls
    assigned_agent_id on every revert
  - the edge function take/release paths (around lines 9888-9998) still write
    { status, assigned_agent_id: null, assigned_at: null } and never record the
    prior assignee
  - src/pages/CallsPage.tsx queries status: 'pending' only
  - 11 write paths still match phones with %last8% instead of %last8
  - assigned_pending_counts() still counts status = 'pending'
  - there is no LEAD_SOURCE_TYPES / is_lead_source / open-lead endpoint /
    anti-fork guard / bulk disposition
  - status.take is still "Земена" / "Взета"

Work in this order and keep each step verifiable:
  1. The three migrations. RENUMBER them — this repo has diverged to 182
     migrations and 20260913-20260916 are already taken by the AlterCPA and MK
     settlement work. Start at 20260917000000.
  2. The edge function changes.
  3. The frontend changes, including status.take -> In progress / В обработка /
     Во обработка / Në përpunim in all four locales.
  4. The two repair scripts, and run each as a DRY RUN first — show me what they
     would change before anything is written.

Constraints for this repo:
  - npx tsc --noEmit is a no-op; use -p tsconfig.app.json and compare against
    the existing error count.
  - supabase db push is blocked (no DB password). Apply migrations through the
    Management API database/query endpoint, and dry-run each one wrapped
    BEGIN ... ROLLBACK first.
  - Pushing needs the VAULT section 4 PAT, not the cached elyoncoding creds.
  - Read .grok/skills/ first — elyon-assigner, elyon-segments-and-prediction,
    elyon-i18n, elyon-security, elyon-affiliates all apply here too.
  - Every user-visible string goes through i18n in all four locales.

Do NOT deploy anything until you have shown me: the typecheck delta, the test
run, the production build, and the dry run of each migration. I will tell you
when to apply.

Finish by running the verification ritual in section 5 of the guide and telling
me which checks passed.
````

---

*Written 2026-08-10 after the BG rollout. If you change a rule in section 2,
change it in both repos and in `.grok/skills/elyon-assigner` on the same day.*
