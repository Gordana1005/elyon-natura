/**
 * leads-parcel-orders — the pure half of scripts/repair-leads-parcel-orders.mjs and scripts/verify-folder-orders.mjs
 * (owner, Mile, 01.10.2026). No I/O here.
 *
 * OWNER (verbatim): "If there is delivery from MEX too or return, then of course we will import them, that way we know
 * that MEX really tried to deliver that order."
 *
 * THE RULES LIVE IN SQL, ONCE: public.leads_parcel_orders_plan(days) — migration 20260944000970. Before the migration
 * is applied the scripts run the migration FILE's plan body ("inline", cf. scripts/lib/link-lead-parcels.mjs),
 * afterwards the live function — the nightly cron and the one-off backfill are the same SELECT.
 */
import { candidateHash, fmtSkopje, fmtSkopjeDate, fmtMkd, q, qUuid } from './repair-kit.mjs';
import { functionBody } from './link-lead-parcels.mjs';

export const KEY = 'leads-parcel-orders';
export const MIGRATION = '20260944000970_leads_parcel_orders.sql';
export const PLAN_SIG = 'public.leads_parcel_orders_plan(integer)';
export const APPLY_SIG = 'public.leads_parcel_orders(boolean,integer,uuid,text)';
export const DEFAULT_DAYS = 75;
/** Read-only 01.10.2026 ~23:00 Skopje (after the 21:17 link backfill): 213 parcels → 121 orders, 92 manual. */
export const EXPECTED = Object.freeze({ parcels: 213, create: 121, manual: 92 });

