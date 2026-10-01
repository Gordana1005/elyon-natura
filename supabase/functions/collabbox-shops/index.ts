/**
 * collabbox-shops — the 22 shops' tills (collabBox, НАТУРА ТЕРАПИ СТОРЕС ДООЕЛ) → the shops tables.
 * READ-ONLY against collabBox: client.ts sends only the allow-listed request shapes (shops.ts isAllowed;
 * contract docs/SHOPS.md). Owner request 02.10.2026: how much the shops make, how many products Natura
 * gives them, and how much stock each shop holds at any moment.
 *
 *   POST /functions/v1/collabbox-shops
 *   header: x-collabbox-sync-secret: <COLLABBOX_SYNC_SECRET>     (the SAME secret collabbox-sync uses)
 *   body:   { mode: 'sales' | 'docs' | 'nightly' | 'backfill', trigger: 'cron' }   pg_cron (invoke_collabbox_shops)
 *           { mode: 'manual', from: 'YYYY-MM-DD', to?: 'YYYY-MM-DD' (≤ 7 days), parts: ['sales','docs','stock',
 *             'controls','lnp'], shops?: ['003', …], dry_run?: true, wait?: true }
 *   A cron run answers 202 at once and works in the background (EdgeRuntime.waitUntil); follow it in
 *   public.shops_reader_runs. A dry run reads, parses and asks the writers for their plan — it writes nothing
 *   (no data, no run row) and answers when done.
 *
 * MODES (request budget per run in brackets — login 2 + a form 1 each are included):
 *   sales     [≤ 6]   today's 10022 receipt + 10010 return lines of every shop in ONE request (before 07:30 also
 *                     yesterday) → shops_ingest_sales (the day is replaced as read; deleted receipts removed).
 *   docs      [≤ 8]   the goods documents of yesterday + today: ONE searchdoc (with Natura's invoice / return
 *                     numbers) + ONE lines request → shops_ingest_docs (+ the 10010 returns → shops_ingest_sales).
 *   nightly   [≤ 40]  today's receipts once more · infollc stock of every active shop (one request each) →
 *                     shops_ingest_stock · the 10018 daily reports + the trade book (all / cash) → shops_ingest_controls
 *                     · shops_articles_refresh_averages · shops_snapshots_prune.
 *   backfill  [≤ app_settings.shops_reader.backfill.max_requests] yesterday closed (receipts + controls), then
 *                     history oldest first: receipt days from sales_from, 10018 months, goods weeks from docs_from,
 *                     lnp per shop and month from lnp_from — each step logged in shops_backfill_log (resumable).
 *   manual    [≤ 40]  the parts asked, for one window.
 * Strictly sequential, ≥ 1,5 s between requests, one run at a time (shops_reader_runs 'running' → 409), and never
 * while a collabbox-sync run is running (the same login). A cron run does nothing while
 * app_settings.shops_reader.enabled is false (the SQL invoker checks it first, this function again).
 *
 * Secrets: COLLABBOX_USER / COLLABBOX_PASS (the collabBox login — VAULT §7, never logged), COLLABBOX_SYNC_SECRET,
 * SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY. All already set for collabbox-sync — nothing new.
 * Migrations: 20260946000100 (tables + writers), 0200 (reports), 0300 (switch + cron).
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { RequestCapError, ShopsClient } from "./client.ts";
import type { FetchLike } from "./client.ts";
import * as S from "./shops.ts";

const PAUSE_MS = 1_600;
const CAPS: Record<S.ShopsMode, number> = { sales: 6, docs: 8, nightly: 40, backfill: 60, manual: 40 };
const BUDGET_MS = 330_000;            // the platform's wall clock is 400 s
const RUNNING_STALE_MS = 20 * 60_000; // a 'running' row older than this was killed
const MAX_BACKFILL_REQUESTS = 120;

// deno-lint-ignore no-explicit-any
type Admin = any;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const errText = (e: unknown) => S.redact((e as Error)?.message ?? String(e)).slice(0, 500);

function safeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

async function rpc<T = Record<string, unknown>>(admin: Admin, fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await admin.rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data as T;
}

interface Shop { code: string; name: string; collabbox_magid: number; collabbox_name: string; active: boolean }
interface Settings {
  enabled?: boolean; snapshot_keep_days?: number;
  backfill?: { enabled?: boolean; sales_from?: string; docs_from?: string; lnp_from?: string; max_requests?: number;
               sales_days_per_run?: number; lnp_per_run?: number };
}
interface Ctx {
  admin: Admin; req: S.ShopsRequest; runId: string | null; client: ShopsClient; startedMs: number;
  shops: Shop[]; settings: Settings; warnings: string[]; stats: Record<string, unknown>; today: string;
}
const elapsed = (c: Ctx) => Date.now() - c.startedMs;
const timeLeft = (c: Ctx) => BUDGET_MS - elapsed(c);
const shopCodes = (c: Ctx) => new Set(c.shops.map((s) => s.code));
const toIsoNow = () => new Date().toISOString();

// ── the steps ────────────────────────────────────────────────────────────────
/** Receipt + return lines of [from, to] (all shops, one request) → shops_ingest_sales. */
async function stepSales(c: Ctx, from: string, to: string) {
  const page = await c.client.lines({ types: S.SALES_TYPES, fromDmy: S.toDmy(from), toDmy: S.toDmy(to) });
  const split = S.splitLines(page.lines, shopCodes(c));
  const res = await rpc(c.admin, "shops_ingest_sales", {
    p_run: c.runId, p_lines: split.sales, p_days: S.dayRange(from, to), p_types: S.SALES_TYPES, p_dry: c.req.dry,
  });
  return { from, to, lines: page.lines.length, skipped: split.skipped, ...res };
}

