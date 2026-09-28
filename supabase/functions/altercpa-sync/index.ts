/**
 * altercpa-sync — pull leads from AlterCPA into Elyon.
 *
 *   POST /functions/v1/altercpa-sync
 *   header: x-altercpa-sync-secret: <ALTERCPA_SYNC_SECRET>
 *   body:   { account?: string,
 *             kind?: 'rolling'|'nightly'|'weekly'|'backfill'|'manual'|'status'|'continue',
 *             from?: <ISO or epoch s>, to?: <ISO or epoch s>, dry?: boolean,
 *             limit?: number }   // status only: cap on candidates per run (default 2000)
 *
 * Called by pg_cron every 2 minutes (rolling), nightly and weekly (sweeps),
 * every 5 minutes 07:00–20:55 Skopje ('status' — resolves imported pendings
 * whose AlterCPA copy has been decided), and by an admin for backfills.
 *
 * ── Sweeps are resumable (2026-09-28) ───────────────────────────────────────
 * 'nightly' (7 d) and 'weekly' (90 d) OPEN a sweep (altercpa_sweeps) and work
 * it in day chunks for at most 100 s; 'continue' — posted by the
 * altercpa-sync-continue cron only while a sweep is open and not leased —
 * works the open one on from its cursor. Every invocation writes its own run
 * row, ok once its chunks are written, until the cursor passes the window.
 * The per-lead work is exactly the rolling kind's; only the reads are batched
 * per page. A DRY nightly/weekly is still the one-shot preview. See sweep.ts
 * and 20260940000100_altercpa_sweep_resume.sql.
 *
 * ── Why a separate function and not another route in api/index.ts ───────────
 * That file is ~15.500 lines and 784 KB and serves every interactive request in
 * the CRM. This is a batch job with a different failure profile: it fans out to
 * a third-party API, can run for tens of seconds, and must be redeployable
 * without shipping the live API. It also needs none of api's auth machinery —
 * its only caller is cron, holding a shared secret.
 *
 * ── The rule that shapes everything ─────────────────────────────────────────
 * EVERY record is written to altercpa_leads. Only records whose geo is in the
 * account's callable_geos are ALSO written to public.orders. Foreign traffic is
 * mirrored and reported on, never called — which is what keeps it away from
 * normalizeMkPhone, from the segment engine, and from every calling queue.
 *
 * Nothing is ever sent back to AlterCPA. Mirrored orders get no affiliate_leads
 * row, so the postback trigger has nothing to fire on.
 *
 * ── What AlterCPA may decide here: confirmed or dead, nothing physical ─────
 * Every write path — the insert, the rolling/sweep apply and the status kind —
 * maps their record through resolveRemoteOutcome (B′, 2026-08-11 doctrine):
 * pending | confirmed | cancelled | trashed. shipped, delivered, paid and
 * returned are MEX's alone (mex-reconcile); AlterCPA never moves this account
 * past status 6 "Packing", even for parcels MEX delivered. Until 2026-09-27
 * the insert path used the history table instead (phase 3 → paid), and the
 * 2026-09-18 import_scope='all' backfill created 1.344 orders directly as
 * paid, ~345 of them with no parcel at all.
 */
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  AlterCpaOrder, PHASE, REASON, STATUS_LABEL,
  CRM_STATUS_RANK, CRM_TERMINAL, resolveRemoteOutcome, forwardOutcome, insertStatusFor,
  outcomeColumns, cancelOtherConfirmedNote, guardedOutcomeNote,
  fetchByIds, fetchWindow, isTestOrder, normalizeMkGeo, normalizePhoneForGeo,
  productNameOf, quantityOf, toEur,
} from "./altercpa.ts";
import {
  SWEEP_BUDGET_MS, SWEEP_DAYS, SWEEP_LEASE_SEC, SWEEP_MIN_CHUNK_MS, SweepIo, SweepRun, SweepStatus,
  eachLimit, isSweepRequest, runSweep, sweepWindow,
} from "./sweep.ts";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

/** Overlap on the rolling window: re-reading a few minutes is free (the upsert
 * is idempotent) and it absorbs clock skew plus anything in flight when the
 * previous run took its snapshot. */
const ROLLING_OVERLAP_MIN = 45;

/** Ledger UPDATEs a sweep page sends at once (see flushLedgerWrites). */
const SWEEP_WRITE_CONCURRENCY = 8;

const s = (v: unknown, max = 300) => (v == null ? "" : String(v).trim().slice(0, max));
const epoch = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  if (Number.isFinite(n) && n > 1_000_000_000) return Math.floor(n);
  const d = new Date(String(v));
  return isNaN(d.getTime()) ? null : Math.floor(d.getTime() / 1000);
};
const isoOf = (sec: number) => new Date(sec * 1000).toISOString();

/**
 * Nudge the TV leaderboard and the agent dashboards after a run that changed
 * orders — the same minimal REST broadcast as broadcastLeaderboard in
 * api/index.ts (channel 'tv-leaderboard', event 'refresh'; both listeners
 * ignore the payload and just refetch). Best-effort: the board also polls, so
 * a failure must never fail the sync. Bounded, because the status kind runs
 * against a 110s budget under the gateway's ~150s cut-off.
 */
async function broadcastBoardRefresh(payload: Record<string, unknown>): Promise<void> {
  try {
    const url = Deno.env.get("SUPABASE_URL");
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !key) return;
    const res = await fetch(`${url}/realtime/v1/api/broadcast`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: key, Authorization: `Bearer ${key}` },
      body: JSON.stringify({ messages: [{ topic: "tv-leaderboard", event: "refresh", payload }] }),
      signal: AbortSignal.timeout(5000),
    });
    await res.body?.cancel();
  } catch (_e) { /* never fail a sync on the broadcast */ }
}

serve(async (req: Request) => {
  // A sweep's budget runs from here: the wall clock is per invocation.
  const invokedMs = Date.now();
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const expected = Deno.env.get("ALTERCPA_SYNC_SECRET");
  if (!expected) {
    console.error("ALTERCPA_SYNC_SECRET not set — refusing to run (fail-closed).");
    return json({ error: "Not configured" }, 503);
  }
  if ((req.headers.get("x-altercpa-sync-secret") || "") !== expected) {
    return json({ error: "Forbidden" }, 403);
  }

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* empty body = rolling, all accounts */ }

  const kind = s(body.kind, 20) || "rolling";
  if (!["rolling", "nightly", "weekly", "backfill", "manual", "status", "continue"].includes(kind)) {
    return json({ error: `Unknown kind '${kind}'` }, 400);
  }
  const dry = body.dry === true;
  if (kind === "continue" && dry) {
    return json({ error: "kind 'continue' works an open sweep; there is nothing to preview" }, 400);
  }
  const limitRaw = Number(body.limit);
  // Default 2000: the 500 cap + created_remote ASC starved every pending after
  // 2026-08-20 08:25 UTC — confirmed/shipped filled the window and never left
  // STATUS_OPEN. Hard max stays 2000 (altercpaSyncSchema).
  const limit = Number.isFinite(limitRaw) && limitRaw >= 1 ? Math.min(Math.floor(limitRaw), 2000) : 2000;

  const admin = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  );

  // Nightly/weekly have been dying mid-sweep since 2026-08-10 (edge wall-clock)
  // and leaving status='running' forever. pg_cron still reports success because
  // invoke_altercpa_sync is fire-and-forget. Mark those failed so the run log
  // stops looking healthy.
  if (!dry) {
    await admin.from("altercpa_sync_runs")
      .update({
        status: "failed",
        error: "stale: still running after 10 minutes (edge function likely timed out)",
        finished_at: new Date().toISOString(),
      })
      .eq("status", "running")
      .lt("started_at", new Date(Date.now() - 10 * 60 * 1000).toISOString());
  }

  const accountRef = s(body.account, 200);
  let q = admin.from("altercpa_accounts").select("*").eq("is_active", true);
  if (accountRef) q = q.eq("name", accountRef);
  const { data: accounts, error: accErr } = await q;
  if (accErr) return json({ error: `accounts: ${accErr.message}` }, 500);
  if (!accounts?.length) return json({ error: "No active AlterCPA account matched" }, 404);

  const sweep = isSweepRequest(kind, dry);
  const results = [];
  for (const account of accounts) {
    try {
      results.push(kind === "status"
        ? await syncStatusAccount(admin, account, dry, limit)
        : sweep
          ? await syncSweepAccount(admin, account, kind, body, invokedMs + SWEEP_BUDGET_MS)
          : await syncAccount(admin, account, kind, body, dry));
    } catch (e) {
      console.error(`altercpa-sync: account ${account.name} failed:`, (e as Error).message);
      results.push({ account: account.name, status: "failed", error: (e as Error).message });
    }
  }
  return json({ ok: true, dry, kind, results });
});

