---
name: elyon-assigner
description: Use for anything related to the Assigner page, bulk assignment of pending orders and prediction list members, the Unassign tab (full detach + per-client unassign), unassign rules (especially for pendings vs confirmed), cross-list baskets, round-robin distribution, the live agent status tile, and the logic that controls which agents see which leads. Critical for lead distribution and agent workload management. Post-2026 segments redesign: all prediction work now operates on unique phones (exclusive rule-driven membership).
---

# Elyon Assigner Skill

The Assigner is the control center for distributing work to agents. It combines unassigned pending orders with members from the intelligent prediction lists (segments) and gives managers powerful tools to assign them fairly and efficiently. After the 2026 prediction segments redesign (Option 1), **prediction member workloads are now clean by design** — every rule-driven phone appears in at most one list, eliminating the previous duplicate-calling frustration.

## Core Concepts

### Two Main Sources of Work
1. **Unassigned Pending Orders** — New leads that have not yet been assigned to an agent (classic flow, unaffected by segments redesign).
2. **Prediction List Members** — Customers automatically classified by the rule engine into the **single best** list (priority + 21-day floor + winner selection). These are the high-signal "smart" follow-up leads. **Post-redesign**: exclusively one active rule-driven list per phone.

### Key Screens (3 tabs on /assigner + the right-hand agents panel)
- **Prediction Lists tab** — one expandable row per list: Distribute bar (whole/half/custom × N agents, round-robin) + inline member table feeding the cross-list basket.
- **Pendings tab** — the UNASSIGNED pending pool with select + bulk-assign, a source filter, and a chip strip of who already holds pendings (chip → Unassign tab, focused on that agent with the pendings row open).
- **Unassign tab** — the one-stop "who holds what, take it back" surface (see below). Replaced the old per-agent drawer.
- **Cross-List Basket** — Advanced manager tool for selecting members across multiple prediction lists before bulk distribution. Still extremely useful — now works on inherently unique phones.
- **Agents panel (right)** — per-agent card: live **Status tile** (In call / Available / Offline) + "Clients to call N of M assigned"; clicking a card jumps to that agent's row in the Unassign tab.

> **The per-agent Inspector (`<Sheet>` drawer) was DELETED on 2026-07-28.** Everything it did — see what an agent holds, unassign individual pendings or list members — now lives in the Unassign tab, which additionally shows *every* agent at once. Do not reintroduce a drawer; extend the Unassign tab instead.

### The Unassign tab (2026-07-22, full detach since 2026-07-28)
Fed by `GET /assigner/assignment-summary` (one `assignment_matrix()` + `assigned_pending_counts()` round-trip). Structure:
- **Header nuke bar** — "Unassign ALL clients from ALL agents (N)".
- **One row per agent** holding anything (`assigned_total > 0 || pendings_total > 0` — so done-only agents ARE listed), with to-call / pendings / done badges and a per-agent detach button.
- **Expand an agent** → its lists (`assigned > 0`, so done-only lists show too) + a "Pending leads" row.
- **Expand a list** → the individual clients, done ones badged, each with a one-click unassign; 50/page.

**Full detach is the rule here**: every bulk button sends `include_done: true`, which also clears `assigned_agent_*` on already-called rows so the (agent, list) pair leaves `assignment_matrix()` entirely. Rationale (operator, 2026-07-28): an emptied list must not stay attached to an agent's profile. History is NOT lost — `is_completed`, `last_call_*`, `call_logs`, recordings and sales credit (`confirmed_by_*`) are all untouched, and the audit row records the per-agent breakdown.

### Pendings are a queue on /calls too (2026-08-06)

Assigning a pending lead used to be invisible to the agent: the queue strip in the /calls topbar
listed only prediction lists, while pendings were fetched separately and silently given priority.
An agent working leads saw a *prediction list name* in the strip that wasn't what they were calling,
and could not tell they had leads at all.

