---
name: elyon-notifications
description: Use when adding, changing, or debugging ANY in-app notification in Elyon CRM — the bell dropdown, a DB trigger or pg_cron job that writes to `notifications`, the api's notifyUsers() pings, notification text/translation, the unpaid-delivery chase alerts, or the presence 30-minute inactivity alerts. Covers every live type and its producer, the English-in-DB + `meta.i18n` translation contract (four locales), the owner-attribution rule, and the "REVOKE FROM PUBLIC on every new table/RPC" law that any new notification job must follow.
---

# Elyon Notifications — the bell, and everything that writes to it

One table (`public.notifications`), one UI ([src/components/NotificationsDropdown.tsx](../../../src/components/NotificationsDropdown.tsx)),
and two kinds of producer: the **database** (triggers and pg_cron jobs) and the **api edge
function** (`notifyUsers()`, `supabase/functions/api/index.ts` ~19026 — best-effort, never
fails the request). Nothing in the frontend sends a notification in production — the only
browser insert is the Settings DEV test panel, which writes to the caller's OWN bell
(`SettingsPage.tsx` `sendTestNotification`). A notification can therefore never be missed
because a browser tab was closed.

## The table

`id, user_id, title, message, type, is_read, link, created_at, meta`

- **RLS**: each user reads/updates only their own rows; admins and managers can manage all.
- **INSERT is already tight** — `WITH CHECK (user_id = auth.uid() OR has_role(…,'admin') OR
  has_role(…,'manager'))`. An agent hitting PostgREST directly with their own JWT can only
  write a notification **to themselves**; forging one into someone else's bell is refused.
  Admins/managers may target anyone (no screen does; the DEV panel targets only the caller).
  ⚠️ The original `20260312051251` migration created this policy as `WITH CHECK (true)`, and
  `20260312051301` dropped and replaced it **ten seconds later**. Reading only the CREATE TABLE
  migration will tell you this table is wide open. It is not — **check `pg_policies`, not the
  migration file**, before claiming any RLS hole here.
- `type` is free text — no CHECK constraint (verified live 2026-09-27, 20260935000200 header), so
  a new type needs no constraint change.
- The bell loads the newest 50 rows, polls every 30 s **and** subscribes to realtime changes on
  the user's own rows (any event → refetch; only an INSERT pops a toast).

## The live types

| type | Producer | Goes to |
|---|---|---|
| `missed_call` | trigger on `missed_calls` (20260604130000 / 20260614120000) | last agent who called that number + all admins |
| `order_returned` | trigger on `orders` status → `returned` (re-emitted 20260934000200) | sale owner + all admins |
| `order_paid` | trigger on `orders` status → `paid` (20260604140000, re-emitted 20260934000200) | sale owner + all admins |
| `low_stock` | trigger on `products.stock_quantity` **downward crossing** | admins + warehouse |
| `shipped_unpaid` | `notify_unpaid_shipped_orders()` job (20260905000100) | sale owner only |
| `unpaid_digest` | same job, once after the loop | one per active admin per day |
| `altercpa_rate` | triggers on `altercpa_leads` (every STEP-th lead) and on orders (every STEP-th confirm of a cohort) — 20260922000000, re-emitted 20260934000200 | active admins + managers, one copy each |
| `altercpa_rate_below` | cron `altercpa-rate-verdicts` (hourly :05; acts at 23:xx and 10:xx local) | active admins + managers |
| `inactivity` | `presence_record_beat()` via `presence_heartbeat()` (20260935000200) | the idle person (`meta.self`) + the `presence_idle_alert_recipients` (default owners) |
| `assignment` | api `notifyUsers()`: bulk assign, single assign, Call Agains assign (`meta notif.callAgainsAssigned`), prediction-list distribution, manual lead-distribution run (`meta notif.leadsAssigned`) | the agent who received the work (never yourself) |
| `affiliate_lead` | api `notifyUsers()` on `POST /cpa/lead` | all admins |

**UI maps.** A type needs **five** entries in `NotificationsDropdown.tsx`: `typeIcons`,
`typeColors`, `getUnreadMoodClass`, `getUnreadTitleClass`, `toastSeverity`. Miss one and the row
renders with the grey default. Today `inactivity` has all five; `assignment` has only an icon and
a colour; `altercpa_rate`, `altercpa_rate_below` and `affiliate_lead` are in none of the maps
(they render as the grey `Info` default).