async function syncAccount(
  admin: SupabaseClient,
  account: Record<string, any>,
  kind: string,
  body: Record<string, unknown>,
  dry: boolean,
) {
  const startedMs = Date.now();

  const token = Deno.env.get(account.token_secret_name);
  if (!token) {
    // Named explicitly: "secret missing" and "wrong token" look identical from
    // the API's error body, and this is the one of the two we can detect.
    throw new Error(`Secret ${account.token_secret_name} is not set on this function`);
  }

  // ── window ────────────────────────────────────────────────────────────────
  const nowSec = Math.floor(Date.now() / 1000);
  let from = epoch(body.from);
  let to = epoch(body.to) ?? nowSec;

  if (from == null) {
    if (kind === "rolling") {
      const last = account.last_synced_at ? Math.floor(new Date(account.last_synced_at).getTime() / 1000) : null;
      // First ever rolling run has no high-water mark. Take one day, not "since
      // sync_from" — a cold start must not silently become an unattended
      // multi-year backfill on a 2-minute cron.
      from = last ? last - ROLLING_OVERLAP_MIN * 60 : nowSec - 86400;
    } else if (SWEEP_DAYS[kind]) {
      from = nowSec - SWEEP_DAYS[kind] * 86400;
    } else {
      throw new Error(`kind '${kind}' requires an explicit from`);
    }
  }
  // A backfill may not reach further back than the account allows.
  if (account.sync_from) {
    const floor = Math.floor(new Date(account.sync_from).getTime() / 1000);
    if (from < floor) from = floor;
  }
  if (to <= from) throw new Error(`empty window: ${isoOf(from)} → ${isoOf(to)}`);

  // ── run log opened BEFORE the fetch, so a run that dies mid-flight is
  // visible as 'running' rather than leaving no trace at all. ───────────────
  let runId: string | null = null;
  if (!dry) {
    const { data: run } = await admin.from("altercpa_sync_runs").insert({
      account_id: account.id,
      kind,
      window_from: isoOf(from),
      window_to: isoOf(to),
      status: "running",
    }).select("id").single();
    runId = run?.id ?? null;
  }

  const splits: string[] = [];
  let rows: AlterCpaOrder[];
  try {
    rows = await fetchWindow(account.api_base, token, from, to, 0, (m) => splits.push(m));
  } catch (e) {
    if (runId) {
      await admin.from("altercpa_sync_runs").update({
        status: "failed", error: (e as Error).message,
        finished_at: new Date().toISOString(), duration_ms: Date.now() - startedMs,
      }).eq("id", runId);
    }
    throw e;
  }

  const leadRun = await openLeadRun(admin, account, rows.length);
  const { stats, offerMap, newOfferSightings } = leadRun;
  const preview: unknown[] = [];

  for (const o of rows) {
    const { geo, offerName, phase, priceEur, skip, mapping, ledgerRow } = buildLead(leadRun, o);

    if (dry) {
      // Rows that WOULD be written come first and are never crowded out. A
      // preview that fills up with skipped rows answers the least interesting
      // question — the point of a dry run is to see what is about to change.
      if (skip === null || preview.length < 25) {
        preview.push({
          altercpa_id: ledgerRow.altercpa_id, geo, offer: offerName,
          phase, phase_label: phase ? PHASE[phase] : null,
          reason_label: REASON[ledgerRow.reason ?? 0] ?? null,
          price_raw: ledgerRow.price_raw, currency: ledgerRow.currency_raw, price_eur: priceEur,
          skip_reason: skip,
          would_write_order: skip === null,
          // What an INSERT would create. An order that already exists goes
          // through applyOutcomeToExistingOrder instead (forward-only B′).
          would_be_status: skip === null ? insertStatusFor(o) : null,
        });
      }
      continue;
    }

    const written = await upsertLead(admin, account, ledgerRow, o, mapping, stats);
    if (written === "new") stats.ledger_new++;
    else if (written === "updated") stats.ledger_updated++;
  }

  if (!dry) await recordSightings(admin, leadRun);

  if (dry) {
    return {
      account: account.name, status: "ok", dry: true,
      window: { from: isoOf(from), to: isoOf(to) },
      splits, ...stats, preview,
      offers_seen: [...newOfferSightings.values()]
        .sort((a, b) => b.n - a.n)
        .map((v) => ({ geo: v.geo, offer: v.name, n: v.n, mapped: !!offerMap.get(`${v.geo}|${v.name.trim().toLowerCase()}`)?.product_id })),
    };
  }

  // Advance the high-water mark ONLY on a clean rolling/sweep run. A backfill
  // must never move it forward — it looks at the past, and moving the cursor
  // would skip everything between the backfill's end and now. (A written
  // nightly/weekly is a sweep now: syncSweepAccount moves it, forward only,
  // when the sweep completes. Here they only ever arrive dry.)
  if (kind === "rolling") {
    await admin.from("altercpa_accounts")
      .update({ last_synced_at: isoOf(to), last_cursor_to: isoOf(to) })
      .eq("id", account.id);
  }

  if (runId) {
    await admin.from("altercpa_sync_runs").update({
      status: "ok",
      fetched: stats.fetched,
      ledger_new: stats.ledger_new,
      ledger_updated: stats.ledger_updated,
      orders_created: stats.orders_created,
      orders_updated: stats.orders_updated,
      skipped: stats.skipped,
      error: splits.length ? `windows split: ${splits.length}` : null,
      finished_at: new Date().toISOString(),
      duration_ms: Date.now() - startedMs,
    }).eq("id", runId);
  }

  if (stats.orders_created > 0 || stats.orders_updated > 0) {
    await broadcastBoardRefresh({
      source: "altercpa-sync", kind,
      orders_created: stats.orders_created, orders_updated: stats.orders_updated,
    });
  }

  return {
    account: account.name, status: "ok",
    window: { from: isoOf(from), to: isoOf(to) },
    splits, ...stats,
    offers_seen: newOfferSightings.size,
  };
}

/**
 * What a windowed run carries from one lead to the next — a rolling, backfill
 * or manual run, a dry preview, one invocation of a sweep: the account's rules,
 * the offer map, the counters and the sighting tallies.
 */
interface LeadRun {
  account: Record<string, any>;
  callable: Set<string>;
  importScope: string;
  offerMap: Map<string, any>;
  stats: {
    fetched: number; ledger_new: number; ledger_updated: number;
    orders_created: number; orders_updated: number;
    skipped: Record<string, number>;
  };
  newOfferSightings: Map<string, { geo: string; name: string; n: number }>;
  newWebmasterSightings: Map<string, number>;
}

async function openLeadRun(
  admin: SupabaseClient,
  account: Record<string, any>,
  fetched: number,
): Promise<LeadRun> {
  // Offer map, loaded once. Keyed the same way the unique index is: lowercased,
  // trimmed — the historical map needed byte-identical names and a stray double
  // space silently broke the link.
  const { data: mapRows } = await admin
    .from("altercpa_offer_map").select("*").eq("account_id", account.id);
  const offerMap = new Map<string, any>();
  for (const m of mapRows || []) {
    offerMap.set(`${String(m.geo).toUpperCase()}|${String(m.offer_name).trim().toLowerCase()}`, m);
  }
  return {
    account,
    callable: new Set<string>((account.callable_geos || []).map((g: string) => String(g).toUpperCase())),
    importScope: String(account.import_scope || "pending_only"),
    offerMap,
    stats: {
      fetched, ledger_new: 0, ledger_updated: 0,
      orders_created: 0, orders_updated: 0,
      skipped: {} as Record<string, number>,
    },
    newOfferSightings: new Map<string, { geo: string; name: string; n: number }>(),
    // Same idea for affiliates: their API has no directory endpoint, so an
    // affiliate we have never seen would otherwise show up as a bare number on
    // /orders with nothing anywhere prompting anyone to name it.
    newWebmasterSightings: new Map<string, number>(),
  };
}

/**
 * One AlterCPA record → its ledger row, and why it is NOT an order (skip null:
 * it is, or should be). Decided here and nowhere else — every windowed kind
 * calls it once per lead, a sweep page included — so a sweep writes exactly
 * what the rolling kind would. Counts the skip and the offer/affiliate
 * sightings.
 */
