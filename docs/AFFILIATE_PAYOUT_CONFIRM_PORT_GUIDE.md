# Affiliate payout at CONFIRMATION + admin Dashboard tab — port guide for elyon-natura (MK)

**Origin:** Elyon BG (`elyoncrm`), 2026-08-10. Commits `eef594a` + `1b44a21`, both LIVE on BG prod (edge fn + Vercel, verified).
**Purpose:** a complete, self-sufficient record of the change so the Macedonian fork
(`elyon-natura`, separate repo + separate Supabase project) can be brought to the exact
same behaviour. Paste this file into a session on the MK repo; the handoff prompt is in §8.

**Both databases were inspected on 2026-08-10 before writing this** — see §5. The short
version: the MK schema already has everything this feature needs (**zero migrations to
apply**), the MK affiliate program has **zero data** (so the money-semantics flip costs
€0 there), and MK's 27,277 real-status orders have **zero `confirmed_at` gaps**.

Companion: `docs/PENDINGS_HARDENING_PORT_GUIDE.md` (a separate, orthogonal port — neither
depends on the other).

---

## 1. The business change (operator decisions — FINAL, do not re-ask)

The CPA program was built as CoD: affiliate payout earned only at `orders.status='paid'`;
confirmed/shipped/delivered showed "Approved (hold)". The operator reversed this on
2026-08-10, with three decisions taken explicitly:

1. **Earned at FIRST CONFIRMATION, sticky forever.** The affiliate's job ends when the
   call centre confirms. A later cancel / trash / return NEVER removes the payout.
2. **Fully retroactive.** One rule across all history (in BG this flipped €30 → €450;
   in MK there is no history, so this is moot but the rule still applies to day one).
3. **Postbacks 100% unchanged.** The network keeps receiving the exact same events and
   AlterCPA codes at the exact same moments. Their panel = logistics truth; OUR portal =
   payment truth. No new APIs, no partner-side changes.

Also requested by the operator, same day:
- A **Dashboard tab on `/affiliates-admin`** so staff see the partner's exact dashboard
  without logging into the partner account — plus staff-only **super-metrics**: funnel by
  outcome, Conversion %, **Avg order value (confirmed)** (selling side), Cost per lead
  (payout side), test counters.
- A **free from–to date filter** (the shared `DateRangePicker`) on BOTH the staff tab and
  the partner portal — not just 7/30/90 presets.
- The funnel shows ONLY: **Pending (left) · Call again · Confirmed · Trashed · Cancelled**
  — shipped/delivered/paid count inside Confirmed; nothing after confirm matters there.

## 2. The invariants (port the rules, not just the diffs)

1. **Earned ⇔ `orders.confirmed_at IS NOT NULL` OR current status ∈ REAL_ORDER_STATUSES.**
   The OR term is a safety net for legacy rows that reached a real status before every
   write path stamped the timestamp; it can never un-earn anything. (Both DBs currently
   have zero such gap rows — keep the net anyway.)
2. **`CPA_STAGE` / SQL `affiliate_stage()` are LOGISTICS truth only.** They drive
   postbacks and the partner S2S `GET /cpa/leads`, nothing else. Payment/portal/admin
   surfaces use the new `affiliateEarned()` / `affiliateDisplayStage()` helpers. Changing
   one must never change the other.
3. **`confirmed_at` is sacred.** Stamped once on the FIRST flip into any real status, by
   every write path (single PATCH, bulk, create), never overwritten, never NULLed. The
   attribution tool re-points WHO confirmed — never WHETHER/WHEN.
4. **Display stages are `wait / hold / cancel / trash`**, where `hold` renders as
   "Approved" (ever-confirmed — paid/returned/cancelled-after-confirm fold into it) and
   `cancel`/`trash` mean killed BEFORE confirm. Legacy filter values `approve`/`return`
   alias to `hold` for one release.
5. **The partner never gains internal detail.** `statuses` funnel, `tests`, `revenue`,
   real PII, `orders.display_id` exist ONLY on staff endpoints (`affiliates/*` plural).
   The portal twin endpoints must never return them.
6. **Transitional compat:** all three stats responses emit literal `hold: 0,
   payout_hold: 0` for one release so an older SPA renders €0.00 instead of NaN during
   the deploy window. Drop them (and the `approve`/`return` aliases) in the NEXT release,
   in both repos.
7. **Agent commissions remain PAID-gated.** That is a separate money concept
   (`elyon-agent-commissions`); the two gates now differ BY DESIGN.
8. Deploy order is **edge function first, SPA second** (the SPA reads fields only the new
   fn emits). Rollback in the opposite order.

## 3. What was verified in the MK repo before writing this (2026-08-10)

- All affiliate migrations present: `20260801000000/100/200/300`, `20260802000200`,
  `20260904000020/100/200`. All four `src/pages/Affiliate*` pages present.
- The pre-change markers exist verbatim: `STAGE_STATUSES` (portal leads, ~:3153), dead
  `if (new_status === "confirmed")` in bulk-status-update (~:5265), attribution writing
  `confirmed_at: newConfirmedAt` (~:6210), duplicated rate math in `AffiliatesTab.tsx`
  (~:538). None of the new helpers exist. **Line numbers WILL differ from BG — always
  find by the marker strings given below.**
- **MK divergences that change the port:**
  - `src/lib/currency.ts`: `MKD_PER_EUR = 61.5`; money renders as **denari only** via
    `formatMoney` ("X ден"); `formatPriceInline` is an alias of it; there is **no
    `formatEur`** (deliberate — see the comment in that file). The MK portal ALREADY uses
    `formatMoney`. → Everywhere BG passes `formatEur` (portal) or `formatPriceInline`
    (admin), MK passes **`formatMoney`**. The embedded code below is already MK-adapted.
  - `src/pages/AffiliatesAdminPage.tsx` already has a **4th tab: Countries**
    (`MirrorTab` from `src/components/altercpa/` — the AlterCPA-mirror subsystem, skill
    `elyon-altercpa-bridge`). **Preserve it.** Dashboard becomes the FIRST of FIVE tabs.
  - Locales are the same four files (`en/bg/sq/mk.json`) with the same parity +
    keys-used tests, and the same `dateRange.*` keys for `DateRangePicker` (component
    exists in MK). i18n values in §4.7 apply verbatim.
  - `.grok/skills/elyon-affiliates/SKILL.md` and `docs/AFFILIATE-INTEGRATION.md` both
    exist in MK — update them per §4.8.

## 4. The change map

Everything below happened in TWO files' worth of backend edits + a small SPA set. No DB
migrations. No changes to: the DB trigger, `affiliate_stage()`, `CPA_STAGE`'s content,
the drain, `altercpaParams`, reason maps, macros, `GET /cpa/leads`, intake, HMAC,
anything RLS.

### 4.1 Edge fn — new helpers (insert right AFTER the `CPA_STAGE` const)

Also extend the comment above `CPA_STAGE` to say it renders ONLY the partner S2S
`/cpa/leads` replies and that portal/admin use the helpers below.

