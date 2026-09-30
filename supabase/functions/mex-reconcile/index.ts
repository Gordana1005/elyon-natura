/**
 * mex-reconcile — courier ground truth into Elyon, automatically.
 *
 *   POST /functions/v1/mex-reconcile
 *   header: x-mex-sync-secret: <MEX_SYNC_SECRET>
 *   body:   { kind?: 'rolling'|'backfill'|'manual'|'register', from?: 'YYYY-MM-DD',
 *             dry?: boolean, register_only?: boolean }
 *
 * Called by pg_cron twice an hour, 07:00–20:55 Skopje (gate in
 * invoke_mex_reconcile). Port of scripts/reconcile-mex-shipments.mjs matching —
 * keep the two in step, the same way altercpa.ts mirrors scripts/lib. The pure
 * matching rules live in ./match.ts (tested by match.test.ts).
 *
 * Sweeps BOTH MEX accounts (BIO NATURAL = the Elyon business; NATURA = teleshop
 * and social). Their tracking ids are disjoint, so the two shipment lists merge
 * into one pass. Add/remove an account by setting MEX_API_KEY / MEX_API_KEY_2.
 *
 * 1. REGISTER. Every shipment fetched is upserted into public.mex_parcels —
 *    mex_upsert_parcels(account, raw list_shipments rows), ≤500 per call —
 *    BEFORE any matching, so MEX's side of the ledger exists whether or not an
 *    order matches it. `register_only: true` (or kind 'register') stops there:
 *    no matching, the run is still logged, and it never advances the cursor.
 *
 * 2. MATCH (never guessed):
 *    a. remembered — the order whose mex_tracking_id is this parcel (method
 *       'tracking'). Several holders → the register's link, else the one real
 *       sale, else skipped (tracking_conflict). A holder the register has not
 *       recorded yet is recorded via mex_link_parcel (register_healed).
 *    b. fresh — phone → E.164 (+389, trunk 0 stripped) → unlinked orders in
 *       [−3d … +75d], REAL SALES ONLY (price > 0, a real product name, not
 *       duplicated):
 *         COD = round(price€ × 61.5) or +150 достава (±3 ден) → 'phone_cod',
 *           nearest created date wins;
 *         no COD fit → 'phone_single' only when exactly ONE real sale is on
 *           the phone and it is open (pending/take/call_again/confirmed) or
 *           shipped/delivered;
 *         no COD fit → 'upsell_revive' only when exactly ONE real sale is on
 *           the phone, it is our own 7-day no-parcel cancel ('no_parcel_7d')
 *           of an AlterCPA order, and the parcel is BIO NATURAL series 9110
 *           with a COD > 0 — an upsell at AlterCPA (owner rule 2026-09-28:
 *           a late parcel reopens the 7-day cancel; counted 'upsell_revive');
 *       then linked through mex_link_parcel — never a raw update. 'conflict'
 *       ⇒ skipped (link_conflict). A parcel the register links to an order that
 *       no longer holds it is left alone (register_disagrees), and so is one
 *       with a negative COD — MEX paying money out, not a sale (negative_cod).
 *    Why real sales only: the old fallback took ANY lone candidate — typically
 *    a prediction agent's 0 ден "No prior product on file" cancel — and flipped
 *    it to paid/returned (182 ghost rows by 2026-09-27).
 *
 * 3. APPLY — the truth the 2026-08-11 reconciliation established, with MEX 8 split off
 *    (owner 30.09.2026, the naturatherapy.mk semantics — match.ts targetFor / atMexGate):
 *    8 Shipment created → за пакување: NO status change. A confirmed (or shipped) order gets
 *                       orders.mex_sent_at (the parcel's creation) if NULL; an open one, or a
 *                       cancel rule C would revive, waits for the pickup (then → shipped as
 *                       below). NEVER shipped at 8: the courier has not taken it yet.
 *    4/10/9/1/3/… → shipped  (the courier HAS the parcel —
 *                       forward-only from pending/take/call_again/confirmed.
 *                       Rule C, MEX outranks AlterCPA: also from an AlterCPA
 *                       cancelled/trashed order, or one cancelled 'no_parcel_7d',
 *                       on a 'tracking' or 'phone_cod' link — and from the
 *                       AlterCPA 'no_parcel_7d' cancel an 'upsell_revive' link
 *                       names)
 *    2 Delivered → paid (paid_at = courier time, paid_basis 'mex'; cancel/trash
 *                       reasons cleared — AlterCPA cancels on delivered parcels
 *                       are wrong, proven at 4.184-order scale)
 *    7 Returned  → returned (paid_at removed — the COD was never collected)
 *    'duplicated' orders are never touched, and paid/returned never land on a
 *    zero-value row (price 0 — typically a call disposition a pre-fix run
 *    linked; zero_value_link). Otherwise no ownership guard: money truth from
 *    the courier outranks any status, per the operator decision.
 *    Anything applied → one 'refresh' broadcast on the TV leaderboard channel.
 */
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  COD_TOLERANCE_MKD, DAY, DELIVERY_MKD, MKD_PER_EUR, atMexGate, dedupeShipments, hasSaleValue,
  isNegativeCod, isRegisterOnlyRun, mexDate, mkE164, parseCod, pickCandidate,
  rememberedLinkMethod, resolveHolder, shipGate, targetFor,
} from "./match.ts";
import type { LinkMethod, MexShipment, OrderRow } from "./match.ts";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const MEX_BASE = "https://mex.mk/api/json";
const OVERLAP_DAYS = 2;            // updated_from is date-granular; re-reading is idempotent
const DEFAULT_LOOKBACK_DAYS = 7;
const REGISTER_BATCH = 500;        // mex_upsert_parcels takes ≤ 500 rows per call
const KINDS = ["rolling", "backfill", "manual", "register"];
// What matching reads, on remembered holders and fresh candidates alike. One
// literal on purpose: supabase-js types a select from its literal string.
const ORDER_COLS = "id, status, price, created_at, mex_tracking_id, customer_phone, product_name, source_type, external_source, cancellation_reason, mex_sent_at";

