# scripts/sf-feed/verify-sf-feed-parity.py — the Salesforce read-only window (migration 20261024210000_sf_readonly_feed)
# against the Salesforce contract's OWN computation, on ONE consistent snapshot. Owner 24.10.2026: "Читање од naturall".
#
# READ-ONLY against the CRM: one REPEATABLE READ, READ ONLY transaction through psql (pgpass of the cutover). It reads the
# raw rows the Salesforce interim script reads (orders, mex_parcels, AlterCPA deciders, the hand-over EV) AND the two
# views, then computes every view row again with the Salesforce repo's migration/trial/courier_contract.py
# (Contract("live").order_view_row / parcel_view_row, the hand-over package proof of export_clean_handover.py, the
# 04.10.2026 review list) and compares every contract column, outcome_hash and parcel_hash. Counts only on screen; the
# snapshot (ids, no names) goes to the PRIVATE archive, never into the repository.
#
#   python scripts/sf-feed/verify-sf-feed-parity.py [--sf D:/naturatherapy/natura-salesforce-s11/migration/trial]
#
# Acceptance: "differences": {} (24.10.2026 21:26 Skopje: 310.020 order rows, 275.899 parcel rows, 0 differences).
import csv, json, os, re, subprocess, sys, datetime as dt
from collections import Counter, defaultdict
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")
ROOT = Path(__file__).resolve().parents[2]
MK_REF = "oufoazmnbwugtfldkwsn"
PSQL = r"C:/Program Files/PostgreSQL/17/bin/psql.exe"
PGPASS = ROOT / "exports/db-move/2026-10-03-cutover/pgpass.conf"
PRIV = Path(r"D:/naturatherapy/_salesforce-plan/07-data-backups-PRIVATE")
REVIEW = PRIV / "2026-10-04/naturall-crm-clean/review_orders.csv"
OUT = PRIV / f"{dt.date.today().isoformat()}-naturall-sf-feed-parity"
SF = Path(sys.argv[sys.argv.index("--sf") + 1]) if "--sf" in sys.argv else Path(r"D:/naturatherapy/natura-salesforce-s11/migration/trial")

ref = re.search(r'^\s*project_id\s*=\s*"([^"]+)"', (ROOT / "supabase/config.toml").read_text(encoding="utf-8"), re.M)
if not ref or ref.group(1) != MK_REF:
    sys.exit("supabase/config.toml is not the Macedonian project — refusing.")
if str(OUT.resolve()).lower().startswith(str(ROOT.resolve()).lower()):
    sys.exit("the output must not be inside the repository — refusing.")
sys.path.insert(0, str(SF))
from courier_contract import Contract, iso, canon_hash  # noqa: E402

OUT.mkdir(parents=True, exist_ok=True)
TEST = "('70123456','23123123')"
PARTS = {
    "orders": f"""select row_to_json(t)::text from (select o.id, o.display_id, o.created_at, o.status::text as status, o.paid_basis,
      o.source_type, o.external_source, o.external_order_id, o.sale_source, o.sale_source_detail, o.price::text as price, o.sold_at,
      o.paid_at, o.returned_at, o.shipped_at, o.cancelled_at, o.cancellation_reason, o.mex_tracking_id, o.mex_account, o.mex_status_id,
      o.mex_cod_mkd, o.mex_delivered_at,
      cohort_order_bucket(o.status::text, o.price, o.sold_at, o.paid_basis, o.source_type, o.sale_source_detail, o.mex_tracking_id,
                          o.mex_status_id, o.mex_cod_mkd, o.mex_delivered_at, false) as bucket
      from orders o where right(regexp_replace(coalesce(o.customer_phone, ''), '[^0-9]', '', 'g'), 8) not in {TEST}) t""",
    "parcels": """select row_to_json(t)::text from (select p.tracking_id, p.account, p.series, p.status_id, p.status_name, p.cod_mkd,
      p.receiver_city, p.phone8, p.sender_reference, p.created_at_mex, p.last_update_at, p.delivered_at, p.returned_at, p.picked_up_at,
      p.order_id, p.link_method, p.linked_at, p.history_run, h.external_source as holder_source, h.external_order_id as holder_ext,
      h.display_id as holder_display from mex_parcels p left join orders h on h.id = p.order_id) t""",
    "deciders": """select row_to_json(t)::text from (select l.order_id, l.decided_by_altercpa_user, l.decided_at, l.id from altercpa_leads l
      where l.order_id is not null and l.decided_by_altercpa_user is not null) t""",
    "ev": """select row_to_json(t)::text from (select r.order_id, r.id, r.rule, rr.applied_at,
      coalesce(r.evidence->>'resend_doc', r.evidence->>'doc') as doc, r.evidence->>'tracking' as tracking, r.evidence->>'courier' as courier
      from data_repair_rows r join data_repair_runs rr on rr.id = r.run_id
      where rr.applied_at >= '2026-10-03 18:00:00+00' and r.after is not null and rr.key <> 'cod-price' and rr.key not like 'rollback-%') t""",
    "view_orders": "select row_to_json(t)::text from (select v.*, v.price::text as price_text from public.sf_order_outcome_v v) t",
    "view_parcels": "select row_to_json(t)::text from (select v.* from public.sf_parcel_v v) t",
}