```ts
// PAYMENT truth (operator decision 2026-08-10): affiliate payout is earned the
// moment an order is first CONFIRMED and is never reversed — later cancel/
// trash/return is our loss, not the webmaster's. "Ever confirmed" is read off
// orders.confirmed_at (stamped once on the first flip into a real status); the
// REAL_ORDER_STATUSES check covers historical rows from before bulk flips
// stamped it. Postbacks deliberately still follow CPA_STAGE — the network
// panel keeps logistics statuses while the portal carries the money truth.
const AFFILIATE_WAIT_STATUSES = ["pending", "take", "call_again"];
type AffiliateOrderLite = { status?: string | null; confirmed_at?: string | null } | null | undefined;
function affiliateEarned(o: AffiliateOrderLite): boolean {
  return !!o && (o.confirmed_at != null || REAL_ORDER_STATUSES.includes(o.status || ""));
}
function affiliateDisplayStage(o: AffiliateOrderLite): "wait" | "hold" | "cancel" | "trash" {
  if (affiliateEarned(o)) return "hold"; // rendered as "Approved" — sticky
  if (o?.status === "cancelled") return "cancel";
  if (o?.status === "trashed") return "trash";
  return "wait"; // pending/take/call_again + duplicated/unknown fallback
}
// Stage filter for lead lists (portal + admin). Embedded-column filters work
// because both routes join orders!inner(...). 'approve'/'return' are legacy
// aliases from pre-2026-08 SPAs — drop them next release.
function applyAffiliateStageFilter(q: any, stage: string) {
  const s = stage === "approve" || stage === "return" ? "hold" : stage;
  if (s === "hold") return q.or(`confirmed_at.not.is.null,status.in.(${REAL_ORDER_STATUSES.join(",")})`, { referencedTable: "orders" });
  if (s === "wait") return q.is("orders.confirmed_at", null).in("orders.status", AFFILIATE_WAIT_STATUSES);
  if (s === "cancel") return q.is("orders.confirmed_at", null).eq("orders.status", "cancelled");
  if (s === "trash") return q.is("orders.confirmed_at", null).eq("orders.status", "trashed");
  return q;
}
```

`REAL_ORDER_STATUSES` already exists (`["confirmed","shipped","delivered","paid","returned"]`).
The `.or(..., { referencedTable: "orders" })` options form is required for an OR on an
embedded table (supabase-js v2). If the option name were ever wrong it fails LOUD with a
400 — the verification ritual covers it.

### 4.2 Edge fn — two `confirmed_at` holes (both exist in MK, both must be fixed)

**Bulk stamp gap** — in `POST /orders/bulk-status-update`, find
`if (new_status === "confirmed") {` (it is DEAD CODE: bulk only accepts
shipped/paid/cancelled/returned) and change the condition to
`if (REAL_ORDER_STATUSES.includes(new_status)) {`. Keep the `.is("confirmed_by_name", null)`
never-overwrite guard and the body untouched. Result: an order bulk-shipped straight from
pending gets its stamp; already-stamped orders are untouched. Postback-neutral.

**Attribution tool** — in `POST /orders/:id/attribution` (marker:
`confirmed_at: newConfirmedAt`):
- add `confirmed_at` to the order select (`"id, confirmed_by_name, confirmed_at"`),
- delete the `newConfirmedAt` variable,
- build the update conditionally: always send `confirmed_by_agent_id` /
  `confirmed_by_name`; add `confirmed_at` ONLY when re-attributing, valued
  `order.confirmed_at ?? new Date().toISOString()` (preserve the original date; stamp now
  only if missing). Clearing the attribution leaves `confirmed_at` untouched.
The audit/history code after the update only uses the id/name variables — safe.

### 4.3 Edge fn — the three stats loops (the money change)

Three near-identical loops bucket by `CPA_STAGE[orders.status]` today. Rewrite all three
with this shape (markers: `GET /affiliates` list rollup, `GET /affiliates/:id/stats`,
`GET /affiliate/stats` portal):

- every select gains `confirmed_at` → `orders(status, confirmed_at)`
- new totals object: `{ sent: 0, wait: 0, approved: 0, paid: 0, cancelled: 0, trashed: 0, payout_earned: 0 }`
- per-lead bucket logic:

```ts
const o = l.orders;
const p = Number(l.payout_eur_snapshot) || 0;
if (affiliateEarned(o)) { totals.approved++; totals.payout_earned += p; if (o?.status === "paid") totals.paid++; }
else if (o && AFFILIATE_WAIT_STATUSES.includes(o.status)) totals.wait++;
else if (o?.status === "cancelled") totals.cancelled++;
else if (o?.status === "trashed") totals.trashed++;
```

- day rows (`days` map in the two per-day endpoints) become
  `{ date, sent, wait, approved, paid, cancelled, trashed }` with the same branches
  incrementing `d.*` alongside `totals.*`.
- `returned`, `hold`, `payout_hold` fields are GONE from the real data; every response
  spreads transitional literals: `totals: { ...totals, hold: 0, payout_hold: 0 }`
  (list endpoint: `stats: { ...s, hold: 0, payout_hold: 0 }`). Comment them
  "drop next release".
- round `payout_earned` with the existing round2 pattern.

### 4.4 Edge fn — ADMIN stats super-metrics (`GET /affiliates/:id/stats` ONLY)

The portal twin must NOT get any of this. Inside the admin stats handler:

- select becomes `orders(status, confirmed_at, customer_name, price)`
- before the loop:

```ts
// Staff-only super-metrics: raw CURRENT-status funnel + test counters.
// These never go on the portal twin (GET /affiliate/stats) — internal
// funnel detail (call_again load, test hygiene) is not for webmasters.
const statuses: Record<string, number> = {};
const TEST_NAME_RE = /test|тест/i; // heuristic: no test-lead flag exists in the schema
let testLeads = 0;
// Selling side (staff-only): what the CONFIRMED orders were sold for —
// orders.price is the order total the agent settled at confirm (incl.
// upsold quantities), so avg = confirmed revenue / confirmed count.
let approvedRevenue = 0;
```

- inside the loop, before the buckets:
  `if (o?.status) statuses[o.status] = (statuses[o.status] || 0) + 1;`
  `if (o?.customer_name && TEST_NAME_RE.test(String(o.customer_name))) testLeads++;`
  and inside the earned branch: `approvedRevenue += Number(o?.price) || 0;`
- after the loop, one head-count query:

```ts
const { count: postbackTests } = await adminClient
  .from("affiliate_postbacks")
  .select("id", { count: "exact", head: true })
  .eq("affiliate_id", segments[1])
  .eq("event", "test")
  .gte("created_at", `${from}T00:00:00Z`)
  .lte("created_at", `${to}T23:59:59Z`);
```

- response gains, next to `days`:

```ts
statuses,
tests: { test_leads: testLeads, postback_tests: postbackTests || 0 },
revenue: {
  confirmed_eur: Math.round(approvedRevenue * 100) / 100,
  avg_confirmed_eur: totals.approved > 0 ? Math.round((approvedRevenue / totals.approved) * 100) / 100 : 0,
},
```

(Values are EUR internally; MK renders them in denari via `formatMoney` — the peg
conversion lives in the formatter, never in the API.)

### 4.5 Edge fn — portal `GET /affiliate/leads` rewrite

- DELETE the `STAGE_STATUSES` map and its `.in("orders.status", ...)` block; replace with
  `q = applyAffiliateStageFilter(q, stageFilter);`
- select gains `confirmed_at` inside `orders!inner(...)`; drop `return_reason` from the
  select and from the reason fallback chain