Now the strip carries a **virtual "Pendings" entry, always first**, fed by `GET /my-pendings-summary`
(`ready` / `open` / `parked` / `talked_today`, Europe/Skopje). Key rules:

- The entry is **synthetic** — leads are `orders` rows, not segment members, so there is no list row
  and **no segment list was created for them**. The sentinel `PENDINGS_QUEUE_ID = '__pendings__'`
  (`src/components/calls/useMyQueue.ts`) must short-circuit every list-scoped path; if it ever
  reaches PostgREST or `markAfterCall` it is an invalid uuid.
- **Auto-selected on load** when `ready > 0`. Picking a prediction list **pins** it
  (`manualPickRef`), so an arriving lead no longer yanks the agent off the customer they chose —
  the strip shows an amber pulsing badge with the waiting count instead, and they switch back when
  they want. Choosing Pendings deliberately does *not* pin (it is the default priority).
- Running out of leads **falls through** to the first prediction list with work rather than
  stranding the agent on an empty queue.
- `GET /my-pendings-summary` is hard-scoped to `auth.uid()` with **no `agent_id` parameter** and
  stays inside the edge function. Do not turn it into a view or RPC: affiliates hold real Supabase
  logins, so nothing new may become readable to `authenticated`.

## Lead handling — the ten rules (2026-08-11, LAW)

Ported from Elyon BG after thirteen compounding defects. Full write-up:
`docs/LEADS_PORT_GUIDE_MK.md`. **Port the rules, not just the diffs.**

1. **The assignment triple moves as one.** `assigned_agent_id`,
   `assigned_agent_name` and `assigned_at` are written together. A NULL id must
   never leave a name behind ("phantom owner" — the row displays an owner while
   counting as unassigned, which is why the take-lock bug hid for weeks).
2. **A lead is never forked.** One customer, one open order. Every disposition
   updates the order that already exists.
3. **Call Again is a LEAD state, not a call outcome.** A prediction client who
   isn't reached is a *no answer* on their member row; their order is untouched.
4. **Pendings = inbound leads only** — `is_lead_source()` /`LEAD_SOURCE_TYPES`.
   Agent-created `manual` work never appears there.
5. **Ownership governs distribution, not action.** Queues and automation are
   per-agent; a deliberate disposition by whoever is on the client is always
   allowed on an open lead. Credit follows the work (`confirmed_by_*`).
6. **The queue, the badge and the manager's chip use ONE definition** —
   `pending|take|call_again` + lead sources — or they disagree and nobody trusts
   them.
7. **Phone matching on any WRITE path is a suffix** (`%last8`), never `%last8%`.
   A substring can hit a different customer entirely.
8. **No order is junked without a reason.** Bulk paths included.
9. **Leads are never auto-trashed and never throttled.** The 9-strike Unreachable
   rule and the paced retry apply to prediction outreach only (`hasLiveLead`
   guard). On a lead the customer is waiting for US.
10. **Fresh leads are served before call-backs; call-backs stay visible** — no
    `ready_only` on the lead queue, parked ones just sort last.