def snapshot():
    bs = "\\"
    lines = [bs + "set ON_ERROR_STOP on", bs + "pset format unaligned", bs + "pset tuples_only on", bs + "pset footer off",
             "begin transaction isolation level repeatable read read only;", "set statement_timeout = '15min';",
             "set work_mem = '128MB';"]
    for k, sql in PARTS.items():
        lines += [f"{bs}o {(OUT / f'{k}.jsonl').as_posix()}", " ".join(sql.split()) + ";", bs + "o"]
    lines.append("rollback;")
    script = OUT / "_snapshot.sql"
    script.write_text("\n".join(lines) + "\n", encoding="utf-8")
    env = dict(os.environ, PGPASSFILE=str(PGPASS), PGCLIENTENCODING="UTF8")
    conn = (f"host=aws-0-eu-central-1.pooler.supabase.com port=5432 dbname=postgres user=postgres.{MK_REF} sslmode=require "
            "keepalives=1 keepalives_idle=20 keepalives_interval=10 keepalives_count=6")
    r = subprocess.run([PSQL, conn, "-q", "-X", "-f", str(script)], env=env, capture_output=True, text=True, encoding="utf-8")
    script.unlink(missing_ok=True)
    if r.returncode != 0:
        sys.exit(f"psql failed — {r.stderr.strip()[:800]}")