- row stage: `const stage = affiliateDisplayStage(l.orders);`
- reason ONLY for pre-confirm kills: `["cancel","trash"].includes(stage) ?
  (l.orders?.cancellation_reason || l.orders?.trash_reason || null) : null`
- NEW: date range params (the portal got the from–to picker too):

```ts
const fromDay = url.searchParams.get("from");
const toDay = url.searchParams.get("to");
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
// after .range(...):
if (fromDay && DAY_RE.test(fromDay)) q = q.gte("created_at", `${fromDay}T00:00:00Z`);
if (toDay && DAY_RE.test(toDay)) q = q.lte("created_at", `${toDay}T23:59:59Z`);
```

Everything else (row shape, `phone_masked` last-4, pagination envelope) unchanged.

### 4.6 Edge fn — NEW staff route `GET /affiliates/:id/leads`

Insert in the AFFILIATES ADMIN block, right after the `GET /affiliates/:id/stats`
handler. This is the ONE place `orders.display_id` may appear anywhere affiliate-adjacent
— never copy this select into `affiliate/*` or `/cpa/*` routes.

```ts
// GET /affiliates/:id/leads?page&limit&stage&from&to — staff view of one
// affiliate's leads: same display-stage semantics as the portal, plus
// role-privacy-governed customer PII, the CRM order linkage (display_id +
// real status + confirmed_at) and an optional date range. STAFF-ONLY
// fields — never copy this select into affiliate/* or /cpa/* routes
// (orders.display_id is banned anywhere a partner can see it).
if (req.method === "GET" && segments[0] === "affiliates" && segments[2] === "leads" && segments.length === 3) {
  if (!isAdminOrManager) return json({ error: "Forbidden" }, 403);
  if (!UUID_RE.test(segments[1])) return json({ error: "Invalid id" }, 400);
  const page = Math.max(1, Number(url.searchParams.get("page")) || 1);
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 30));
  const stageFilter = url.searchParams.get("stage") || "";
  const fromDay = url.searchParams.get("from");
  const toDay = url.searchParams.get("to");
  const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
  let q = adminClient
    .from("affiliate_leads")
    .select("id, ext_id, clickid, sub1, sub2, sub3, sub4, sub5, payout_eur_snapshot, created_at, order_id, offers(name), orders!inner(status, confirmed_at, display_id, customer_name, customer_phone, cancellation_reason, trash_reason)", { count: "exact" })
    .eq("affiliate_id", segments[1])
    .order("created_at", { ascending: false })
    .range((page - 1) * limit, page * limit - 1);
  if (fromDay && DAY_RE.test(fromDay)) q = q.gte("created_at", `${fromDay}T00:00:00Z`);
  if (toDay && DAY_RE.test(toDay)) q = q.lte("created_at", `${toDay}T23:59:59Z`);
  q = applyAffiliateStageFilter(q, stageFilter);
  const { data, error, count } = await q;
  if (error) return json({ error: sanitizeDbError(error) }, 400);
  const rows = (data || []).map((l: any) => {
    const stage = affiliateDisplayStage(l.orders);
    const red = redactCustomer(l.orders, piiFlags);
    return {
      id: l.id,
      ext_id: l.ext_id,
      clickid: l.clickid,
      sub1: l.sub1, sub2: l.sub2, sub3: l.sub3, sub4: l.sub4, sub5: l.sub5,
      offer_name: l.offers?.name ?? null,
      payout_eur: Number(l.payout_eur_snapshot) || 0,
      created_at: l.created_at,
      stage,
      reason: ["cancel", "trash"].includes(stage)
        ? (l.orders?.cancellation_reason || l.orders?.trash_reason || null)
        : null,
      customer_name: red?.customer_name ?? null,
      customer_phone: red?.customer_phone ?? null,
      order_id: l.order_id ?? null,
      display_id: l.orders?.display_id ?? null,
      order_status: l.orders?.status ?? null,
      confirmed_at: l.orders?.confirmed_at ?? null,
    };
  });
  return json({ rows, total: count || 0, page, limit });
}
```

`redactCustomer` + `piiFlags` already exist (role_privacy enforcement). The hard wall
covers this route for free (plural `affiliates/*` ≠ `affiliate/*`) — no wall changes.

### 4.7 SPA

**`src/lib/api.ts`** — replace/add:

```ts
// Earned-at-confirmation (operator decision 2026-08-10): `approved` counts
// every lead whose order was EVER confirmed — sticky, a later cancel/trash/
// return keeps the payout. wait/cancelled/trashed are pre-confirm only;
// `paid` ⊆ approved feeds the informational Buyout rate; payout_earned is
// the € sum over approved.
export interface AffiliateStats {
  sent: number; wait: number; approved: number; paid: number;
  cancelled: number; trashed: number;
  payout_earned: number;
}
export interface AffiliateDayStat {
  date: string; sent: number; wait: number; approved: number; paid: number;
  cancelled: number; trashed: number;
}
export interface AffiliateAdminStats {
  totals: AffiliateStats;
  days: AffiliateDayStat[];
  statuses: Record<string, number>;
  tests: { test_leads: number; postback_tests: number };
  /** Selling side over the CONFIRMED pool (staff-only — never on the portal). */
  revenue: { confirmed_eur: number; avg_confirmed_eur: number };
  from: string;
  to: string;
}
// apiGetAffiliateStats return type becomes Promise<AffiliateAdminStats>.
export type AffiliateAdminLead = Omit<AffiliatePortalLead, 'phone_masked'> & {
  customer_phone: string | null;
  order_id: string | null;
  display_id: string | null;
  order_status: string | null;
  confirmed_at: string | null;
};
export const apiGetAffiliateAdminLeads = (
  id: string,
  params: { page?: number; limit?: number; stage?: string; from?: string; to?: string },
): Promise<{ rows: AffiliateAdminLead[]; total: number; page: number; limit: number }> => {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  }
  const s = qs.toString();
  return apiFetch(`affiliates/${id}/leads${s ? `?${s}` : ''}`);
};
// apiGetAffiliatePortalLeads params widen to { page?; limit?; stage?; from?; to? }.
```

