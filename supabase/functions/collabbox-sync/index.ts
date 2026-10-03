/**
 * collabbox-sync — collabBox (Accent Computers) → the CRM, every night at 00:00 Skopje, and the
 * day's bookings every 30 minutes for the leaderboard. Owner (Mile, 28.09.2026): "We need it every
 * day at 00:00 — recording and seeing everything."
 *
 *   POST /functions/v1/collabbox-sync
 *   header: x-collabbox-sync-secret: <COLLABBOX_SYNC_SECRET>
 *   body:   { mode: 'nightly' }                          pg_cron 00:xx Skopje (invoke_collabbox_sync)
 *           { mode: 'live' }                             pg_cron every 30 min 08–20 Skopje
 *           { mode: 'manual', from: 'YYYY-MM-DD', to: 'YYYY-MM-DD' }   a window by hand (≤ 14 days)
 *           …, dry_run: true                             fetch + classify + return the PLAN; writes
 *                                                        nothing (no order, no ledger, no run row)
 *   A run that writes orders (nightly / manual, not dry) answers 202 with its run_id at once and
 *   works in the background (EdgeRuntime.waitUntil) — follow it in collabbox_sync_runs; add
 *   "wait": true to keep it synchronous. A dry run and the live run answer when done (≈ 30–90 s).
 *
 * NIGHTLY / MANUAL — the window is public.collabbox_nightly_window() (the last 3 Skopje days, caught
 * up after a missed night) or the manual from/to. Per day, strictly sequential and paced:
 *   1. the headers of every sales type (comp=searchdoc, all rows in one page, count checked);
 *   2. the line items (comp=repbydocitm, HTML table — no file is left on their server); a failure
 *      leaves that day's order documents 'no_items' (re-read next night), never guessed;
 *   3. lines classified here (collabbox.ts: goods / delivery / note / marker, product via
 *      product_aliases then products.sku), stornos paired inside the window;
 *   4. komitent cards (comp=infocc, the Коминтенти form as the operators send it — fixed 03.10.2026) for
 *      the customers of order and 10111 LEADS documents the database cannot place
 *      (public.collabbox_komitenti_needed: no phone anywhere first), within the request cap and the time budget;
 *   5. public.collabbox_apply_documents() in batches of 40 — THE writer (orders, conflicts, credits,
 *      the ledger, the run counters); public.collabbox_close_window() per fully read day (documents
 *      deleted in collabBox); public.collabbox_retry_open() (open rows of the last 14 days).
 * AHEAD (the frequent pass: `ahead_days: 14` with a window ending today, 20260944000500) — after the
 *   window's days, ONE header search + ONE line-items request for the documents DATED tomorrow …
 *   today + 14: collabBox dates a document on its dispatch day, so a sale booked today for dispatch
 *   in five days is read within 15 minutes of booking and the ledger records WHEN it was booked
 *   (collabbox_documents.booked_at, owner 01.10.2026: "the day the operator entered it counts").
 *   The run row's ahead_to records the range read (the 'seen' rule of collabbox_estimate_booked_at).
 * LIVE — today's headers of 10036 · 10050 · 10111 · 10114 · 10106 → public.collabbox_record_booked()
 *   ('booked' ledger rows; ≤ 10 requests); public.collabbox_booked_today() serves the leaderboard.
 *
 * Secrets: COLLABBOX_USER / COLLABBOX_PASS (the collabBox login; VAULT §7 — never logged),
 * COLLABBOX_SYNC_SECRET (this header; the same value lives in Vault as collabbox_sync_secret for
 * pg_cron). Fails closed when any is unset. The run log is public.collabbox_sync_runs; freshness is
 * public.collabbox_feed_state(). Migration: supabase/migrations/20260942000900_collabbox_nightly_sync.sql.
 * Runbook: docs/handoff/2026-09-28/collabbox-pipeline.md §8.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { CollabboxClient, RequestCapError } from "./client.ts";
import type { FetchLike } from "./client.ts";
import {
  LIVE_TYPES, NIGHTLY_TYPES, aheadRange, bookedHeader, buildCatalogue, buildDocuments, chunk, dayRange, isOrderRole,
  komitentCard, pairStornos, parseRequest, redact, skopjeDate, summarizeResults, toDmy,
} from "./collabbox.ts";
import type { AliasRow, ApplyResult, Catalogue, ItemRow, KomitentCard, ProductRow, SyncDoc, SyncRequest } from "./collabbox.ts";

const BATCH = 40;                      // documents per writer call (service_role statement_timeout 30 s)
const MAX_REQUESTS_FULL = 100;         // collabBox requests per nightly / manual run
const MAX_REQUESTS_LIVE = 10;
const PAUSE_MS = 1_500;                // between two collabBox requests (single-threaded, always)
const KOMITENT_CAP = 60;               // card lookups per run (the rest stay 'no_phone' → next night)
const BUDGET_BACKGROUND_MS = 330_000;  // the platform's wall clock is 400 s
const BUDGET_SYNC_MS = 115_000;        // a synchronous answer must come back within ~150 s
const APPLY_RESERVE_MS = 45_000;       // time kept for the writer after the last fetch
const RUNNING_STALE_MS = 20 * 60_000;  // a 'running' row older than this was killed
const RETRY_ROUNDS = 10;
const MAX_WINDOW_BACK = 14;

// deno-lint-ignore no-explicit-any
type Admin = any;   // untyped client: the schema types are not generated for Edge Functions here
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** Constant-time comparison of the shared secret. */
function safeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}
const errText = (e: unknown) => redact((e as Error)?.message ?? String(e)).slice(0, 500);