`order_paid` / `order_returned` rows carry **no `meta`** (English only), and the `order_paid`
message prints the price as `€NN.NN` from the EUR column — a leftover against `elyon-currency`.

## Rule 1 — the owner of a sale is the CONFIRMER

`COALESCE(confirmed_by_agent_id, assigned_agent_id)` — the SQL twin of `salesOwnerId()` in the
edge function. Same rule as commissions and the My Orders tabs. Never notify both the assignee
and the confirmer; never notify the assignee when a confirmer exists. See
[elyon-agent-commissions](../elyon-agent-commissions/SKILL.md). (`orders.sold_by_person_id` —
who made the sale, `elyon-presence-and-leaderboard` — is NOT used by any bell producer.)

## Rule 2 — write English, ship `meta` for translation

The DB cannot know which of EN/BG/SQ/MK the reader picked, so producers write **English**
`title`/`message` **and** an optional:

```json
meta = { "i18n": "notif.shippedUnpaid", "order": "ORD-37262", "customer": "…", "days": 4 }
```

`localizeNotification()` renders `t(meta.i18n + '.title' | '.body', { ...meta, defaultValue: <stored English> })`
(the payload is spread FIRST so row data can never override `defaultValue`). So a missing locale
key degrades to readable English — never a `⟪key⟫` placeholder. `meta IS NULL` = legacy row,
rendered verbatim. Add every new key to **all four** locale files (`en`, `bg`, `sq`, `mk`;
`npm test` enforces parity). Interpolated values are DB data (order id, customer name, counts)
and are never translated — see [elyon-i18n](../elyon-i18n/SKILL.md).

Keys in use: `notif.shippedUnpaid`, `notif.unpaidDigest` (+ `.staleSync`),
`notif.callAgainsAssigned`, `notif.leadsAssigned`, `notif.altercpaRate{Leads,Confirms,BelowDay,BelowFinal}`,
`notif.inactivity`, `notif.inactivitySelf`.

⚠️ Inside `renderNotificationToast` and the custom toast components, `t` is the **sonner toast
instance**, not the translator. Use `i18n.t` there. This has bitten us before.

## Rule 3 — triggers swallow, jobs don't