/** Goods documents of [from, to]: headers (with Natura's numbers) + lines → shops_ingest_docs; their 10010
 *  return lines → shops_ingest_sales (only that type, the same days). */
async function stepDocs(c: Ctx, from: string, to: string) {
  const headers = await c.client.headers(S.DOC_TYPES, S.toDmy(from), S.toDmy(to), true);
  let lineRows: S.DocLineRow[] | null = null;
  let returns: S.SalesLineRow[] | null = null;
  let linesError: string | null = null;
  let skipped: Record<string, number> = {};
  try {
    const page = await c.client.lines({ types: [...S.DOC_TYPES, "10010"], fromDmy: S.toDmy(from), toDmy: S.toDmy(to) });
    const split = S.splitLines(page.lines, shopCodes(c));
    lineRows = split.docs;
    returns = split.sales.filter((l) => l.doc_type === "10010");
    skipped = split.skipped;
  } catch (e) {
    if (e instanceof RequestCapError) throw e;
    linesError = errText(e);
    c.warnings.push(`docs lines ${from}..${to} not read: ${linesError}`);
  }
  const res = await rpc(c.admin, "shops_ingest_docs", {
    p_run: c.runId,
    p_headers: headers.rows.map((h) => ({
      doc_number: h.docNumber, doc_type: h.typeId, doc_at: h.at, amount_mkd: h.amount, natura_doc: h.naturaDoc,
      author: h.author, collabbox_doc_id: h.docId, collabbox_object_id: h.objectId,
    })),
    p_lines: lineRows, p_from: from, p_to: to, p_types: S.DOC_TYPES, p_dry: c.req.dry,
  });
  let ret: unknown = null;
  if (returns) {
    ret = await rpc(c.admin, "shops_ingest_sales", {
      p_run: c.runId, p_lines: returns, p_days: S.dayRange(from, to), p_types: ["10010"], p_dry: c.req.dry,
    });
  }
  return { from, to, headers: headers.rows.length, lines: lineRows?.length ?? null, lines_error: linesError, skipped, ...res, returns: ret };
}

