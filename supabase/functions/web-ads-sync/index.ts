/**
 * web-ads-sync — naturatherapy.mk Meta ad spend, ad names and customers into the CRM
 * (owner 15.10.2026, the Web page; migration 20261016130000_web_page.sql).
 *
 *   POST /functions/v1/web-ads-sync
 *   header: x-web-sync-secret: <WEB_SYNC_SECRET>          (the same secret as web-sync)
 *   body:   {}                         ads: the last 4 days · names · customers incremental
 *           { days: 35 }               ads: the last 35 days (pg_cron, nightly — Meta revises)
 *           { since: "2025-01-01" }    ads: everything from that day (a one-off backfill)
 *           { customers: false }       skip the customers feed
 *           { customers_full: true }   re-read every customer (cursor from the start)
 *           { dry: true }              read + count, write NOTHING
 *
 * Reads the shop ONLY through the read-only export crm_export (supabase/shop-side/
 * crm_export_tenant2.sql, approval 2 of 15.10.2026: mk_ad_spend, mk_ad_entities, mk_customers) as
 * the login role elyon_crm_reader, inside READ ONLY transactions — the same connection rules as
 * web-sync (WEB_SHOP_DB_URL must be that role on the shop project; never an Elyon CRM). It never
 * writes to the shop. Writes here go through web_ad_spend_replace / web_ad_entities_upsert /
 * web_customers_upsert, and each feed leaves a row in web_feed_runs.
 *
 * Ad spend is REPLACED per window (≤ 31 days per call): the shop itself re-reads Meta's last 3
 * days every hour, so a day's rows can change; a window replace keeps the mirror exact. Customers
 * are incremental by the shop's (updatedAt, id) with a 10-minute overlap (monotonic upsert).
 */
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Client } from "https://deno.land/x/postgres@v0.19.3/mod.ts";