def rows(name):
    with open(OUT / f"{name}.jsonl", encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


snapshot()
c = Contract("live")
orders, parcels, deciders, ev = rows("orders"), rows("parcels"), rows("deciders"), rows("ev")
vo = {r["id"]: r for r in rows("view_orders")}
vp = {(r["account"], r["tracking_id"]): r for r in rows("view_parcels")}
review = {r["order_id"]: r["reason"] for r in csv.DictReader(open(REVIEW, encoding="utf-8-sig"))}
checks, diff = Counter(), Counter()

dec = defaultdict(list)
for d in deciders:
    dec[d["order_id"]].append(d)
decider = {}
for oid, ds in dec.items():                     # the view: decided_at desc nulls last, then id desc
    ds.sort(key=lambda d: (d["decided_at"] is not None, d["decided_at"] or "", d["id"]), reverse=True)
    decider[oid] = ds[0]["decided_by_altercpa_user"]
    if len(ds) > 1 and ds[0]["decided_at"] == ds[1]["decided_at"] and ds[0]["decided_by_altercpa_user"] != ds[1]["decided_by_altercpa_user"]:
        checks["decider_tie_with_different_user"] += 1
evo = defaultdict(list)
for e in ev:
    evo[e["order_id"]].append(e)
evb = {}
for oid, es in evo.items():                     # export_clean_handover.py EV: the newest applied run, then row id desc
    es.sort(key=lambda e: (e["applied_at"], e["id"]), reverse=True)
    evb[oid] = es[0]
    if len(es) > 1 and es[0]["applied_at"] == es[1]["applied_at"] and \
            (es[0]["rule"], es[0]["doc"], es[0]["tracking"], es[0]["courier"]) != (es[1]["rule"], es[1]["doc"], es[1]["tracking"], es[1]["courier"]):
        checks["ev_tie_with_different_evidence"] += 1


def package(o):
    """export_clean_handover.py PROOF + EV as orders_proof.csv carries them (CSV: null -> '')"""
    e = evb.get(o["id"]) or {}
    rule = e.get("rule")
    if o["mex_tracking_id"] is not None and o["mex_status_id"] in (2, 7):
        proof = "mex_parcel"
    elif o["mex_tracking_id"] is not None:
        proof = "mex_parcel_open"
    elif o["status"] == "paid" and o["paid_basis"] == "operator_ruling":
        proof = "collabbox_courier_flag"
    elif o["status"] == "returned" and rule in ("paid_returned", "dead_returned", "dup_own_doc_returned"):
        proof = "collabbox_courier_flag"
    elif o["status"] == "returned" and rule is not None and rule.startswith("mex_returned"):
        proof = "mex_register_unlinked"
    elif o["status"] in ("paid", "returned", "shipped"):
        proof = "none"
    else:
        proof = ""
    return {"proof": proof, "proof_document": e.get("doc") or "", "proof_tracking": e.get("tracking") or "",
            "proof_courier": e.get("courier") or ""}


by_order = defaultdict(list)
for p in parcels:
    if p["order_id"]:
        by_order[p["order_id"]].append(p)
for pl in by_order.values():                    # the view's fallback order: newest last_update_at, then tracking id
    pl.sort(key=lambda p: p["tracking_id"])
    pl.sort(key=lambda p: p["last_update_at"] or "", reverse=True)

ORDER_COLS = ["order_key", "id", "display_id", "external_source", "external_order_id", "status", "paid_basis", "paid_at",
              "returned_at", "shipped_at", "cancelled_at", "cancellation_reason", "mex_tracking_id", "mex_account", "mex_status_id",
              "mex_cod_mkd", "mex_delivered_at", "parcel_count", "price", "bucket", "proof", "proof_reference", "proof_courier",
              "link_method", "decider_altercpa_user", "review_reason", "outcome_hash"]
PARCEL_COLS = ["account", "tracking_id", "sender_reference", "series", "status_id", "status_name", "cod_mkd", "created_at_mex",
               "last_update_at", "delivered_at", "returned_at", "picked_up_at", "receiver_city", "phone_last8", "holder_order_key",
               "link_method", "linked_at", "history", "parcel_hash"]
TIMES = {"paid_at", "returned_at", "shipped_at", "cancelled_at", "mex_delivered_at", "created_at_mex", "last_update_at",
         "delivered_at", "picked_up_at", "linked_at"}
n_orders = 0
for o in orders:
    pl = by_order.get(o["id"], [])
    if pl and not any(p["tracking_id"] == o["mex_tracking_id"] for p in pl):
        checks["current_parcel_by_fallback"] += 1
    v = c.order_view_row(o, pl, package(o), decider.get(o["id"]),
                         ("review_orders:" + review[o["id"]]) if o["id"] in review else None)
    if c.cohort_bucket(o) != o["bucket"]:
        checks["cohort_port_differs_from_naturall_bucket"] += 1
    if not v["proof"]:
        if o["id"] in vo:
            diff["order_in_view_but_not_in_contract"] += 1
        continue
    n_orders += 1
    w = vo.get(o["id"])
    if w is None:
        diff["order_in_contract_but_not_in_view"] += 1
        continue
    for col in ORDER_COLS:
        got = w["price_text"] if col == "price" else (iso(w[col]) or None) if col in TIMES else w[col]
        if got != v[col]:
            diff["order." + col] += 1
n_parcels = 0
for p in parcels:
    if (p["phone8"] or "") in ("70123456", "23123123"):
        if (p["account"], p["tracking_id"]) in vp:
            diff["parcel_test_phone_in_view"] += 1
        continue
    holder = None
    if p["order_id"]:
        holder = c.order_key(dict(external_source=p["holder_source"], external_order_id=p["holder_ext"], display_id=p["holder_display"]))
    v = c.parcel_view_row(p, holder)
    n_parcels += 1
    w = vp.get((p["account"], p["tracking_id"]))
    if w is None:
        diff["parcel_in_contract_but_not_in_view"] += 1
        continue
    for col in PARCEL_COLS:
        got = (iso(w[col]) or None) if col in TIMES else w[col]
        if got != v[col]:
            diff["parcel." + col] += 1
report = dict(at=dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC"), orders_read=len(orders),
              contract_order_rows=n_orders, view_order_rows=len(vo), parcels_read=len(parcels), contract_parcel_rows=n_parcels,
              view_parcel_rows=len(vp), view_parcels_not_in_contract=len(vp) - n_parcels,
              differences=dict(sorted(diff.items())), checks=dict(sorted(checks.items())))
(OUT / "parity.json").write_text(json.dumps(report, indent=1), encoding="utf-8")
print(json.dumps(report, indent=1))
sys.exit(1 if diff or report["view_parcels_not_in_contract"] else 0)