/** infollc per shop as of `asOf` → shops_ingest_stock (each shop its own take, taken when read). */
async function stepStock(c: Ctx, asOf: string, shops: Shop[]) {
  const out = { as_of: asOf, shops: 0, ok: 0, units: 0, failed: [] as { shop: string; error: string }[], not_reached: [] as string[] };
  for (const s of shops) {
    if (timeLeft(c) < 25_000 || c.client.remaining < 1) { out.not_reached.push(s.code); continue; }
    out.shops++;
    try {
      const page = await c.client.stock(s.collabbox_magid, S.toDmy(asOf));
      if (page.shop !== s.code) throw new Error(`answer is for warehouse ${page.shop ?? "?"}, not ${s.code}`);
      if (!page.vatColumn) c.warnings.push(`stock ${s.code}: no VAT column`);
      const r = await rpc<Record<string, number>>(c.admin, "shops_ingest_stock", {
        p_run: c.runId, p_shop: s.code, p_taken_at: toIsoNow(), p_as_of: asOf, p_dry: c.req.dry,
        p_rows: page.rows.map((x) => ({
          article_code: x.articleCode, article_id: x.articleId, article_name: x.articleName, group: x.group, unit: x.unit,
          avg_cost: x.avgCost, qty: x.qty, reserved: x.reserved, available: x.available, value: x.value,
          retail_price: x.retailPrice, vat_rate: x.vatRate,
        })),
      });
      out.ok++;
      out.units += Number(r.units) || 0;
    } catch (e) {
      if (e instanceof RequestCapError) { out.not_reached.push(s.code); continue; }
      out.failed.push({ shop: s.code, error: errText(e) });
    }
  }
  if (out.not_reached.length) c.warnings.push(`stock not read for ${out.not_reached.join(",")} (budget)`);
  if (!c.req.dry && out.ok) {
    await rpc(c.admin, "shops_articles_refresh_averages", {});
    await rpc(c.admin, "shops_snapshots_prune", { p_keep_days: Number(c.settings.snapshot_keep_days) || 62 });
  }
  return out;
}

/** The day's 10018 reports and the trade book (all payments, cash only) → shops_ingest_controls. */
async function stepControls(c: Ctx, day: string, withTradeBook = true) {
  const dmy = S.toDmy(day);
  const reports = await c.client.headers([S.CONTROL_TYPE], dmy, dmy);
  let tkAll: S.TkPage | null = null;
  let tkCash: S.TkPage | null = null;
  if (withTradeBook) {
    tkAll = await c.client.tradeBook(dmy, dmy, "all");
    tkCash = await c.client.tradeBook(dmy, dmy, "cash");
  }
  const rows = S.buildControls(reports.rows, tkAll, tkCash, c.shops);
  const res = await rpc(c.admin, "shops_ingest_controls", { p_run: c.runId, p_day: day, p_rows: rows, p_dry: c.req.dry });
  return { day, reports: reports.rows.length, trade_book_total: tkAll?.total ?? null, ...res };
}

/** A whole month of 10018 reports in one search → the report totals of each day. */
async function stepControlsMonth(c: Ctx, ym: string) {
  const { from, to } = S.monthRange(ym);
  const last = to < c.today ? to : S.addDays(c.today, -1);
  const reports = await c.client.headers([S.CONTROL_TYPE], S.toDmy(from), S.toDmy(last));
  const byDay = new Map<string, S.DocHeader[]>();
  for (const r of reports.rows) {
    const d = (r.at ?? "").slice(0, 10);
    if (S.isYmd(d)) (byDay.get(d) ?? byDay.set(d, []).get(d)!).push(r);
  }
  let checked = 0;
  for (const [day, rows] of byDay) {
    const res = await rpc<Record<string, number>>(c.admin, "shops_ingest_controls", {
      p_run: c.runId, p_day: day, p_rows: S.buildControls(rows, null, null, c.shops), p_dry: c.req.dry,
    });
    checked += Number(res.checked) || 0;
  }
  return { month: ym, reports: reports.rows.length, days: byDay.size, checked };
}

/** lnp of one shop over [from, to] → shops_ingest_periods. */
async function stepPeriod(c: Ctx, s: Shop, from: string, to: string) {
  const page = await c.client.period(s.collabbox_magid, S.toDmy(from), S.toDmy(to));
  if (page.shop !== s.code) throw new Error(`lnp answer is for warehouse ${page.shop ?? "?"}, not ${s.code}`);
  return await rpc(c.admin, "shops_ingest_periods", {
    p_run: c.runId, p_shop: s.code, p_from: from, p_to: to, p_dry: c.req.dry,
    p_rows: page.rows.map((x) => ({
      article_code: x.articleCode, article_name: x.articleName, subgroup: x.subgroup ?? x.group, opening_qty: x.openingQty,
      opening_value: x.openingValue, in_purchase: x.inPurchase, in_transfer: x.inTransfer, out_sales: x.outSales,
      out_transfer: x.outTransfer, closing_qty: x.closingQty, closing_value: x.closingValue, avg_cost: x.avgCost,
      closing_retail: x.closingRetail,
    })),
  });
}