async function rpc<T = Record<string, unknown>>(admin: Admin, fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await admin.rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data as T;
}

/** Every row of a small table (PostgREST caps a response at 1.000 rows). */
async function selectAll<T>(admin: Admin, table: string, columns: string, filter?: (q: any) => any): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    let q = admin.from(table).select(columns).range(from, from + 999);
    if (filter) q = filter(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < 1000) return out;
  }
}

async function loadCatalogue(admin: Admin): Promise<Catalogue> {
  const aliases = await selectAll<AliasRow>(admin, "product_aliases", "source, alias_norm, product_id, kind",
    (q) => q.in("source", ["collabbox", "any"]));
  const products = await selectAll<ProductRow>(admin, "products", "id, sku, name, is_active");
  return buildCatalogue(aliases, products);
}

interface Ctx {
  admin: Admin;
  req: SyncRequest;
  runId: string | null;
  startedMs: number;
  budgetMs: number;
  client: CollabboxClient;
  warnings: string[];
}
const elapsed = (c: Ctx) => Date.now() - c.startedMs;
const timeLeft = (c: Ctx) => c.budgetMs - elapsed(c);

async function finishRun(c: Ctx, status: string, error: string | null, fields: Record<string, unknown> = {}) {
  if (!c.runId) return;
  const row = {
    status, error: error ? error.slice(0, 500) : null,
    warning: c.warnings.length ? c.warnings.join("; ").slice(0, 500) : null,
    requests: c.client.requests, finished_at: new Date().toISOString(), duration_ms: elapsed(c), ...fields,
  };
  let { error: e } = await c.admin.from("collabbox_sync_runs").update(row).eq("id", c.runId);
  if (e && "ahead_to" in row && /ahead_to/.test(e.message)) {
    // deployed before migration 20260944000500 (no ahead_to column yet): close the run without it,
    // never leave it 'running' (that would block every pass for 20 minutes)
    const { ahead_to: _skip, ...rest } = row as Record<string, unknown>;
    ({ error: e } = await c.admin.from("collabbox_sync_runs").update(rest).eq("id", c.runId));
  }
  if (e) console.error("collabbox-sync: could not close the run:", e.message);
}