function buildLead(run: LeadRun, o: AlterCpaOrder) {
  const { account, callable, importScope, offerMap, stats, newOfferSightings, newWebmasterSightings } = run;
  const geo = s(o.country, 8).toUpperCase();
  const offerName = productNameOf(o) || "(blank)";
  const offerKey = `${geo}|${offerName.trim().toLowerCase()}`;
  const qty = quantityOf(o);
  const priceEur = toEur(o.price, o.currency);
  const phase = Number(o.phase) || null;

  // Always resolve the number to ITS OWN country's E.164 — a Romanian lead
  // must read +40…, never +389…. An unrecognised geo yields null and
  // phone_raw carries the truth; nothing is ever prefixed with a country code
  // that is not the lead's own.
  const phoneE164 = normalizePhoneForGeo(o.phone, geo);

  // Decide skip_reason; the ledger row is written either way.
  let skip: string | null = null;
  if (isTestOrder(o)) skip = "test_order";
  else if (!callable.has(geo)) skip = "geo_not_callable";
  // PENDINGS ONLY (the default). AlterCPA's own operators work their queue:
  // an order already approved, cancelled or trashed there has been decided,
  // and importing it would drop a finished order into our pipeline — for
  // phase 3, a sale our agents never made, straight into the to-ship queue
  // as confirmed (insertStatusFor; it can no longer arrive as paid). We take
  // the leads that are still open and decide them ourselves. Everything else
  // stays in the ledger, fully visible in reports, just not in the calling
  // queue.
  else if (importScope === "pending_only" && phase != null && phase !== 1 && phase !== 2) {
    skip = "not_pending";
  }
  else if (!phoneE164) skip = "no_phone";

  // Every sighting is counted, mapped or not, callable geo or not. seen_count
  // is then the true volume per offer, which is both how an admin picks what
  // to map first and how you see which offers a new country actually runs.
  const seen = newOfferSightings.get(offerKey);
  if (seen) seen.n++;
  else newOfferSightings.set(offerKey, { geo, name: offerName, n: 1 });

  if (o.wm != null) {
    const wmKey = String(o.wm);
    newWebmasterSightings.set(wmKey, (newWebmasterSightings.get(wmKey) || 0) + 1);
  }

  const mapping = offerMap.get(offerKey);
  if (skip === null) {
    // An offer with no row, an explicitly ignored one, and one still awaiting
    // a product all mean the same thing here: mirror it, do not invent an
    // order for it. Importing with product_id = NULL instead would make the
    // order invisible to every product report and to stock, with nothing to
    // surface the gap.
    if (!mapping || mapping.is_ignored || !mapping.product_id) skip = "unmapped_offer";
    else if (priceEur == null) skip = "no_fx_rate";
  }

  if (skip) stats.skipped[skip] = (stats.skipped[skip] || 0) + 1;

  const ledgerRow = {
    account_id: account.id,
    altercpa_id: String(o.id),
    geo: geo || null,
    offer_name: offerName,
    offer_ext_id: o.offer != null ? String(o.offer) : null,
    product_id: mapping?.product_id ?? null,
    webmaster: o.wm != null ? String(o.wm) : null,
    phase,
    status: Number(o.status) || null,
    reason: Number(o.reason) || 0,
    created_remote: o.time ? isoOf(Number(o.time)) : null,
    phone_raw: s(o.phone, 60) || null,
    phone_e164: phoneE164,
    customer_name: s(o.name, 200) || null,
    city: s(o.city, 200) || null,
    price_raw: Number(o.price) || 0,
    currency_raw: s(o.currency, 10).toLowerCase() || null,
    price_eur: priceEur,
    quantity: qty,
    payload: o as unknown as Record<string, unknown>,
    skip_reason: skip,
    last_seen_at: new Date().toISOString(),
  };

  return { geo, offerName, phase, priceEur, skip, mapping, ledgerRow };
}

async function recordSightings(admin: SupabaseClient, run: LeadRun) {
  const { account, newOfferSightings, newWebmasterSightings } = run;

  // ── record newly-seen offers so the admin queue is self-populating ────────
  // Via RPC rather than a PostgREST upsert: uniqueness is on a normalized key,
  // and seen_count has to ACCUMULATE. An upsert with ignoreDuplicates would
  // freeze the count at the first batch, and that count is what an admin sorts
  // by to decide which unmapped offer to map first.
  if (newOfferSightings.size) {
    for (const v of newOfferSightings.values()) {
      const { error: mapErr } = await admin.rpc("altercpa_record_offer_sighting", {
        _account_id: account.id,
        _geo: v.geo || "??",
        _offer_name: v.name,
        _n: v.n,
      });
      if (mapErr) console.error("altercpa-sync: offer sighting:", mapErr.message);
    }
  }

  // ── and the affiliates, so the naming queue is self-populating too ────────
  // A sighting never touches `name` — the sync discovers affiliates, humans name
  // them, and a re-sighting must not undo an admin's correction.
  if (newWebmasterSightings.size) {
    for (const [wmId, n] of newWebmasterSightings) {
      const { error: wmErr } = await admin.rpc("altercpa_record_webmaster_sighting", {
        _account_id: account.id,
        _wm_id: wmId,
        _n: n,
      });
      if (wmErr) console.error("altercpa-sync: webmaster sighting:", wmErr.message);
    }
  }
}

/**
 * Upsert the ledger row, then promote it to an order when it is callable.
 * Returns 'new' | 'updated'.
 *
 * `page` is a sweep's batched context (processSweepPage): the three reads
 * below come from its prefetch instead of one round-trip each, and the ledger
 * write is queued for flushLedgerWrites. Every decision is the same code either
 * way; rolling, backfill and manual pass no page and run exactly as before.
 */
async function upsertLead(
  admin: SupabaseClient,
  account: Record<string, any>,
  row: Record<string, any>,
  o: AlterCpaOrder,
  mapping: any,
  stats: any,
  page?: SweepPage,
): Promise<string> {
  const { data: existing } = page
    ? { data: page.ledger.get(row.altercpa_id) ?? null }
    : await admin
      .from("altercpa_leads")
      .select("id, order_id, phase, skip_reason")
      .eq("account_id", account.id)
      .eq("altercpa_id", row.altercpa_id)
      .maybeSingle();

  const phaseChanged = !existing || existing.phase !== row.phase;
  if (phaseChanged) row.phase_seen_at = new Date().toISOString();

  // Promote to an order first, so the ledger row can carry order_id in the same
  // write and never exists in a half-linked state.
  let orderId: string | null = existing?.order_id ?? null;
  if (!row.skip_reason) {
    orderId = await upsertOrder(admin, account, row, o, mapping, stats, orderId, phaseChanged);
  } else if (!orderId) {
    // ADOPT, never create. A skip_reason means "do not invent an order for this
    // lead" — it must never mean "leave an order that already exists orphaned".
    //
    // Found 2026-08-13: 33 pendings from 03-05 Aug were unresolvable. Their
    // orders had been created by an earlier path, the ledger row was then
    // written with skip_reason='not_pending' and a NULL order_id, and the
    // status cron's candidate query requires `.not("order_id","is",null)`.
    // So AlterCPA cancelled or trashed them and nothing here ever found out —
    // they would have sat in the calling queue forever.
    //
    // Matched on the same (external_source, external_order_id) key upsertOrder
    // uses. Scoping to external_source is load-bearing: opencart orders carry
    // external_order_id too, and a bare id match could adopt a stranger's row.
    const { data: adopted } = page
      ? { data: page.adoptable.get(row.altercpa_id) ?? null }
      : await admin
        .from("orders")
        .select("id, cpa_webmaster_id, cpa_offer_id, cpa_offer_name, cpa_stream_id")
        .eq("external_source", "altercpa")
        .eq("external_order_id", row.altercpa_id)
        .limit(1)
        .maybeSingle();
    if (adopted?.id) {
      orderId = adopted.id;
      // A skipped lead still knows who sent it. This is the only path that
      // reaches orders created by the 2026-08 history import.
      await fillMissingCpaAttribution(admin, adopted, row, o);
      stats.skipped.adopted_existing_order = (stats.skipped.adopted_existing_order || 0) + 1;
    }
  }
  // skip ≠ leave stale. Under pending_only a lead that resolves inside the
  // rolling overlap gets skip_reason='not_pending' and used to skip upsertOrder
  // entirely — ledger phase 3/4/5, CRM still pending — because outcomes were
  // delegated to the status kind. When that kind is starved (2026-08-20) the
  // 45-minute window writes the truth and never applies it. Apply B′ here too.
  if (row.skip_reason === "not_pending" && orderId) {
    await applyOutcomeToExistingOrder(admin, account, orderId, o, stats,
      page ? { knownStatus: page.orderStatus.get(orderId) } : {});
  }
  row.order_id = orderId;

  if (page) {
    page.writes.push({ row, existingId: existing?.id ?? null });
    return existing ? "updated" : "new";
  }
  return writeLedgerRow(admin, row, existing?.id ?? null);
}

/** The ledger write at the end of upsertLead: 'new' | 'updated'. */
async function writeLedgerRow(
  admin: SupabaseClient,
  row: Record<string, any>,
  existingId: string | null,
): Promise<string> {
  if (existingId) {
    await admin.from("altercpa_leads").update(row).eq("id", existingId);
    return "updated";
  }
  const { error } = await admin.from("altercpa_leads").insert(row);
  if (error) {
    // Two concurrent runs raced on the same id; the other one won, which is a
    // correct outcome, not a failure.
    if ((error as any).code === "23505") return "updated";
    throw new Error(`ledger insert ${row.altercpa_id}: ${error.message}`);
  }
  return "new";
}

