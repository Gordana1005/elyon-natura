/**
 * mex-reconcile — courier ground truth into Elyon, automatically.
 *
 *   POST /functions/v1/mex-reconcile
 *   header: x-mex-sync-secret: <MEX_SYNC_SECRET>
 *   body:   { kind?: 'rolling'|'backfill'|'manual', from?: 'YYYY-MM-DD', dry?: boolean }
 *
 * Called by pg_cron twice an hour, 07:00–20:55 Skopje (gate in
 * invoke_mex_reconcile). Port of scripts/reconcile-mex-shipments.mjs matching —
 * keep the two in step, the same way altercpa.ts mirrors scripts/lib.
 *
 * What it does: pulls MEX shipments whose status changed since the cursor,
 * matches each to an order, and applies the truth the 2026-08-11
 * reconciliation established:
 *   any non-terminal status → shipped  (the parcel EXISTS at the courier —
 *                      that alone means the order left fulfilment; applied
 *                      forward-only from pending/take/call_again/confirmed)
 *   2 Delivered → paid  (paid_at = courier time; cancel/trash reasons cleared —
 *                      AlterCPA cancels on delivered parcels are wrong, proven
 *                      at 4.184-order scale)
 *   7 Returned  → returned (paid_at removed — the COD was never collected)
 *
 * Matching (never guessed):
 *   1. orders.mex_tracking_id — a link decided once is never re-derived
 *   2. else phone → E.164 (+389, trunk 0 stripped) → candidates, COD must be
 *      round(price€ × 61.5) or +150 достава (±3 ден), nearest created date in
 *      [−3d … +75d]; several equally-plausible orders ⇒ counted ambiguous,
 *      NOT changed. The match is then remembered in mex_tracking_id.
 *   'duplicated' orders are never touched. No ownership guard: money truth
 *   from the courier outranks any status, per the operator decision.
 */
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const MKD_PER_EUR = 61.5;          // FROZEN — see src/lib/currency.ts
const DELIVERY_MKD = 150;
const MEX_BASE = "https://mex.mk/api/json";
const DAY = 86400_000;
const OVERLAP_DAYS = 2;            // updated_from is date-granular; re-reading is idempotent
const DEFAULT_LOOKBACK_DAYS = 7;

interface MexShipment {
  tracking_id: string;
  current_status_id: number;
  receiver_city?: string;
  receiver_phone?: string;
  cod?: string;
  created_at?: string;
  last_update_at?: string;
}

/** MEX timestamps are Skopje local. +02:00 is exact in summer and one hour off
 * in winter — acceptable for settlement dates, and consistent with the CSV
 * reconciliation that established the baseline. */
const mexDate = (s: string | undefined) => (s ? new Date(s.replace(" ", "T") + "+02:00") : null);

/** Local MK number (070…, 70…) → E.164 the way every order stores it. */
function mkE164(raw: unknown): string | null {
  let d = String(raw ?? "").replace(/\D/g, "");
  if (!d) return null;
  if (d.startsWith("389")) d = d.slice(3);
  d = d.replace(/^0+/, "");
  if (d.length < 8 || d.length > 9) return null;
  return "+389" + d;
}

serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const expected = Deno.env.get("MEX_SYNC_SECRET");
  if (!expected) return json({ error: "Not configured" }, 503);
  if ((req.headers.get("x-mex-sync-secret") || "") !== expected) return json({ error: "Forbidden" }, 403);

  const apiKey = Deno.env.get("MEX_API_KEY");
  if (!apiKey) return json({ error: "MEX_API_KEY is not set" }, 503);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* defaults */ }
  const kind = ["rolling", "backfill", "manual"].includes(String(body.kind)) ? String(body.kind) : "rolling";
  const dry = body.dry === true;

  const admin = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  );
  const startedMs = Date.now();

  // ── cursor: last clean run's window_to, minus overlap ─────────────────────
  let fromDate = String(body.from || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDate)) {
    const { data: lastRun } = await admin
      .from("mex_sync_runs").select("window_to")
      .eq("status", "ok").not("window_to", "is", null)
      .order("window_to", { ascending: false }).limit(1).maybeSingle();
    const base = lastRun?.window_to
      ? new Date(new Date(lastRun.window_to).getTime() - OVERLAP_DAYS * DAY)
      : new Date(Date.now() - DEFAULT_LOOKBACK_DAYS * DAY);
    fromDate = base.toISOString().slice(0, 10);
  }
  const toDate = new Date().toISOString().slice(0, 10);

  let runId: string | null = null;
  if (!dry) {
    const { data: run } = await admin.from("mex_sync_runs").insert({
      kind, window_from: fromDate, window_to: toDate, status: "running",
    }).select("id").single();
    runId = run?.id ?? null;
  }

  const stats = { fetched: 0, matched: 0, paid_applied: 0, returned_applied: 0, shipped_applied: 0, skipped: {} as Record<string, number> };
  const bump = (k: string) => { stats.skipped[k] = (stats.skipped[k] || 0) + 1; };
  const fail = async (msg: string) => {
    if (runId) {
      await admin.from("mex_sync_runs").update({
        status: "failed", error: msg.slice(0, 500),
        finished_at: new Date().toISOString(), duration_ms: Date.now() - startedMs,
      }).eq("id", runId);
    }
    return json({ error: msg }, 502);
  };

  try {
    // ── fetch terminal shipments updated in the window ──────────────────────
    const ships: MexShipment[] = [];
    for (let page = 1; ; page++) {
      const url = `${MEX_BASE}/list_shipments.php?updated_from=${fromDate}&per_page=500&page=${page}&order=last_update_asc`;
      const res = await fetch(url, { headers: { AuthKey: apiKey } });
      if (!res.ok) throw new Error(`MEX HTTP ${res.status}`);
      const j = await res.json();
      if (j?.success !== 1 || !Array.isArray(j.shipments)) {
        throw new Error(`MEX error body: ${JSON.stringify(j).slice(0, 200)}`);
      }
      ships.push(...j.shipments);
      if (page >= Number(j.total_pages || 1) || ships.length >= 4000) break;
    }
    stats.fetched = ships.length;

    // ── resolve existing links in one query ─────────────────────────────────
    const trackIds = ships.map((s) => s.tracking_id);
    const linked = new Map<string, any>();
    for (let i = 0; i < trackIds.length; i += 200) {
      const { data } = await admin.from("orders")
        .select("id, status, mex_tracking_id, price, created_at, cancellation_reason")
        .in("mex_tracking_id", trackIds.slice(i, i + 200));
      for (const o of data || []) linked.set(o.mex_tracking_id, o);
    }

    // ── candidates for unlinked shipments, one query per phone batch ────────
    const phones = [...new Set(ships.filter((s) => !linked.has(s.tracking_id))
      .map((s) => mkE164(s.receiver_phone)).filter(Boolean))] as string[];
    const byPhone = new Map<string, any[]>();
    for (let i = 0; i < phones.length; i += 100) {
      const { data } = await admin.from("orders")
        .select("id, customer_phone, price, status, created_at, mex_tracking_id")
        .in("customer_phone", phones.slice(i, i + 100))
        .gte("created_at", new Date(Date.now() - 200 * DAY).toISOString());
      for (const o of data || []) {
        const arr = byPhone.get(o.customer_phone) ?? [];
        arr.push(o);
        byPhone.set(o.customer_phone, arr);
      }
    }

    const codOk = (price: unknown, cod: number) => {
      const exp = Math.round(Number(price) * MKD_PER_EUR);
      if (!exp) return false;
      return Math.abs(cod - exp) <= 3 || Math.abs(cod - exp - DELIVERY_MKD) <= 3;
    };

    const OPEN_FOR_SHIP = new Set(["pending", "take", "call_again", "confirmed"]);
    for (const s of ships) {
      const target = s.current_status_id === 2 ? "paid"
        : s.current_status_id === 7 ? "returned"
        : "shipped";                       // the parcel exists at the courier
      const when = mexDate(s.last_update_at) ?? new Date();

      // 1. remembered link
      let order = linked.get(s.tracking_id) ?? null;

      // 2. fresh match
      if (!order) {
        const phone = mkE164(s.receiver_phone);
        if (!phone) { bump("no_phone"); continue; }
        const created = mexDate(s.created_at);
        const cod = Math.round(Number(String(s.cod ?? "").replace(/[^\d.]/g, "")) || 0);
        const cands = (byPhone.get(phone) || []).filter((o) =>
          !o.mex_tracking_id
          && created && (created.getTime() - new Date(o.created_at).getTime()) >= -3 * DAY
          && (created.getTime() - new Date(o.created_at).getTime()) <= 75 * DAY);
        const pool = cands.filter((o) => codOk(o.price, cod));
        const chosen = pool.length ? pool : (cands.length === 1 ? cands : []);
        if (!chosen.length) { bump(cands.length ? "ambiguous" : "unmatched"); continue; }
        order = chosen.sort((a, b) =>
          Math.abs(created!.getTime() - new Date(a.created_at).getTime())
          - Math.abs(created!.getTime() - new Date(b.created_at).getTime()))[0];
        order.mex_tracking_id = s.tracking_id;   // consume for this run
        if (!dry) {
          await admin.from("orders").update({ mex_tracking_id: s.tracking_id }).eq("id", order.id);
        }
      }
      stats.matched++;

      if (order.status === target) { bump("unchanged"); continue; }
      if (order.status === "duplicated") { bump("duplicated_conflict"); continue; }
      // `shipped` is a forward-only progress marker: it never overrides a
      // terminal status or `delivered` — those either already settled or the
      // terminal branches above will settle them.
      if (target === "shipped" && !OPEN_FOR_SHIP.has(order.status)) { bump("ship_no_op"); continue; }
      if (dry) { bump(`would_${target}`); continue; }

      const upd: Record<string, unknown> = target === "paid"
        ? {
          status: "paid", paid_at: when.toISOString(),
          cancellation_reason: null, cancellation_reason_notes: null, cancelled_at: null,
          trash_reason: null, trash_reason_notes: null, trashed_at: null,
        }
        : target === "returned"
        ? {
          status: "returned", returned_at: when.toISOString(), paid_at: null,
          cancellation_reason: null, cancellation_reason_notes: null, cancelled_at: null,
          trash_reason: null, trash_reason_notes: null, trashed_at: null,
        }
        : {
          // shipped_at from the courier's own creation stamp, or the NULL-only
          // trigger would date an April parcel today.
          status: "shipped", shipped_at: (mexDate(s.created_at) ?? when).toISOString(),
          cancellation_reason: null, cancellation_reason_notes: null, cancelled_at: null,
          trash_reason: null, trash_reason_notes: null, trashed_at: null,
        };
      const { error: updErr } = await admin.from("orders").update(upd).eq("id", order.id);
      if (updErr) { bump("update_failed"); console.error(`mex-reconcile ${s.tracking_id}:`, updErr.message); continue; }
      await admin.from("order_history").insert({
        order_id: order.id, from_status: order.status, to_status: target,
        changed_by: null, changed_by_name: "System (mex:reconciliation)",
      });
      await admin.from("order_notes").insert({
        order_id: order.id,
        text: target === "paid"
          ? `MEX ${s.tracking_id} delivered ${when.toISOString().slice(0, 10)} — status corrected to paid (was ${order.status}).`
          : target === "returned"
          ? `MEX ${s.tracking_id} returned to sender ${when.toISOString().slice(0, 10)} — status set to returned (was ${order.status}).`
          : `MEX ${s.tracking_id} is with the courier (${s.current_status_id}) — status set to shipped (was ${order.status}).`,
        author_id: null, author_name: "System",
      });
      if (target === "paid") stats.paid_applied++;
      else if (target === "returned") stats.returned_applied++;
      else stats.shipped_applied++;
    }
  } catch (e) {
    return await fail((e as Error).message);
  }

  if (runId) {
    await admin.from("mex_sync_runs").update({
      status: "ok", fetched: stats.fetched, matched: stats.matched,
      paid_applied: stats.paid_applied, returned_applied: stats.returned_applied,
      shipped_applied: stats.shipped_applied,
      skipped: stats.skipped,
      finished_at: new Date().toISOString(), duration_ms: Date.now() - startedMs,
    }).eq("id", runId);
  }
  return json({ ok: true, kind, dry, window: { from: fromDate, to: toDate }, ...stats });
});