**NEW `src/components/affiliates/affiliateStage.ts`** (kills the duplicated rate math in
the portal page and `AffiliatesTab`'s StatsDialog):

```ts
// Affiliate display stages — PAYMENT truth shared by the partner portal and
// the staff Dashboard tab. 'hold' renders as "Approved": payout is earned at
// the FIRST confirmation and is sticky, so the edge fn folds paid / returned /
// cancelled-after-confirm orders into it; cancel/trash here mean killed
// BEFORE confirm. Postback event codes are a separate, unchanged vocabulary
// (logistics truth) — do not reuse these for the postback log.
import type { AffiliateStats } from '@/lib/api';

export const AFFILIATE_STAGES = ['wait', 'hold', 'cancel', 'trash'] as const;

export const stageBadgeClass: Record<string, string> = {
  wait: 'bg-slate-500/10 text-slate-600 border-slate-200',
  hold: 'bg-[hsl(var(--success))]/15 text-[hsl(var(--success))] border-[hsl(var(--success))]/30',
  cancel: 'bg-destructive/10 text-destructive border-destructive/30',
  trash: 'bg-muted text-muted-foreground border-border',
};

/** Approve rate = ever-confirmed share of everything sent. */
export const approveRatePct = (t?: AffiliateStats | null): number =>
  t && t.sent > 0 ? Math.round((t.approved / t.sent) * 100) : 0;

/** Buyout rate (informational only — payout no longer depends on it) = paid share of the approved pool. */
export const buyoutRatePct = (t?: AffiliateStats | null): number =>
  t && t.approved > 0 ? Math.round((t.paid / t.approved) * 100) : 0;
```

**NEW `src/components/affiliates/AffiliateKpiCards.tsx`** — the 5-tile grid, money
injected (MK passes `formatMoney` on BOTH surfaces):

```tsx
import { cn } from '@/lib/utils';
import type { AffiliateStats } from '@/lib/api';
import { approveRatePct, buyoutRatePct } from './affiliateStage';

interface AffiliateKpiCardsProps {
  totals: AffiliateStats;
  /** MK: pass formatMoney (denari) on both the portal and the staff tab. */
  fmtMoney: (eur: number) => string;
  labels: {
    sent: string;
    approveRate: string;
    buyoutRate: string;
    approved: string;
    payoutEarned: string;
  };
}

// The 5 KPI tiles shared by the partner portal and the staff Dashboard tab.
// "Payout on hold" is gone by design: earned-at-confirmation leaves nothing
// on hold.
export function AffiliateKpiCards({ totals, fmtMoney, labels }: AffiliateKpiCardsProps) {
  const tiles: { label: string; value: string | number; highlight?: boolean }[] = [
    { label: labels.sent, value: totals.sent },
    { label: labels.approveRate, value: `${approveRatePct(totals)}%` },
    { label: labels.buyoutRate, value: `${buyoutRatePct(totals)}%` },
    { label: labels.approved, value: totals.approved },
    { label: labels.payoutEarned, value: fmtMoney(totals.payout_earned), highlight: true },
  ];
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
      {tiles.map((s, i) => (
        <div
          key={i}
          className={cn(
            'rounded-xl border bg-card shadow-sm px-4 py-4',
            s.highlight && 'border-[hsl(var(--success))]/40 bg-[hsl(var(--success))]/5',
          )}
        >
          <p className="text-xl font-bold">{s.value}</p>
          <p className="text-xs text-muted-foreground mt-0.5">{s.label}</p>
        </div>
      ))}
    </div>
  );
}
```

**NEW `src/components/affiliates/AffiliateLeadsTable.tsx`** — shared table + stage filter
+ pagination; `staffColumns` adds real phone, ORD number + CRM status. Copy from the BG
file 1:1 (it is market-agnostic; money injected). Full source:

```tsx
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Copy, Inbox, Loader2 } from 'lucide-react';
import { SmartPagination } from '@/components/SmartPagination';
import { EmptyState } from '@/components/EmptyState';
import { useToast } from '@/hooks/use-toast';
import { format } from 'date-fns';
import { cn } from '@/lib/utils';
import type { AffiliatePortalLead } from '@/lib/api';
import { AFFILIATE_STAGES, stageBadgeClass } from './affiliateStage';

// Row shape both the portal (phone_masked) and the staff tab (real PII +
// order linkage) satisfy — staff-only fields are optional extras.
export type AffiliateLeadRow = Omit<AffiliatePortalLead, 'phone_masked'> & {
  phone_masked?: string | null;
  customer_phone?: string | null;
  order_id?: string | null;
  display_id?: string | null;
  order_status?: string | null;
  confirmed_at?: string | null;
};

interface AffiliateLeadsTableProps {
  title: string;
  rows: AffiliateLeadRow[];
  isLoading: boolean;
  page: number;
  pages: number;
  total: number;
  onPageChange: (p: number) => void;
  stage: string;
  onStageChange: (s: string) => void;
  fmtMoney: (eur: number) => string;
  /** "Your ID" on the portal, "Ext ID" on the staff tab. */
  extIdLabel: string;
  emptyTitle: string;
  emptyDesc: string;
  /** Staff extras: real customer phone, ORD number + CRM status columns. */
  staffColumns?: boolean;
}

// Leads table + stage filter + pagination, shared by the partner portal and
// the staff Dashboard tab. Stage = payment truth (hold = "Approved", sticky);
// the staff CRM-status column is where cancelled-after-confirm stays visible.
export function AffiliateLeadsTable({
  title, rows, isLoading, page, pages, total, onPageChange,
  stage, onStageChange, fmtMoney, extIdLabel, emptyTitle, emptyDesc, staffColumns,
}: AffiliateLeadsTableProps) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const colCount = staffColumns ? 10 : 8;

  const copyOrder = (text: string) => {
    navigator.clipboard.writeText(text);
    toast({ title: t('affiliatesAdmin.orderCopied') });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">{title}</h2>
        <Select value={stage} onValueChange={onStageChange}>
          <SelectTrigger className="w-[170px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('affiliate.allStages')}</SelectItem>
            {AFFILIATE_STAGES.map((s) => <SelectItem key={s} value={s}>{t(`affiliate.stage.${s}`)}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      <div className="rounded-xl border bg-card shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/30">
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">{t('affiliate.colDate')}</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">{extIdLabel}</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">{t('affiliate.colClickid')}</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">{t('affiliate.colSub1')}</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">{t('affiliate.colOffer')}</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">{t('affiliate.colCustomer')}</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">{t('affiliate.colPayout')}</th>
                {staffColumns && (
                  <>
                    <th className="text-left px-4 py-3 font-medium text-muted-foreground">{t('affiliatesAdmin.colOrder')}</th>
                    <th className="text-left px-4 py-3 font-medium text-muted-foreground">{t('affiliatesAdmin.colCrmStatus')}</th>
                  </>
                )}
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">{t('affiliate.colStage')}</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr><td colSpan={colCount} className="py-16 text-center"><Loader2 className="h-6 w-6 animate-spin text-primary inline-block" /></td></tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={colCount} className="p-0">
                    <EmptyState
                      icon={<Inbox className="h-5 w-5" />}
                      title={emptyTitle}
                      description={emptyDesc}
                      size="sm"
                      className="border-0 bg-transparent hover:shadow-none py-8"
                    />
                  </td>
                </tr>
              ) : rows.map((l) => (
                <tr key={l.id} className="border-b last:border-0 hover:bg-muted/20 transition-colors">
                  <td className="px-4 py-3 text-xs text-muted-foreground whitespace-nowrap">
                    {format(new Date(l.created_at), 'MMM d, HH:mm')}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs">{l.ext_id || '—'}</td>
                  <td className="px-4 py-3 font-mono text-xs truncate max-w-[140px]" title={l.clickid || ''}>{l.clickid || '—'}</td>
                  <td className="px-4 py-3 font-mono text-xs">{l.sub1 || '—'}</td>
                  <td className="px-4 py-3">{l.offer_name || '—'}</td>
                  <td className="px-4 py-3 text-xs">
                    {l.customer_name}
                    {staffColumns
                      ? l.customer_phone && <span className="text-muted-foreground ml-1.5 font-mono">{l.customer_phone}</span>
                      : l.phone_masked && <span className="text-muted-foreground ml-1.5 font-mono">{l.phone_masked}</span>}
                  </td>
                  <td className="px-4 py-3 font-semibold">{fmtMoney(l.payout_eur)}</td>
                  {staffColumns && (
                    <>
                      <td className="px-4 py-3">
                        {l.display_id ? (
                          <span className="inline-flex items-center gap-1">
                            <code className="font-mono text-xs">{l.display_id}</code>
                            <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => copyOrder(String(l.display_id))}>
                              <Copy className="h-3 w-3" />
                            </Button>
                          </span>
                        ) : '—'}
                      </td>
                      <td className="px-4 py-3">
                        {l.order_status ? (
                          <span className="text-xs text-muted-foreground">{t(`status.${l.order_status}`)}</span>
                        ) : '—'}
                      </td>
                    </>
                  )}
                  <td className="px-4 py-3">
                    <Badge variant="outline" className={cn('text-xs', stageBadgeClass[l.stage])}>
                      {t(`affiliate.stage.${l.stage}`)}
                    </Badge>
                    {l.reason && <p className="text-[11px] text-muted-foreground mt-0.5">{l.reason}</p>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {pages > 1 && (
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>{t('affiliate.pageOf', { page, pages, total })}</span>
          <SmartPagination page={page} totalPages={pages} onPageChange={onPageChange} />
        </div>
      )}
    </div>
  );
}
```

**NEW `src/components/affiliates/AffiliateDashboardTab.tsx`** — the staff tab.
MK-adapted (imports `formatMoney`; everything else identical to BG's final state):

```tsx
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { apiGetAffiliates, apiGetAffiliateStats, apiGetAffiliateAdminLeads } from '@/lib/api';
import { formatMoney } from '@/lib/currency';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { DateRangePicker, type DateRange } from '@/components/DateRangePicker';
import { format, subDays } from 'date-fns';
import { Handshake, Loader2 } from 'lucide-react';
import { EmptyState } from '@/components/EmptyState';
import { AffiliateKpiCards } from './AffiliateKpiCards';
import { AffiliateLeadsTable } from './AffiliateLeadsTable';
import { approveRatePct } from './affiliateStage';

// Default range = the last 30 days, matching what the partner portal shows.
const last30Days = (): DateRange => ({
  from: format(subDays(new Date(), 29), 'yyyy-MM-dd'),
  to: format(new Date(), 'yyyy-MM-dd'),
});

// Staff Dashboard tab on /affiliates-admin: the exact partner-portal view
// (same KPI tiles + leads table) PLUS staff-only super-metrics — outcome
// funnel, conversion %, avg confirmed order value, payout cost per lead and
// test counters. Read-only, so manager access is inherently safe.
export function AffiliateDashboardTab() {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const [range, setRange] = useState<DateRange>(last30Days);
  const [stage, setStage] = useState('all');
  const [page, setPage] = useState(1);
  const limit = 30;

  const { data: affiliates = [], isLoading: affLoading } = useQuery({
    queryKey: ['affiliates'],
    queryFn: apiGetAffiliates,
  });

  // ?affiliate= deep-links a partner; falls back to the first one.
  const urlAff = searchParams.get('affiliate') || '';
  const affId = affiliates.some((a) => a.id === urlAff) ? urlAff : (affiliates[0]?.id ?? '');
  const selectAffiliate = (id: string) => {
    setPage(1);
    setSearchParams((prev) => ({ ...Object.fromEntries(prev), affiliate: id }));
  };

  // The stats endpoint defaults a missing `from` to the last 30 days
  // server-side, so "All time" (both bounds empty) needs an explicit floor
  // older than any lead. The leads endpoint has no default; omitted bounds
  // already mean all time there.
  const statsFrom = range.from || '2020-01-01';
  const statsTo = range.to || undefined;

  const { data: stats, isLoading: statsLoading } = useQuery({
    queryKey: ['affiliate-admin-stats', affId, range.from, range.to],
    queryFn: () => apiGetAffiliateStats(affId, statsFrom, statsTo),
    enabled: !!affId,
  });
  const { data: leads, isLoading: leadsLoading } = useQuery({
    queryKey: ['affiliate-admin-leads', affId, stage, page, range.from, range.to],
    queryFn: () => apiGetAffiliateAdminLeads(affId, {
      page, limit,
      stage: stage === 'all' ? undefined : stage,
      from: range.from || undefined,
      to: range.to || undefined,
    }),
    enabled: !!affId,
  });

  const totals = stats?.totals;
  const rows = leads?.rows || [];
  const total = leads?.total || 0;
  const pages = Math.max(1, Math.ceil(total / limit));

  const costPerLead = totals && totals.sent > 0 ? totals.payout_earned / totals.sent : 0;

  // Funnel = the outcome of the affiliate's job ONLY (operator decision:
  // nothing after confirm matters here). Confirmed = ever-confirmed, so
  // shipped/delivered/paid/returned fold into it; cancelled/trashed are
  // pre-confirm kills; pending = still-unworked leads (incl. taken);
  // call again is the current retry pile.
  const funnel = useMemo(() => {
    const tot = stats?.totals;
    if (!tot) return [];
    const s = stats?.statuses || {};
    return [
      { status: 'pending', count: (s.pending || 0) + (s.take || 0) },
      { status: 'call_again', count: s.call_again || 0 },
      { status: 'confirmed', count: tot.approved },
      { status: 'trashed', count: tot.trashed },
      { status: 'cancelled', count: tot.cancelled },
    ];
  }, [stats]);

  if (affLoading) {
    return <div className="flex items-center justify-center py-20"><Loader2 className="h-8 w-8 animate-spin text-primary" /></div>;
  }
  if (!affId) {
    return (
      <EmptyState
        icon={<Handshake className="h-5 w-5" />}
        title={t('affiliatesAdmin.noAffiliates')}
        description={t('affiliatesAdmin.noAffiliatesDesc')}
        size="sm"
      />
    );
  }

  return (
    <div className="space-y-6">
      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <Select value={affId} onValueChange={selectAffiliate}>
          <SelectTrigger className="w-[200px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            {affiliates.map((a) => <SelectItem key={a.id} value={a.id}>{a.name} ({a.code})</SelectItem>)}
          </SelectContent>
        </Select>
        <DateRangePicker value={range} onChange={(r) => { setRange(r); setPage(1); }} />
      </div>

      {statsLoading || !totals ? (
        <div className="flex items-center justify-center py-10"><Loader2 className="h-6 w-6 animate-spin text-primary" /></div>
      ) : (
        <>
          {/* Same KPI row the partner sees */}
          <AffiliateKpiCards
            totals={totals}
            fmtMoney={formatMoney}
            labels={{
              sent: t('affiliate.kpiSent'),
              approveRate: t('affiliate.kpiApproveRate'),
              buyoutRate: t('affiliate.kpiBuyoutRate'),
              approved: t('affiliate.kpiHold'),
              payoutEarned: t('affiliate.kpiPayoutEarned'),
            }}
          />

          {/* Staff-only super-metrics */}
          <div className="space-y-3">
            <h2 className="text-lg font-semibold">{t('affiliatesAdmin.metricsHeading')}</h2>
            <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
              <div className="rounded-xl border bg-card shadow-sm px-4 py-4">
                <p className="text-xl font-bold">{approveRatePct(totals)}%</p>
                <p className="text-xs text-muted-foreground mt-0.5">{t('affiliatesAdmin.conversionPct')}</p>
              </div>
              <div className="rounded-xl border bg-card shadow-sm px-4 py-4">
                <p className="text-xl font-bold">{formatMoney(stats?.revenue?.avg_confirmed_eur ?? 0)}</p>
                <p className="text-xs text-muted-foreground mt-0.5">{t('affiliatesAdmin.avgOrderValue')}</p>
              </div>
              <div className="rounded-xl border bg-card shadow-sm px-4 py-4">
                <p className="text-xl font-bold">{formatMoney(costPerLead)}</p>
                <p className="text-xs text-muted-foreground mt-0.5">{t('affiliatesAdmin.costPerLead')}</p>
              </div>
              <div className="rounded-xl border bg-card shadow-sm px-4 py-4">
                <p className="text-xl font-bold">{stats?.tests.test_leads ?? 0}</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {t('affiliatesAdmin.testLeads')}
                  <span className="block text-[10px] opacity-70">{t('affiliatesAdmin.testLeadsHint')}</span>
                </p>
              </div>
              <div className="rounded-xl border bg-card shadow-sm px-4 py-4">
                <p className="text-xl font-bold">{stats?.tests.postback_tests ?? 0}</p>
                <p className="text-xs text-muted-foreground mt-0.5">{t('affiliatesAdmin.postbackTests')}</p>
              </div>
            </div>

            {/* Funnel by outcome */}
            {funnel.length > 0 && (
              <div className="rounded-xl border bg-card shadow-sm overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b bg-muted/30">
                        <th className="text-left px-4 py-2.5 font-medium text-muted-foreground">{t('affiliatesAdmin.funnelHeading')}</th>
                        <th className="text-right px-4 py-2.5 font-medium text-muted-foreground">{t('affiliatesAdmin.colCount')}</th>
                        <th className="text-right px-4 py-2.5 font-medium text-muted-foreground">{t('affiliatesAdmin.colShare')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {funnel.map((row) => (
                        <tr key={row.status} className="border-b last:border-0">
                          <td className="px-4 py-2">{t(`status.${row.status}`)}</td>
                          <td className="px-4 py-2 text-right font-medium tabular-nums">{row.count}</td>
                          <td className="px-4 py-2 text-right text-muted-foreground tabular-nums">
                            {totals.sent > 0 ? Math.round((row.count / totals.sent) * 100) : 0}%
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>

          {/* Leads with staff extras (real PII per role privacy, ORD id, CRM status) */}
          <AffiliateLeadsTable
            title={t('affiliatesAdmin.leadsHeading')}
            rows={rows}
            isLoading={leadsLoading}
            page={page}
            pages={pages}
            total={total}
            onPageChange={setPage}
            stage={stage}
            onStageChange={(v) => { setStage(v); setPage(1); }}
            fmtMoney={formatMoney}
            extIdLabel={t('affiliatesAdmin.colExtId')}
            emptyTitle={t('affiliatesAdmin.noLeadsRange')}
            emptyDesc={t('affiliatesAdmin.noLeadsRangeDesc')}
            staffColumns
          />
        </>
      )}
    </div>
  );
}
```

**`src/pages/AffiliateDashboardPage.tsx` (portal) — refactor onto the shared
components.** Delete the local `STAGES`/`stageBadge` export/rate math/inline table.
Result (MK version — note `formatMoney`, which the MK portal already used):

- state: `range` (`last30Days()` as in the tab) replaces `days`; `stage`, `page` stay
- `statsFrom = range.from || '2020-01-01'` (same all-time floor note)
- stats query: key `['affiliate-portal-stats', range.from, range.to]`, fn
  `apiGetAffiliatePortalStats(statsFrom, range.to || undefined)`
- leads query: key gains `range.from, range.to`; params gain `from/to`
- layout: `<AppLayout title={t('affiliate.dashboardTitle')}>` (headerActions preset
  select DELETED) → body starts with
  `<DateRangePicker value={range} onChange={(r) => { setRange(r); setPage(1); }} />`,
  then `AffiliateKpiCards` (labels: `kpiSent/kpiApproveRate/kpiBuyoutRate/kpiHold/`
  `kpiPayoutEarned`, `fmtMoney={formatMoney}`), then `AffiliateLeadsTable` with
  `title={t('affiliate.myLeads')}`, `extIdLabel={t('affiliate.colYourId')}`,
  `emptyTitle/Desc = affiliate.noLeads(+Desc)`, NO `staffColumns`.

**`src/components/affiliates/AffiliatesTab.tsx`** — five edits:
1. import `{ approveRatePct, buyoutRatePct } from './affiliateStage'`
2. `leadsBreakdown` interpolation: `{ hold: a.stats.hold, ... }` →
   `{ approved: a.stats.approved, paid: a.stats.paid }`
3. delete the `payoutHoldShort` span (`a.stats.payout_hold > 0 && ...`)
4. StatsDialog: replace the two inline rate formulas with the shared helpers; the
   `stHold` tile value → `totals.approved`; DELETE the whole "Payout on hold" row
   (`affiliatesAdmin.payoutHold`); day-table `d.hold` cell → `d.approved`
5. summary cards (sent/paid/payout_earned) need no change

**`src/pages/AffiliatesAdminPage.tsx` — MK version (FIVE tabs, Countries preserved):**

```tsx
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { AppLayout } from '@/layouts/AppLayout';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Globe, Handshake, LayoutDashboard, Send, Tag } from 'lucide-react';
import { AffiliateDashboardTab } from '@/components/affiliates/AffiliateDashboardTab';
import { AffiliatesTab } from '@/components/affiliates/AffiliatesTab';
import { OffersTab } from '@/components/affiliates/OffersTab';
import { PostbackLogTab } from '@/components/affiliates/PostbackLogTab';
import { MirrorTab } from '@/components/altercpa/MirrorTab';

const TABS = ['dashboard', 'affiliates', 'offers', 'postbacks', 'countries'] as const;

/**
 * Affiliates (Admin) — per-affiliate dashboard + staff super-metrics, then
 * webmaster management, offers/payouts, the postback delivery log and the
 * AlterCPA country mirror. View is admin/manager; every mutation is
 * re-checked admin-only server-side. Tabs are URL-synced (?tab=&affiliate=)
 * so affiliate rows can deep-link into the dashboard.
 */
export default function AffiliatesAdminPage() {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();

  const requested = searchParams.get('tab');
  const activeTab = TABS.find((v) => v === requested) ?? 'dashboard';

  return (
    <AppLayout title={t('nav.affiliates')}>
      <Tabs
        value={activeTab}
        onValueChange={(v) => setSearchParams((prev) => ({ ...Object.fromEntries(prev), tab: v }))}
        className="space-y-6"
      >
        <TabsList>
          <TabsTrigger value="dashboard" className="gap-2">
            <LayoutDashboard className="h-4 w-4" /> {t('affiliatesAdmin.tabDashboard')}
          </TabsTrigger>
          <TabsTrigger value="affiliates" className="gap-2">
            <Handshake className="h-4 w-4" /> {t('affiliatesAdmin.tabAffiliates')}
          </TabsTrigger>
          <TabsTrigger value="offers" className="gap-2">
            <Tag className="h-4 w-4" /> {t('affiliatesAdmin.tabOffers')}
          </TabsTrigger>
          <TabsTrigger value="postbacks" className="gap-2">
            <Send className="h-4 w-4" /> {t('affiliatesAdmin.tabPostbacks')}
          </TabsTrigger>
          {/* The AlterCPA mirror, by country — same component as /altercpa's
              Mirror tab so the two can never drift apart. */}
          <TabsTrigger value="countries" className="gap-2">
            <Globe className="h-4 w-4" /> {t('affiliatesAdmin.tabCountries')}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="dashboard"><AffiliateDashboardTab /></TabsContent>
        <TabsContent value="affiliates"><AffiliatesTab /></TabsContent>
        <TabsContent value="offers"><OffersTab /></TabsContent>
        <TabsContent value="postbacks"><PostbackLogTab /></TabsContent>
        <TabsContent value="countries"><MirrorTab /></TabsContent>
      </Tabs>
    </AppLayout>
  );
}
```

### 4.8 i18n — key diff, ALL FOUR locales (`src/i18n/locales/{en,bg,sq,mk}.json`)

Same structure in all four; `mk.json` must not contain `ъ щ я ю ь` (parity test enforces
it). The `leadsBreakdown` placeholder rename MUST land in the same commit as the code
(placeholder-parity test).

REMOVE (from all four): `affiliate.stage.approve`, `affiliate.stage.return`,
`affiliate.kpiPayoutHold`, `affiliate.last7`, `affiliate.last30`, `affiliate.last90`,
`affiliatesAdmin.payoutHold`, `affiliatesAdmin.payoutHoldShort`.

CHANGE:

| key | EN | BG | SQ | MK |
|---|---|---|---|---|
| `affiliate.stage.hold` | Approved | Одобрена | E miratuar | Одобрена |
| `affiliate.kpiHold` | Approved | Одобрени | Të miratuara | Одобрени |
| `affiliatesAdmin.stHold` | Approved | Одобрени | Të miratuara | Одобрени |
| `affiliatesAdmin.leadsBreakdown` | {{approved}} approved · {{paid}} paid | {{approved}} одобрени · {{paid}} платени | {{approved}} të miratuar · {{paid}} të paguar | {{approved}} одобрени · {{paid}} платени |
| `affiliate.payoutPerBuyout` | per approved (confirmed) order | на одобрена (потвърдена) поръчка | për porosi të miratuar (të konfirmuar) | по одобрена (потврдена) нарачка |

ADD under `affiliatesAdmin`:

| key | EN | BG | SQ | MK |
|---|---|---|---|---|
| `tabDashboard` | Dashboard | Табло | Paneli | Табла |
| `leadsHeading` | Leads | Лийдове | Lead-e | Лидови |
| `colExtId` | Ext ID | Ext ID | Ext ID | Ext ID |
| `colOrder` | Order | Поръчка | Porosia | Нарачка |
| `colCrmStatus` | CRM status | CRM статус | Statusi CRM | CRM статус |
| `colCount` | Count | Брой | Numri | Број |
| `colShare` | % of leads | % от лийдовете | % e lead-eve | % од лидовите |
| `metricsHeading` | Metrics | Метрики | Metrika | Метрики |
| `funnelHeading` | Funnel by status | Фуния по статус | Hinka sipas statusit | Инка по статус |
| `conversionPct` | Conversion % | Конверсия % | Konvertimi % | Конверзија % |
| `costPerLead` | Cost per lead | Цена на лийд | Kosto për lead | Цена по лид |
| `avgOrderValue` | Avg order value (confirmed) | Средна цена на поръчка (одобрени) | Vlera mesatare e porosisë (të miratuara) | Просечна цена на нарачка (одобрени) |
| `testLeads` | Test leads | Тестови лийдове | Lead-e testi | Тест лидови |
| `testLeadsHint` | by customer name (heuristic) | по име на клиента (евристика) | sipas emrit të klientit (heuristikë) | по име на клиентот (хевристика) |
| `postbackTests` | Postback test-fires | Тестови postback-и | Postback-e testi | Тест postback-и |
| `noLeadsRange` | No leads in this range | Няма лийдове в този период | S'ka lead-e në këtë periudhë | Нема лидови во овој период |
| `noLeadsRangeDesc` | Change the range, stage or affiliate to see leads. | Сменете периода, етапа или афилиата, за да видите лийдове. | Ndryshoni periudhën, fazën ose afiliatin për të parë lead-e. | Сменете го периодот, фазата или афилијатот за да видите лидови. |
| `orderCopied` | Order ID copied | Номерът на поръчката е копиран | ID e porosisë u kopjua | Бројот на нарачката е копиран |

(If a value already exists locally with slightly different phrasing conventions — e.g.
"лийд" vs "лид" — keep THIS table's forms; they were reviewed for the mk orthography
test. `affiliatesAdmin.tabCountries` already exists in MK, untouched.)

### 4.9 Docs + skill (the MK repo has both)

- `docs/AFFILIATE-INTEGRATION.md` — the §Stages money table: `hold` → "**payout earned**
  (final)"; `approve` → "payout was already earned at `hold`"; `cancel`/`trash` → "no
  payout if it never reached `hold`; an earned payout is kept"; `return` → "payout kept —
  **not** reversed". Replace the "This is a COD buyout model…" paragraph with: payout
  accrues when the call centre confirms (`hold`) and is never reversed; everything after
  `hold` is logistics info; the portal's "Payout earned" is the billing truth; postback
  events/params/macros unchanged. In §3a replace the "Two things we need from you (CPS or
  CoD…)" sentence — billing settles at confirmation (`accept=1`) on our side; `status=10`
  / `status=11` are logistics only.
- `.grok/skills/elyon-affiliates/SKILL.md` — decision #3 → earned at FIRST CONFIRMATION,
  sticky (`orders.confirmed_at`, defensive OR, survives attribution corrections; still
  `payout_eur_snapshot`; agent commissions stay paid-gated). Status-map section → add the
  scope note (stage map = postbacks + `/cpa/leads` ONLY; stats/lists decoupled via the
  helpers; partner panel may show `return` while portal shows Approved — by design). Red
  flags → "re-litigating the confirmed-at-earn gate", add "keying portal payout on
  CPA_STAGE/current status" and "NULLing or re-stamping confirmed_at in any write path";
  scope the display_id ban with "(the staff-only GET /affiliates/:id/leads is the one
  place it may appear)".