// ── the backfill log ─────────────────────────────────────────────────────────
async function doneKeys(c: Ctx, kinds: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await c.admin.from("shops_backfill_log").select("kind, key").in("kind", kinds).eq("ok", true).range(from, from + 999);
    if (error) throw new Error(`shops_backfill_log: ${error.message}`);
    for (const r of (data ?? []) as { kind: string; key: string }[]) out.add(`${r.kind}:${r.key}`);
    if (!data || data.length < 1000) return out;
  }
}
async function markDone(c: Ctx, kind: string, key: string, stats: unknown, ok = true) {
  if (c.req.dry) return;
  const { error } = await c.admin.from("shops_backfill_log").upsert({ kind, key, ok, stats, run_id: c.runId, done_at: toIsoNow() });
  if (error) c.warnings.push(`backfill log ${kind}:${key}: ${error.message}`);
}
const mondayOf = (ymd: string) => {
  const dow = (new Date(Date.parse(ymd + "T00:00:00Z")).getUTCDay() + 6) % 7;
  return S.addDays(ymd, -dow);
};

// ── the modes ────────────────────────────────────────────────────────────────
async function runSales(c: Ctx) {
  const early = S.skopjeHm() < "07:30";
  c.stats.sales = await stepSales(c, early ? S.addDays(c.today, -1) : c.today, c.today);
}

async function runDocs(c: Ctx) {
  c.stats.docs = await stepDocs(c, S.addDays(c.today, -1), c.today);
}

async function runNightly(c: Ctx) {
  try { c.stats.sales = await stepSales(c, c.today, c.today); } catch (e) { if (e instanceof RequestCapError) throw e; c.warnings.push(`sales: ${errText(e)}`); }
  c.stats.stock = await stepStock(c, c.today, c.shops.filter((s) => s.active));
  try { c.stats.controls = await stepControls(c, c.today); } catch (e) { if (e instanceof RequestCapError) throw e; c.warnings.push(`controls: ${errText(e)}`); }
}

async function runBackfill(c: Ctx) {
  const b = c.settings.backfill ?? {};
  const yesterday = S.addDays(c.today, -1);
  const salesFrom = S.isYmd(b.sales_from) ? b.sales_from : "2026-01-01";
  const docsFrom = S.isYmd(b.docs_from) ? b.docs_from : "2026-01-01";
  const lnpFrom = /^\d{4}-\d{2}$/.test(String(b.lnp_from ?? "")) ? String(b.lnp_from) : "2025-01";
  const salesPerRun = Math.min(60, Math.max(1, Number(b.sales_days_per_run) || 25));
  const lnpPerRun = Math.min(12, Math.max(0, Number(b.lnp_per_run ?? 4)));
  const done = await doneKeys(c, ["sales_day", "close_day", "controls_month", "docs_week", "lnp_month"]);
  const out: Record<string, unknown> = {};
  const enough = (ms: number, req: number) => timeLeft(c) > ms && c.client.remaining >= req;

  // 1. yesterday closed: its receipts once more + the controls with the trade book
  if (!done.has(`close_day:${yesterday}`) && enough(40_000, 4)) {
    const s = await stepSales(c, yesterday, yesterday);
    const k = await stepControls(c, yesterday);
    await markDone(c, "close_day", yesterday, { sales: s, controls: k });
    out.close_day = { day: yesterday, receipts_rows: (s as Record<string, unknown>).rows, mismatches: (k as Record<string, unknown>).mismatches };
  }
  // 2. receipt days, oldest first
  const days = S.dayRange(salesFrom, S.addDays(yesterday, -1), 800).filter((d) => !done.has(`sales_day:${d}`) && !done.has(`close_day:${d}`));
  const salesDone: string[] = [];
  for (const d of days.slice(0, salesPerRun)) {
    if (!enough(30_000, 1)) break;
    const s = await stepSales(c, d, d);
    await markDone(c, "sales_day", d, { rows: (s as Record<string, unknown>).rows, documents: (s as Record<string, unknown>).documents });
    salesDone.push(d);
  }
  out.sales_days = { done: salesDone.length, first: salesDone[0] ?? null, last: salesDone.at(-1) ?? null, left: days.length - salesDone.length };
  // 3. the 10018 reports of closed months (one search a month)
  const months = S.monthsBetween(salesFrom.slice(0, 7), yesterday.slice(0, 7)).filter((m) => !done.has(`controls_month:${m}`) && S.monthRange(m).to < c.today);
  const monthsDone: string[] = [];
  for (const m of months.slice(0, 3)) {
    if (!enough(30_000, 1)) break;
    const r = await stepControlsMonth(c, m);
    await markDone(c, "controls_month", m, r);
    monthsDone.push(m);
  }
  out.controls_months = monthsDone;
  // 4. goods documents, a week at a time (headers + lines)
  const weeks: string[] = [];
  for (let w = mondayOf(docsFrom); S.addDays(w, 6) < c.today && weeks.length < 120; w = S.addDays(w, 7)) {
    if (!done.has(`docs_week:${w}`)) weeks.push(w);
  }
  const weeksDone: string[] = [];
  for (const w of weeks.slice(0, 4)) {
    if (!enough(40_000, 2)) break;
    const r = await stepDocs(c, w, S.addDays(w, 6));
    await markDone(c, "docs_week", w, { headers: (r as Record<string, unknown>).headers, lines: (r as Record<string, unknown>).lines }, !(r as Record<string, unknown>).lines_error);
    weeksDone.push(w);
  }
  out.docs_weeks = weeksDone;
  // 5. lnp per shop and closed month (~30 s each on their side — a few per run)
  const lastClosed = S.addDays(`${c.today.slice(0, 7)}-01`, -1).slice(0, 7);
  const todo: { shop: Shop; ym: string }[] = [];
  for (const ym of S.monthsBetween(lnpFrom, lastClosed)) {
    for (const s of c.shops.filter((x) => x.active)) if (!done.has(`lnp_month:${s.code}|${ym}`)) todo.push({ shop: s, ym });
  }
  const lnpDone: string[] = [];
  for (const t of todo.slice(0, lnpPerRun)) {
    if (!enough(60_000, 1)) break;
    const { from, to } = S.monthRange(t.ym);
    try {
      const r = await stepPeriod(c, t.shop, from, to);
      await markDone(c, "lnp_month", `${t.shop.code}|${t.ym}`, r);
      lnpDone.push(`${t.shop.code}|${t.ym}`);
    } catch (e) {
      if (e instanceof RequestCapError) break;
      c.warnings.push(`lnp ${t.shop.code} ${t.ym}: ${errText(e)}`);
    }
  }
  out.lnp = { done: lnpDone, left: todo.length - lnpDone.length };
  c.stats.backfill = out;
  if (salesDone.length || out.close_day) c.stats.sales = { backfill: true };
  if (weeksDone.length) c.stats.docs = { backfill: true };
}

