/**
 * web-sync — naturatherapy.mk (shop tenant 2) orders into public.web_orders.
 *
 *   POST /functions/v1/web-sync
 *   header: x-web-sync-secret: <WEB_SYNC_SECRET>
 *   body:   {}                                  incremental (pg_cron, every 15 min)
 *           { backfill: true }                  one chunk of a FULL sweep — call again until
 *                                               the response says done: true
 *           { backfill: true, restart: true }   abandon an unfinished sweep, start over
 *           { backfill: true, nightly: true }   pg_cron: continue tonight's sweep, or no-op
 *                                               when one finished in the last 20 h
 *           { dry: true [, backfill: true] }    read + validate one pass, write NOTHING
 *
 * ── Where the data comes from ───────────────────────────────────────────────
 * The shop (D:\naturatherapy\storefront, Supabase kctgthpoeysmhmkrnkil) is a
 * LIVE multi-tenant platform: tenants 1 BG, 2 MK, 3 AL, 4 GR share one
 * production database. The owner approved exactly one thing on it
 * (2026-09-27): schema crm_export exposing tenant-2 orders read-only, and a
 * LOGIN role elyon_crm_reader that can read that export and nothing else
 * (supabase/shop-side/crm_export_tenant2.sql). The export is four late-bound
 * PL/pgSQL functions — mk_orders (by updatedAt, id), mk_orders_by_id,
 * mk_order_items, mk_orders_summary — so it holds NO dependency on any shop
 * column: a shop schema change can only make these calls fail (the run is
 * then 'failed' and visible), never block the shop's own deploy.
 * This function logs in as that role — WEB_SHOP_DB_URL — through the shop's
 * Supavisor pooler, inside READ ONLY transactions. It never writes to the
 * shop, and it refuses any connection string that is not that role on that
 * project (the shop's full-access keys must never be used here).
 *
 * ── Guards ──────────────────────────────────────────────────────────────────
 *   * tenant: every row must carry tenant_slug 'naturatherapy-mk' — one
 *     foreign row aborts the run before anything is written;
 *   * order number: OC-… (legacy OpenCart) or NTMK… (native) — any other row
 *     is NOT written; it is counted in `rejected` (sample in stats) and the
 *     run carries a `warning`. It never blocks the cursor — one odd legacy row
 *     must not stop live orders from flowing. The nightly full sweep re-reads
 *     it, so insights_web_block().sync.rejected_24h stays non-zero until the
 *     pattern is widened (here AND in web_order_number_ok()); the next sweep
 *     then mirrors it;
 *   * web_upsert_orders() re-checks both in SQL and refuses the whole batch.
 *
 * ── Incremental ─────────────────────────────────────────────────────────────
 * Keyset over the shop's (updatedAt, id), cursor = the last ok/partial run's
 * cursor_to_*. An 'ok' (caught-up) cursor is re-read with a 10 min overlap
 * (app-server clocks, transactions committing late); a 'partial' one is
 * continued exactly. Upserts are monotonic on updated_at, so re-reading is
 * free of side effects. The shop's @updatedAt is set by Prisma, so an edit
 * made with raw SQL does not move it — the nightly full sweep catches those,
 * and orders the shop deleted (web_mark_deleted).
 *
 * ── MEX ─────────────────────────────────────────────────────────────────────
 * After each page, and for every unlinked order of the last 60 days at the
 * end of a run, web_link_mex_parcels() links web orders to their parcel in
 * public.mex_parcels (tracking > sender_reference > order number). It reads
 * the register and writes only web_orders — mex_parcels is never touched.
 *
 * Secrets: WEB_SYNC_SECRET (this header), WEB_SHOP_DB_URL (the reader's
 * pooler URL), optional WEB_SHOP_DB_CA (PEM; only needed if the runtime does
 * not trust the Supabase CA — the connection is ALWAYS TLS, never plaintext).
 * Values live in docs/VAULT.md §8; set them with
 *   node scripts/apply-shop-crm-export.mjs --set-function-secrets
 */
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Client } from "https://deno.land/x/postgres@v0.19.3/mod.ts";