/**
 * The four CPA provenance columns on `orders` — which affiliate sent the lead,
 * for which offer, and through which traffic source. Only the affiliate ID is
 * stored; the name is resolved through altercpa_webmasters at display time, so
 * renaming a partner is one row.
 *
 * `offername` is the OFFER's name, while row.offer_name is productNameOf() —
 * goods[0].name, which is the offer-map key. They are identical on every record
 * we hold, but offername is the authoritative one here.
 *
 * `tracking.exts` is the stream/publisher code (raw, no name registry —
 * operator decision 2026-08-19). Empty string → NULL via `|| null`. Never
 * `tracking.extu` — that is a per-lead click id, unique per record.
 */
function cpaAttribution(row: Record<string, any>, o: AlterCpaOrder) {
  return {
    cpa_webmaster_id: row.webmaster ?? null,
    cpa_offer_id: row.offer_ext_id ?? null,
    cpa_offer_name: s(o.offername, 200) || row.offer_name || null,
    cpa_stream_id: s(o.tracking?.exts, 120) || null,
  };
}

/** Settlement → MEX zone, same join the api uses on POST /orders. Cached
 *  per isolate: a rolling run creates a handful of orders, not thousands. */
let mexZoneByNorm: Map<string, { id: number; name: string | null }> | null = null;
async function loadMexZones(admin: SupabaseClient) {
  if (mexZoneByNorm) return mexZoneByNorm;
  const map = new Map<string, { id: number; name: string | null }>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await admin.from("mk_settlements")
      .select("name_norm, kind, mex_city_id, mex_cities(city_name)")
      .not("mex_city_id", "is", null)
      .order("kind", { ascending: true })
      .range(from, from + 999);
    if (error) throw new Error(`mex zones: ${error.message}`);
    for (const row of data || []) {
      const norm = String(row.name_norm || "");
      if (!norm || map.has(norm)) continue;
      const zone = (row as { mex_cities?: { city_name?: string } }).mex_cities;
      map.set(norm, { id: row.mex_city_id as number, name: zone?.city_name ?? null });
    }
    if (!data || data.length < 1000) break;
  }
  mexZoneByNorm = map;
  return map;
}

async function resolveMexCity(
  admin: SupabaseClient,
  cityRaw: string | null | undefined,
): Promise<{ id: number | null; name: string | null }> {
  const city = String(cityRaw || "").trim();
  if (!city) return { id: null, name: null };
  const base = city.split(",")[0].replace(/^\s*(?:гр\.|с\.|село\s+|град\s+)/i, "").trim();
  const key = normalizeMkGeo(base);
  if (key.length < 2) return { id: null, name: null };
  const zone = (await loadMexZones(admin)).get(key);
  return zone ? { id: zone.id, name: zone.name } : { id: null, name: null };
}

/**
 * Fill attribution on an order that predates these columns, or that some other
 * path created. NULL-only: provenance is what their record said when the lead
 * arrived, so a value already present is never rewritten.
 *
 * `existing` must already carry the three columns — every caller selects them,
 * so this costs no extra round-trip.
 */
async function fillMissingCpaAttribution(
  admin: SupabaseClient,
  existing: Record<string, any>,
  row: Record<string, any>,
  o: AlterCpaOrder,
): Promise<void> {
  const patch: Record<string, any> = {};
  for (const [k, v] of Object.entries(cpaAttribution(row, o))) {
    if (v != null && existing[k] == null) patch[k] = v;
  }
  if (Object.keys(patch).length) await admin.from("orders").update(patch).eq("id", existing.id);
}

/**
 * Create or update the mirrored order.
 *
 * Keyed on (external_source='altercpa', external_order_id=<their id>) — the
 * exact pair scripts/import-altercpa-mk.mjs used for the 81.657-order history
 * import, backed by the partial-unique index from 20260521150000. Reusing it
 * means the live bridge continues from the import with no duplicates and no
 * cutover date to get right.
 */
async function upsertOrder(
  admin: SupabaseClient,
  account: Record<string, any>,
  row: Record<string, any>,
  o: AlterCpaOrder,
  mapping: any,
  stats: any,
  knownOrderId: string | null,
  phaseChanged: boolean,
): Promise<string | null> {
  const phase = row.phase as number | null;
  // o.price is the ORDER TOTAL on their side (3 × 1000 arrives as price=3000,
  // goods[0].price=1000) — multiplying by quantity would double-count. It never
  // fired only because leads arrive as 1 pack; found 2026-08-11 via the upsell
  // resize bug.
  const priceTotal = Number(row.price_eur) || 0;

  const { data: product } = mapping?.product_id
    ? await admin.from("products").select("id, name").eq("id", mapping.product_id).maybeSingle()
    : { data: null };

  const { data: existing } = await admin
    .from("orders")
    .select("id, status, assigned_agent_id, confirmed_at, cpa_webmaster_id, cpa_offer_id, cpa_offer_name, cpa_stream_id, mex_city_id")
    .eq("external_source", "altercpa")
    .eq("external_order_id", row.altercpa_id)
    .maybeSingle();

  const mexZone = await resolveMexCity(admin, row.city || s(o.city, 200));

  if (!existing) {
    // B′ as if this were a fresh pending: pending | confirmed | cancelled |
    // trashed, and insertStatusFor throws on anything else. Under
    // import_scope='pending_only' only phase 1/2 (or none) reaches here; under
    // 'all' this line is what used to book every approved lead as paid.
    const insertStatus = insertStatusFor(o);
    const { data: order, error } = await admin.from("orders").insert({
      product_id: product?.id ?? null,
      product_name: product?.name ?? row.offer_name,
      customer_name: row.customer_name || "—",
      customer_phone: row.phone_e164,
      customer_city: row.city || "",
      customer_address: s(o.addr, 600),
      postal_code: s(o.index, 30),
      mex_city_id: mexZone.id,
      mex_city_name: mexZone.name,
      price: priceTotal,
      quantity: row.quantity,
      status: insertStatus,
      source_type: "altercpa",
      external_source: "altercpa",
      external_order_id: row.altercpa_id,
      ...cpaAttribution(row, o),
      created_at: row.created_remote ?? undefined,
      // Unassigned on purpose so it surfaces in the Assigner like any other
      // pending lead. The bridge distributes nothing.
      assigned_agent_id: null,
      assigned_agent_name: null,
      assigned_at: null,
      // Their-clock timestamp + the reason pair for cancelled/trashed — the
      // same columns a B′ update writes, so an insert and an update of the
      // same record can never differ.
      ...outcomeColumns(o, insertStatus),
    }).select("id, display_id").single();

    if (error) {
      if ((error as any).code === "23505") return knownOrderId;   // concurrent run won
      throw new Error(`order insert ${row.altercpa_id}: ${error.message}`);
    }

    await admin.from("order_items").insert({
      order_id: order.id,
      product_id: product?.id ?? null,
      product_name: product?.name ?? row.offer_name,
      quantity: row.quantity,
      price_per_unit: Math.round((priceTotal / Math.max(1, row.quantity)) * 100) / 100,
      total_price: priceTotal,
    });
    await admin.from("order_notes").insert({
      order_id: order.id,
      text: [
        `Mirrored from AlterCPA (${account.name}) — order #${row.altercpa_id}`,
        `Offer: ${row.offer_name}${row.geo ? ` [${row.geo}]` : ""}`,
        row.webmaster ? `Webmaster: ${row.webmaster}` : "",
        phase ? `Their phase: ${PHASE[phase]}${row.reason ? ` (${REASON[row.reason] ?? row.reason})` : ""}` : "",
        `Their price: ${row.price_raw} ${String(row.currency_raw || "").toUpperCase()}`,
        s(o.comment, 500) ? `Customer comment: ${s(o.comment, 500)}` : "",
      ].filter(Boolean).join("\n"),
      author_id: null,
      author_name: "System",
    });
    await admin.from("order_history").insert({
      order_id: order.id,
      to_status: insertStatus,
      changed_by: null,
      changed_by_name: `System (altercpa:${account.name})`,
    });
    const cancelOtherNote = cancelOtherConfirmedNote(o, insertStatus);
    if (cancelOtherNote) {
      await admin.from("order_notes").insert({
        order_id: order.id, text: cancelOtherNote, author_id: null, author_name: "System",
      });
      stats.skipped.cancel_other_confirmed = (stats.skipped.cancel_other_confirmed || 0) + 1;
    }

    // Keep the phone-keyed profile in step — FILL-ONLY. An agent who corrected
    // an address on the phone has better data than the web form AlterCPA
    // captured it from, so a field that already has a value is never touched.
    // "Do not blank" is not enough here; the rule is "do not overwrite".
    const incoming: Record<string, string> = {};
    if (row.customer_name) incoming.customer_name = row.customer_name;
    if (row.city) incoming.city = row.city;
    if (s(o.index, 30)) incoming.postal_code = s(o.index, 30);
    if (s(o.street, 300)) incoming.street = s(o.street, 300);

    const { data: prof } = await admin
      .from("customer_profiles")
      .select("phone, customer_name, city, postal_code, street")
      .eq("phone", row.phone_e164)
      .maybeSingle();

    if (!prof) {
      await admin.from("customer_profiles").insert({ phone: row.phone_e164, ...incoming });
    } else {
      const patch: Record<string, string> = {};
      for (const [k, v] of Object.entries(incoming)) {
        if (!s((prof as Record<string, unknown>)[k])) patch[k] = v;
      }
      if (Object.keys(patch).length) {
        await admin.from("customer_profiles").update(patch).eq("phone", row.phone_e164);
      }
    }

    stats.orders_created++;
    return order.id;
  }

  // Attribution is independent of the status-mirror policy below: it is
  // provenance, not an outcome, so it is filled even on an order nobody here is
  // allowed to touch.
  await fillMissingCpaAttribution(admin, existing, row, o);

  // NULL-only: the zone is a snapshot (re-running the settlement map must not
  // rewrite where an already-routed parcel went). A lead that arrived before
  // the bridge stamped mex_city_id still needs one before fulfilment export.
  if (existing.mex_city_id == null && mexZone.id != null) {
    await admin.from("orders")
      .update({ mex_city_id: mexZone.id, mex_city_name: mexZone.name })
      .eq("id", existing.id);
  }

  // ── existing order: the same B′ apply as every other path ────────────────
  // Forward-only, never over a terminal status, never over an order someone
  // here is working (guarded → one note per remote phase change), never
  // anything physical. Until 2026-09-27 this branch mapped through
  // PHASE_TO_STATUS (phase 3 → paid) with no ladder, no terminal check and the
  // pre-08-13 assigned_agent_id guard — the side door its own comment warned
  // would open the moment import_scope became 'all'. Still evaluated once per
  // REMOTE phase change; the status kind re-reads every open order anyway.
  if (!phaseChanged) return existing.id;
  await applyOutcomeToExistingOrder(admin, account, existing.id, o, stats, { noteIfGuarded: true });
  return existing.id;
}