### 4.10 `scripts/report-affiliate-earned-delta.mjs`

Copy verbatim from the BG repo if available; otherwise it is a read-only script that
pages `affiliate_leads` (1000-row `.range()` chunks) selecting
`affiliate_id, payout_eur_snapshot, orders(status, confirmed_at)`, joins `affiliates`
once, and `console.table`s per affiliate + TOTAL: leads · old hold cnt/€ (status
confirmed|shipped|delivered) · old earned € (paid) · new pure cnt/€ (`confirmed_at` set)
· new defensive cnt/€ (pure OR status∈REAL) · **DELTA €** · retro-credit (stamped AND now
cancelled/trashed/returned) · hold→earned flip · gap rows (status∈REAL, stamp NULL). Env
pattern: `VITE_SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` with `.env` fallback,
`persistSession: false`. In MK it will print zeros today — run it anyway; it is the
standing tool for this feature.

## 5. Database comparison (checked 2026-08-10, read-only)

| | **BG** `sxymaloycddnoxudxaqp` | **MK** `bmfxhgznttcnnlqloqzp` |
|---|---|---|
| Affiliate schema (5 tables, `postback_format` column, dedupe knob) | applied | **applied — verified empirically** (tables answer; `affiliates.postback_format` selectable ⇒ trigger v3 migration live; `app_settings.affiliate_dedupe_window_hours` present) |
| Migrations needed for this port | none | **none** |
| `affiliates` / `offers` / `affiliate_leads` / `affiliate_postbacks` rows | 1 / live / 72 / live | **0 / 0 / 0 / 0** — program not started |
| Payout delta on flip | +€420 (13 holds €390 + 1 retro €30) — approved & applied | **€0** — nothing to sign off |
| Orders in real statuses with `confirmed_at` NULL (gap rows) | 0 of ~all | **0 of 27,277** |