The trigger producers (missed call, returned, paid, low stock, both AlterCPA rate triggers) are
`SECURITY DEFINER` + `EXCEPTION WHEN OTHERS THEN RETURN NEW`. That is deliberate: a failed
notification must never roll back the business write it hangs off (missed-call ingestion, a
status change, a stock decrement, a partner's lead). Worst case is "no notification". The
presence alert follows the same idea inside a function: its inserts run in their own
subtransaction and only `RAISE WARNING`, so a failed alert never costs the minute just counted.

A **pg_cron job** is the opposite: it writes nothing business-critical, so a blanket swallow
would just hide bugs behind a green run. Wrap each *item* in its own `BEGIN … EXCEPTION …
CONTINUE` so one bad row can't kill the batch, but let a real failure surface in
`cron.job_run_details`. (Known exception: `altercpa_rate_verdict_sweep()` swallows everything —
its failures never show in pg_cron.)

`SET LOCAL elyon.bulk_repair = 'on'` (20260934000200) silences the order-paid, order-returned
and AlterCPA confirm-rate triggers for one repair transaction — a repair of thousands of orders
must not bury the staff in bells that describe no real event. The 7-day no-parcel rule sets it
in apply mode.

## Rule 4 — every new table/RPC starts locked

Learned the hard way in the 2026-07-22 sweep. In the **same migration**:

```sql
ALTER TABLE public.<t> ENABLE ROW LEVEL SECURITY;      -- zero policies = deny all
REVOKE ALL ON public.<t> FROM PUBLIC;                   -- PUBLIC, not just anon —
REVOKE ALL ON public.<t> FROM anon, authenticated;      -- `authenticated` inherits PUBLIC
REVOKE ALL ON FUNCTION public.<f>(…) FROM PUBLIC, anon, authenticated;  -- default is EXECUTE TO PUBLIC
```

Verify with a live anon call, not just by reading the migration.

## The presence inactivity alert (2026-09-27)

Full engine: `elyon-presence-and-leaderboard`. What the bell needs to know:

- Written by `presence_record_beat()` when an idle streak crosses 30, 60, 90 … minutes
  (`app_settings.presence_idle_alert_minutes`; only agent-role logins that are not admin,
  manager or owner; 07:00–21:59 Skopje by default — `{"from":7,"to":22}`). `link` is NULL.
- **Two copies.** The person's own (`meta {i18n:'notif.inactivitySelf', minutes, self:true,
  subjectId, day}`) and one per recipient (`meta {i18n:'notif.inactivity', name, minutes,
  subjectId, day}`), never the person twice. Default recipients `"owners"` =
  `business_owners` ∪ every ACTIVE admin (20260939000500).
- **Self copy → one sticky toast**, not a normal one: `renderNotificationToast` calls
  `showIdleSelfToast()` (`src/lib/presence/ui.ts`, id `presence-idle-self`,
  `duration: Infinity`) — the same id the activity beat already used in the tab that sent it,
  so sonner replaces instead of stacking and every other open tab still shows it.
- **Owner copy → click opens the "Who is working" sheet** (`openPresencePanel()` →
  `PresenceHeaderButton`, rendered for owners only) instead of navigating.

## The unpaid-delivery chase (2026-09-05)

**Why**: most returns are avoidable — the parcel ships, the client never collects it, nobody
calls, the courier sends it back and we pay shipping both ways. When it was built there were 38
orders in `shipped`, **20 of them unpaid for 3+ days**, oldest 27 days.

**How**: `notify_unpaid_shipped_orders(_force, _dry_run)`, cron `unpaid-delivery-chase` hourly at
:00, self-gated to hours 09–11 **Europe/Skopje** (the code computes Skopje time; comments in the
migration still say "Sofia"). A missed 09:00 heals at 10:00; the ledger PK stops double-sends.

- **Candidates**: `status IN ('shipped','delivered')`, `shipped_at IS NOT NULL`,
  `duplicated_from IS NULL`, `source_type <> 'monadon_legacy'`, age in `[unpaid_chase_days,
  unpaid_chase_stop_days]` (defaults 3 / 30, both in `app_settings`, editable in Settings).
- **Idempotency** is the `order_unpaid_alerts (order_id, alert_date)` primary key — that alone.
  Run the job five times in a morning and each order still pings once.
- **Never writes to `orders`.** All state is in the ledger, so it can't disturb the
  status/`shipped_at`/`paid_at`/history triggers or bump `updated_at` on every row each morning.
- **Digest counts the full problem** (every order unpaid ≥ threshold, no upper bound), not just
  what pinged today — otherwise orders aged past the stop threshold would silently vanish from
  oversight, which is the exact blind spot the feature exists to remove.
- **`syncAgeHours`** in the digest = hours since the last `order.bigarena_status_sync`
  audit entry. ⚠️ Stale on MK: the BigArena status-upload button was removed 2026-08-18 (the
  `POST /orders/bigarena-sync` route still exists, nothing in the UI calls it) and courier
  outcomes now come from the `mex-reconcile` cron, which writes no such audit row. So this age
  no longer measures the data behind the digest, and the `staleSync` sentence (shown from 36 h)
  says nothing about MEX. Judge MEX freshness in Settings → Integrations health. Do **not** mute
  alerts on staleness — muting hides real returns.

`unpaid_chase_stop_days` is the only place alerts go quiet. Raise it to 999 to chase forever.

## Debugging checklist

1. Nothing arrived → is the row in `notifications` at all? If yes it's a UI/type-map problem; if
   no it's the producer.
2. Wrong agent → check `confirmed_by_agent_id` vs `assigned_agent_id` on that order.
3. English text in a Macedonian (or other) UI → `meta` is NULL, or the key is missing in that
   locale file.
4. Job "succeeded" but sent nothing → the 09–11 Skopje gate, or every order already had today's
   ledger row. `SELECT notify_unpaid_shipped_orders(true, true);` tells you what it *would* send.
5. Duplicate pings → someone dropped the ledger PK, or a producer runs both a trigger and a job.
6. No idle alert → outside `presence_idle_alert_hours`, the person is admin/manager/owner (never
   alerts under scope `agents`), an open break, or `presence_idle_alert_minutes` = 0.
7. A burst of paid/returned bells during a repair → the repair forgot `SET LOCAL elyon.bulk_repair = 'on'`.