⚠ **MACEDONIA:** the lead source is **`altercpa`**, not BG's `affiliate`, and the
bulk import is **`import`** (80k legacy rows) which must NEVER be a lead source.
The partner sidecar is `altercpa_leads`; `affiliate_leads` is empty and the
bridge is **one-way** — nothing ever posts back (`elyon-altercpa-bridge` #3), so
no disposition path may nudge a postback drain.

⚠ **Never run the phantom-owner repair repo-wide here.** 67.069 rows have a name
with no id; every one is a terminal-state legacy import holding historical
attribution. Scope any such repair to `status IN ('pending','take','call_again')`
or you erase who sold and who cancelled across the whole order history.

**Call Agains tab** (`CallAgainsPanel.tsx`) redistributes **prediction** call
agains only. A lead that didn't answer stays in its own agent's Pendings queue
until they reach the customer — it is never handed out from there.

## Assignment Rules & Recent Changes (Important)

- **Pending orders** can be unassigned more freely (even after some work).
- **Confirmed / shipped orders** are protected (sales credit immutable except via superadmin correction).
- **Prediction list members** use dedicated flows (`apiAssignSegmentMembers`, `apiBulkUnassignSegment`, `apiAutoAssignSegment`).
- When unassigning a prediction member, it returns to the unassigned pool for that list (or will be re-evaluated on next order event).
- Bulk assign supports single agent or multi-agent round-robin (shuffled for fairness). Scope options: 'unassigned' (preserve existing) or 'all'.
- Auto-assign can take exact `limit` or `fraction` of a list.

**The unassign contract (2026-07-28 — read before touching any unassign path)**:
- `POST /assigner/unassign-all` body: `{agent_id:'all'|uuid, list_ids?, include_pendings?, include_done?}`.
  - **No `include_done`** (API default) = free only `is_completed = false` members — the original 07-22 behaviour, kept for backward compatibility.
  - **`include_done: true`** = ALSO clear the stamp on already-called rows → the (agent, list) pair leaves `assignment_matrix()` and the list detaches from the agent's profile. **The Unassign tab always sends this.**
  - `include_pendings: true` frees the agent's `status='pending'` orders as well — **never** `take`/`call_again` (the agent already engaged; orders-side mirror of the `is_completed` rule). Server ignores the flag when `list_ids` narrows the call.
- Whatever the flag, only three columns move: `assigned_agent_id`, `assigned_agent_name`, `assigned_at`. **Never** touch `is_completed`, `last_call_*`, `in_call_again_until`, or `confirmed_by_*` in an unassign path.
- Per-client unassign = `POST /segments/:id/assign` with `agent_id: null` (works on done rows too). Per-order = `POST /orders/bulk-unassign`.
- Engine holding pens are unaffected and must stay that way: Current Cancels (14-day freeze) and NEWCOMERS still strip assignment on entry all by themselves.

**Post-2026 Redesign Impact (the big win)**:
- Prediction members assigned to agents are now guaranteed unique phones (the engine's priority pick-one + delete-siblings logic).
- No agent will ever see the same customer in two different prediction lists in the Unassign tab or their queue.
- Cross-list basket and the multi-list Unassign tab remain powerful for managers but now operate on a deduplicated universe.
- `avg_package_price` (first-class, currency-formatted) is visible in the member tables used by the Assigner.

Recent broader improvements:
- Granular unassign for both pendings and prediction members (May 2026), now reachable for every agent from one screen (July 2026).
- Live per-agent visibility: who holds what (Unassign tab) and who is on a call right now (Status tile).
- Sales credit protection.

## When This Skill Applies

- Working on AssignerPage, the Unassign tab, cross-list basket, or bulk flows
- Changing any assignment/unassignment logic (pending or prediction)
- Building distribution strategies or fairness algorithms
- Debugging "why does this agent have (or not have) this lead?"
- Bulk operations that move prediction members between agents
- Any change that affects agent workload visibility or the interaction between pending orders and prediction lists
- Post-redesign verification that prediction workloads are clean

## Important Files

- `src/pages/AssignerPage.tsx` (3 controlled tabs, agent cards + status tiles, cross-list basket, `PredictionListRow`; the drawer is gone)
- `src/components/assigner/` folder:
  - `BulkUnassignPanel.tsx` — the Unassign tab (summary query, agent rows, confirm dialog, `focus` prop for jump-to-agent, shared `invalidateAll()`)
  - `AgentListMembersRow.tsx` — expandable per-(agent, list) client rows + per-client unassign + 403 handling
  - `AgentPendingLeadsRow.tsx` — expandable pending-leads row + per-order unassign
  - `SegmentMemberTable.tsx` (Avg / pkg dual-currency column), `AgentPickerChips.tsx`, `CrossListBasketBar.tsx`
- API layer (`src/lib/api.ts`): `apiGetUnassignedPending`, `apiBulkAssignOrders`, `apiBulkUnassignOrders`, `apiGetSegment`, `apiAssignSegmentMembers`, `apiBulkUnassignSegment`, `apiAutoAssignSegment`, `apiGetAssignmentSummary`, `apiUnassignAllForAgent(agentId, listIds?, {includePendings, includeDone})`
- Backend: `supabase/functions/api/index.ts` — `GET /assigner/assignment-summary`, `POST /assigner/unassign-all`, `GET /agents/online`, segment member endpoints
- RPCs: `assignment_matrix()`, `assigned_pending_counts()`, `agent_workloads()`, `bulk_last_calls()`
- Live agent status: `profiles.voip_state` / `voip_state_at` (migration `20260908000000`), `src/lib/voip/callStateBus.ts`, `POST /presence/heartbeat` — see **Live agent status** below
- Related prediction data layer: `src/components/calls/useMyQueue.ts`

**Companion skills (inject first)**: elyon-segments-and-prediction (the source of the now-exclusive members), elyon-currency (avg_package_price and all money in tables), elyon-phone-normalization (phone keys in all matching), elyon-voip-and-pbx (the softphone whose state feeds the status tile).

## Live agent status (2026-07-28)

The right-hand agent cards show **In call / Available / Offline** instead of the old "Open orders" count (which was almost always 0 and told nobody anything).

- **Source is the agent's own browser, not the PBX.** `VoipContext` pushes every softphone transition (`idle|dialing|in_call|wrapping|ending`) to `POST /presence/heartbeat` and onto `src/lib/voip/callStateBus.ts`; `AuthContext`'s 45s presence beat reads the bus and re-sends the state while it is non-idle (so long calls stay fresh, even in a background tab).
- **Server verdict** (`GET /agents/online`, `GET /operations-center`): `in_call = is_online AND voip_state ∈ {dialing,in_call} AND voip_state_at younger than 3 min`. The staleness window is what makes a crashed tab fall back to Available/Offline on its own.
- **Multi-tab safety, do not break it**: `idle` is only ever written by the tab that actually ends a call — VoipContext skips the initial-mount report and the periodic beat omits the field while idle. Without both guards, a second CRM tab clears a colleague's live "In call".
- An agent still running a pre-deploy tab reports nothing and simply shows Available — the fix is a refresh **between calls** (a reload mid-call drops the WebRTC session).
- `agent_workloads().orders_open` is still returned by the API; it is just no longer rendered on the card.

## Common Gotchas & Rules

- Do **not** assume unassigning always reverts to simple "pending". Some states (confirmed, etc.) are protected.
- Prediction memberships can (and do) change on recompute or order events — assignments are not permanent, but the engine now intelligently carries state to the winner list.
- The Unassign tab (`assignment_matrix()`) is the ground truth for "where each agent is right now." There is **no list→agent table** — "agent holds list X" is derived purely from member rows, which is exactly why leftover done rows used to keep empty lists glued to profiles.
- `assignment_matrix()` has **no `is_completed` filter** and must keep it that way: that is what makes done-only lists visible (and detachable) in the Unassign tab.
- Agent cards and pendings chips no longer open a drawer — they set `focus` on `BulkUnassignPanel` and switch tabs. The query keys `['assigned-pending']` and `['agent-assigned-members']` no longer exist; the expandable rows use `['assigner-agent-list-members', agentId, listId, page]` and `['assigner-agent-pendings', agentId]`, lazily enabled on expand.
- A manager without the `show_segment_members` privilege gets a 403 on the member expansion (inline notice) but can still bulk-detach — keep those two paths independent.
- Sales credit (`confirmed_by_agent_id`, `confirmed_by_name`) must be protected. Use the special superadmin Command picker flow for corrections only.
- **Post-redesign**: "Customer appears in multiple lists" is no longer a normal case for rule-driven prediction work. The engine guarantees exclusivity for calling/assignment.

## Decision Table (Post-2026 Redesign — Updated)

| Situation                                              | Correct Approach                                                                 | Avoid                                              |
|--------------------------------------------------------|----------------------------------------------------------------------------------|----------------------------------------------------|
| Agent has too many leads                               | Unassign tab → expand the agent → free a whole list, or expand a list and free individual clients | Blind bulk unassign without live counts            |
| An "empty" list is still stuck on an agent's profile   | That's leftover done rows. Unassign tab → the list still shows (it counts `assigned`, not `open`) → Unassign = full detach | Hand-editing `prediction_segment_members` in SQL   |
| Want to distribute fairly across team                  | Multi-agent + round-robin in bulk/auto-assign (or fraction/limit for partial)    | One-by-one manual assignment                       |
| Customer appears in prediction lists (cross-list work) | The system now guarantees at most one active rule-driven list per phone. Cross-list basket remains powerful for managers but operates on unique phones only. | Assuming old multi-membership behavior for calling queues |
| Need to correct who confirmed an order                 | Special superadmin Command picker flow only                                      | Direct DB edit or normal OrderModal                |
| After changing segment rules or priorities             | Trigger recompute (UI does this on PATCH), run apply-prediction-priority-migration.mjs + verify scripts, then review Unassign-tab workloads and 21-day floor behavior | Assuming member counts or agent assignments stay identical |
| Agent complains about seeing the same customer twice   | Post-redesign this should be impossible for rule-driven lists. Verify via the Unassign tab + DB query on the phone + confirm a recent recompute ran. Escalate only if static list or personal hold involved. | Assuming the old duplicate problem still exists    |
| Agent card says "Available" while they're clearly talking | Their tab predates the 2026-07-28 deploy (or `voip_state_at` is stale) — have them refresh **between** calls | Reloading a tab mid-call (it kills the WebRTC session) |

## Best Practices

- Always open the Unassign tab when an agent reports workload or duplicate issues (now the duplicate case should only surface pre-redesign data or static lists).
- Prefer the cross-list basket for sophisticated manager distribution across multiple high-priority segments — it now naturally works on deduplicated phones.
- After any bulk prediction operation, immediately refresh the summary (the panel's shared `invalidateAll()` already covers `assignment-summary`, `segments`, `online-agents`, `my-queue-summary`, `unassigned-pending` and the two lazy row queries) and have affected agents refresh their Calls queues.
- When building new features or reports, preserve (and surface) the live "exactly what each agent holds right now" visibility — and keep the Unassign tab the single place to take work back rather than adding another per-agent modal.
- Surface `avg_package_price` (using elyon-currency dual formatting) in any new Assigner-adjacent tables or pickers — agents and managers love the high-frequency vs one-big-order signal.
- After segments redesign work, always verify that prediction agent workloads are clean in the Unassign tab (no phone appears more than once across an agent's assigned lists).

This area directly affects agent morale, fairness perception, and conversion rates. Confusing or duplicative distribution is one of the fastest ways to damage trust and productivity.

When making changes here, always think from the perspective of both the manager doing the sophisticated assigning and the agent who must actually call the work — now with the massive quality-of-life win that the prediction engine itself prevents duplicates.

**Post-redesign, agent workloads for prediction lists are dramatically cleaner and higher-signal. The cross-list tools remain just as powerful but now operate in a deduplicated world. Preserve that cleanliness in every new flow.**

---

*Last meaningful update: 2026-07-28 (commit `30f9830`) — Unassign tab became the one-stop unassign surface: full detach via `include_done`, expandable per-list/per-client rows, per-agent drawer deleted, live In call / Available / Offline status tile on the agent cards. Keep this skill, `elyon-segments-and-prediction`, `docs/PREDICTION_LISTS_PLAIN_GUIDE.md` and `docs/HOW_PREDICTION_SEGMENTS_WORK_NOW.md` in sync on any further unassign-rule change.*