const SHOP_REF = "kctgthpoeysmhmkrnkil";
const READER = "elyon_crm_reader";
const TENANT_SLUG = "naturatherapy-mk";
const FORBIDDEN_REFS = ["bmfxhgznttcnnlqloqzp", "oufoazmnbwugtfldkwsn", "sxymaloycddnoxudxaqp"]; // Elyon CRMs + live Bulgaria
const WINDOW_DAYS = 31;              // ad-spend days per replace call (the writer allows 63)
const CUSTOMER_PAGE = 2000;
const MAX_CUSTOMER_PAGES = 15;       // ≤ 30.000 per call (MK has ~17.000)
const TIME_BUDGET_MS = 110_000;
const OVERLAP_MS = 10 * 60_000;
const EPOCH = "1970-01-01T00:00:00.000Z";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function safeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  const n = Math.max(ea.length, eb.length);
  for (let i = 0; i < n; i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

/** WEB_SHOP_DB_URL → deno-postgres options — the same rules as web-sync's: only
 *  elyon_crm_reader on the shop project passes, always TLS. */
function shopConnectionOptions(raw: string | undefined, ca: string | undefined) {
  if (!raw) throw new Error("WEB_SHOP_DB_URL is not set");
  for (const ref of FORBIDDEN_REFS) {
    if (raw.includes(ref)) throw new Error("WEB_SHOP_DB_URL points at an Elyon CRM project, not the shop — refusing");
  }
  let u: URL;
  try { u = new URL(raw); } catch { throw new Error("WEB_SHOP_DB_URL is not a valid URL"); }
  if (u.protocol !== "postgres:" && u.protocol !== "postgresql:") throw new Error("WEB_SHOP_DB_URL must be a postgres:// URL");
  const user = decodeURIComponent(u.username);
  const host = u.hostname.toLowerCase();
  const viaPooler = /^aws-[0-9]+-[a-z0-9-]+\.pooler\.supabase\.com$/.test(host) && user === `${READER}.${SHOP_REF}`;
  const direct = host === `db.${SHOP_REF}.supabase.co` && user === READER;
  if (!viaPooler && !direct) {
    throw new Error(`WEB_SHOP_DB_URL must log in as ${READER} to the shop project ${SHOP_REF} — refusing`);
  }
  const password = decodeURIComponent(u.password);
  if (!password) throw new Error("WEB_SHOP_DB_URL has no password");
  return {
    hostname: host,
    port: Number(u.port || 5432),
    user,
    password,
    database: decodeURIComponent(u.pathname.replace(/^\//, "")) || "postgres",
    applicationName: "elyon-crm-web-ads-sync",
    connection: { attempts: 1 },
    tls: { enabled: true, enforce: true, caCertificates: ca ? [ca] : [] },
  };
}

const TS = (c: string) => `to_char((${c}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const SQL_SPEND = `SELECT tenant_slug, day::text AS day, ad_id, adset_id, campaign_id, account_id, purpose, currency,
    spend::text AS spend, fx_rate::text AS fx_rate, impressions, link_clicks, meta_purchases, ${TS("fetched_at")} AS fetched_at
  FROM crm_export.mk_ad_spend($1::date, $2::date)`;
const SQL_ENTITIES = `SELECT tenant_slug, id, kind, name, status, account_id, ${TS("fetched_at")} AS fetched_at
  FROM crm_export.mk_ad_entities()`;
const SQL_CUSTOMERS = `SELECT shop_customer_id, tenant_slug, email, phone, first_name, city, orders_count,
    total_spent::text AS total_spent, marketing_opt_in, has_account, loyalty_balance,
    ${TS("created_at")} AS created_at, ${TS("updated_at")} AS updated_at
  FROM crm_export.mk_customers($1::timestamptz, $2::int, $3::int)
  ORDER BY updated_at, shop_customer_id`;

type Row = Record<string, unknown> & { tenant_slug: string };

const ymd = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (day: string, n: number) => { const d = new Date(`${day}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return ymd(d); };

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
  const dry = body.dry === true;
  const today = ymd(new Date());
  const since = typeof body.since === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.since) ? body.since : null;
  const days = Math.min(Math.max(Number(body.days) || 4, 1), 800);
  const from = since ?? addDays(today, -(days - 1));
  const withCustomers = body.customers !== false;
  const customersFull = body.customers_full === true;

  const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } });
  const started = Date.now();
  const out: Record<string, unknown> = { dry, window: [from, today] };

  const runStart = async (feed: string, extra: Record<string, unknown> = {}) => {
    if (dry) return null;
    const { data } = await admin.from("web_feed_runs").insert({ feed, status: "running", ...extra }).select("id").single();
    return (data?.id as string | undefined) ?? null;
  };
  const runEnd = async (id: string | null, patch: Record<string, unknown>) => {
    if (!id) return;
    await admin.from("web_feed_runs").update({ ...patch, finished_at: new Date().toISOString() }).eq("id", id);
  };
  const rpc = async (fn: string, args: Record<string, unknown>) => {
    const { data, error } = await admin.rpc(fn, args);
    if (error) throw new Error(`${fn}: ${error.message}`);
    return data as Record<string, unknown>;
  };
  const foreign = (rows: Row[]) => rows.some((r) => r.tenant_slug !== TENANT_SLUG);

  const shop = new Client(shopOpts);
  try {
    await shop.connect();

    // ── names (small: every call) ──
    {
      const id = await runStart("entities");
      try {
        const tx = shop.createTransaction("web_ads_entities", { isolation_level: "repeatable_read", read_only: true });
        await tx.begin();
        const rows = (await tx.queryObject<Row>(SQL_ENTITIES)).rows;
        await tx.commit();
        if (foreign(rows)) throw new Error("a foreign-tenant row in mk_ad_entities — refusing");
        const w = dry ? { written: 0 } : await rpc("web_ad_entities_upsert", { p_rows: rows });
        out.entities = { read: rows.length, written: w.written };
        await runEnd(id, { status: "ok", rows_read: rows.length, rows_written: Number(w.written) || 0 });
      } catch (e) {
        out.entities = { error: (e as Error).message };
        await runEnd(id, { status: "failed", error: (e as Error).message.slice(0, 500) });
      }
    }

    // ── ad spend: replace window by window (oldest first) ──
    {
      const id = await runStart("ads", { window_from: from, window_to: today });
      let read = 0, written = 0, windows = 0;
      let partial = false;
      try {
        for (let a = from; a <= today; a = addDays(a, WINDOW_DAYS)) {
          if (Date.now() - started > TIME_BUDGET_MS) { partial = true; break; }
          const b = [addDays(a, WINDOW_DAYS - 1), today].sort()[0];
          const tx = shop.createTransaction(`web_ads_spend_${windows}`, { isolation_level: "repeatable_read", read_only: true });
          await tx.begin();
          const rows = (await tx.queryObject<Row>({ text: SQL_SPEND, args: [a, b] })).rows;
          await tx.commit();
          if (foreign(rows)) throw new Error("a foreign-tenant row in mk_ad_spend — refusing");
          read += rows.length; windows++;
          if (!dry) {
            const w = await rpc("web_ad_spend_replace", { p_from: a, p_to: b, p_rows: rows });
            written += Number(w.written) || 0;
          }
        }
        out.ads = { read, written, windows, partial };
        await runEnd(id, { status: partial ? "partial" : "ok", rows_read: read, rows_written: written, stats: { windows } });
      } catch (e) {
        out.ads = { error: (e as Error).message, read, written, windows };
        await runEnd(id, { status: "failed", rows_read: read, rows_written: written, error: (e as Error).message.slice(0, 500) });
      }
    }

    // ── customers: incremental by (updatedAt, id) ──
    if (withCustomers) {
      let cursor = { ts: EPOCH, id: 0 };
      if (!customersFull) {
        const { data: last } = await admin.from("web_feed_runs").select("status, cursor_ts, cursor_id")
          .eq("feed", "customers").in("status", ["ok", "partial"]).not("cursor_ts", "is", null)
          .order("started_at", { ascending: false }).limit(1);
        const c = last?.[0];
        if (c?.cursor_ts) {
          const at = Date.parse(String(c.cursor_ts));
          cursor = c.status === "partial"
            ? { ts: new Date(at).toISOString(), id: Number(c.cursor_id) || 0 }
            : { ts: new Date(at - OVERLAP_MS).toISOString(), id: 0 };
        }
      }
      const id = await runStart("customers");
      let read = 0, written = 0, pages = 0, done = false;
      let last = cursor;
      try {
        while (pages < MAX_CUSTOMER_PAGES && Date.now() - started < TIME_BUDGET_MS) {
          const tx = shop.createTransaction(`web_customers_${pages}`, { isolation_level: "repeatable_read", read_only: true });
          await tx.begin();
          const rows = (await tx.queryObject<Row & { shop_customer_id: number; updated_at: string }>({
            text: SQL_CUSTOMERS, args: [last.ts, last.id, CUSTOMER_PAGE],
          })).rows;
          await tx.commit();
          pages++;
          if (foreign(rows)) throw new Error("a foreign-tenant row in mk_customers — refusing");
          read += rows.length;
          if (rows.length && !dry) {
            const w = await rpc("web_customers_upsert", { p_rows: rows });
            written += Number(w.written) || 0;
          }
          if (rows.length) {
            const r = rows[rows.length - 1];
            last = { ts: r.updated_at, id: r.shop_customer_id };
          }
          if (rows.length < CUSTOMER_PAGE) { done = true; break; }
        }
        out.customers = { read, written, pages, done, from: cursor.ts };
        await runEnd(id, { status: done ? "ok" : "partial", rows_read: read, rows_written: written,
                           cursor_ts: last.ts === EPOCH ? null : last.ts, cursor_id: last.id, stats: { pages, from: cursor.ts } });
      } catch (e) {
        out.customers = { error: (e as Error).message, read, written, pages };
        await runEnd(id, { status: "failed", rows_read: read, rows_written: written, error: (e as Error).message.slice(0, 500) });
      }
    }
  } catch (e) {
    try { await shop.end(); } catch { /* ignore */ }
    return json({ ok: false, error: (e as Error).message, ...out }, 502);
  }
  try { await shop.end(); } catch { /* ignore */ }
  const failed = ["entities", "ads", "customers"].some((k) => (out[k] as Record<string, unknown> | undefined)?.error);
  return json({ ok: !failed, ms: Date.now() - started, ...out }, failed ? 500 : 200);
});