// ── NIGHTLY / MANUAL ──────────────────────────────────────────────────────────
async function runFull(c: Ctx, window: { from: string; to: string }, today: string) {
  const days = dayRange(window.from, window.to);
  const dayStats: Record<string, unknown>[] = [];
  const docs: SyncDoc[] = [];
  const seenByDay = new Map<string, string[]>();
  let linesRead = 0;
  let stopped: string | null = null;
  // the ahead range (frequent pass, 20260944000500): documents DATED after today are booked already —
  // collabBox dates a document on its dispatch day — so they are read every 15 minutes too, and the
  // ledger learns WHEN each was booked (collabbox_documents.booked_at)
  const ahead = aheadRange(window.to, today, c.req.ahead);
  let aheadStats: Record<string, unknown> | null = null;
  let aheadRead: { from: string; to: string } | null = null;

  const cat = await loadCatalogue(c.admin);
  await c.client.login();

  for (const day of days) {
    // leave room for the other days' requests, the cards and the writer
    if (timeLeft(c) < APPLY_RESERVE_MS + 20_000 || c.client.remaining < 3) {
      stopped = `stopped before ${day} (${timeLeft(c) < APPLY_RESERVE_MS + 20_000 ? "time budget" : "request cap"})`;
      break;
    }
    const dmy = toDmy(day);
    let headers;
    try {
      headers = await c.client.searchHeaders(NIGHTLY_TYPES, dmy, dmy);
    } catch (e) {
      stopped = `headers of ${day}: ${errText(e)}`;
      break;
    }
    let items = null;
    let itemsError: string | null = null;
    if (headers.rows.length) {
      try {
        items = await c.client.searchItems(NIGHTLY_TYPES, dmy, dmy);
      } catch (e) {
        itemsError = errText(e);
        c.warnings.push(`line items of ${day} not read: ${itemsError}`);
        if (e instanceof RequestCapError) stopped = "request cap";
      }
    } else {
      items = [];
    }
    const built = buildDocuments(headers.rows, items, cat, day);
    linesRead += items?.length ?? 0;
    docs.push(...built.docs);
    seenByDay.set(day, built.docs.map((d) => d.doc_number));
    dayStats.push({
      day, headers: headers.rows.length, items: items?.length ?? null, items_error: itemsError,
      items_without_header: built.warnings.items_without_header,
      duplicate_doc_numbers: built.warnings.duplicate_doc_numbers,
    });
    if (stopped) break;
  }
  if (!seenByDay.size) throw new Error(stopped ?? "no day could be read");

  // ONE header search for the whole ahead range and ONE line-items request for it (same request
  // shapes as a day, never more); the days of the window come first, the ahead range only when
  // there is time and request budget left
  if (ahead && !stopped) {
    if (timeLeft(c) < APPLY_RESERVE_MS + 20_000 || c.client.remaining < 2) {
      c.warnings.push(`ahead ${ahead.from}..${ahead.to} not read (${timeLeft(c) < APPLY_RESERVE_MS + 20_000 ? "time budget" : "request cap"})`);
    } else {
      try {
        const headers = await c.client.searchHeaders(NIGHTLY_TYPES, toDmy(ahead.from), toDmy(ahead.to));
        let items: ItemRow[] | null = [];
        let itemsError: string | null = null;
        if (headers.rows.length) {
          try {
            items = await c.client.searchItems(NIGHTLY_TYPES, toDmy(ahead.from), toDmy(ahead.to));
          } catch (e) {
            items = null;
            itemsError = errText(e);
            c.warnings.push(`line items of ahead ${ahead.from}..${ahead.to} not read: ${itemsError}`);
          }
        }
        const built = buildDocuments(headers.rows, items, cat, null);
        linesRead += items?.length ?? 0;
        const known = new Set(docs.map((d) => d.doc_number));
        const fresh = built.docs.filter((d) => !known.has(d.doc_number) && d.day > window.to && d.day <= ahead.to);
        docs.push(...fresh);
        for (const d of fresh) (seenByDay.get(d.day) ?? seenByDay.set(d.day, []).get(d.day)!).push(d.doc_number);
        aheadRead = ahead;   // the headers were read: every booking dated in the range is now seen
        aheadStats = {
          from: ahead.from, to: ahead.to, headers: headers.rows.length, items: items?.length ?? null, items_error: itemsError,
          documents: fresh.length, items_without_header: built.warnings.items_without_header,
          duplicate_doc_numbers: built.warnings.duplicate_doc_numbers,
        };
      } catch (e) {
        c.warnings.push(`ahead ${ahead.from}..${ahead.to}: ${errText(e)}`);
      }
    }
  }
  if (stopped) c.warnings.push(stopped);

  const stornoPairs = pairStornos(docs);

  // komitent cards for the customers the database cannot place — the order documents AND the 10111 LEADS
  // documents (credit): since 20260947001850 a LEADS booking counts on its booking day only with the
  // customer's phone, and the card is where a new customer's phone is (owner 03.10.2026)
  const komitenti = { needed: 0, read: 0, found: 0, not_found: 0, skipped_budget: 0, error: null as string | null };
  const cardDocs = docs.filter((d) => (isOrderRole(d.role) || d.role === "credit") && !d.storno && d.komitent_id);
  if (cardDocs.length) {
    const needed = await rpc<{ komitent_id: string; priority: number }[]>(c.admin, "collabbox_komitenti_needed", {
      p_docs: cardDocs.map((d) => ({ doc_number: d.doc_number, komitent_id: d.komitent_id })),
    });
    komitenti.needed = needed.length;
    const cards = new Map<string, KomitentCard>();
    for (const n of needed) {
      if (komitenti.read >= KOMITENT_CAP || c.client.remaining < 1 || timeLeft(c) < APPLY_RESERVE_MS) {
        komitenti.skipped_budget = needed.length - komitenti.read;
        break;
      }
      try {
        komitenti.read++;
        const row = await c.client.readKomitent(n.komitent_id);
        if (row) { cards.set(n.komitent_id, komitentCard(row)); komitenti.found++; } else komitenti.not_found++;
      } catch (e) {
        komitenti.error = errText(e);
        komitenti.skipped_budget = needed.length - komitenti.read;
        c.warnings.push(`komitent cards stopped: ${komitenti.error}`);
        break;
      }
    }
    for (const d of docs) if (d.komitent_id && cards.has(d.komitent_id)) d.komitent = cards.get(d.komitent_id)!;
  }

  // the writer — oldest first, so every batch (and every retry) sees the same order of events
  docs.sort((a, b) => a.doc_at.localeCompare(b.doc_at) || a.doc_number.localeCompare(b.doc_number));
  const results: ApplyResult[] = [];
  for (const part of chunk(docs, BATCH)) {
    const r = await rpc<{ results: ApplyResult[] }>(c.admin, "collabbox_apply_documents", {
      p_run: c.runId, p_docs: part, p_dry: c.req.dry,
    });
    results.push(...(r.results ?? []));
  }

  // documents deleted in collabBox — only for days read completely, never on an empty re-read
  // (an empty page proves nothing; the SQL also refuses a day that lost more than half)
  const vanished = { gone: 0, marked: 0, orders_noted: 0, suspicious_days: [] as unknown[], sample: [] as unknown[] };
  for (const [day, seen] of seenByDay) {
    if (!seen.length) continue;
    const r = await rpc<Record<string, any>>(c.admin, "collabbox_close_window", {
      p_run: c.runId, p_from: day, p_to: day, p_types: NIGHTLY_TYPES, p_seen: seen, p_dry: c.req.dry,
    });
    vanished.gone += Number(r.gone) || 0;
    vanished.marked += Number(r.marked) || 0;
    vanished.orders_noted += Number(r.orders_noted) || 0;
    vanished.suspicious_days.push(...(r.suspicious_days ?? []));
    vanished.sample.push(...(r.sample ?? []).slice(0, 20));
  }
  if (vanished.suspicious_days.length) c.warnings.push(`suspicious re-read (not marked): ${JSON.stringify(vanished.suspicious_days).slice(0, 200)}`);

  // open rows of the last 14 days (a parcel, a card or a holder may have appeared)
  const retry: ApplyResult[] = [];
  for (let round = 0; round < (c.req.dry ? 1 : RETRY_ROUNDS); round++) {
    const r = await rpc<{ docs: number; results: ApplyResult[] }>(c.admin, "collabbox_retry_open", {
      p_run: c.runId, p_dry: c.req.dry, p_days: MAX_WINDOW_BACK, p_limit: c.req.dry ? 100 : BATCH,
    });
    retry.push(...(r.results ?? []));
    if (!r.docs || timeLeft(c) < 10_000) break;
  }

  const byNumber = new Map(docs.map((d) => [d.doc_number, d]));
  // a dry run wrote nothing, so its retry preview can repeat a window document (older payload): drop those
  if (c.req.dry) retry.splice(0, retry.length, ...retry.filter((x) => !byNumber.has(x.doc)));
  const summary = summarizeResults(results, byNumber);
  const retrySummary = summarizeResults(retry);
  const stats = {
    window, days: dayStats, ahead: aheadStats, komitenti, storno_pairs: stornoPairs.filter((p) => p.original || p.candidates !== 1),
    ...summary, retry: { outcomes: retrySummary.outcomes, reasons: retrySummary.reasons, created: retrySummary.created },
    vanished, slowest_ms: c.client.slowestMs, logins: c.client.logins, warnings: c.warnings,
  };
  return { status: stopped ? "partial" : "ok", docs, results, retry, stats, linesRead, komitenti, aheadRead };
}