Meaning for MK: the port is pure future-proofing — it changes no existing numbers, needs
no data repair and no operator €-approval. Ship it before the MK affiliate program signs
its first partner so the program starts life with the correct semantics.

## 6. MK-specific constraints (from the fork's own memory + verified)

- **Money:** `formatMoney` (denari, frozen peg `MKD_PER_EUR = 61.5` — never update) on
  BOTH the portal and the staff tab. No `formatEur` exists; do not create one.
- **Preserve the Countries tab** (`MirrorTab`, skill `elyon-altercpa-bridge`) — Dashboard
  becomes the first of FIVE tabs; `'countries'` stays in the URL-synced tab list.
- **Line numbers differ** from every BG reference — locate by the marker strings in §4.
- `npx tsc --noEmit` is a NO-OP — use `-p tsconfig.app.json` and compare the error count
  against the pre-change baseline (only pre-existing errors allowed).
- `supabase db push` is blocked (no DB password) — **irrelevant here: zero migrations.**
- Deploy: edge fn FIRST — `npx supabase functions deploy api --project-ref
  bmfxhgznttcnnlqloqzp --use-api` — then commit by EXPLICIT paths and push (push needs
  the VAULT §4 PAT, not the cached elyoncoding creds; push = Vercel prod deploy).
- Read `.grok/skills/` first: `elyon-affiliates`, `elyon-currency`, `elyon-i18n`,
  `elyon-security`, `elyon-altercpa-bridge` all apply.