/** A fetched shipment tagged with the account whose list it came from. */
type FetchedShipment = MexShipment & { account: string };

/** TV-board nudge — the same REST broadcast as broadcastLeaderboard in
 * api/index.ts. Best-effort: the board also polls, so a failed send is harmless. */
async function broadcastBoardRefresh(payload: Record<string, unknown>): Promise<void> {
  try {
    const url = Deno.env.get("SUPABASE_URL");
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !key) return;
    const res = await fetch(`${url}/realtime/v1/api/broadcast`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: key, Authorization: `Bearer ${key}` },
      body: JSON.stringify({ messages: [{ topic: "tv-leaderboard", event: "refresh", payload }] }),
    });
    await res.body?.cancel();
  } catch (_e) { /* never fail the run on the broadcast */ }
}

serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const expected = Deno.env.get("MEX_SYNC_SECRET");
  if (!expected) return json({ error: "Not configured" }, 503);
  if ((req.headers.get("x-mex-sync-secret") || "") !== expected) return json({ error: "Forbidden" }, 403);

  // TWO MEX ACCOUNTS (2026-09-18). BIO NATURAL carries the Elyon business —
  // doc series 002-9110 (Нарачка LEADS) and 002-9103 (LEADS-OUT). NATURA carries
  // teleshop and social — 002-9102 (Нарачка out), 002-9100 (Нарачка in), 002-9108
  // (Социјални Мрежи). They are separate contracts with DISJOINT tracking ids
  // (verified: 0 overlap over 15k shipments), so merging their shipment lists is
  // safe and every match below is unambiguous about which parcel it means.
  //
  // Reconciling only the first one left NATURA — the LARGER account — completely
  // unswept: 9.355 shipments and EUR 250.546 of delivered COD invisible to the
  // CRM. MEX_API_KEY_2 is optional so the function still runs if it is unset.
  const mexAccounts = [
    { label: "bio_natural", key: Deno.env.get("MEX_API_KEY") ?? "" },
    { label: "natura",      key: Deno.env.get("MEX_API_KEY_2") ?? "" },
  ].filter((a) => a.key);
  if (!mexAccounts.length) return json({ error: "No MEX API key is set (MEX_API_KEY / MEX_API_KEY_2)" }, 503);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* defaults */ }
  const kind = KINDS.includes(String(body.kind)) ? String(body.kind) : "rolling";
  const dry = body.dry === true;
  // Register-only: fetch + upsert the register, no matching. kind 'register'
  // implies it; any other kind may ask for it and is logged as given.
  const registerOnly = body.register_only === true || kind === "register";

  const admin = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  );
  const startedMs = Date.now();

  // ── cursor: last clean MATCHING run's window_to, minus overlap ────────────
  let fromDate = String(body.from || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDate)) {
    // A register-only run matched nothing: letting its window_to move the
    // cursor would skip every parcel updated since the last matching run.
    const { data: recent } = await admin
      .from("mex_sync_runs").select("window_to, kind, skipped")
      .eq("status", "ok").not("window_to", "is", null)
      .order("window_to", { ascending: false }).limit(50);
    const lastRun = (recent || []).find((r: any) => !isRegisterOnlyRun(r));
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

  const stats = {
    fetched: 0, matched: 0, paid_applied: 0, returned_applied: 0, shipped_applied: 0, at_mex_applied: 0,
    register: { upserted: 0, delivered_new: 0, returned_new: 0, orders_synced: 0 },
    skipped: {} as Record<string, number>,
  };
  const add = (k: string, n: number) => { stats.skipped[k] = (stats.skipped[k] || 0) + n; };
  const bump = (k: string) => add(k, 1);
  const fail = async (msg: string) => {
    if (runId) {
      await admin.from("mex_sync_runs").update({
        status: "failed", error: msg.slice(0, 500),
        finished_at: new Date().toISOString(), duration_ms: Date.now() - startedMs,
      }).eq("id", runId);
    }
    return json({ error: msg }, 502);
  };

  // Raw rows into the register, one account per call. A failure fails the run:
  // every link below needs its parcel row to exist.
  const registerRows = async (account: string, rows: MexShipment[]) => {
    const unique = dedupeShipments(rows);   // one upsert statement can't touch a key twice
    for (let i = 0; i < unique.length; i += REGISTER_BATCH) {
      const { data, error } = await admin.rpc("mex_upsert_parcels", {
        p_account: account, p_rows: unique.slice(i, i + REGISTER_BATCH),
      });
      if (error) throw new Error(`mex_upsert_parcels (${account}): ${error.message}`);
      stats.register.upserted += Number(data?.upserted) || 0;
      stats.register.delivered_new += Number(data?.delivered_new) || 0;
      stats.register.returned_new += Number(data?.returned_new) || 0;
      stats.register.orders_synced += Number(data?.orders_synced) || 0;
    }
  };

  // → 'linked' | 'already' | 'conflict' | 'missing', or 'error' if the call failed.
  // The RPC also writes orders.mex_tracking_id and the orders.mex_* facts.
  const linkParcel = async (tracking: string, orderId: string, method: string): Promise<string> => {
    const { data, error } = await admin.rpc("mex_link_parcel", {
      p_tracking: tracking, p_order: orderId, p_method: method,
    });
    if (error) { console.error(`mex-reconcile link ${tracking}:`, error.message); return "error"; }
    return String(data ?? "");
  };

  try {
    // ── fetch shipments updated in the window, registering every page ───────
    const ships: FetchedShipment[] = [];
    // Per-account cap: one busy account must not starve the other of headroom.
    const cap = kind === "backfill" || kind === "register" ? 30000 : 4000;
    for (const acct of mexAccounts) {
      let fromThis = 0;
      for (let page = 1; ; page++) {
        const url = `${MEX_BASE}/list_shipments.php?updated_from=${fromDate}&per_page=500&page=${page}&order=last_update_asc`;
        const res = await fetch(url, { headers: { AuthKey: acct.key } });
        if (!res.ok) throw new Error(`MEX HTTP ${res.status} (${acct.label})`);
        const j = await res.json();
        if (j?.success !== 1 || !Array.isArray(j.shipments)) {
          throw new Error(`MEX error body (${acct.label}): ${JSON.stringify(j).slice(0, 200)}`);
        }
        const rows = j.shipments as MexShipment[];
        fromThis += rows.length;
        // The account label rides on the in-memory row; the register gets the
        // rows exactly as MEX sent them.
        for (const r of rows) ships.push({ ...r, account: acct.label });
        if (dry) add("would_register", rows.length);
        else await registerRows(acct.label, rows);
        // Rolling runs are incremental and small; a backfill sweep must see the
        // whole window or "never lose an order" is a lie.
        if (page >= Number(j.total_pages || 1) || fromThis >= cap) break;
      }
      stats.skipped[`fetched_${acct.label}`] = fromThis;
    }
    stats.fetched = ships.length;

    if (!registerOnly) {
      // A parcel that moved pages mid-sweep arrives twice; keep its newest row.
      const shipments = dedupeShipments(ships);
      if (shipments.length < ships.length) add("duplicate_rows", ships.length - shipments.length);
      const trackIds = shipments.map((s) => s.tracking_id);

      // ── every order already holding one of these parcels ────────────────
      const holders = new Map<string, OrderRow[]>();
      for (let i = 0; i < trackIds.length; i += 200) {
        const { data, error } = await admin.from("orders").select(ORDER_COLS)
          .in("mex_tracking_id", trackIds.slice(i, i + 200));
        if (error) throw new Error(`orders by tracking id: ${error.message}`);
        for (const o of (data || []) as OrderRow[]) {
          const k = String(o.mex_tracking_id);
          const arr = holders.get(k) ?? [];
          arr.push(o);
          holders.set(k, arr);
        }
      }

      // ── the register's own link for the same parcels ─────────────────────
      // no key = no register row yet (a dry run registers nothing); null = unlinked
      const regLink = new Map<string, string | null>();
      for (let i = 0; i < trackIds.length; i += 200) {
        const { data, error } = await admin.from("mex_parcels").select("tracking_id, order_id")
          .in("tracking_id", trackIds.slice(i, i + 200));
        if (error) throw new Error(`mex_parcels: ${error.message}`);
        for (const p of data || []) regLink.set(String(p.tracking_id), p.order_id ?? null);
      }

      // ── candidates for parcels nobody holds, one query per phone batch ──
      const phones = [...new Set(shipments.filter((s) => !holders.has(s.tracking_id))
        .map((s) => mkE164(s.receiver_phone)).filter(Boolean))] as string[];
      const byPhone = new Map<string, OrderRow[]>();
      for (let i = 0; i < phones.length; i += 100) {
        const { data, error } = await admin.from("orders").select(ORDER_COLS)
          .in("customer_phone", phones.slice(i, i + 100))
          .neq("status", "duplicated")
          .gte("created_at", new Date(Date.now() - 200 * DAY).toISOString());
        if (error) throw new Error(`candidate orders: ${error.message}`);
        for (const o of (data || []) as OrderRow[]) {
          const k = String(o.customer_phone);
          const arr = byPhone.get(k) ?? [];
          arr.push(o);
          byPhone.set(k, arr);
        }
      }

      for (const s of shipments) {
        const target = targetFor(s.current_status_id);
        const when = mexDate(s.last_update_at) ?? new Date();
        const reg = regLink.get(s.tracking_id);
        let order: OrderRow;
        let method: LinkMethod;

        const held = holders.get(s.tracking_id);
        if (held?.length) {
          // 1. remembered link — decided once, never re-derived
          if (held.length > 1) bump("tracking_shared");   // a ghost double, for the repair
          const r = resolveHolder(held, reg);
          if ("skip" in r) { bump(r.skip); continue; }
          order = r.order;
          method = "tracking";
          if (!reg) {
            // Linked before the register existed, or by a writer that bypassed
            // it: record it so mex_parcels and the order's mex_* facts agree.
            if (dry) bump("would_register_heal");
            else {
              const res = await linkParcel(s.tracking_id, order.id, rememberedLinkMethod(order));
              bump(res === "linked" || res === "already" ? "register_healed" : `register_heal_${res || "unknown"}`);
            }
          }
        } else {
          // The register links this parcel to an order that no longer holds it
          // (re-sent under a new parcel, or unlinked by hand): an old parcel
          // must neither drive that order nor be re-matched to a sibling.
          if (reg) { bump("register_disagrees"); continue; }

          // 2. fresh match — real sales only (see match.ts pickCandidate)
          if (isNegativeCod(s.cod)) { bump("negative_cod"); continue; }   // money out, not a sale
          const phone = mkE164(s.receiver_phone);
          if (!phone) { bump("no_phone"); continue; }
          // `s` carries the account and tracking id the upsell revive needs.
          const pick = pickCandidate(byPhone.get(phone) || [], parseCod(s.cod), mexDate(s.created_at), s);
          if ("skip" in pick) { bump(pick.skip); continue; }
          order = pick.order;
          method = pick.method;
          if (method === "phone_single") bump("fallback_single");
          if (method === "upsell_revive") bump("upsell_revive");
          if (!dry) {
            const res = await linkParcel(s.tracking_id, order.id, method);
            if (res !== "linked" && res !== "already") {
              order.mex_tracking_id = s.tracking_id;   // don't offer it again this run
              bump(res === "conflict" ? "link_conflict" : `link_${res || "unknown"}`);
              continue;
            }
          }
          order.mex_tracking_id = s.tracking_id;     // consume for this run
        }
        stats.matched++;

        // Passive telemetry: the courier's COD vs the order total (±3 ден, with
        // or without the 150 ден delivery fee). A rising counter means sizes are
        // drifting again — the AlterCPA resize sync should be catching them.
        {
          const cod = parseCod(s.cod);
          if (cod > 0 && order.price != null) {
            const exp = Math.round(Number(order.price) * MKD_PER_EUR);
            if (exp > 0 && Math.abs(cod - exp) > COD_TOLERANCE_MKD
              && Math.abs(cod - exp - DELIVERY_MKD) > COD_TOLERANCE_MKD) bump("cod_mismatch");
          }
        }

        // MEX 8 "Shipment created" = за пакување (owner 30.09.2026): the parcel exists but no
        // driver has it, so the order is confirmed — never shipped — until 4/10/9/1/3 arrives.
        // Never a status change at 8 (match.ts atMexGate): a confirmed / shipped order only gets
        // mex_sent_at; an open or cancelled one waits for the pickup, when shipGate moves it.
        if (target === "at_mex") {
          const gate = atMexGate(order, method);
          if (gate === "wait_pickup") { bump("at_mex_waits_for_pickup"); continue; }
          if (!gate) { bump("at_mex_no_op"); continue; }
          if (order.mex_sent_at) { bump("unchanged"); continue; }
          if (dry) { bump("would_stamp_mex_sent_at"); continue; }
          const sentAt = (mexDate(s.created_at) ?? when).toISOString();
          const { error: stampErr } = await admin.from("orders").update({ mex_sent_at: sentAt })
            .eq("id", order.id).is("mex_sent_at", null);
          if (stampErr) { bump("update_failed"); console.error(`mex-reconcile stamp ${s.tracking_id}:`, stampErr.message); continue; }
          order.mex_sent_at = sentAt;
          stats.at_mex_applied++;
          continue;
        }

        if (order.status === target) { bump("unchanged"); continue; }
        if (order.status === "duplicated") { bump("duplicated_conflict"); continue; }
        // Courier MONEY truth never lands on a price-0 row. Fresh matching can no
        // longer pick one, but pre-fix runs linked parcels to /calls dispositions
        // (7 still-cancelled ones held in-flight parcels on 2026-09-27 — each a
        // ghost paid on delivery). `shipped` carries no money and passes: a
        // disposition is cancelled/trashed, which shipGate refuses anyway.
        if (target !== "shipped" && !hasSaleValue(order)) { bump("zero_value_link"); continue; }
        // `shipped` is a forward-only progress marker: it never overrides a
        // terminal status or `delivered` — those either already settled or the
        // terminal branches will settle them. Rule C is the one exception.
        let ruleC = false;
        if (target === "shipped") {
          const gate = shipGate(order, method);
          if (!gate) { bump("ship_no_op"); continue; }
          ruleC = gate === "rule_c";
          if (ruleC) bump("rule_c");
        }
        if (dry) { bump(`would_${target}`); continue; }

        const cleared = {
          cancellation_reason: null, cancellation_reason_notes: null, cancelled_at: null,
          trash_reason: null, trash_reason_notes: null, trashed_at: null,
        };
        const upd: Record<string, unknown> = target === "paid"
          // paid_basis explicitly: a NULL basis on a paid write is stamped
          // 'manual' by the DB trigger.
          ? { status: "paid", paid_at: when.toISOString(), paid_basis: "mex", ...cleared }
          : target === "returned"
          ? { status: "returned", returned_at: when.toISOString(), paid_at: null, ...cleared }
          : {
            // shipped_at from the courier's own creation stamp, or the NULL-only
            // trigger would date an April parcel today.
            status: "shipped", shipped_at: (mexDate(s.created_at) ?? when).toISOString(), ...cleared,
            mex_sent_at: order.mex_sent_at ?? (mexDate(s.created_at) ?? when).toISOString(),
          };
        const { error: updErr } = await admin.from("orders").update(upd).eq("id", order.id);
        if (updErr) { bump("update_failed"); console.error(`mex-reconcile ${s.tracking_id}:`, updErr.message); continue; }
        const was = order.status;
        order.status = target;
        await admin.from("order_history").insert({
          order_id: order.id, from_status: was, to_status: target,
          changed_by: null, changed_by_name: "System (mex:reconciliation)",
        });
        const how = method === "phone_cod" ? " Linked by phone + COD."
          : method === "phone_single" ? " Linked by phone (the only open sale; COD differs)."
          : method === "upsell_revive"
          ? " Linked by phone (the only sale on it; BIO NATURAL 9110, COD differs from the price — an upsell)."
          : "";
        const overruled = !ruleC ? ""
          : order.cancellation_reason === "no_parcel_7d" && was === "cancelled"
          ? " The parcel exists, so the 7-day no-parcel cancel no longer holds."
          : ` The courier outranks the AlterCPA ${was === "trashed" ? "trash" : "cancel"}.`;
        await admin.from("order_notes").insert({
          order_id: order.id,
          text: (target === "paid"
            ? `MEX ${s.tracking_id} delivered ${when.toISOString().slice(0, 10)} — status corrected to paid (was ${was}).`
            : target === "returned"
            ? `MEX ${s.tracking_id} returned to sender ${when.toISOString().slice(0, 10)} — status set to returned (was ${was}).`
            : `MEX ${s.tracking_id} is with the courier (${s.current_status_id}) — status set to shipped (was ${was}).`
              + overruled)
            + how,
          author_id: null, author_name: "System",
        });
        if (target === "paid") stats.paid_applied++;
        else if (target === "returned") stats.returned_applied++;
        else stats.shipped_applied++;
      }
    }
  } catch (e) {
    return await fail((e as Error).message);
  }

  if (!dry && stats.paid_applied + stats.returned_applied + stats.shipped_applied > 0) {
    await broadcastBoardRefresh({
      source: "mex-reconcile",
      paid: stats.paid_applied, returned: stats.returned_applied, shipped: stats.shipped_applied,
    });
  }

  // Register counters ride in the skipped jsonb next to fetched_<account> (no
  // dedicated columns); the marker keeps register-only runs off the cursor.
  if (!dry) {
    add("register_upserted", stats.register.upserted);
    add("register_delivered_new", stats.register.delivered_new);
    add("register_returned_new", stats.register.returned_new);
    add("register_orders_synced", stats.register.orders_synced);
    // MEX 8 (за пакување): orders.mex_sent_at stamps ride in the skipped jsonb (no column for them)
    if (stats.at_mex_applied) add("mex_sent_at_stamped", stats.at_mex_applied);
  }
  if (registerOnly) stats.skipped.register_only = 1;

  if (runId) {
    await admin.from("mex_sync_runs").update({
      status: "ok", fetched: stats.fetched, matched: stats.matched,
      paid_applied: stats.paid_applied, returned_applied: stats.returned_applied,
      shipped_applied: stats.shipped_applied,
      skipped: stats.skipped,
      finished_at: new Date().toISOString(), duration_ms: Date.now() - startedMs,
    }).eq("id", runId);
  }
  return json({ ok: true, kind, dry, register_only: registerOnly, window: { from: fromDate, to: toDate }, ...stats });
});