const SHOP_REF = "kctgthpoeysmhmkrnkil";
const READER = "elyon_crm_reader";
const TENANT_SLUG = "naturatherapy-mk";
// Same pattern as public.web_order_number_ok() — keep the two in step.
const ORDER_NUMBER_RE = /^(OC-[0-9]{1,12}|NTMK[0-9]{1,12})$/;
// Never a shop: the Elyon CRMs (Macedonia = this project, Bulgaria = live BG).
const FORBIDDEN_REFS = ["bmfxhgznttcnnlqloqzp", "sxymaloycddnoxudxaqp"];

const PAGE = 500;                         // orders per read + per upsert RPC
const MAX_PAGES_INCREMENTAL = 20;         // ≤ 10.000 orders per call
const MAX_PAGES_BACKFILL = 20;            // ≤ 10.000 orders per call (≈ 3 calls for MK)
const TIME_BUDGET_MS = 100_000;           // stop starting new pages after this
const OVERLAP_MS = 10 * 60_000;
const RUNNING_STALE_MS = 10 * 60_000;     // a 'running' row older than this was killed
const SESSION_MAX_AGE_MS = 24 * 3_600_000;
const NIGHTLY_FRESH_MS = 20 * 3_600_000;
const LINK_RECENT_DAYS = 60;
const EPOCH = "1970-01-01T00:00:00.000Z";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** Constant-time string comparison for the shared secret. */
function safeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  const n = Math.max(ea.length, eb.length);
  for (let i = 0; i < n; i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

/** WEB_SHOP_DB_URL → deno-postgres options, or an error naming what is wrong
 * (never the password). Only elyon_crm_reader on the shop project passes. */
function shopConnectionOptions(raw: string | undefined, ca: string | undefined) {
  if (!raw) throw new Error("WEB_SHOP_DB_URL is not set");
  for (const ref of FORBIDDEN_REFS) {
    if (raw.includes(ref)) throw new Error("WEB_SHOP_DB_URL points at an Elyon CRM project, not the shop — refusing");
  }
  let u: URL;
  try { u = new URL(raw); } catch { throw new Error("WEB_SHOP_DB_URL is not a valid URL"); }
  if (u.protocol !== "postgres:" && u.protocol !== "postgresql:") {
    throw new Error("WEB_SHOP_DB_URL must be a postgres:// URL");
  }
  const user = decodeURIComponent(u.username);
  const host = u.hostname.toLowerCase();
  const viaPooler = /^aws-[0-9]+-[a-z0-9-]+\.pooler\.supabase\.com$/.test(host) && user === `${READER}.${SHOP_REF}`;
  const direct = host === `db.${SHOP_REF}.supabase.co` && user === READER;
  if (!viaPooler && !direct) {
    throw new Error(`WEB_SHOP_DB_URL must log in as ${READER} to the shop project ${SHOP_REF} ` +
      `(got user "${user.split(".")[0]}" at ${host}) — refusing`);
  }
  const password = decodeURIComponent(u.password);
  if (!password) throw new Error("WEB_SHOP_DB_URL has no password");
  return {
    hostname: host,
    port: Number(u.port || 5432),
    user,
    password,
    database: decodeURIComponent(u.pathname.replace(/^\//, "")) || "postgres",
    applicationName: "elyon-crm-web-sync",
    connection: { attempts: 1 },
    // Always TLS. enforce: a failed handshake is an ERROR — deno-postgres would
    // otherwise fall back to an unencrypted connection. Deployed Supabase
    // functions trust the Supabase CA; WEB_SHOP_DB_CA is the escape hatch.
    tls: { enabled: true, enforce: true, caCertificates: ca ? [ca] : [] },
  };
}

// ── shop SQL (SELECT only; the role is read-only and so is every transaction)
// Milliseconds: the shop's columns are timestamp(3), so this is exact — and a
// cursor can only ever be rounded DOWN, which re-reads a row, never skips one.
const TS = (c: string) => `to_char((${c}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const ORDER_COLS = `shop_order_id, order_number, tenant_slug, status, payment_method, payment_status,
  total::text AS total, shipping_total::text AS shipping_total, discount_total::text AS discount_total,
  currency, city, phone, source, channel, traffic_source, campaign, discount_code,
  shipping_carrier, shipping_method, tracking_number, tracking_status,
  ${TS("tracking_status_at")} AS tracking_status_at, ${TS("shipped_at")} AS shipped_at,
  ${TS("created_at")} AS created_at, ${TS("updated_at")} AS updated_at`;
const ITEM_COLS = `shop_item_id, shop_order_id, tenant_slug, product_id, variant_id, name, variant_label, sku,
  quantity, price::text AS price, discount_allocated::text AS discount_allocated, kind,
  compare_at_price::text AS compare_at_price`;

// The export is four set-returning functions (no views: a view would pin the
// shop's columns). The keyset filtering, ordering and page limit happen INSIDE
// them; the outer ORDER BY only restates the order the rows arrive in.
const SQL_PROBE = `SELECT orders::int AS n, ${TS("max_updated_at")} AS max_updated_at
  FROM crm_export.mk_orders_summary()`;
const SQL_INCREMENTAL = `SELECT ${ORDER_COLS}
  FROM crm_export.mk_orders($1::timestamptz, $2::int, $3::int)
  ORDER BY updated_at, shop_order_id`;
const SQL_BACKFILL = `SELECT ${ORDER_COLS}
  FROM crm_export.mk_orders_by_id($1::int, $2::int)
  ORDER BY shop_order_id`;
const SQL_ITEMS = `SELECT ${ITEM_COLS}
  FROM crm_export.mk_order_items($1::int[])
  ORDER BY shop_order_id, shop_item_id`;

type ShopOrder = Record<string, unknown> & {
  shop_order_id: number; order_number: string; tenant_slug: string; updated_at: string;
};
type ShopItem = Record<string, unknown> & { shop_item_id: number; shop_order_id: number; tenant_slug: string };
type Cursor = { ts: string; id: number };

const laterOf = (a: Cursor, b: Cursor): Cursor => {
  const ta = Date.parse(a.ts), tb = Date.parse(b.ts);
  return ta > tb || (ta === tb && a.id >= b.id) ? a : b;
};

serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const expected = Deno.env.get("WEB_SYNC_SECRET");
  if (!expected) return json({ error: "Not configured" }, 503);
  if (!safeEqual(req.headers.get("x-web-sync-secret") || "", expected)) return json({ error: "Forbidden" }, 403);

  let shopOpts: ReturnType<typeof shopConnectionOptions>;
  try {
    shopOpts = shopConnectionOptions(Deno.env.get("WEB_SHOP_DB_URL"), Deno.env.get("WEB_SHOP_DB_CA") || undefined);
  } catch (e) {
    return json({ error: (e as Error).message }, 503);
  }

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* defaults */ }
  const backfill = body.backfill === true;
  const nightly = body.nightly === true;
  const restart = body.restart === true;
  const dry = body.dry === true;
  const kind = backfill ? "backfill" : "incremental";

  const admin = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  );
  const startedMs = Date.now();

  // ── housekeeping: a run killed mid-flight (wall-clock limit) stays 'running'
  if (!dry) {
    await admin.from("web_sync_runs").update({
      status: "failed", error: "abandoned — the invocation never finished (timeout or crash)",
      finished_at: new Date().toISOString(),
    }).eq("status", "running").lt("started_at", new Date(Date.now() - RUNNING_STALE_MS).toISOString());

    const { data: busy } = await admin.from("web_sync_runs").select("id")
      .eq("kind", kind).eq("status", "running").limit(1);
    if (busy?.length) return json({ ok: false, skipped: "already_running", kind }, 409);
  }

  // ── plan ────────────────────────────────────────────────────────────────
  let cursorFrom: Cursor = { ts: EPOCH, id: 0 };   // incremental: exclusive start
  let prevCursor: Cursor | null = null;           // incremental: the stored (un-overlapped) cursor
  let session: string | null = null;              // backfill
  let sessionStartedAt: string | null = null;
  let afterId = 0;

  if (backfill) {
    const { data: lastB, error: lbErr } = await admin.from("web_sync_runs")
      .select("status, backfill_session, backfill_session_started_at, backfill_after_id, backfill_done")
      .eq("kind", "backfill").order("started_at", { ascending: false }).limit(1);
    if (lbErr) return json({ error: `web_sync_runs: ${lbErr.message}` }, 500);
    const prev = lastB?.[0];
    // An unfinished sweep (a chunk that ran out of budget, failed, or was
    // killed) resumes from its last recorded shop id; a finished one never does.
    const continuable: boolean = !restart && !!prev && ["partial", "failed"].includes(prev.status) &&
      !prev.backfill_done && !!prev.backfill_session && !!prev.backfill_session_started_at &&
      prev.backfill_after_id != null &&
      Date.now() - Date.parse(prev.backfill_session_started_at) < SESSION_MAX_AGE_MS;

    if (nightly && !restart && !continuable) {
      const { data: done } = await admin.from("web_sync_runs").select("finished_at")
        .eq("kind", "backfill").eq("backfill_done", true)
        .order("finished_at", { ascending: false }).limit(1);
      const lastDone = done?.[0]?.finished_at;
      if (lastDone && Date.now() - Date.parse(lastDone) < NIGHTLY_FRESH_MS) {
        return json({ ok: true, skipped: "nightly_sweep_already_done", last_done_at: lastDone });
      }
    }
    if (continuable) {
      session = prev!.backfill_session;
      sessionStartedAt = prev!.backfill_session_started_at;
      afterId = Number(prev!.backfill_after_id) || 0;
    }
  } else {
    const { data: last, error: lErr } = await admin.from("web_sync_runs")
      .select("status, cursor_to_updated_at, cursor_to_id")
      .in("status", ["ok", "partial"]).not("cursor_to_updated_at", "is", null)
      .order("finished_at", { ascending: false }).limit(1);
    if (lErr) return json({ error: `web_sync_runs: ${lErr.message}` }, 500);
    const c = last?.[0];
    if (c) {
      const at = Date.parse(String(c.cursor_to_updated_at));
      if (!Number.isFinite(at)) {
        return json({ error: `web_sync_runs holds an unreadable cursor (${String(c.cursor_to_updated_at).slice(0, 40)})` }, 500);
      }
      prevCursor = { ts: new Date(at).toISOString(), id: Number(c.cursor_to_id) || 0 };
      cursorFrom = c.status === "partial"
        ? prevCursor
        : { ts: new Date(at - OVERLAP_MS).toISOString(), id: 0 };
    }
  }

  // ── the run row (its DB-clock started_at is a new sweep's session start) ─
  let runId: string | null = null;
  if (!dry) {
    const { data: run, error: runErr } = await admin.from("web_sync_runs").insert({
      kind, status: "running",
      cursor_from_updated_at: backfill ? null : cursorFrom.ts,
      cursor_from_id: backfill ? null : cursorFrom.id,
      backfill_session: session, backfill_session_started_at: sessionStartedAt,
      backfill_after_id: backfill ? afterId : null,
    }).select("id, started_at").single();
    if (runErr || !run) return json({ error: `web_sync_runs insert: ${runErr?.message ?? "no row"}` }, 500);
    runId = run.id;
    if (backfill && !session) {
      session = run.id;
      sessionStartedAt = run.started_at;
      await admin.from("web_sync_runs").update({
        backfill_session: session, backfill_session_started_at: sessionStartedAt,
      }).eq("id", runId);
    }
  }

  const stats = {
    read_orders: 0, read_items: 0, written: 0, new: 0, changed: 0, stale: 0, retired: 0,
    items_upserted: 0, items_deleted: 0, rejected: 0, mex_linked: 0, pages: 0,
  };
  const rejectedSample: string[] = [];
  let cursorTo: Cursor | null = prevCursor;
  let done = false;
  let probe: { n: number; max_updated_at: string | null } | null = null;
  const extra: Record<string, unknown> = {};

  const rejectWarning = () => stats.rejected
    ? `${stats.rejected} shop rows not mirrored (order number not OC-…/NTMK…): ${rejectedSample.slice(0, 5).join(", ")}`
    : null;

  const finish = async (status: string, error: string | null, more: Record<string, unknown> = {}) => {
    if (!runId) return;
    await admin.from("web_sync_runs").update({
      status, error: error ? error.slice(0, 500) : null,
      warning: rejectWarning()?.slice(0, 500) ?? null,
      read_orders: stats.read_orders, read_items: stats.read_items,
      new_orders: stats.new, changed_orders: stats.changed, rejected: stats.rejected,
      mex_linked: stats.mex_linked,
      shop_total_orders: probe?.n ?? null, shop_max_updated_at: probe?.max_updated_at ?? null,
      stats: { ...stats, rejected_sample: rejectedSample, ...extra },
      finished_at: new Date().toISOString(), duration_ms: Date.now() - startedMs,
      ...more,
    }).eq("id", runId);
  };

  const rpc = async (fn: string, args: Record<string, unknown>) => {
    const { data, error } = await admin.rpc(fn, args);
    if (error) throw new Error(`${fn}: ${error.message}`);
    return (data ?? {}) as Record<string, number | string>;
  };

  const shop = new Client(shopOpts);
  try {
    await shop.connect();

    // A consistent read-only snapshot for one page of orders and their lines.
    const readPage = async (sql: string, args: unknown[]) => {
      const tx = shop.createTransaction(`web_sync_page_${stats.pages}`, {
        isolation_level: "repeatable_read", read_only: true,
      });
      await tx.begin();
      try {
        const orders = (await tx.queryObject<ShopOrder>({ text: sql, args })).rows;
        const ids = orders.map((o) => Number(o.shop_order_id));
        const items = ids.length
          ? (await tx.queryObject<ShopItem>({ text: SQL_ITEMS, args: [ids] })).rows
          : [];
        await tx.commit();
        return { orders, items };
      } catch (e) {
        try { await tx.rollback(); } catch { /* already closed by the driver */ }
        throw e;
      }
    };

    // A renamed tenant slug makes the export RAISE; a shop column change makes
    // it fail on call — both land in the catch below as a 'failed' run.
    probe = (await shop.queryObject<{ n: number; max_updated_at: string | null }>(SQL_PROBE)).rows[0];
    if (!probe) throw new Error("crm_export.mk_orders_summary() returned nothing");
    if (probe.n === 0) {
      throw new Error("crm_export reports 0 tenant-2 orders — refusing to sync (export broken?)");
    }

    const maxPages = backfill ? MAX_PAGES_BACKFILL : MAX_PAGES_INCREMENTAL;
    let from: Cursor = cursorFrom;

    while (stats.pages < maxPages && Date.now() - startedMs < TIME_BUDGET_MS) {
      const { orders, items } = backfill
        ? await readPage(SQL_BACKFILL, [afterId, PAGE])
        : await readPage(SQL_INCREMENTAL, [from.ts, from.id, PAGE]);
      stats.pages++;
      if (!orders.length) { done = true; break; }
      stats.read_orders += orders.length;
      stats.read_items += items.length;

      // Tenant guard — hard: one foreign row and nothing of this page is written.
      const foreignOrder = orders.find((o) => o.tenant_slug !== TENANT_SLUG);
      const foreignItem = items.find((i) => i.tenant_slug !== TENANT_SLUG);
      if (foreignOrder || foreignItem) {
        throw new Error(`foreign-tenant row in the shop export (order ${foreignOrder?.order_number ?? foreignItem?.shop_order_id}) — refusing to sync`);
      }

      // Order-number guard — soft: the row is skipped and reported.
      const accepted: ShopOrder[] = [];
      for (const o of orders) {
        if (ORDER_NUMBER_RE.test(String(o.order_number ?? ""))) accepted.push(o);
        else {
          stats.rejected++;
          if (rejectedSample.length < 20) rejectedSample.push(`${o.shop_order_id}:${o.order_number}`);
        }
      }
      const acceptedIds = new Set(accepted.map((o) => Number(o.shop_order_id)));
      const acceptedItems = items.filter((i) => acceptedIds.has(Number(i.shop_order_id)));

      if (!dry && accepted.length) {
        const r = await rpc("web_upsert_orders", {
          p_orders: accepted, p_items: acceptedItems, p_items_complete: true,
        });
        stats.written += Number(r.written) || 0;
        stats.new += Number(r.new) || 0;
        stats.changed += Number(r.changed) || 0;
        stats.stale += Number(r.stale) || 0;
        stats.retired += Number(r.retired) || 0;
        stats.items_upserted += Number(r.items_upserted) || 0;
        stats.items_deleted += Number(r.items_deleted) || 0;
        const l = await rpc("web_link_mex_parcels", { p_ids: [...acceptedIds], p_recent_days: null });
        stats.mex_linked += Number(l.linked) || 0;
      }

      const last = orders[orders.length - 1];
      if (backfill) {
        afterId = Number(last.shop_order_id);
        // Progress survives a killed invocation: the next call resumes here.
        if (runId) {
          await admin.from("web_sync_runs").update({
            backfill_after_id: afterId, read_orders: stats.read_orders, read_items: stats.read_items,
          }).eq("id", runId);
        }
      } else {
        from = { ts: String(last.updated_at), id: Number(last.shop_order_id) };
        cursorTo = cursorTo ? laterOf(cursorTo, from) : from;
      }
      if (orders.length < PAGE) { done = true; break; }
    }
  } catch (e) {
    const msg = (e as Error).message || String(e);
    await finish("failed", msg, backfill ? { backfill_after_id: afterId } : {});
    try { await shop.end(); } catch { /* ignore */ }
    return json({ ok: false, kind, dry, run_id: runId, error: msg, ...stats, rejected_sample: rejectedSample }, 502);
  }
  try { await shop.end(); } catch { /* ignore */ }

  // ── finish ──────────────────────────────────────────────────────────────
  try {
    if (dry) {
      return json({
        ok: true, kind, dry, done, shop: probe, ...stats, rejected_sample: rejectedSample,
        cursor: backfill ? { after_id: afterId } : { from: cursorFrom, to: cursorTo },
      });
    }

    if (backfill) {
      if (!done) {
        await finish("partial", null, { backfill_after_id: afterId });
        return json({
          ok: true, kind, done: false, run_id: runId, session, after_id: afterId,
          next: "call again with {\"backfill\": true} to continue this sweep",
          shop: probe, ...stats, rejected_sample: rejectedSample,
        });
      }

      // The sweep saw every order: retire what the shop no longer has, link
      // every live order, and reset the incremental cursor to the sweep start.
      const mark = await rpc("web_mark_deleted", {
        p_session_started_at: sessionStartedAt, p_shop_count: probe?.n ?? null,
      });
      extra.mark_deleted = mark;
      const link = await rpc("web_link_mex_parcels", { p_ids: null, p_recent_days: null });
      stats.mex_linked += Number(link.linked) || 0;
      extra.link_all = link;

      // Session-wide rejects (earlier chunks of this sweep included).
      const { data: sess } = await admin.from("web_sync_runs").select("rejected")
        .eq("backfill_session", session).neq("id", runId);
      const sessionRejected = stats.rejected + (sess || []).reduce((s: number, r: any) => s + (Number(r.rejected) || 0), 0);
      extra.session_rejected = sessionRejected;

      const cursorAt = new Date(Date.parse(String(sessionStartedAt)) - OVERLAP_MS).toISOString();
      // A tripped deletion guard means the sweep saw far fewer orders than we
      // hold — something is wrong with the export, so the run FAILS loudly.
      const guardError = mark.guard === "tripped"
        ? `deletion guard tripped: ${mark.candidates} of ${mark.live} live orders were not seen by the sweep — nothing marked`
        : null;
      // The closing row of a sweep carries the WHOLE sweep's reject count (the
      // Overview reads the max over recent runs, so this is what it shows).
      stats.rejected = sessionRejected;

      await finish(guardError ? "failed" : "ok", guardError, {
        backfill_after_id: afterId, backfill_done: true,
        marked_deleted: Number(mark.marked) || 0,
        cursor_to_updated_at: cursorAt, cursor_to_id: 0,
      });
      return json({
        ok: !guardError, kind, done: true, run_id: runId, session, error: guardError ?? undefined,
        warning: rejectWarning() ?? undefined, session_rejected: sessionRejected,
        shop: probe, marked_deleted: mark, ...stats, rejected_sample: rejectedSample,
      });
    }

    // Incremental: parcels often reach the register after the order reached
    // us — retry the link for every recent unlinked order.
    const link = await rpc("web_link_mex_parcels", { p_ids: null, p_recent_days: LINK_RECENT_DAYS });
    stats.mex_linked += Number(link.linked) || 0;
    extra.link_recent = link;

    // Rejected rows never hold the cursor back (see the header).
    const status = done ? "ok" : "partial";
    await finish(status, null, cursorTo
      ? { cursor_to_updated_at: cursorTo.ts, cursor_to_id: cursorTo.id }
      : {});
    return json({
      ok: true, kind, status, run_id: runId, done,
      cursor: { from: cursorFrom, to: cursorTo }, shop: probe, ...stats,
      rejected_sample: rejectedSample, warning: rejectWarning() ?? undefined,
    });
  } catch (e) {
    const msg = (e as Error).message || String(e);
    await finish("failed", msg, backfill ? { backfill_after_id: afterId } : {});
    return json({ ok: false, kind, run_id: runId, error: msg, ...stats }, 502);
  }
});