// ── LIVE ──────────────────────────────────────────────────────────────────────
async function runLive(c: Ctx, today: string) {
  await c.client.login();
  const page = await c.client.searchHeaders(LIVE_TYPES, toDmy(today), toDmy(today));
  const headers = page.rows.map(bookedHeader);
  let booked: Record<string, unknown> = { headers: headers.length, booked: 0 };
  if (!c.req.dry && headers.length) {
    booked = { headers: 0, booked: 0, already_processed: 0, invalid: 0 };
    for (const part of chunk(headers, 500)) {
      const r = await rpc<Record<string, number>>(c.admin, "collabbox_record_booked", { p_run: c.runId, p_docs: part });
      for (const k of Object.keys(booked)) (booked as Record<string, number>)[k] += Number(r[k]) || 0;
    }
  }
  const byType: Record<string, number> = {};
  for (const h of headers) byType[String(h.type_id)] = (byType[String(h.type_id)] || 0) + 1;
  return { headers, booked, byType };
}

// ── the handler ───────────────────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const expected = Deno.env.get("COLLABBOX_SYNC_SECRET");
  if (!expected) return json({ error: "Not configured (COLLABBOX_SYNC_SECRET)" }, 503);
  if (!safeEqual(req.headers.get("x-collabbox-sync-secret") || "", expected)) return json({ error: "Forbidden" }, 403);
  const user = Deno.env.get("COLLABBOX_USER");
  const pass = Deno.env.get("COLLABBOX_PASS");
  if (!user || !pass) return json({ error: "Not configured (COLLABBOX_USER / COLLABBOX_PASS)" }, 503);

  let body: unknown = {};
  try { body = await req.json(); } catch { /* defaults */ }
  const today = skopjeDate();
  const parsed = parseRequest(body, today);
  if (!parsed.ok) return json({ error: parsed.error }, 400);
  const r = parsed.req;
  const kind = r.mode;

  const admin: Admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } });
  const startedMs = Date.now();

  // housekeeping: a run killed mid-flight stays 'running' → failed; one full run (or one live run) at a time
  if (!r.dry) {
    await admin.from("collabbox_sync_runs").update({
      status: "failed", error: "abandoned — the invocation never finished (timeout or crash)", finished_at: new Date().toISOString(),
    }).eq("status", "running").lt("started_at", new Date(Date.now() - RUNNING_STALE_MS).toISOString());
    const { data: busy } = await admin.from("collabbox_sync_runs").select("id")
      .in("kind", kind === "live" ? ["live"] : ["nightly", "manual"]).eq("status", "running").limit(1);
    if (busy?.length) return json({ ok: false, skipped: "already_running", mode: kind }, 409);
  }

  // the window
  let window: { from: string; to: string } = { from: today, to: today };
  if (kind !== "live") {
    if (r.from && r.to) {
      window = { from: r.from, to: r.to };
    } else {
      try {
        const w = await rpc<{ from: string; to: string }>(admin, "collabbox_nightly_window", { p_days: r.days, p_max_days: MAX_WINDOW_BACK });
        window = { from: String(w.from), to: String(w.to) };
      } catch (e) {
        return json({ ok: false, error: errText(e) }, 500);
      }
    }
  }

  // the run row (a dry run writes none)
  let runId: string | null = null;
  if (!r.dry) {
    const { data, error } = await admin.from("collabbox_sync_runs").insert({
      kind, trigger_kind: r.trigger, status: "running", window_from: window.from, window_to: window.to,
      doc_types: kind === "live" ? LIVE_TYPES : NIGHTLY_TYPES,
    }).select("id").single();
    if (error || !data) return json({ ok: false, error: `collabbox_sync_runs insert: ${error?.message ?? "no row"}` }, 500);
    runId = (data as { id: string }).id;
  }

  const c: Ctx = {
    admin, req: r, runId, startedMs, budgetMs: r.background ? BUDGET_BACKGROUND_MS : BUDGET_SYNC_MS, warnings: [],
    client: new CollabboxClient({
      fetch: fetch as unknown as FetchLike, user, pass, pauseMs: PAUSE_MS,
      maxRequests: kind === "live" ? MAX_REQUESTS_LIVE : MAX_REQUESTS_FULL,
      log: (line) => console.log(`collabbox-sync ${kind}: ${redact(line)}`),
    }),
  };

  const work = async (): Promise<Response> => {
    try {
      if (kind === "live") {
        const out = await runLive(c, today);
        await finishRun(c, "ok", null, { fetched: out.headers.length, stats: { day: today, by_type: out.byType, booked: out.booked, warnings: c.warnings } });
        return json({ ok: true, mode: kind, dry: r.dry, run_id: runId, day: today, requests: c.client.requests,
          headers: out.headers.length, by_type: out.byType, booked: out.booked,
          ...(r.dry ? { plan: out.headers } : {}) });
      }
      const out = await runFull(c, window, today);
      await finishRun(c, out.status, null, {
        fetched: out.docs.length, lines_read: out.linesRead, komitenti_fetched: out.komitenti.read, stats: out.stats,
        // the ahead range this pass READ (its bookings are seen; collabbox_estimate_booked_at's 'seen' rule)
        ...(out.aheadRead ? { ahead_to: out.aheadRead.to } : {}),
      });
      console.log(`collabbox-sync ${kind}: ${out.status} ${window.from}..${window.to} docs=${out.docs.length} ` +
        `requests=${c.client.requests} outcomes=${JSON.stringify(out.stats.outcomes)}`);
      return json({
        ...out.stats, ok: true, mode: kind, dry: r.dry, run_id: runId, status: out.status, window, ahead_read: out.aheadRead,
        requests: c.client.requests, fetched: out.docs.length, lines_read: out.linesRead,
        ...(r.dry ? { plan: out.results, retry_plan: out.retry } : {}),
      });
    } catch (e) {
      const msg = errText(e);
      console.error(`collabbox-sync ${kind}: failed — ${msg}`);
      await finishRun(c, "failed", msg, { stats: { window, warnings: c.warnings } });
      return json({ ok: false, mode: kind, dry: r.dry, run_id: runId, error: msg, requests: c.client.requests }, 502);
    }
  };

  if (r.background) {
    const p = work().catch((e) => console.error("collabbox-sync background:", errText(e)));
    (globalThis as any).EdgeRuntime?.waitUntil?.(p);
    return json({ ok: true, accepted: true, mode: kind, run_id: runId, window }, 202);
  }
  return await work();
});