async function runManual(c: Ctx) {
  const from = c.req.from!, to = c.req.to!;
  const shops = c.shops.filter((s) => (c.req.shops ? c.req.shops.includes(s.code) : s.active));
  for (const part of c.req.parts) {
    try {
      if (part === "sales") c.stats.sales = await stepSales(c, from, to);
      if (part === "docs") c.stats.docs = await stepDocs(c, from, to);
      if (part === "stock") c.stats.stock = await stepStock(c, to, shops);
      if (part === "controls") {
        const res = [];
        for (const d of S.dayRange(from, to)) res.push(await stepControls(c, d));
        c.stats.controls = res;
      }
      if (part === "lnp") {
        const res: Record<string, unknown> = {};
        for (const s of shops) res[s.code] = await stepPeriod(c, s, from, to);
        c.stats.lnp = res;
      }
    } catch (e) {
      if (e instanceof RequestCapError) { c.warnings.push(`${part}: request cap`); break; }
      throw e;
    }
  }
}

// ── the run row ──────────────────────────────────────────────────────────────
async function finishRun(c: Ctx, status: string, error: string | null) {
  if (!c.runId) return;
  const { error: e } = await c.admin.from("shops_reader_runs").update({
    status, error: error ? error.slice(0, 500) : null, warning: c.warnings.length ? c.warnings.join("; ").slice(0, 1000) : null,
    requests: c.client.requests, requests_by_kind: c.client.byKind, stats: c.stats,
    finished_at: toIsoNow(), duration_ms: elapsed(c),
  }).eq("id", c.runId);
  if (e) console.error("collabbox-shops: could not close the run:", e.message);
}

