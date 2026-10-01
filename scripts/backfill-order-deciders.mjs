#!/usr/bin/env node
/**
 * Backfill orders.sold_at / sold_by_person_id / sold_via / sold_by_ext —
 * WHO made each order a sale (migration 20260935000100).
 *
 *   node scripts/backfill-order-deciders.mjs                       # DRY RUN: coverage + CSVs
 *   node scripts/backfill-order-deciders.mjs --apply               # stamp every resolvable order
 *   node scripts/backfill-order-deciders.mjs --apply --limit 500   # smoke test
 *   options: --chunk <n> (default 2000) · --page <n> (default 5000) · --pause-ms <n> (default 250)
 *
 * Run AFTER: both migrations, scripts/backfill-sale-source.mjs --apply and
 * scripts/seed-sales-people.mjs --apply (without people nothing resolves to a
 * person; the run still stamps sold_at / sold_via / sold_by_ext, and a later
 * run can never re-stamp — so seed first).
 *
 * ── Which orders ─────────────────────────────────────────────────────────────
 * A real sale that has no sold_at yet: price > 0, not a synthetic product (the
 * isRealSale test mex-reconcile uses), not an unworked `duplicated` copy — and
 * it IS or WAS a sale: a sale status now, OR order_history shows it became one
 * (that first step counts only when a person took it or the order still holds a
 * parcel — owner 01.10.2026, migration 20260944001200: an undone System (mex) flip
 * is no sale), OR AlterCPA approved it (incl. cancel-other, the 2026-08-11 manager rule).
 * The last two keep a sale that was later cancelled — e.g. the 345 no-parcel
 * approvals — credited to whoever approved it. That is the point: the boards
 * must show "approved, never shipped" per operator.
 *
 * ── Who decided (first rule that applies) ────────────────────────────────────
 *   collabbox_author   sale_source collabbox → the document author
 *                      (confirmed_by_name = collabBox Avtor)          sold_via collabbox
 *   history_import     altercpa/history (not a duplicate) → the operator the
 *                      2026-08 import wrote (confirmed_by_name; 'Import' /
 *                      'System' placeholders fall back to assigned_agent_name)
 *                                                                      sold_via import
 *                      An import row that names nobody is reported, not stamped.
 *   crm_decided        the order's FIRST transition into a sale status in
 *                      order_history was made by a person (not 'System (…)')
 *                      → that person                                  sold_via crm
 *                      …and when a real (non-noop) CRM APPROVAL push to
 *                      AlterCPA (params.accept = '1') lands within 15 min
 *                      before / 5 min after AlterCPA's approval, AlterCPA's
 *                      approval is the MIRROR of this CRM decision
 *                                                                      sold_via crm_push
 *   altercpa_ledger    otherwise, an AlterCPA-sourced order their operator
 *                      approved (approved | cancel_other) → the ledger's
 *                      decided_by_altercpa_user                        sold_via altercpa
 *                      …with an approval push in that window but no CRM
 *                      decision row → the agent the push's comment names
 *                      ("Agent: <name> — …"), by the order_name identity;
 *                      a push naming nobody is reported     sold_via crm_push
 *   crm_confirmer      no order_history at all (pre-history rows), not an
 *                      AlterCPA order → the recorded confirmer (id, else
 *                      exact name)                                     sold_via crm
 * Anything else stays NULL and is reported by bucket — notably AlterCPA leads
 * THEY cancelled that MEX later delivered (first sale = System (mex…)): the
 * seller is not in our data.
 *
 * The first-transition rule is what keeps a warehouse user who later moved an
 * AlterCPA-approved order to `shipped` (the status PATCH then fills
 * confirmed_by_*) from being credited with the sale. Pushes are made by admins;
 * the push rule credits the CRM agent who decided, not the admin who pressed it
 * (their comment reads "Agent: <name>" for exactly that reason). Callback and
 * cancel pushes never count (stamp review 2026-09-28, defect 1).
 * KEEP IN STEP with order_decider_plan() — the cron's copy, last re-emitted in
 * supabase/migrations/20260944001200_decider_plan_first_sale_proof.sql (first in
 * 20260939000300_stamp_deciders_cron.sql); verify-stamp-parity.mjs reads the newest.
 *
 * sold_by_ext keeps the raw key (AlterCPA user id, operator name, collabBox
 * author) even when no person matches, so once the owner names e.g. AlterCPA
 * #4429 a person can be filled in — sold_* are write-once per column, so a
 * NULL person may still be filled later while nothing set is ever overwritten.
 *
 * ── Apply ────────────────────────────────────────────────────────────────────
 * The plan is recomputed at apply time (never read back from a CSV). Chunks of
 * --chunk orders, each ONE implicit transaction with SET LOCAL
 * session_replication_role = replica (trg_orders_updated_at must not bump
 * updated_at — GET /call-agains shows it as last_call_at; the pattern of
 * scripts/backfill-cpa-attribution.mjs). Replica mode also skips FK checks, so
 * the UPDATE itself re-checks that every person id exists. Guarded by
 * sold_at IS NULL: idempotent, never overwrites the live trigger's stamp.
 *
 * 🛑 MACEDONIA ONLY (same guards as scripts/lib/repair-kit.mjs). The token is
 * never printed.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MK_REF = 'bmfxhgznttcnnlqloqzp';
const BG_REF = 'sxymaloycddnoxudxaqp'; // live Bulgaria — never a target, never touched
const EXPORT_DIR = join(ROOT, 'exports', 'attribution');
const REAL = "('confirmed','shipped','delivered','paid','returned')";

const paint = (code) => (s) => (process.stdout.isTTY ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const red = paint(31); const green = paint(32); const yellow = paint(33); const cyan = paint(36); const bold = paint(1); const dim = paint(90);
const num = (n) => Number(n ?? 0).toLocaleString('de-DE');
const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(1).replace('.', ',')}%` : '—');

class Refusal extends Error {}
const refuse = (m) => { throw new Refusal(m); };

// ── Guard + Management API (CLI only; tests inject their own sql) ────────────
export function mkApi() {
  const toml = readFileSync(join(ROOT, 'supabase', 'config.toml'), 'utf8');
  const ref = toml.match(/^\s*project_id\s*=\s*"([^"]+)"/m)?.[1];
  if (ref !== MK_REF) refuse(`supabase/config.toml project_id = "${ref}", expected "${MK_REF}" — refusing.`);
  if (toml.includes(BG_REF)) refuse('supabase/config.toml mentions the LIVE BULGARIAN project — refusing.');
  let envText = '';
  try { envText = readFileSync(join(ROOT, '.env'), 'utf8'); } catch { /* .env optional when exported */ }
  if (envText.includes(BG_REF)) refuse('.env mentions the LIVE BULGARIAN project — refusing.');
  const env = {};
  for (const line of envText.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/);
    if (m) env[m[1]] = m[2];
  }
  for (const k of ['SUPABASE_URL', 'VITE_SUPABASE_URL', 'VITE_SUPABASE_PROJECT_ID']) {
    const v = process.env[k] || env[k];
    if (v && v.includes(BG_REF)) refuse(`${k} points at LIVE BULGARIA — refusing.`);
    if (v && !v.includes(MK_REF)) refuse(`${k} does not point at ${MK_REF} — refusing.`);
  }
  const token = process.env.SUPABASE_ACCESS_TOKEN || env.SUPABASE_ACCESS_TOKEN;
  if (!token) refuse('SUPABASE_ACCESS_TOKEN missing (set it in .env).');
  async function sql(query, { readOnly = false } = {}) {
    const attempts = readOnly ? 4 : 1;
    let lastErr;
    for (let i = 1; i <= attempts; i++) {
      try {
        const res = await fetch(`https://api.supabase.com/v1/projects/${MK_REF}/database/query`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(readOnly ? { query, read_only: true } : { query }),
        });
        const text = await res.text();
        if (!res.ok) { const err = new Error(`Management API ${res.status}: ${text.slice(0, 1500)}`); err.status = res.status; throw err; }
        if (!text) return [];
        const json = JSON.parse(text);
        return Array.isArray(json) ? json : [];
      } catch (e) {
        lastErr = e;
        const transient = !e.status || e.status >= 500 || e.status === 429 || e.status === 408;
        if (i < attempts && transient) { await new Promise((r) => setTimeout(r, 1500 * i)); continue; }
        throw e;
      }
    }
    throw lastErr;
  }
  return { sql, sqlRead: (q) => sql(q, { readOnly: true }) };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const q = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/\u0000/g, '').replace(/'/g, "''")}'`);
const qUuid = (v) => {
  if (v === null || v === undefined) return 'NULL::uuid';
  if (!UUID_RE.test(String(v))) throw new Error(`not a uuid: ${String(v).slice(0, 60)}`);
  return `'${String(v).toLowerCase()}'::uuid`;
};
const qTs = (v) => {
  if (v === null || v === undefined) return 'NULL::timestamptz';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new Error(`not a timestamp: ${String(v).slice(0, 60)}`);
  return `'${d.toISOString()}'::timestamptz`;
};

function parseArgs(argv) {
  const a = { apply: false, limit: 0, chunk: 2000, page: 5000, pauseMs: 250 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const val = () => { const v = Number(argv[++i]); if (!Number.isFinite(v) || v < 0) refuse(`${k} needs a number`); return Math.floor(v); };
    if (k === '--apply') a.apply = true;
    else if (k === '--limit') a.limit = val();
    else if (k === '--chunk') a.chunk = Math.min(5000, Math.max(100, val()));
    else if (k === '--page') a.page = Math.min(20000, Math.max(500, val()));
    else if (k === '--pause-ms') a.pauseMs = val();
    else if (k === '--help' || k === '-h') a.help = true;
    else refuse(`unknown argument ${k}`);
  }
  return a;
}

// ── the plan, one keyset page of candidate orders at a time ──────────────────
// Candidates = real sales without sold_at (price > 0, not synthetic, not an
// unworked duplicate); the "is or was a sale" gate is applied after the joins.
// Returns ONE row: {page_last, page_n, rows: [...]} so an all-filtered page
// still advances the keyset.
export function planPageSql(after, pageSize) {
  const byName = (kinds, nameExpr) => `(SELECT i.person_id FROM public.sales_person_identities i
            WHERE i.account_id IS NULL AND i.value = ${nameExpr} AND i.kind = ANY (ARRAY[${kinds.map((k) => `'${k}'`).join(', ')}])
            ORDER BY array_position(ARRAY[${kinds.map((k) => `'${k}'`).join(', ')}], i.kind) LIMIT 1)`;
  const byUser = (uidExpr) => `(SELECT sp.id FROM public.sales_people sp WHERE sp.user_id = ${uidExpr})`;
  return `
WITH o AS (
  SELECT o.id, o.display_id, o.status::text AS status, o.price, o.duplicated_from,
         o.confirmed_by_agent_id, o.confirmed_by_name, o.assigned_agent_name, o.confirmed_at, o.created_at,
         o.mex_tracking_id,
         coalesce(o.sale_source, cl.c[1]) AS src,
         coalesce(o.sale_source_detail, cl.c[2]) AS det
    FROM public.orders o
    CROSS JOIN LATERAL (SELECT public.classify_sale_source(o.source_type, o.external_source, o.external_order_id,
                                                           o.prediction_list_id, o.price, o.product_name) AS c) cl
   WHERE o.sold_at IS NULL
     AND coalesce(o.price, 0) > 0
     AND NOT public.is_synthetic_product_name(o.product_name)
     AND o.status::text <> 'duplicated'
     ${after ? `AND o.id > ${qUuid(after)}` : ''}
   ORDER BY o.id
   LIMIT ${Number(pageSize)}
), fr AS (
  -- the FIRST transition into a sale status, and who made it
  SELECT DISTINCT ON (h.order_id) h.order_id, h.changed_at, h.changed_by, h.changed_by_name,
         (coalesce(h.changed_by_name, '') NOT LIKE 'System (%'
          AND coalesce(h.changed_by_name, '') NOT LIKE '% — %'
          AND (h.changed_by IS NOT NULL OR h.changed_by_name IS NOT NULL)) AS human
    FROM public.order_history h
    JOIN o ON o.id = h.order_id
   WHERE h.to_status::text IN ${REAL}
     AND (h.from_status IS NULL OR h.from_status::text NOT IN ${REAL})
   ORDER BY h.order_id, h.changed_at, h.id
), led AS (
  SELECT DISTINCT ON (l.order_id) l.order_id, l.account_id, l.decision, l.decided_by_altercpa_user, l.decided_at
    FROM public.altercpa_leads l
    JOIN o ON o.id = l.order_id
   ORDER BY l.order_id, l.last_seen_at DESC
), push AS (
  -- a real CRM APPROVAL push of this order (params.accept = '1') landing
  -- around AlterCPA's decision, and the agent its comment names
  SELECT DISTINCT ON (led.order_id) led.order_id, a.actor_id, a.created_at, p.full_name AS actor_name,
         nullif(btrim(split_part(substring(a.payload -> 'params' ->> 'comment' FROM '^Agent: (.*)$'), ' — ', 1)), '')
           AS agent_name
    FROM led
    JOIN public.audit_log a
      ON a.target_type = 'order' AND a.target_id = led.order_id::text
     AND a.action = 'order.altercpa_push'
     AND (a.payload ->> 'noop') IS DISTINCT FROM 'true'
     AND a.payload -> 'params' ->> 'accept' = '1'
     AND a.created_at BETWEEN led.decided_at - interval '15 minutes' AND led.decided_at + interval '5 minutes'
    LEFT JOIN public.profiles p ON p.user_id = a.actor_id
   WHERE led.decided_at IS NOT NULL
   ORDER BY led.order_id, abs(extract(epoch FROM (a.created_at - led.decided_at)))
), x AS (
  SELECT o.*,
         (fr.order_id IS NOT NULL) AS has_fr, coalesce(fr.human, false) AS fr_human,
         fr.changed_at AS fr_at, fr.changed_by AS fr_by, fr.changed_by_name AS fr_name,
         (led.order_id IS NOT NULL) AS has_led, led.account_id, led.decision,
         led.decided_by_altercpa_user AS alt_user, led.decided_at,
         push.actor_id AS push_by, push.actor_name AS push_name, push.agent_name AS push_agent,
         (o.mex_tracking_id IS NOT NULL
          OR EXISTS (SELECT 1 FROM public.mex_parcels mp WHERE mp.order_id = o.id)) AS holds_parcel,
         CASE WHEN lower(btrim(coalesce(o.confirmed_by_name, ''))) IN ('', 'import', 'system')
              THEN nullif(btrim(o.assigned_agent_name), '')
              ELSE o.confirmed_by_name END AS hist_name
    FROM o
    LEFT JOIN fr   ON fr.order_id = o.id
    LEFT JOIN led  ON led.order_id = o.id
    LEFT JOIN push ON push.order_id = o.id
), r AS (
  SELECT x.*,
    CASE
      -- Imports name their operator or they have no decider: a nameless row is
      -- reported, never stamped with an empty key.
      WHEN src = 'collabbox' AND nullif(btrim(confirmed_by_name), '') IS NOT NULL THEN 'collabbox_author'
      WHEN src = 'altercpa' AND det = 'history' AND duplicated_from IS NULL AND hist_name IS NOT NULL THEN 'history_import'
      WHEN fr_human THEN CASE WHEN push_by IS NOT NULL AND decision IN ('approved', 'cancel_other')
                              THEN 'crm_decided_pushed' ELSE 'crm_decided' END
      -- An approval push naming no agent stays unresolved: the manager who
      -- pressed it is not the seller.
      WHEN src = 'altercpa' AND decision IN ('approved', 'cancel_other')
        THEN CASE WHEN push_by IS NULL THEN 'altercpa_ledger'
                  WHEN push_agent IS NOT NULL THEN 'crm_push_only' END
      -- Pre-history rows only, and never an AlterCPA order: a confirmer recorded
      -- on those can be whoever moved the parcel on, not who sold it.
      WHEN NOT has_fr AND src <> 'altercpa' AND confirmed_by_agent_id IS NOT NULL THEN 'crm_confirmer'
      WHEN NOT has_fr AND src = 'elyon_crm' AND nullif(btrim(confirmed_by_name), '') IS NOT NULL THEN 'crm_confirmer'
    END AS rule
    FROM x
   -- 2026-10-01 (owner, migration 20260944001200): a first step into a sale counts only when a
   -- person took it or the order still holds a parcel — an undone System (mex) flip is no sale
   WHERE status IN ${REAL} OR (has_fr AND (fr_human OR holds_parcel)) OR (src = 'altercpa' AND decision IN ('approved', 'cancel_other'))
), s AS (
  SELECT r.id, r.display_id, r.src, r.det, r.status, r.rule,
    CASE r.rule
      WHEN 'collabbox_author'   THEN 'collabbox'
      WHEN 'history_import'     THEN 'import'
      WHEN 'crm_decided'        THEN 'crm'
      WHEN 'crm_decided_pushed' THEN 'crm_push'
      WHEN 'crm_push_only'      THEN 'crm_push'
      WHEN 'altercpa_ledger'    THEN 'altercpa'
      WHEN 'crm_confirmer'      THEN 'crm'
    END AS via,
    CASE r.rule
      WHEN 'collabbox_author'   THEN coalesce(r.confirmed_at, r.created_at)
      WHEN 'history_import'     THEN coalesce(r.confirmed_at, r.created_at)
      WHEN 'crm_decided'        THEN r.fr_at
      WHEN 'crm_decided_pushed' THEN r.fr_at
      WHEN 'crm_push_only'      THEN r.decided_at
      WHEN 'altercpa_ledger'    THEN r.decided_at
      WHEN 'crm_confirmer'      THEN coalesce(r.confirmed_at, r.created_at)
    END AS sold_at,
    CASE r.rule
      WHEN 'collabbox_author'   THEN ${byName(['collabbox_author', 'order_name'], 'r.confirmed_by_name')}
      WHEN 'history_import'     THEN ${byName(['order_name', 'collabbox_author'], 'r.hist_name')}
      WHEN 'crm_decided'        THEN coalesce(${byUser('r.fr_by')}, ${byName(['order_name'], 'r.fr_name')})
      WHEN 'crm_decided_pushed' THEN coalesce(${byUser('r.fr_by')}, ${byName(['order_name'], 'r.fr_name')})
      WHEN 'crm_push_only'      THEN ${byName(['order_name'], 'r.push_agent')}
      WHEN 'altercpa_ledger'    THEN (SELECT i.person_id FROM public.sales_person_identities i
                                       WHERE i.kind = 'altercpa_user' AND i.account_id = r.account_id
                                         AND i.value = r.alt_user::text)
      WHEN 'crm_confirmer'      THEN coalesce(${byUser('r.confirmed_by_agent_id')}, ${byName(['order_name'], 'r.confirmed_by_name')})
    END AS person_id,
    CASE r.rule
      WHEN 'collabbox_author'   THEN r.confirmed_by_name
      WHEN 'history_import'     THEN r.hist_name
      WHEN 'crm_decided'        THEN coalesce(r.fr_name, r.fr_by::text)
      WHEN 'crm_decided_pushed' THEN coalesce(r.fr_name, r.fr_by::text)
      WHEN 'crm_push_only'      THEN r.push_agent
      WHEN 'altercpa_ledger'    THEN r.alt_user::text
      WHEN 'crm_confirmer'      THEN coalesce(nullif(btrim(r.confirmed_by_name), ''), r.confirmed_by_agent_id::text)
    END AS ext,
    CASE WHEN r.rule IS NULL THEN concat_ws(' · ',
      r.src || '/' || r.det,
      'AlterCPA ' || coalesce(r.decision, CASE WHEN r.has_led THEN 'open' ELSE 'no ledger row' END),
      CASE WHEN r.src = 'collabbox' OR (r.src = 'altercpa' AND r.det = 'history' AND r.duplicated_from IS NULL)
           THEN 'no operator name on the import' END,
      CASE WHEN r.push_by IS NOT NULL AND r.push_agent IS NULL THEN 'approval pushed naming no agent' END,
      'first sale by ' || CASE WHEN NOT r.has_fr THEN 'nobody on record'
                               ELSE regexp_replace(coalesce(r.fr_name, '?'), '^System \\(([^:)]*).*$', 'System (\\1)') END)
    END AS bucket
  FROM r
)
SELECT (SELECT id::text FROM o ORDER BY id DESC LIMIT 1) AS page_last,
       (SELECT count(*) FROM o)::int AS page_n,
       coalesce((SELECT json_agg(json_build_object(
          'id', s.id, 'display_id', s.display_id, 'src', s.src, 'det', s.det, 'status', s.status,
          'rule', s.rule, 'via', s.via, 'sold_at', s.sold_at, 'person_id', s.person_id,
          'ext', s.ext, 'bucket', s.bucket)) FROM s), '[]'::json) AS rows;`;
}

// ── apply ────────────────────────────────────────────────────────────────────
export function applyChunkSql(rows) {
  const values = rows.map((r) => `(${qUuid(r.id)}, ${qTs(r.sold_at)}, ${qUuid(r.person_id)}, ${q(r.via)}, ${q(r.ext)})`);
  return `
SET LOCAL session_replication_role = replica;
SET LOCAL statement_timeout = '120s';
SET LOCAL lock_timeout = '10s';
WITH v(id, sold_at, person_id, via, ext) AS (VALUES
${values.join(',\n')}
), upd AS (
  UPDATE public.orders o
     SET sold_at = v.sold_at, sold_by_person_id = v.person_id, sold_via = v.via, sold_by_ext = v.ext
    FROM v
   WHERE o.id = v.id
     AND o.sold_at IS NULL
     -- replica mode skips FK triggers: re-check the person exists here
     AND (v.person_id IS NULL OR EXISTS (SELECT 1 FROM public.sales_people sp WHERE sp.id = v.person_id))
  RETURNING o.id
)
SELECT count(*)::int AS updated FROM upd;`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function withRetry(label, fn, log) {
  for (let i = 1; ; i++) {
    try { return await fn(); } catch (e) {
      const msg = String(e.message || e);
      const retryable = /lock timeout|canceling statement|deadlock|Management API (5\d\d|429|408)|fetch failed|ECONNRESET/i.test(msg);
      if (!retryable || i >= 3) throw e;
      log(yellow(`  ! ${label} failed (${msg.slice(0, 160)}) — retry ${i}/2`));
      await sleep(3000 * i);
    }
  }
}

// ── report ───────────────────────────────────────────────────────────────────
function report(plan, people, log) {
  const name = (id) => people.get(id) || id;
  const bySrc = new Map();
  for (const r of plan) {
    const k = `${r.src}/${r.det}`;
    const e = bySrc.get(k) || { n: 0, resolved: 0, person: 0, via: new Map() };
    e.n++;
    if (r.rule) { e.resolved++; e.via.set(r.via, (e.via.get(r.via) || 0) + 1); }
    if (r.person_id) e.person++;
    bySrc.set(k, e);
  }
  log(bold('\n  sale_source / detail            real sales   decider known   with a person   sold_via'));
  let tn = 0; let tr = 0; let tp = 0;
  for (const [k, e] of [...bySrc].sort((a, b) => b[1].n - a[1].n)) {
    tn += e.n; tr += e.resolved; tp += e.person;
    const via = [...e.via].sort((a, b) => b[1] - a[1]).map(([v, n]) => `${v} ${num(n)}`).join(' · ');
    log(`  ${k.padEnd(30)} ${num(e.n).padStart(10)} ${`${num(e.resolved)} ${dim(pct(e.resolved, e.n))}`.padStart(22)} ${`${num(e.person)} ${dim(pct(e.person, e.n))}`.padStart(22)}   ${via}`);
  }
  log(`  ${bold('total'.padEnd(30))} ${num(tn).padStart(10)} ${`${num(tr)} ${pct(tr, tn)}`.padStart(22)} ${`${num(tp)} ${pct(tp, tn)}`.padStart(22)}`);

  // Recent window — the era the boards and the checker (C13) care about.
  const recent = plan.filter((r) => r.src !== 'altercpa' || r.det !== 'history').filter((r) => r.src !== 'collabbox');
  const rp = recent.filter((r) => r.person_id).length;
  log(`\n  live-era sales (AlterCPA bridge + ElyonCRM): ${num(recent.length)} · with a person ${bold(num(rp))} (${pct(rp, recent.length)})`);

  const perPerson = new Map();
  for (const r of plan) if (r.person_id) perPerson.set(r.person_id, (perPerson.get(r.person_id) || 0) + 1);
  log(bold('\n  top deciders'));
  for (const [id, n] of [...perPerson].sort((a, b) => b[1] - a[1]).slice(0, 25)) log(`    ${String(name(id)).padEnd(30)} ${num(n).padStart(8)}`);

  const unresolvedExt = new Map();
  for (const r of plan) if (r.rule && !r.person_id) {
    const k = `${r.via}: ${r.ext ?? '(none)'}`;
    unresolvedExt.set(k, (unresolvedExt.get(k) || 0) + 1);
  }
  log(bold(`\n  decider known but no person — ${num(unresolvedExt.size)} keys (top 30)`));
  for (const [k, n] of [...unresolvedExt].sort((a, b) => b[1] - a[1]).slice(0, 30)) log(`    ${k.padEnd(44)} ${num(n).padStart(8)}`);

  const buckets = new Map();
  for (const r of plan) if (!r.rule) buckets.set(r.bucket, (buckets.get(r.bucket) || 0) + 1);
  log(bold(`\n  no decider in our data — left NULL (${num([...buckets.values()].reduce((a, b) => a + b, 0))})`));
  for (const [k, n] of [...buckets].sort((a, b) => b[1] - a[1])) log(`    ${num(n).padStart(7)}  ${k}`);
  return { total: tn, resolved: tr, with_person: tp, recent: recent.length, recent_with_person: rp,
    unresolved_ext: Object.fromEntries(unresolvedExt), buckets: Object.fromEntries(buckets) };
}

function writeCsv(plan, people, stamp, dir = EXPORT_DIR) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `order-deciders-${stamp}.csv`);
  const cols = ['display_id', 'sale_source', 'detail', 'status', 'rule', 'sold_via', 'person', 'sold_by_ext', 'sold_at', 'bucket'];
  const esc = (v) => { const s = String(v ?? ''); return /[",;\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const lines = plan.map((r) => [r.display_id, r.src, r.det, r.status, r.rule, r.via, r.person_id ? people.get(r.person_id) : '',
    r.ext, r.sold_at, r.bucket].map(esc).join(','));
  writeFileSync(file, '\uFEFF' + [cols.join(','), ...lines].join('\r\n') + '\r\n');
  return file;
}

// ── main ─────────────────────────────────────────────────────────────────────
export async function run({ sql, sqlRead = (qq) => sql(qq, { readOnly: true }), argv = [], log = console.log, stamp, exportDir = EXPORT_DIR }) {
  const args = parseArgs(argv);
  if (args.help) { log('usage: node scripts/backfill-order-deciders.mjs [--apply] [--limit n] [--chunk n] [--page n] [--pause-ms n]'); return { help: true }; }
  stamp = stamp || new Date().toISOString().replace(/[:.]/g, '-');
  log(bold('\nOrder deciders backfill') + ` — ${MK_REF}`);
  log(args.apply ? yellow('MODE: APPLY (writes orders.sold_*)') : cyan('MODE: dry run (read-only) — pass --apply to write'));

  const [fp] = await sqlRead(`SELECT count(*)::int AS n, count(*) FILTER (WHERE customer_phone LIKE '+359%')::int AS bg FROM public.orders;`);
  if (!fp || !fp.n) refuse('The remote has no orders — this is not the Macedonian CRM.');
  if (fp.bg / fp.n > 0.2) refuse(`The remote has ${fp.bg}/${fp.n} orders on +359 phones — this looks like LIVE BULGARIA.`);
  log(`${green('✓')} remote ${MK_REF} — ${num(fp.n)} orders, ${num(fp.bg)} on +359`);

  const [pre] = await sqlRead(`
    SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'orders' AND column_name = 'sold_by_person_id') AS has_sold,
           EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'orders' AND column_name = 'sale_source') AS has_src,
           EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'altercpa_leads' AND column_name = 'decided_by_altercpa_user') AS has_led,
           to_regprocedure('public.classify_sale_source(text,text,text,uuid,numeric,text)') IS NOT NULL AS has_fn,
           to_regclass('public.sales_people') IS NOT NULL AS has_people;`);
  if (!pre?.has_src || !pre?.has_fn) refuse('migration 20260935000000 (sale_source) is not applied — nothing to plan against.');
  if (!pre?.has_sold || !pre?.has_led || !pre?.has_people) refuse('migration 20260935000100 (sales people, orders.sold_*, ledger decisions) is not applied — nothing to plan against.');
  const [st] = await sqlRead(`
    SELECT (SELECT count(*) FROM public.orders WHERE sale_source IS NULL)::int AS unclassified,
           (SELECT count(*) FROM public.sales_people)::int AS people,
           (SELECT count(*) FROM public.sales_person_identities)::int AS identities,
           (SELECT count(*) FROM public.orders WHERE sold_at IS NOT NULL)::int AS stamped;`);
  log(`  people ${num(st.people)} · identities ${num(st.identities)} · orders already stamped ${num(st.stamped)} · unclassified orders ${num(st.unclassified)}`);
  if (st.unclassified) log(yellow(`  ! ${num(st.unclassified)} orders have no sale_source yet — planned with the classifier; run backfill-sale-source.mjs --apply first`));
  if (!st.people) log(yellow('  ! sales_people is empty — nothing will resolve to a person; run seed-sales-people.mjs --apply first'));

  const peopleRows = await sqlRead(`SELECT id::text, display_name FROM public.sales_people;`);
  const people = new Map(peopleRows.map((p) => [p.id, p.display_name]));

  // Plan, keyset page by page.
  const plan = [];
  let after = null;
  for (let i = 0; ; i++) {
    const [pg] = await sqlRead(planPageSql(after, args.page));
    const rows = typeof pg?.rows === 'string' ? JSON.parse(pg.rows) : (pg?.rows || []);
    plan.push(...rows);
    if (!pg || !pg.page_n || pg.page_n < args.page) break;
    after = pg.page_last;
  }
  log(bold(`\n── plan: ${num(plan.length)} real sales without a decider stamp ──`));
  const summary = report(plan, people, log);
  const file = writeCsv(plan, people, stamp, exportDir);
  log(`\n  plan written to ${file}`);

  if (!args.apply) { log(cyan('\nDry run complete. Review, then re-run with --apply (quiet window).\n')); return { plan, summary }; }

  // ── APPLY ─────────────────────────────────────────────────────────────────
  if (st.unclassified) refuse('orders without a sale_source remain — run scripts/backfill-sale-source.mjs --apply first.');
  const noTime = plan.filter((r) => r.rule && !r.sold_at);
  if (noTime.length) log(yellow(`  ! ${num(noTime.length)} orders have a decider but no decision time — left unstamped (e.g. ${noTime.slice(0, 5).map((r) => r.display_id).join(', ')})`));
  let todo = plan.filter((r) => r.rule && r.sold_at);
  if (args.limit) todo = todo.slice(0, args.limit);
  if (!todo.length) { log(green('\n✓ nothing to stamp.\n')); return { plan, summary, updated: 0 }; }
  log(bold(`\n── stamping ${num(todo.length)} orders, ${num(args.chunk)} per transaction ──`));
  let updated = 0;
  for (let i = 0; i < todo.length; i += args.chunk) {
    const slice = todo.slice(i, i + args.chunk);
    const [r] = await withRetry(`chunk ${1 + i / args.chunk}`, () => sql(applyChunkSql(slice)), log);
    updated += r?.updated || 0;
    if (process.stdout?.isTTY) process.stdout.write(`\r  stamped ${num(updated)} / ${num(todo.length)}   `);
    if (args.pauseMs && i + args.chunk < todo.length) await sleep(args.pauseMs);
  }
  if (process.stdout?.isTTY) process.stdout.write('\n');
  const skipped = todo.length - updated;
  log(`  stamped ${bold(num(updated))}${skipped ? yellow(` · ${num(skipped)} skipped (stamped meanwhile by the live trigger, or a person id vanished)`) : ''}`);

  const after2 = await sqlRead(`
    SELECT coalesce(sold_via, '(none)') AS via, count(*)::int AS n, count(sold_by_person_id)::int AS with_person
      FROM public.orders WHERE sold_at IS NOT NULL GROUP BY 1 ORDER BY 2 DESC;`);
  log(bold('\n  stamped now:'));
  for (const r of after2) log(`    ${r.via.padEnd(10)} ${num(r.n).padStart(8)}  with a person ${num(r.with_person).padStart(8)} (${pct(r.with_person, r.n)})`);
  log(green('\n✓ done.\n'));
  return { plan, summary, updated };
}

// ── CLI ──────────────────────────────────────────────────────────────────────
function isMain() {
  if (!process.argv[1]) return false;
  const me = fileURLToPath(import.meta.url);
  const called = resolve(process.argv[1]);
  return process.platform === 'win32' ? me.toLowerCase() === called.toLowerCase() : me === called;
}

if (isMain()) {
  try {
    const api = mkApi();
    await run({ ...api, argv: process.argv.slice(2) });
  } catch (e) {
    console.error(red(`✗ ${e instanceof Refusal ? e.message : (e.stack || e.message || e)}`));
    process.exit(1);
  }
}