/** Orders the status kind considers still open — everything not yet terminal.
 * `shipped`/`delivered` stay in so a parcel keeps being tracked to paid or
 * returned; terminal statuses are excluded, so our own dedupe/cancel decisions
 * permanently outrank a later remote change. */
const STATUS_OPEN = ["pending", "take", "call_again", "confirmed", "shipped", "delivered"];
/** Calling-queue first: confirmed/shipped stay in STATUS_OPEN until MEX
 * settles them, so oldest-first used to fill the whole cap with them and
 * starve every pending created after ~2026-08-20 08:25 UTC. */
const STATUS_CALLING = ["pending", "take", "call_again"];
const STATUS_FULFILMENT = ["confirmed", "shipped", "delivered"];

const CANDIDATE_SELECT =
  "id, altercpa_id, phase, status, order_id, last_seen_at, orders!inner(id, status, assigned_agent_id, confirmed_at, quantity, price, call_again_since)";

function embedOrder(c: { orders?: unknown }) {
  const o = c.orders as unknown;
  return (Array.isArray(o) ? o[0] : o) as {
    id: string; status: string; assigned_agent_id: string | null;
    confirmed_at: string | null; quantity: number; price: number;
    call_again_since: string | null;
  } | undefined;
}

async function countOpenLeads(
  admin: SupabaseClient,
  accountId: string,
  statuses: string[],
): Promise<number> {
  const { count, error } = await admin.from("altercpa_leads")
    .select("id, orders!inner(id)", { count: "exact", head: true })
    .eq("account_id", accountId)
    .not("order_id", "is", null)
    .in("orders.status", statuses);
  if (error) throw new Error(`status candidate count: ${error.message}`);
  return count ?? 0;
}

async function fetchOpenLeads(
  admin: SupabaseClient,
  accountId: string,
  statuses: string[],
  limit: number,
) {
  if (limit <= 0) return [];
  // Rotate by last_seen_at, not created_remote: oldest-first pinned the same
  // 500 confirmed/shipped forever (they never leave STATUS_OPEN).
  const { data, error } = await admin.from("altercpa_leads")
    .select(CANDIDATE_SELECT)
    .eq("account_id", accountId)
    .not("order_id", "is", null)
    .in("orders.status", statuses)
    .order("last_seen_at", { ascending: true, nullsFirst: true })
    .limit(limit);
  if (error) throw new Error(`status candidates: ${error.message}`);
  return data || [];
}

/**
 * B′ apply onto an order that already exists. Two callers:
 *   - the rolling path when pending_only stamps skip_reason='not_pending' —
 *     that skip means "do not CREATE", never "leave the existing row pending";
 *     silent when guarded, because it re-runs on every pass of the overlap.
 *   - upsertOrder's existing-order branch (import_scope='all', or a sweep
 *     re-reading a lead), once per remote phase change, with noteIfGuarded.
 * Silent when there is nothing to do (still open, already matching, terminal,
 * would move backwards — forwardOutcome).
 *
 * `knownStatus` (a sweep page's one-read prefetch) may only SKIP the order
 * read, when B′ has nothing to do from that status. Anything that might apply
 * or be guarded is decided on the fresh read below, as on every other path.
 */
async function applyOutcomeToExistingOrder(
  admin: SupabaseClient,
  account: Record<string, any>,
  orderId: string,
  o: AlterCpaOrder,
  stats: { orders_updated: number; skipped: Record<string, number> },
  opts: { noteIfGuarded?: boolean; knownStatus?: string } = {},
) {
  const mode = String(account.status_mirror || "off");
  if (mode === "off") return;
  if (opts.knownStatus !== undefined && forwardOutcome(o, opts.knownStatus) == null) return;
  const { data: order } = await admin.from("orders")
    .select("id, status, confirmed_at, quantity, price, call_again_since")
    .eq("id", orderId)
    .maybeSingle();
  if (!order) return;
  const cur = String(order.status);
  const target = forwardOutcome(o, cur);
  if (target == null) return;
  const untouched = !order.confirmed_at && cur !== "take";
  if (!(mode === "always" || untouched)) {
    stats.skipped.guarded = (stats.skipped.guarded || 0) + 1;
    if (opts.noteIfGuarded) {
      await admin.from("order_notes").insert({
        order_id: order.id, text: guardedOutcomeNote(o), author_id: null, author_name: "System",
      });
    }
    return;
  }
  const { error: updErr } = await admin.from("orders")
    .update({ status: target, ...outcomeColumns(o, target) })
    .eq("id", order.id);
  if (updErr) throw new Error(`outcome apply ${o.id}: ${updErr.message}`);
  await admin.from("order_history").insert({
    order_id: order.id,
    from_status: cur,
    to_status: target,
    changed_by: null,
    changed_by_name: `System (altercpa:${account.name})`,
  });
  const cancelOtherNote = cancelOtherConfirmedNote(o, target);
  if (cancelOtherNote) {
    await admin.from("order_notes").insert({
      order_id: order.id, text: cancelOtherNote, author_id: null, author_name: "System",
    });
    stats.skipped.cancel_other_confirmed = (stats.skipped.cancel_other_confirmed || 0) + 1;
  }
  stats.orders_updated++;
}

/**
 * kind='status' — chase outcomes for already-imported pendings.
 *
 * The windowed kinds filter on CREATION time, so they can never observe a lead
 * that was created long ago and resolved yesterday. This kind inverts the
 * question: take OUR still-open mirrored orders, re-read exactly those ids via
 * comp/list.json?oid=…, and resolve forward-only per resolveRemoteOutcome (B′).
 *
 * Rules, in the order they are applied per lead:
 *   1. Ledger is always refreshed (phase/status/reason/payload) — the mirror
 *      stays truthful even when the order is guarded.
 *   2. Remote still open → nothing. Same target as current → nothing.
 *   3. Forward-only: never move down CRM_STATUS_RANK, never rewrite terminal.
 *   4. Ownership: 'until_touched' applies only while nobody here has taken or
 *      confirmed the order ("once we have taken a pending, the order is ours");
 *      'always' trusts AlterCPA until cutover. Guarded changes become ONE note
 *      per remote phase change, not one per 5-minute run.
 *   5. Reasons are written only alongside cancelled/trashed; timestamps come
 *      from their clock (outcomeTimestamps); never advances last_synced_at.
 */