/** The plan body, $1::integer inlined — ONE read-only SELECT returning `plan`. */
export function inlinePlanSql(migrationText, days = DEFAULT_DAYS) {
  const d = Number(days);
  if (!Number.isInteger(d) || d < 1 || d > 400) throw new Error(`days must be an integer 1…400 (got ${days})`);
  const body = functionBody(migrationText, 'FUNCTION public.leads_parcel_orders_plan(', '$plan$');
  const uses = body.split('$1::integer').length - 1;
  if (uses !== 1) throw new Error(`the plan body must use $1::integer exactly once (found ${uses})`);
  const sql = body.replace('$1::integer', `${d}::integer`);
  if (/\$\d/.test(sql.replace(/'(?:[^']|'')*'/g, ''))) throw new Error('an unsubstituted $n parameter is left in the plan body');
  return `SELECT (${sql.trim()}) AS plan`;
}
export const rpcPlanSql = (days = DEFAULT_DAYS) => `SELECT public.leads_parcel_orders_plan(${Number(days)}::integer) AS plan`;

const parseJson = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
export const planOf = (row) => parseJson(row?.plan);

/** The hash the plan carries must be the repair-kit's own (sha256 of the sorted lines) — the ledger's contract. */
export function planHashParity(plan) {
  const lines = (plan?.create ?? []).map((l) => l.line);
  const js = candidateHash(lines);
  return { ok: js === plan?.hash, js, sql: plan?.hash, lines };
}

/** tracking:LPO_create:paid|returned:price€:author-person|- */
export const PLAN_LINE_RE = /^\d{3}-9110-\d+\/\d{4}:LPO_create:(paid|returned):\d+\.\d{2}:([0-9a-f-]{36}|-)$/;

/** The writer's price rule (collabbox_apply_one): goods ден / 61,5 unless the COD fits neither goods nor goods + 150. */
export function writerPrice({ goodsMkd, amountMkd, nlines, codMkd }, { rate = 61.5, delivery = 150, tol = 3 } = {}) {
  const goods = Number(nlines) > 0 ? Number(goodsMkd) : Number(amountMkd);
  const cod = Number(codMkd);
  const fromCod = cod > 0 && !(Math.abs(cod - Math.round(goods)) <= tol || Math.abs(cod - Math.round(goods) - delivery) <= tol);
  const raw = fromCod ? cod / rate : goods / rate;
  return { price: Math.round(raw * 100) / 100, fromCod };
}

/** The status MEX gives the new order. Only 2 and 7 qualify — anything else is still moving (it waits). */
export function targetFor(mexStatusId) {
  const s = Number(mexStatusId);
  if (s === 2) return 'paid';
  if (s === 7) return 'returned';
  return null;
}

/** The CSV the owner reviews: one row per order to make, then one per manual parcel. Holds PII — exports/ only. */
export function planCsvRows(plan, names = new Map()) {
  const rows = [];
  for (const c of plan?.create ?? []) {
    rows.push({
      action: 'create', reason: '', tracking: c.tracking_id, mex_status: `${c.mex_status_id} ${c.mex_status_name ?? ''}`.trim(),
      cod_mkd: c.cod_mkd, parcel_created: fmtSkopje(c.created_at_mex), doc_day: fmtSkopje(c.doc_at), sale_day: fmtSkopjeDate(c.sale_at),
      target: c.target, price_eur: c.price_eur, price_from_cod: c.price_from_cod ? 'yes' : '', product: c.product_name ?? '',
      product_mapped: c.product_id ? 'yes' : 'NO', quantity: c.quantity, author: c.author ?? '',
      seller: names.get(c.author_person_id) ?? (c.author_person_id ? c.author_person_id : 'UNMAPPED'),
      customer: c.customer_name, phone: c.customer_phone, phone_source: c.phone_source,
      phone_differs_from_parcel: c.phone_differs_from_parcel ? 'yes' : '', city: c.customer_city, orders_on_phone: '',
    });
  }
  for (const m of plan?.manual ?? []) {
    const os = Array.isArray(m.orders) ? m.orders : [];
    rows.push({
      action: 'manual', reason: m.reason, tracking: m.tracking_id, mex_status: `${m.mex_status_id} ${m.mex_status_name ?? ''}`.trim(),
      cod_mkd: m.cod_mkd, parcel_created: fmtSkopje(m.created_at_mex), doc_day: fmtSkopje(m.doc_at), sale_day: '',
      target: '', price_eur: '', price_from_cod: '', product: '', product_mapped: '', quantity: '', author: m.author ?? '',
      seller: names.get(m.author_person_id) ?? '', customer: '', phone: '', phone_source: '', phone_differs_from_parcel: '', city: '',
      orders_on_phone: os.map((o) => `${o.display_id} ${o.status} ${o.sale_source}${o.tracking ? ` ${o.tracking}` : ''}${o.hours != null ? ` ${o.hours} h` : ''}`).join(' | '),
    });
  }
  return rows;
}

/** Skopje "YYYY-MM" of a timestamp. */
export const skopjeMonth = (v) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Skopje', year: 'numeric', month: '2-digit' }).format(new Date(v));

/**
 * The owner's tables: per MEX status and per author (seller) — for the whole window and for one month (by the SALE
 * day the order gets = the booking). `names` maps person id → display name.
 */
export function createTables(plan, names = new Map(), month = null) {
  const rows = (plan?.create ?? []).filter((c) => !month || skopjeMonth(c.sale_at) === month);
  const byStatus = {};
  const byAuthor = {};
  for (const c of rows) {
    byStatus[c.target] ??= { orders: 0, mkd: 0 };
    byStatus[c.target].orders++;
    byStatus[c.target].mkd += Number(c.cod_mkd) || 0;
    const who = names.get(c.author_person_id) ?? (c.author ? `${c.author} (unmapped)` : '(no author)');
    byAuthor[who] ??= { orders: 0, paid: 0, returned: 0, mkd: 0, paid_mkd: 0 };
    byAuthor[who].orders++;
    byAuthor[who][c.target]++;
    byAuthor[who].mkd += Number(c.cod_mkd) || 0;
    if (c.target === 'paid') byAuthor[who].paid_mkd += Number(c.cod_mkd) || 0;
  }
  return {
    n: rows.length,
    mkd: rows.reduce((s, c) => s + (Number(c.cod_mkd) || 0), 0),
    byStatus: Object.entries(byStatus).map(([status, v]) => ({ status, orders: v.orders, 'COD (ден)': fmtMkd(v.mkd) })),
    byAuthor: Object.entries(byAuthor).sort((a, b) => b[1].mkd - a[1].mkd)
      .map(([seller, v]) => ({ seller, orders: v.orders, paid: v.paid, returned: v.returned, 'COD (ден)': fmtMkd(v.mkd), 'paid COD (ден)': fmtMkd(v.paid_mkd) })),
  };
}

// ─── rollback (the orders it made are deleted; the ledger rows restored) ──────────────────────────────────────

/** Rows of a run (apply or cron) the rollback may touch, with "is it still exactly as made?". Read-only. */
export const rollbackCheckSql = (runId) => `select x.id, x.order_id, x.evidence ->> 'doc' as doc, x.evidence ->> 'order' as display_id,
      x.after -> 'order' ->> 'status' as made_status,
      (o.id is not null) as exists,
      (o.id is not null
       and o.external_source = 'collabbox' and o.external_order_id = x.evidence ->> 'doc'
       and o.mex_tracking_id is not distinct from x.evidence ->> 'doc'
       and o.status::text = x.after -> 'order' ->> 'status'
       and o.price = (x.after -> 'order' ->> 'price')::numeric
       and o.sold_by_person_id is not distinct from nullif(x.after -> 'order' ->> 'sold_by_person_id', '')::uuid
       and not exists (select 1 from public.agent_payout_items ap where ap.order_id = o.id)
       and not exists (select 1 from public.order_history h where h.order_id = o.id and h.changed_by is not null)
       and not exists (select 1 from public.orders d where d.duplicated_from = o.id)) as same
    from public.data_repair_rows x left join public.orders o on o.id = x.order_id
   where x.run_id = ${qUuid(runId)} and x.rule = 'LPO_create' and x.after is not null`;

/**
 * The undo, ONE transaction (one API call, the kit's buildChunkSql contract): per made order, in its own
 * sub-transaction — still exactly as made? → snapshot it into the rollback run's ledger, DELETE it (order_items /
 * notes / history go with it, FK CASCADE; the register row's order_id is SET NULL), the register row's method back,
 * the collabBox ledger row back to its before (credit_pending). Anything that moved on is left alone and listed.
 */
export function buildRollbackSql({ runId, rbRunId, actor }) {
  return `
set local elyon.bulk_repair = 'on';
set local elyon.keep_updated_at = 'on';
set local statement_timeout = '120s';
set local lock_timeout = '20s';
set local timezone = 'UTC';
create temp table _rb_out (order_id uuid, doc text, ok boolean, why text) on commit drop;
do $rb$
declare
  r record;
  o public.orders%rowtype;
  snap jsonb;
begin
  for r in select x.order_id, x.before, x.after, x.evidence from public.data_repair_rows x
            where x.run_id = ${qUuid(runId)} and x.rule = 'LPO_create' and x.after is not null order by x.id loop
    begin
      select * into o from public.orders where id = r.order_id for update;
      if o.id is null then
        insert into _rb_out values (r.order_id, r.evidence ->> 'doc', false, 'the order is gone');
        continue;
      end if;
      if o.external_source is distinct from 'collabbox' or o.external_order_id is distinct from (r.evidence ->> 'doc')
         or o.mex_tracking_id is distinct from (r.evidence ->> 'doc')
         or o.status::text is distinct from (r.after -> 'order' ->> 'status')
         or o.price is distinct from (r.after -> 'order' ->> 'price')::numeric
         or o.sold_by_person_id is distinct from nullif(r.after -> 'order' ->> 'sold_by_person_id', '')::uuid
         or exists (select 1 from public.agent_payout_items ap where ap.order_id = o.id)
         or exists (select 1 from public.order_history h where h.order_id = o.id and h.changed_by is not null)
         or exists (select 1 from public.orders d where d.duplicated_from = o.id) then
        insert into _rb_out values (r.order_id, r.evidence ->> 'doc', false, 'changed since the run (status / price / seller / a person / a payout)');
        continue;
      end if;
      snap := jsonb_build_object('order', to_jsonb(o),
                'items', (select coalesce(jsonb_agg(to_jsonb(i)), '[]'::jsonb) from public.order_items i where i.order_id = o.id),
                'notes', (select coalesce(jsonb_agg(to_jsonb(n)), '[]'::jsonb) from public.order_notes n where n.order_id = o.id),
                'history', (select coalesce(jsonb_agg(to_jsonb(h)), '[]'::jsonb) from public.order_history h where h.order_id = o.id));
      -- the register row first (explicitly — not left to the FK's SET NULL), then the order
      update public.mex_parcels mp
         set order_id = nullif(r.before -> 'parcel' ->> 'order_id', '')::uuid,
             link_method = r.before -> 'parcel' ->> 'link_method',
             linked_at = (r.before -> 'parcel' ->> 'linked_at')::timestamptz
       where mp.tracking_id = r.evidence ->> 'doc' and mp.order_id = o.id;
      delete from public.orders where id = o.id;
      update public.collabbox_documents d
         set outcome = r.before -> 'doc' ->> 'outcome', reason = r.before -> 'doc' ->> 'reason',
             order_id = nullif(r.before -> 'doc' ->> 'order_id', '')::uuid,
             related_order_id = nullif(r.before -> 'doc' ->> 'related_order_id', '')::uuid,
             credit = r.before -> 'doc' ->> 'credit',
             flags = coalesce(array(select jsonb_array_elements_text(r.before -> 'doc' -> 'flags')), '{}'::text[]),
             planned_status = r.before -> 'doc' ->> 'planned_status', paid_basis = r.before -> 'doc' ->> 'paid_basis',
             price_eur = (r.before -> 'doc' ->> 'price_eur')::numeric, updated_at = now()
       where d.doc_number = r.evidence ->> 'doc';
      insert into public.data_repair_rows (run_id, order_id, rule, before, after, evidence)
      values (${qUuid(rbRunId)}, r.order_id, 'rollback:LPO_create', snap, jsonb_build_object('deleted', true),
              jsonb_build_object('rolled_back_run', ${q(runId)}, 'doc', r.evidence ->> 'doc',
                                 'line', r.order_id::text || ':rollback:deleted:' || (r.evidence ->> 'doc')));
      insert into _rb_out values (r.order_id, r.evidence ->> 'doc', true, null);
    exception when others then
      insert into _rb_out values (r.order_id, r.evidence ->> 'doc', false, left(sqlerrm, 300));
    end;
  end loop;
end $rb$;
insert into public.audit_log (actor_id, actor_email, action, target_type, target_id, target_name, payload)
values (${qUuid(actor.id)}, ${q(actor.email)}, 'data_repair.rollback', 'data_repair_run', ${q(runId)}, ${q(KEY)},
        jsonb_build_object('rollback_run', ${q(rbRunId)}, 'restored', (select count(*) from _rb_out where ok),
                           'left_alone', (select count(*) from _rb_out where not ok)));
select (select count(*) from _rb_out)::int as candidates, (select count(*) from _rb_out where ok)::int as restored,
       (select coalesce(jsonb_agg(jsonb_build_object('doc', doc, 'why', why)), '[]'::jsonb) from _rb_out where not ok) as skipped;`;
}