## 7. Verification ritual

1. `npm test` (i18n parity incl. mk orthography + keys-used + placeholder parity) ·
   `npx tsc --noEmit -p tsconfig.app.json` (delta vs baseline) · `npm run build` · lint
   the touched files (pre-existing `no-explicit-any` noise is normal).
2. `node scripts/report-affiliate-earned-delta.mjs` → expect all zeros (no leads yet).
3. Deploy fn → probe `GET /functions/v1/api/cpa/leads?key=invalid_probe` →
   `{"status":"error","error":"security"}` proves the new deploy serves.
4. Push SPA → verify the prod bundle contains a marker (e.g. `tabDashboard`) per the
   "verify what's LIVE via prod bundles" method.
5. Functional (create a test affiliate + fire one test lead through `POST /cpa/lead`):
   portal shows 5 tiles and stage "Waiting"; confirm the order → stage "Approved",
   payout earned immediately; cancel it afterwards → payout and stage UNCHANGED (sticky);
   the postback log shows `hold` then `cancel` exactly as before (zero-diff stream);
   "Approved" stage filter returns confirmed+shipped+delivered+paid+returned rows (proves
   the `referencedTable` or-filter — a wrong option name 400s loudly); admin Dashboard
   tab: `?tab=postbacks` deep-link works, Countries tab intact, KPI numbers ≡ portal,
   funnel = 5 outcome rows, avg order value / cost per lead render in денари, real
   name/phone respect role_privacy; an affiliate-only login gets 403 on
   `GET /api/affiliates/<id>/leads`; `GET /cpa/leads` still answers status-based stages.