async function syncStatusAccount(
  admin: SupabaseClient,
  account: Record<string, any>,
  dry: boolean,
  limit: number,
) {
  const startedMs = Date.now();
  const mode = String(account.status_mirror || "off");
  if (mode === "off") {
    return { account: account.name, status: "skipped", reason: "status_mirror_off" };
  }

  const token = Deno.env.get(account.token_secret_name);
  if (!token) {
    throw new Error(`Secret ${account.token_secret_name} is not set on this function`);
  }

  // Ledger rows linked to a still-open order. `orders!inner` is load-bearing:
  // without it the .in() filter on the embed does not restrict the parent rows
  // and every linked lead would come back regardless of order status.
  //
  // Calling-queue first, then fulfilment, each rotated by last_seen_at.
  // created_remote ASC + 500 cap (the original query) filled the window with
  // confirmed/shipped and never scanned a pending after 2026-08-20 08:25 UTC.
  const [callingTotal, fulfilmentTotal] = await Promise.all([
    countOpenLeads(admin, account.id, STATUS_CALLING),
    countOpenLeads(admin, account.id, STATUS_FULFILMENT),
  ]);
  const callingRows = await fetchOpenLeads(admin, account.id, STATUS_CALLING, limit);
  const fulfilmentRows = await fetchOpenLeads(
    admin, account.id, STATUS_FULFILMENT, Math.max(0, limit - callingRows.length),
  );
  const candidates = [...callingRows, ...fulfilmentRows];
  const candidatesTotal = callingTotal + fulfilmentTotal;

  const stats = {
    fetched: 0, ledger_new: 0, ledger_updated: 0,
    orders_created: 0, orders_updated: 0,
    skipped: {
      candidates_total: candidatesTotal,
      candidates_scanned: candidates.length,
    } as Record<string, number>,
  };
  const bump = (k: string) => { stats.skipped[k] = (stats.skipped[k] || 0) + 1; };
  const preview: unknown[] = [];

  if (!candidates.length) {
    return { account: account.name, status: "ok", dry, mode, candidates: 0, candidates_total: 0, ...stats };
  }

  // Run log opened before the fetch, same as the windowed kinds. window_from =
  // window_to = now(): this kind is an "as-of" snapshot, not a window.
  let runId: string | null = null;
  if (!dry) {
    const nowIso = new Date().toISOString();
    const { data: run } = await admin.from("altercpa_sync_runs").insert({
      account_id: account.id, kind: "status",
      window_from: nowIso, window_to: nowIso, status: "running",
    }).select("id").single();
    runId = run?.id ?? null;
  }

  const splits: string[] = [];
  let byId: Map<string, AlterCpaOrder>;
  try {
    byId = await fetchByIds(account.api_base, token, candidates.map((c: any) => String(c.altercpa_id)), (m) => splits.push(m));
  } catch (e) {
    if (runId) {
      await admin.from("altercpa_sync_runs").update({
        status: "failed", error: (e as Error).message,
        finished_at: new Date().toISOString(), duration_ms: Date.now() - startedMs,
      }).eq("id", runId);
    }
    throw e;
  }
  stats.fetched = byId.size;

  // Supabase's edge gateway 504s at ~150s. A 2000-oid catch-up with hundreds
  // of order writes exceeds that (proved 2026-08-22: calling queue applied,
  // run row left 'running'). Stop with ~40s of headroom and still write the
  // log; last_seen_at rotation continues next tick.
  const BUDGET_MS = 110_000;

  for (const c of candidates as any[]) {
    if (Date.now() - startedMs > BUDGET_MS) { bump("budget_exhausted"); break; }
    const order = embedOrder(c);
    if (!order) { bump("missing_order"); continue; }
    const o = byId.get(String(c.altercpa_id));
    if (!o) { bump("missing_remote"); continue; }        // deleted on their side

    const phase = Number(o.phase) || null;
    const phaseChanged = c.phase !== phase;
    // `c` is the pre-update ledger snapshot from the candidates query, so this
    // still compares against what we knew BEFORE this run refreshed the mirror.
    // Used to note a call-back once per real remote change, not once per run.
    const statusChanged = (Number(c.status) || null) !== (Number(o.status) || null);
    const cur = String(order.status);
    const target = resolveRemoteOutcome(o, cur);
    // "Touched" means WORKED, not merely assigned.
    //
    // Until 2026-08-13 this also tested assigned_agent_id, and that froze 37
    // orders for a week: Nina assigned them on 08-06, AlterCPA then cancelled
    // or trashed them, and every 5-minute run since skipped the change
    // ("guarded": 37, run after run) because an agent nominally owned rows that
    // nobody had actually touched. They sat `pending` in a queue while the
    // partner had already closed them, and only unassigning released them.
    //
    // With automatic distribution now assigning every lead within a minute of
    // arrival, that guard would have frozen the ENTIRE queue permanently.
    // What genuinely deserves protection is real work: `take` (an agent has the
    // customer open at this second) and confirmed_at (a recorded sale).
    const untouched = !order.confirmed_at && String(order.status) !== "take";
    const wouldApply = target !== null && target !== cur
      && !CRM_TERMINAL.has(cur)
      && (CRM_STATUS_RANK[target] ?? 0) > (CRM_STATUS_RANK[cur] ?? 0)
      && (mode === "always" || untouched);

    if (dry) {
      if (wouldApply || preview.length < 25) {
        preview.push({
          altercpa_id: String(c.altercpa_id), order_id: order.id, crm_status: cur,
          phase, phase_label: phase ? PHASE[phase] : null,
          status_label: STATUS_LABEL[Number(o.status) || 0] ?? null,
          reason_label: REASON[Number(o.reason) || 0] ?? null,
          would_be_status: target, would_apply: wouldApply,
          guarded: target !== null && target !== cur && !(mode === "always" || untouched),
          no_remote_ts: wouldApply && CRM_TERMINAL.has(target!)
            && !(Number(o.paid) > 0) && !(Number(o.done) > 0),
        });
      }
    } else {
      // 1. Ledger refresh — narrow patch; this kind never rewrites offer,
      // price or phone, it only keeps the outcome truthful.
      const patch: Record<string, unknown> = {
        phase, status: Number(o.status) || null, reason: Number(o.reason) || 0,
        payload: o as unknown as Record<string, unknown>,
        last_seen_at: new Date().toISOString(),
      };
      if (phaseChanged) patch.phase_seen_at = new Date().toISOString();
      const { error: ledErr } = await admin.from("altercpa_leads").update(patch).eq("id", c.id);
      if (ledErr) console.error(`altercpa-sync status: ledger ${c.altercpa_id}:`, ledErr.message);
      else stats.ledger_updated++;

      // Their operator can RESIZE the order at confirmation (upsell: 1 pack
      // arrives, 3 are sold) — carry the real package count and total onto
      // orders nobody here owns. Found 2026-08-11: 322 confirmed orders showed
      // 1 × 1.490 ден while AlterCPA had 3 × 3.000.
      const newQty = quantityOf(o);
      const newTotal = toEur(o.price, o.currency);
      if (untouched && !CRM_TERMINAL.has(cur) && newTotal != null
        && (order.quantity !== newQty || Math.abs(Number(order.price) - newTotal) > 0.02)) {
        const { error: szErr } = await admin.from("orders")
          .update({ quantity: newQty, price: newTotal }).eq("id", order.id);
        if (szErr) console.error(`altercpa-sync status: resize ${c.altercpa_id}:`, szErr.message);
        else {
          await admin.from("order_items")
            .update({
              quantity: newQty,
              price_per_unit: Math.round((newTotal / Math.max(1, newQty)) * 100) / 100,
              total_price: newTotal,
            }).eq("order_id", order.id);
          await admin.from("order_notes").insert({
            order_id: order.id,
            text: `AlterCPA resized this order to ${newQty} × (total ${o.price} ${String(o.currency || "").toUpperCase()}) — was ${order.quantity} pack(s). Quantity and price synced.`,
            author_id: null,
            author_name: "System",
          });
          bump("resized");
        }
      }
    }

    // ── Callback mirror (operator rule, 2026-08-13) ────────────────────────
    // While AlterCPA is the system of record, our status follows theirs: a lead
    // they marked for a call-back must read `call_again` here, and must return
    // to `pending` when they clear it. "Clear" means an OBSERVED 3→non-3
    // transition (2026-08-19, see wantPendingBack below) — a call_again OUR
    // agent set, with their side never having shown 3, is not "cleared" and
    // must stand until it is pushed to them (the call_again CPA push).
    //
    // This cannot go through the outcome ladder above. Their status 3
    // "Callback" lives INSIDE phase 1/2 — the lead is still open, so
    // resolveRemoteOutcome returns null — and pending/take/call_again all share
    // CRM_STATUS_RANK 0, which the forward-only rule deliberately refuses to
    // move between. It is an explicitly lateral mirror, handled on its own.
    //
    // `take` is never touched: an agent has the customer open at this second.
    // The next run picks it up once they are done.
    if ((phase === 1 || phase === 2) && cur !== "take") {
      const remoteCallback = Number(o.status) === 3;
      const wantCallAgain = remoteCallback && cur === "pending";
      // `c.status` is the pre-run ledger snapshot (same idiom as statusChanged
      // above), so this fires exactly when THEY move off an acknowledged
      // callback — ledger 3 → remote non-3. Until 2026-08-19 the test was just
      // `!remoteCallback`, which also reverted every AGENT-set call_again
      // within 5 minutes (their side still showed 1/2) — silently undoing the
      // agent's disposition and leaving the call_again CPA push nothing to
      // send. After a push the two sides agree at 3 and this stays quiet.
      const wantPendingBack = Number(c.status) === 3 && !remoteCallback && cur === "call_again";
      if (wantCallAgain || wantPendingBack) {
        if (dry) { bump(wantCallAgain ? "would_callback_on" : "would_callback_off"); continue; }
        const next = wantCallAgain ? "call_again" : "pending";
        const upd: Record<string, unknown> = { status: next };
        if (wantCallAgain) {
          // Anchored at the FIRST callback and never reset (20260622000000).
          // next_call_after stays NULL: leads are never throttled (lead rule 9)
          // — on a lead the customer is waiting for US.
          upd.call_again_since = order.call_again_since ?? new Date().toISOString();
        }
        const { error: cbErr } = await admin.from("orders").update(upd).eq("id", order.id);
        if (cbErr) throw new Error(`callback mirror ${c.altercpa_id}: ${cbErr.message}`);
        await admin.from("order_history").insert({
          order_id: order.id,
          from_status: cur,
          to_status: next,
          changed_by: null,
          changed_by_name: `System (altercpa:${account.name})`,
        });
        if (statusChanged) {
          await admin.from("order_notes").insert({
            order_id: order.id,
            text: wantCallAgain
              ? `AlterCPA marked this a call-back${s(o.comment, 300) ? ` — their comment: ${s(o.comment, 300)}` : ""}. Set to Call Again here.`
              : `AlterCPA cleared the call-back (now "${STATUS_LABEL[Number(o.status)] ?? o.status}"). Back to Pending here.`,
            author_id: null,
            author_name: "System",
          });
        }
        stats.orders_updated++;
        bump(wantCallAgain ? "callback_on" : "callback_off");
        continue;
      }
    }

    if (target === null) { bump("still_open_remote"); continue; }
    if (target === cur) { bump("unchanged"); continue; }
    if (CRM_TERMINAL.has(cur)) { bump("would_downgrade"); continue; }
    if ((CRM_STATUS_RANK[target] ?? 0) <= (CRM_STATUS_RANK[cur] ?? 0)) {
      bump(phase != null && phase <= 2 ? "reopened_remote" : "would_downgrade");
      continue;
    }

    if (!(mode === "always" || untouched)) {
      bump("guarded");
      if (!dry && phaseChanged) {
        await admin.from("order_notes").insert({
          order_id: order.id, text: guardedOutcomeNote(o), author_id: null, author_name: "System",
        });
      }
      continue;
    }

    if (dry) { bump("would_apply"); continue; }

    const upd: Record<string, unknown> = { status: target, ...outcomeColumns(o, target) };
    if (CRM_TERMINAL.has(target) && !(Number(o.paid) > 0) && !(Number(o.done) > 0)) {
      // Their record carries no settlement stamp; the NULL-only trigger will
      // date this outcome today. Counted so the catch-up dry run surfaces it.
      bump("no_remote_ts");
    }

    const { error: updErr } = await admin.from("orders").update(upd).eq("id", order.id);
    if (updErr) throw new Error(`status update ${c.altercpa_id}: ${updErr.message}`);
    await admin.from("order_history").insert({
      order_id: order.id,
      from_status: cur,
      to_status: target,
      changed_by: null,
      changed_by_name: `System (altercpa:${account.name})`,
    });
    // The cancel-other-is-confirmed rule fired — say so on the order.
    const cancelOtherNote = cancelOtherConfirmedNote(o, target);
    if (cancelOtherNote) {
      await admin.from("order_notes").insert({
        order_id: order.id, text: cancelOtherNote, author_id: null, author_name: "System",
      });
      bump("cancel_other_confirmed");
    }
    stats.orders_updated++;
  }

  if (runId) {
    await admin.from("altercpa_sync_runs").update({
      status: "ok",
      fetched: stats.fetched,
      ledger_new: 0,
      ledger_updated: stats.ledger_updated,
      orders_created: 0,
      orders_updated: stats.orders_updated,
      skipped: stats.skipped,
      error: splits.length ? `oid batches split: ${splits.length}` : null,
      finished_at: new Date().toISOString(),
      duration_ms: Date.now() - startedMs,
    }).eq("id", runId);
  }

  if (!dry && stats.orders_updated > 0) {
    await broadcastBoardRefresh({ source: "altercpa-sync", kind: "status", orders_updated: stats.orders_updated });
  }

  return {
    account: account.name, status: "ok", dry, mode,
    candidates: candidates.length, candidates_total: candidatesTotal, ...stats,
    ...(dry ? { preview } : {}),
    splits,
  };
}

