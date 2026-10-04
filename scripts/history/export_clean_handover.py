# scripts/history/export_clean_handover.py — the clean-data package for the Salesforce migration (owner, 04.10.2026:
# "спреми сè за да може другиот агент да има чисти податоци за внесување во SalesForce").
#
# READ-ONLY against the CRM (one REPEATABLE READ, READ ONLY transaction through psql — a consistent snapshot). It
# writes ONLY into the private archive, never into a repository:
#   D:\naturatherapy\_salesforce-plan\07-data-backups-PRIVATE\<date>\naturall-crm-clean\
#     cube_orders.csv              PII-free: created month × department × status × proof → orders, Σ price €, Σ COD ден
#     repair_runs.csv              PII-free: every data repair applied since the history audit (key, run, when, rows by rule)
#     orders_proof.csv             ids only: every order, its status, how it is proven and by which parcel / document
#     parcels_without_order.csv    PRIVATE (phones): every MEX parcel of the full register that no CRM order holds or
#                                  names — the sales the CRM never had (delivered / returned, COD, series, web link)
#     review_orders.csv            ids only: the orders the repairs left alone, with the reason
#     MANIFEST.json                row counts and sha256 of each file, the snapshot time, the database
# The hand-over text that explains them: D:\naturatherapy\NATURALL-CRM-CLEAN-DATA-HANDOVER.md
#
#   python scripts/history/export_clean_handover.py [--date 2026-10-04]
import csv, glob, hashlib, json, os, re, subprocess, sys, datetime as dt
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")
ROOT = Path(__file__).resolve().parents[2]
MK_REF = "oufoazmnbwugtfldkwsn"
PSQL = r"C:/Program Files/PostgreSQL/17/bin/psql.exe"
PGPASS = ROOT / "exports/db-move/2026-10-03-cutover/pgpass.conf"
DATE = sys.argv[sys.argv.index("--date") + 1] if "--date" in sys.argv else dt.date.today().isoformat()
OUT = Path(r"D:/naturatherapy/_salesforce-plan/07-data-backups-PRIVATE") / DATE / "naturall-crm-clean"
SINCE = "2026-10-03 18:00:00+00"   # the first repair of the history audit (courier-outcomes, 03.10 22:47 Skopje)

ref = re.search(r'^\s*project_id\s*=\s*"([^"]+)"', (ROOT / "supabase/config.toml").read_text(encoding="utf-8"), re.M)
if not ref or ref.group(1) != MK_REF:
    sys.exit("supabase/config.toml is not the Macedonian project — refusing.")
if str(OUT.resolve()).lower().startswith(str(ROOT.resolve()).lower()):
    sys.exit("the output must not be inside the repository — refusing.")
OUT.mkdir(parents=True, exist_ok=True)

PROOF = """case
    when o.mex_tracking_id is not null and o.mex_status_id in (2, 7) then 'mex_parcel'
    when o.mex_tracking_id is not null then 'mex_parcel_open'
    when o.status = 'paid' and o.paid_basis = 'operator_ruling' then 'collabbox_courier_flag'
    when o.status = 'returned' and ev.rule in ('paid_returned', 'dead_returned', 'dup_own_doc_returned') then 'collabbox_courier_flag'
    when o.status = 'returned' and ev.rule like 'mex_returned%' then 'mex_register_unlinked'
    when o.status in ('paid', 'returned', 'shipped') then 'none'
    else '' end"""
EV = f"""(select distinct on (r.order_id) r.order_id, r.rule, rr.key as run_key, r.run_id,
           coalesce(r.evidence->>'resend_doc', r.evidence->>'doc') as doc, r.evidence->>'tracking' as tracking, r.evidence->>'courier' as courier
      from public.data_repair_rows r join public.data_repair_runs rr on rr.id = r.run_id
     where rr.applied_at >= '{SINCE}' and r.after is not null and rr.key <> 'cod-price' and rr.key not like 'rollback-%'
     order by r.order_id, rr.applied_at desc)"""