6. Update the MK skill + integration doc (§4.9) in the same commit as the code.

## 8. Handoff prompt for the MK session

Paste this into a fresh session opened on the `elyon-natura` repo.

````text
Port the Elyon BG "affiliate payout at confirmation + admin Dashboard tab" work
into this Macedonian CRM (elyon-natura). Separate project, separate database —
nothing is shared with BG.

Read docs/AFFILIATE_PAYOUT_CONFIRM_PORT_GUIDE.md in this repo FIRST (copy it in
from the BG repo if it is not here yet) — it contains the full change map, the
exact code for every new file, the i18n values for all four locales, and the
verified state of THIS repo and THIS database as of 2026-08-10:
  - the affiliate schema is fully applied here (ZERO migrations to run),
  - the affiliate program has ZERO data (the payout flip costs €0),
  - orders have ZERO confirmed_at gaps (27,277 real-status rows checked),
  - this repo still has the OLD code: STAGE_STATUSES in the portal leads route,
    the dead `new_status === "confirmed"` branch in bulk-status-update, the
    attribution tool that NULLs/re-dates confirmed_at, and the duplicated rate
    math in AffiliatesTab. All of it must change per the guide.

The three operator decisions are FINAL — do not re-ask:
  1. payout earned at FIRST confirmation, sticky forever;
  2. fully retroactive (moot here — no data);
  3. postbacks/CPA_STAGE/affiliate_stage()/GET /cpa/leads stay byte-identical.

Constraints for THIS repo:
  - find edit points by the guide's marker strings, never by BG line numbers;
  - money renders via formatMoney (денари) on BOTH the portal and the staff
    tab — there is no formatEur here and you must not add one;
  - /affiliates-admin has a Countries tab (MirrorTab) — PRESERVE it; Dashboard
    becomes the first of FIVE URL-synced tabs;
  - every new string in all four locales (en/bg/sq/mk) using the guide's
    tables; mk.json must not contain ъ щ я ю ь;
  - npx tsc --noEmit is a no-op; use -p tsconfig.app.json and compare against
    the existing error count;
  - supabase db push is blocked — and NOT needed (zero migrations);
  - deploy edge fn first (npx supabase functions deploy api --project-ref
    bmfxhgznttcnnlqloqzp --use-api), then commit by explicit paths and push
    (VAULT §4 PAT, not the cached elyoncoding creds);
  - read .grok/skills/elyon-affiliates, elyon-currency, elyon-i18n,
    elyon-security before touching anything, and update elyon-affiliates +
    docs/AFFILIATE-INTEGRATION.md per guide §4.9 in the same commit.

Work order: edge fn helpers + the two confirmed_at fixes → the three stats
loops + admin super-metrics → both leads endpoints → api.ts → the four shared
components → portal page + AffiliatesTab + AffiliatesAdminPage → i18n → docs +
skill → the delta script.

Do NOT deploy until you have shown me: the typecheck delta, npm test green, the
production build, and the delta script output (expected: all zeros). Then run
the verification ritual in guide §7 — including the sticky-payout functional
test with one test lead — and tell me which checks passed.
````

---

*Written 2026-08-10 after the BG rollout (commits `eef594a` + `1b44a21`). If a rule in
§2 changes, change it in both repos and in `.grok/skills/elyon-affiliates` the same day.
Next-release cleanup owed in BOTH repos: drop the `hold: 0, payout_hold: 0` transitional
fields and the `approve`/`return` stage-filter aliases.*