// ── Resumable sweeps: nightly / weekly / continue (2026-09-28) ───────────────

/**
 * A sweep page's batched reads and its queued ledger writes — what upsertLead
 * reads one round-trip at a time on every other path.
 */
interface SweepPage {
  ledger: Map<string, { id: string; order_id: string | null; phase: number | null; skip_reason: string | null }>;
  /** external_order_id → the order a skipped lead may adopt (+ its cpa columns). */
  adoptable: Map<string, Record<string, any>>;
  /** order id → status: a prefilter for the B′ apply, never a reason to write. */
  orderStatus: Map<string, string>;
  writes: Array<{ row: Record<string, any>; existingId: string | null }>;
}

const secOf = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);

/**
 * kind 'nightly' | 'weekly' (a START — their crons, or an admin) or 'continue'
 * (the altercpa-sync-continue cron): one bounded slice of a resumable sweep.
 *
 * altercpa_sweep_claim decides atomically what this invocation works on. A
 * start opens a sweep over [now − 7 d | 90 d, now] when none is open; with one
 * open it continues THAT one (the start is absorbed) — except that a weekly
 * start closes an open nightly as 'superseded' and opens the weekly, whose 90
 * days contain the rest of the nightly's 7. 'continue' never opens anything.
 * The claim first closes a sweep past its limits, then takes a lease, so two
 * invocations never work one sweep ('busy' otherwise).
 *
 * One run row per invocation — kind = the sweep's kind, sweep_id, window = the
 * creation-time span this slice wrote — ok once its chunks are written, even
 * while the sweep goes on. A throw marks the row failed and hands the error to
 * the sweep; the next claim retries from the cursor.
 */
