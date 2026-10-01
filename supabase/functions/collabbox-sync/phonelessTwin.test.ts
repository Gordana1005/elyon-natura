// The phoneless collabBox twin (owner 01.10.2026, migration 20260944000630): a booking with no phone is the
// copy of the author's own CRM sale within ±10 min of the BOOKING (collabbox_sale_at — doc_at is the dispatch
// day), or within the writer's twin window when the customer's script-folded name matches; the writer's twin
// window is around the sale time too. The SQL is proven on live data read-only and in PGlite; this file keeps
// the migration's shape from drifting.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MIG = readFileSync(join(process.cwd(), "supabase/migrations/20260944000630_phoneless_twin_booking_time.sql"), "utf8")
  .replace(/\r/g, "");
const fn = (name: string): string => {
  const i = MIG.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  expect(i).toBeGreaterThan(0);
  return MIG.slice(i, MIG.indexOf("$function$;", i));
};

describe("20260944000630 — the phoneless twin", () => {
  it("is drift-guarded against the live bodies of 01.10.2026", () => {
    expect(MIG).toMatch(/DO \$drift\$/);
    expect(MIG).toContain("'e7406338692acb5caa2e165d404ccc0c'");   // insights_sale_rows as left by 20260944000600
    expect(MIG).toContain("'199afc20f05b9f5ce023a7778c664323'");   // collabbox_apply_one as left by 20260944000500
    for (const m of MIG.matchAll(/'([0-9a-f]{32})', '([0-9a-f]{32})'\)/g)) expect(m[1]).not.toBe(m[2]);
    expect(MIG).toContain("SET lock_timeout = '10s';");
    expect(MIG).not.toContain("sxymaloycddnoxudxaqp");
  });

  it("folds names: Latin = Cyrillic, word order free, two words at least", () => {
    const nk = fn("collabbox_name_key");
    expect(nk).toContain("IMMUTABLE");
    expect(nk).toContain("public.mk_geo_norm(w)");
    expect(nk).toContain("CASE WHEN count(*) >= 2 THEN string_agg(s.t, ' ' ORDER BY s.t) END");
    expect(nk).toContain("WHERE length(s.t) >= 2");
    expect(MIG).toMatch(/REVOKE ALL ON FUNCTION public\.collabbox_name_key\(text\) FROM PUBLIC, anon;/);
  });

  it("the cohort: the phoneless branch reads the BOOKING, the phone branch is unchanged", () => {
    const sr = fn("insights_sale_rows");
    expect(sr).toContain("public.collabbox_name_key(b.komitent_name) AS name_key");
    const bk = sr.slice(sr.indexOf("bk AS MATERIALIZED ("), sr.indexOf("mo AS MATERIALIZED ("));
    const [phone, phoneless] = bk.split("WHERE k.p8 IS NULL");
    // the phone branch: the dispatch-day window it always had
    expect(phone).toContain("AND (x.created_at BETWEEN k.doc_at - interval '14 days' AND k.doc_at + interval '2 days'");
    // the phoneless branch: nothing on doc_at any more
    expect(phoneless).not.toContain("k.doc_at");
    expect(phoneless).toContain("AND x.sold_by_person_id = k.author_person_id");
    expect(phoneless).toContain("AND x.created_at BETWEEN k.sale_at - interval '1 day' AND k.sale_at + interval '2 days'");
    expect(phoneless).toContain("AND (x.created_at BETWEEN k.sale_at - interval '10 minutes' AND k.sale_at + interval '10 minutes'");
    expect(phoneless).toContain("OR (k.name_key IS NOT NULL");
    expect(phoneless).toContain("AND (public.collabbox_name_key(x.customer_name) = k.name_key");
    // any name the CRM holds on the sale's phone — the expression of idx_orders_phone_last8
    expect(phoneless).toContain("WHERE right(regexp_replace(y.customer_phone, '[^0-9]', '', 'g'), 8)");
    expect(phoneless).toContain("right(regexp_replace(x.customer_phone, '[^0-9]', '', 'g'), 8) ~ '^[0-9]{8}$'");
    // the price fit and the sale filters stay
    expect(phoneless).toContain("AND x.sale_source_detail IS DISTINCT FROM 'disposition'");
    expect(phoneless).toContain("abs(round(x.price * 61.5) + 150 - k.amount_mkd) <= 3");
    // the booking rows still count on the booking day
    expect(sr).toMatch(/FROM bk\n {2}WHERE bk\.sale_at BETWEEN \$1 AND \$2/);
  });

  it("the writer: the twin window around the sale time, same sizes", () => {
    const w = fn("collabbox_apply_one");
    expect(w).toContain("AND o.created_at >= _sale_at - interval '1 day'");
    expect(w).toContain("AND o.created_at <= _sale_at + interval '2 days'");
    expect(w).toContain("ORDER BY abs(extract(epoch FROM o.created_at - _sale_at)), o.created_at");
    expect(w).toContain("AND o.created_at >= _sale_at - interval '3 days' AND o.created_at <= _sale_at + interval '3 days') THEN");
    expect(w).not.toMatch(/o\.created_at [<>]= _doc_at/);
    expect(w).toContain("_sale_at := public.collabbox_sale_at(_doc_at, _booked);");   // set before the twin check
    expect(w.indexOf("_sale_at := public.collabbox_sale_at(_doc_at, _booked);"))
      .toBeLessThan(w.indexOf("'possible_twin_crm_sale'"));
  });

  it("leaves the board's copies alone (bookings_filter_drift stays 0)", () => {
    expect(MIG).not.toContain("CREATE OR REPLACE FUNCTION public.leaderboard_day_v2");
    expect(MIG).not.toContain("CREATE OR REPLACE FUNCTION public.collabbox_booked_today");
  });
});