EXPORTS = {
    "cube_orders.csv": f"""
select to_char(o.created_at at time zone 'Europe/Skopje', 'YYYY-MM') as created_month,
       public.cohort_order_source(o.sale_source, o.sale_source_detail, o.mex_tracking_id, o.dept_override) as department,
       o.status::text as status, {PROOF} as proof,
       count(*) as orders, round(sum(coalesce(o.price, 0))::numeric, 2) as price_eur, coalesce(sum(o.mex_cod_mkd), 0) as cod_mkd
  from public.orders o left join {EV} ev on ev.order_id = o.id
 group by 1, 2, 3, 4 order by 1, 2, 3, 4""",
    "repair_runs.csv": f"""
select rr.key, rr.id as run_id, to_char(rr.applied_at at time zone 'Europe/Skopje', 'YYYY-MM-DD HH24:MI') as applied_skopje,
       r.rule, count(*) as orders
  from public.data_repair_runs rr join public.data_repair_rows r on r.run_id = rr.id and r.after is not null
 where rr.applied_at >= '{SINCE}'
 group by 1, 2, 3, 4
union all
select 'mex-history-links', l.run_id, to_char(min(l.linked_at) at time zone 'Europe/Skopje', 'YYYY-MM-DD HH24:MI'), l.rule, count(*)
  from public.mex_history_links l where l.linked_at is not null and l.undone_at is null group by 2, 4
 order by 3, 1, 4""",
    "orders_proof.csv": f"""
select o.id as order_id, o.display_id, to_char(o.created_at at time zone 'Europe/Skopje', 'YYYY-MM-DD') as created_day,
       o.status::text as status, o.paid_basis, {PROOF} as proof,
       o.mex_tracking_id, o.mex_account, o.mex_status_id, o.mex_cod_mkd,
       (select mp.history_run is not null from public.mex_parcels mp where mp.tracking_id = o.mex_tracking_id) as parcel_from_history,
       o.external_source, o.external_order_id,
       ev.run_key as audit_run_key, ev.rule as audit_rule, ev.doc as proof_document, ev.tracking as proof_tracking, ev.courier as proof_courier
  from public.orders o left join {EV} ev on ev.order_id = o.id
 order by o.created_at, o.id""",
    "parcels_without_order.csv": """
select s.tracking_id, s.account,
       case when s.tracking_id ~ '^[0-9]{3}-[0-9]{4}-' then split_part(s.tracking_id, '-', 2) end as series,
       public.cohort_parcel_source(public.cohort_parcel_split(s.account,
           case when s.tracking_id ~ '^[0-9]{3}-[0-9]{4}-' then split_part(s.tracking_id, '-', 2) end, s.tracking_id, s.sender_reference)) as department_by_series,
       s.status_id, s.status_name, s.cod_mkd,
       to_char(s.created_at_mex at time zone 'Europe/Skopje', 'YYYY-MM-DD HH24:MI:SS') as created_skopje,
       to_char(s.last_update_at at time zone 'Europe/Skopje', 'YYYY-MM-DD HH24:MI:SS') as last_update_skopje,
       s.phone8, s.receiver_city,
       (mp.tracking_id is not null) as in_live_register,
       w.order_number as web_order_number
  from public.mex_history_stage s
  left join public.mex_parcels mp on mp.tracking_id = s.tracking_id
  left join public.web_orders w on w.mex_tracking_id = s.tracking_id
 where mp.order_id is null
   and not exists (select 1 from public.orders o where o.mex_tracking_id = s.tracking_id)
   and not exists (select 1 from public.orders o where o.external_order_id = s.tracking_id)
 order by s.created_at_mex, s.tracking_id""",
}


def psql_copy(name, sql):
    path = OUT / name
    script = OUT / f"_{name}.sql"
    one = " ".join(sql.split())
    script.write_text("\\set ON_ERROR_STOP on\nset statement_timeout = 0;\nset enable_nestloop = off;\nset work_mem = '96MB';\n"
                      "begin transaction isolation level repeatable read read only;\n"
                      f"\\copy ({one}) to '{path.as_posix()}' with (format csv, header true, encoding 'UTF8')\ncommit;\n", encoding="utf-8")
    env = dict(os.environ, PGPASSFILE=str(PGPASS), PGCLIENTENCODING="UTF8")
    conn = (f"host=aws-0-eu-central-1.pooler.supabase.com port=5432 dbname=postgres user=postgres.{MK_REF} sslmode=require "
            "keepalives=1 keepalives_idle=20 keepalives_interval=10 keepalives_count=6")
    r = subprocess.run([PSQL, conn, "-q", "-At", "-f", str(script)], env=env, capture_output=True, text=True, encoding="utf-8")
    script.unlink(missing_ok=True)
    if r.returncode != 0:
        sys.exit(f"{name}: psql failed — {r.stderr.strip()[:800]}")
    return path


manifest = {"database": f"naturall ({MK_REF})", "snapshot_utc": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d %H:%M:%S"), "files": {}}
for name, sql in EXPORTS.items():
    p = psql_copy(name, sql)
    rows = sum(1 for _ in open(p, encoding="utf-8")) - 1
    manifest["files"][name] = {"rows": rows, "sha256": hashlib.sha256(p.read_bytes()).hexdigest()}
    print(f"{name}: {rows} rows")

# the orders the repairs left alone: every run's own CSV says why (ids only)
rev = []
for f in sorted(glob.glob(str(ROOT / "exports/repairs/*.csv"))):
    base = os.path.basename(f)
    if not re.match(r"^(courier-outcomes|mex-history-returns|history-cancels)-2026-10-0[34]", base):
        continue
    for r in csv.DictReader(open(f, encoding="utf-8-sig", newline="")):
        if r.get("action") == "skip":
            rev.append({"order_id": r.get("order_id", ""), "display_id": r.get("display_id", ""), "repair_csv": base, "reason": r.get("reason", ""),
                        "document": r.get("doc") or r.get("own_doc") or "", "tracking": r.get("tracking", "")})
seen, uniq = set(), []
for r in reversed(rev):               # the newest run's word on an order wins
    if r["order_id"] not in seen:
        seen.add(r["order_id"]); uniq.append(r)
p = OUT / "review_orders.csv"
with open(p, "w", encoding="utf-8-sig", newline="") as f:
    w = csv.DictWriter(f, fieldnames=["order_id", "display_id", "repair_csv", "reason", "document", "tracking"])
    w.writeheader(); w.writerows(sorted(uniq, key=lambda r: (r["reason"], r["display_id"])))
manifest["files"]["review_orders.csv"] = {"rows": len(uniq), "sha256": hashlib.sha256(p.read_bytes()).hexdigest()}
print(f"review_orders.csv: {len(uniq)} rows")
(OUT / "MANIFEST.json").write_text(json.dumps(manifest, indent=1, ensure_ascii=False), encoding="utf-8")
print("→", OUT)