async function syncSweepAccount(
  admin: SupabaseClient,
  account: Record<string, any>,
  kind: string,
  body: Record<string, unknown>,
  deadlineMs: number,
) {
  const startedMs = Date.now();

  const token = Deno.env.get(account.token_secret_name);
  if (!token) {
    throw new Error(`Secret ${account.token_secret_name} is not set on this function`);
  }
  // An earlier account of this invocation spent the budget: claiming now would
  // only hold the lease through a slice that cannot write anything.
  if (deadlineMs - Date.now() < SWEEP_MIN_CHUNK_MS) {
    return { account: account.name, status: "skipped", reason: "no_budget_left" };
  }

  const start = kind !== "continue";
  const win = start
    ? sweepWindow(kind, Math.floor(Date.now() / 1000), {
      from: epoch(body.from), to: epoch(body.to), syncFrom: account.sync_from,
    })
    : null;

  const { data: claim, error: claimErr } = await admin.rpc("altercpa_sweep_claim", {
    p_account_id: account.id,
    p_kind: start ? kind : null,
    p_open: start,
    p_window_from: win ? isoOf(win.from) : null,
    p_window_to: win ? isoOf(win.to) : null,
    p_lease_seconds: SWEEP_LEASE_SEC,
  });
  if (claimErr) {
    // A start that cannot even claim still leaves a failed row — otherwise the
    // nightly card keeps showing its last green run.
    if (win) {
      await admin.from("altercpa_sync_runs").insert({
        account_id: account.id, kind, window_from: isoOf(win.from), window_to: isoOf(win.to),
        status: "failed", error: `altercpa_sweep_claim: ${claimErr.message}`,
        finished_at: new Date().toISOString(), duration_ms: Date.now() - startedMs,
      });
    }
    throw new Error(`altercpa_sweep_claim: ${claimErr.message}`);
  }
  if (!claim?.claimed) {
    // 'no_open_sweep' (a continue with nothing to do) or 'busy' (a slice is in
    // flight). Nothing ran, so no run row.
    return {
      account: account.name, status: "skipped", reason: claim?.reason ?? "not_claimed",
      closed: claim?.closed ?? [],
    };
  }

  const sweep = claim.sweep as Record<string, any>;
  const cursorFrom = secOf(sweep.cursor_at);
  const windowTo = secOf(sweep.window_to);

  const { data: runRow } = await admin.from("altercpa_sync_runs").insert({
    account_id: account.id, kind: sweep.kind, sweep_id: sweep.id,
    window_from: isoOf(cursorFrom), window_to: sweep.window_to, status: "running",
  }).select("id").single();
  const runId: string | null = runRow?.id ?? null;

  const leadRun = await openLeadRun(admin, account, 0);
  const { stats } = leadRun;
  const splits: string[] = [];
  // Where this slice got to, kept outside runSweep so a throw can report it.
  const progress = { cursor: cursorFrom, fetched: 0 };

  const io: SweepIo<AlterCpaOrder> = {
    now: () => Date.now(),
    fetch: async (c) => {
      const rows = await fetchWindow(account.api_base, token, c.from, c.to, 0, (m) => splits.push(m));
      progress.fetched += rows.length;
      return rows;
    },
    processPage: (leads, deadline) => processSweepPage(admin, leadRun, leads, deadline),
    advance: async (cursor) => {
      const { data, error } = await admin.rpc("altercpa_sweep_advance", {
        p_sweep_id: sweep.id, p_token: sweep.lease_token, p_cursor: isoOf(cursor),
      });
      if (error) throw new Error(`altercpa_sweep_advance: ${error.message}`);
      const st: SweepStatus = data === "open" || data === "done" ? data : "lost";
      if (st !== "lost") progress.cursor = cursor;
      return st;
    },
  };

  const runFields = () => {
    stats.fetched = progress.fetched;
    return {
      fetched: stats.fetched,
      ledger_new: stats.ledger_new,
      ledger_updated: stats.ledger_updated,
      orders_created: stats.orders_created,
      orders_updated: stats.orders_updated,
      skipped: stats.skipped,
      // The creation-time span this slice wrote (none: where it stood).
      window_to: isoOf(Math.max(cursorFrom, Math.min(progress.cursor - 1, windowTo))),
      finished_at: new Date().toISOString(),
      duration_ms: Date.now() - startedMs,
    };
  };

  let res: SweepRun;
  try {
    res = await runSweep(io, { cursor: cursorFrom, windowTo }, deadlineMs);
  } catch (e) {
    const msg = (e as Error).message;
    // Everything up to the last checkpoint stays written. The lease goes back
    // with the error and a 5-minute pause, so a failing API is retried, not
    // hammered; altercpa_sweeps_close_stale ends a sweep that keeps failing.
    await recordSightings(admin, leadRun);
    if (runId) {
      await admin.from("altercpa_sync_runs").update({ status: "failed", error: msg, ...runFields() }).eq("id", runId);
    }
    const { error: relErr } = await admin.rpc("altercpa_sweep_release", {
      p_sweep_id: sweep.id, p_token: sweep.lease_token, p_error: msg, p_retry_after_seconds: 300,
    });
    if (relErr) console.error("altercpa-sync: sweep release:", relErr.message);
    throw e;
  }

  await recordSightings(admin, leadRun);

  // Done: the rolling high-water mark follows the sweep's end — FORWARD ONLY.
  // The one-shot sweep set it outright moments after its window closed; a
  // resumable one may finish when rolling has long passed window_to, and
  // setting it back would only make the next rolling run re-read that gap.
  if (res.status === "done") {
    const mark = { last_synced_at: sweep.window_to, last_cursor_to: sweep.window_to };
    await admin.from("altercpa_accounts").update(mark).eq("id", account.id).is("last_synced_at", null);
    await admin.from("altercpa_accounts").update(mark).eq("id", account.id).lt("last_synced_at", sweep.window_to);
  }

  if (res.status === "open" && res.budgetExhausted) stats.skipped.budget_exhausted = 1;
  const fields = runFields();
  if (runId) {
    await admin.from("altercpa_sync_runs").update({
      status: "ok",
      ...fields,
      error: res.status === "lost"
        ? "sweep lease lost (re-claimed or closed meanwhile) — this slice stopped"
        : splits.length ? `windows split: ${splits.length}` : null,
    }).eq("id", runId);
  }
  // 'done' dropped the lease in the same statement; a 'lost' one is not ours.
  if (res.status === "open") {
    const { error: relErr } = await admin.rpc("altercpa_sweep_release", {
      p_sweep_id: sweep.id, p_token: sweep.lease_token, p_error: null, p_retry_after_seconds: 0,
    });
    if (relErr) console.error("altercpa-sync: sweep release:", relErr.message);
  }

  if (stats.orders_created > 0 || stats.orders_updated > 0) {
    await broadcastBoardRefresh({
      source: "altercpa-sync", kind: sweep.kind,
      orders_created: stats.orders_created, orders_updated: stats.orders_updated,
    });
  }

  return {
    account: account.name, status: "ok", kind: sweep.kind,
    sweep: {
      id: sweep.id, status: res.status, opened: claim.opened === true,
      window: { from: sweep.window_from, to: sweep.window_to }, cursor: isoOf(progress.cursor),
    },
    window: { from: isoOf(cursorFrom), to: fields.window_to },
    closed: claim.closed ?? [],
    chunks: res.chunks, budget_exhausted: res.budgetExhausted,
    splits, ...stats,
    offers_seen: leadRun.newOfferSightings.size,
  };
}

/**
 * One page of a sweep chunk. The reads upsertLead makes per lead elsewhere are
 * made once for the page — the ledger rows, the orders a skipped lead may
 * adopt (same external key), the status of every linked order — then each
 * lead goes through buildLead + upsertLead exactly as on the rolling path, and
 * the page's ledger writes go out together. Stops between leads at the
 * deadline; returns how many leads (a prefix of the page) are written.
 */
async function processSweepPage(
  admin: SupabaseClient,
  leadRun: LeadRun,
  leads: AlterCpaOrder[],
  deadlineMs: number,
): Promise<number> {
  const ids = leads.map((o) => String(o.id));
  const page: SweepPage = { ledger: new Map(), adoptable: new Map(), orderStatus: new Map(), writes: [] };

  // A failed read fails the page — reading it as "no row" would insert a
  // duplicate ledger row. The sweep retries the page from the cursor.
  const { data: ledgerRows, error: ledgerErr } = await admin.from("altercpa_leads")
    .select("id, altercpa_id, order_id, phase, skip_reason")
    .eq("account_id", leadRun.account.id)
    .in("altercpa_id", ids);
  if (ledgerErr) throw new Error(`sweep ledger read: ${ledgerErr.message}`);
  for (const r of ledgerRows || []) page.ledger.set(String(r.altercpa_id), r);

  const unlinked = ids.filter((id) => !page.ledger.get(id)?.order_id);
  if (unlinked.length) {
    const { data, error } = await admin.from("orders")
      .select("id, external_order_id, status, cpa_webmaster_id, cpa_offer_id, cpa_offer_name, cpa_stream_id")
      .eq("external_source", "altercpa")
      .in("external_order_id", unlinked);
    if (error) throw new Error(`sweep adopt read: ${error.message}`);
    for (const r of data || []) {
      const key = String(r.external_order_id);
      if (!page.adoptable.has(key)) page.adoptable.set(key, r);
      page.orderStatus.set(String(r.id), String(r.status));
    }
  }
  const linked = [...new Set([...page.ledger.values()].map((r) => r.order_id).filter((id): id is string => !!id))];
  if (linked.length) {
    const { data, error } = await admin.from("orders").select("id, status").in("id", linked);
    if (error) throw new Error(`sweep order read: ${error.message}`);
    for (const r of data || []) page.orderStatus.set(String(r.id), String(r.status));
  }

  let n = 0;
  for (const o of leads) {
    if (Date.now() >= deadlineMs) break;
    const { mapping, ledgerRow } = buildLead(leadRun, o);
    await upsertLead(admin, leadRun.account, ledgerRow, o, mapping, leadRun.stats, page);
    n++;
  }
  const written = await flushLedgerWrites(admin, page.writes);
  leadRun.stats.ledger_new += written.new;
  leadRun.stats.ledger_updated += written.updated;
  return n;
}

/**
 * A sweep page's ledger writes, each through the per-lead path's own
 * writeLedgerRow. Updates of existing rows are independent — one row each,
 * BEFORE-row triggers only — so a few go out at once. NEW rows are inserted one
 * by one in lead order, as on the per-lead path: trg_altercpa_lead_rate counts
 * the arrival cohort per inserted row, and a multi-row insert would show every
 * row the same final count.
 */
async function flushLedgerWrites(
  admin: SupabaseClient,
  writes: SweepPage["writes"],
): Promise<{ new: number; updated: number }> {
  const out = { new: 0, updated: 0 };
  const tally = (r: string) => {
    if (r === "new") out.new++;
    else if (r === "updated") out.updated++;
  };
  await eachLimit(writes.filter((w) => w.existingId), SWEEP_WRITE_CONCURRENCY, async (w) => {
    tally(await writeLedgerRow(admin, w.row, w.existingId));
  });
  for (const w of writes) {
    if (!w.existingId) tally(await writeLedgerRow(admin, w.row, null));
  }
  return out;
}