// ── the handler ──────────────────────────────────────────────────────────────
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
  const today = S.skopjeDate();
  const parsed = S.parseRequest(body, today);
  if (!parsed.ok) return json({ error: parsed.error }, 400);
  const r = parsed.req;

  const admin: Admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } });

  const { data: setRow } = await admin.from("app_settings").select("value").eq("key", "shops_reader").maybeSingle();
  const settings = ((setRow as { value?: Settings } | null)?.value ?? {}) as Settings;
  if (r.trigger === "cron" && !settings.enabled) return json({ ok: true, skipped: "disabled", mode: r.mode });
  if (r.mode === "backfill" && r.trigger === "cron" && !settings.backfill?.enabled) return json({ ok: true, skipped: "backfill_disabled" });

  const { data: shopRows, error: shopErr } = await admin.from("shops")
    .select("code, name, collabbox_magid, collabbox_name, active").order("sort");
  if (shopErr) return json({ ok: false, error: `shops: ${shopErr.message}` }, 500);
  const shops = ((shopRows ?? []) as Shop[]).filter((s) => S.SHOP_MAGIDS[s.code] === s.collabbox_magid);
  if (!shops.length) return json({ ok: false, error: "no shop with a known collabBox magid" }, 500);

  if (!r.dry) {
    // housekeeping + one run at a time, and never alongside collabbox-sync (the same collabBox login)
    await admin.from("shops_reader_runs").update({
      status: "failed", error: "abandoned — the invocation never finished (timeout or crash)", finished_at: toIsoNow(),
    }).eq("status", "running").lt("started_at", new Date(Date.now() - RUNNING_STALE_MS).toISOString());
    const { data: busy } = await admin.from("shops_reader_runs").select("id").eq("status", "running").limit(1);
    if (busy?.length) return json({ ok: false, skipped: "already_running", mode: r.mode }, 409);
    const { data: syncBusy } = await admin.from("collabbox_sync_runs").select("id").eq("status", "running")
      .gt("started_at", new Date(Date.now() - RUNNING_STALE_MS).toISOString()).limit(1);
    if (syncBusy?.length) return json({ ok: false, skipped: "collabbox_sync_running", mode: r.mode }, 409);
  }

  let runId: string | null = null;
  if (!r.dry) {
    const { data, error } = await admin.from("shops_reader_runs").insert({
      mode: r.mode, trigger_kind: r.trigger, status: "running",
      window_from: r.from ?? (r.mode === "sales" ? today : r.mode === "docs" ? S.addDays(today, -1) : today), window_to: r.to ?? today,
    }).select("id").single();
    if (error || !data) return json({ ok: false, error: `shops_reader_runs insert: ${error?.message ?? "no row"}` }, 500);
    runId = (data as { id: string }).id;
  }

  const cap = r.mode === "backfill"
    ? Math.min(MAX_BACKFILL_REQUESTS, Math.max(10, Number(settings.backfill?.max_requests) || CAPS.backfill))
    : CAPS[r.mode];
  const c: Ctx = {
    admin, req: r, runId, startedMs: Date.now(), shops, settings, warnings: [], stats: {}, today,
    client: new ShopsClient({
      fetch: fetch as unknown as FetchLike, user, pass, pauseMs: PAUSE_MS, maxRequests: cap,
      log: (line) => console.log(`collabbox-shops ${r.mode}: ${S.redact(line)}`),
    }),
  };

  const work = async (): Promise<Response> => {
    try {
      await c.client.login();
      if (r.mode === "sales") await runSales(c);
      else if (r.mode === "docs") await runDocs(c);
      else if (r.mode === "nightly") await runNightly(c);
      else if (r.mode === "backfill") await runBackfill(c);
      else await runManual(c);
      const status = c.warnings.length ? "partial" : "ok";
      await finishRun(c, status, null);
      console.log(`collabbox-shops ${r.mode}: ${status} requests=${c.client.requests} ${JSON.stringify(c.client.byKind)}`);
      return json({ ok: true, mode: r.mode, dry: r.dry, run_id: runId, status, requests: c.client.requests,
                    requests_by_kind: c.client.byKind, warnings: c.warnings, stats: c.stats });
    } catch (e) {
      const msg = errText(e);
      console.error(`collabbox-shops ${r.mode}: failed — ${msg}`);
      await finishRun(c, "failed", msg);
      return json({ ok: false, mode: r.mode, dry: r.dry, run_id: runId, error: msg, requests: c.client.requests, stats: c.stats }, 502);
    }
  };

  if (!r.wait) {
    const p = work().catch((e) => console.error("collabbox-shops background:", errText(e)));
    // deno-lint-ignore no-explicit-any
    (globalThis as any).EdgeRuntime?.waitUntil?.(p);
    return json({ ok: true, accepted: true, mode: r.mode, run_id: runId }, 202);
  }
  return await work();
});
