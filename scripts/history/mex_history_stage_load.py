# scripts/history/mex_history_stage_load.py — load the MEX register dump into public.mex_history_stage (04.10.2026)
#
# The dump (list_shipments of both MEX accounts since 18.03.2020, pulled read-only on 03.10.2026 by the history audit)
# is written to a private CSV and copied into a session temp table through psql; the INSERT into mex_history_stage
# parses it with the LIVE sync's own helpers (public.mex_parse_ts — Skopje wall clock → timestamptz — and
# public.mex_parse_cod), so a history row is stored exactly as mex_upsert_parcels would have stored it.
# Idempotent: ON CONFLICT (tracking_id) DO NOTHING. Nothing but the stage table is written; no CRM reader uses it.
#
#   python scripts/history/mex_history_stage_load.py            # build the CSV + load
#   python scripts/history/mex_history_stage_load.py --csv-only
# Needs psql 17 and the pgpass of the move (exports/db-move/2026-10-03-cutover/pgpass.conf); the project is the one
# in supabase/config.toml (refused if it is not the Macedonian CRM).
import csv, json, os, re, subprocess, sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")

ROOT = Path(__file__).resolve().parents[2]
DUMP = Path(r"D:/naturatherapy/_salesforce-plan/07-data-backups-PRIVATE/2026-10-03/mex-register")
OUT = ROOT / "exports/repairs/mex-history-register"
OUT.mkdir(parents=True, exist_ok=True)
CSV = OUT / "mex-register-dump.csv"
MK_REF = "oufoazmnbwugtfldkwsn"
PSQL = r"C:/Program Files/PostgreSQL/17/bin/psql.exe"
PGPASS = ROOT / "exports/db-move/2026-10-03-cutover/pgpass.conf"

ref = re.search(r'^\s*project_id\s*=\s*"([^"]+)"', (ROOT / "supabase/config.toml").read_text(encoding="utf-8"), re.M)
if not ref or ref.group(1) != MK_REF:
    sys.exit("supabase/config.toml is not the Macedonian project — refusing.")

clean = lambda v: re.sub(r"[\x00\r\n\t]+", " ", str(v if v is not None else "")).strip()
seen, n = set(), 0
dump_at = None
with open(CSV, "w", encoding="utf-8", newline="") as f:
    w = csv.writer(f)
    w.writerow(["tracking_id", "account", "status_id", "status_name", "cod", "receiver_name", "receiver_city", "receiver_phone",
                "sender_reference", "created_at", "last_update_at"])
    for acc, fn in (("natura", "mex_NATURA.json"), ("bio_natural", "mex_BIO_NATURAL.json")):
        path = DUMP / fn
        dump_at = max(dump_at or 0, os.path.getmtime(path))
        for r in json.load(open(path, encoding="utf-8")):
            tid = clean(r.get("tracking_id"))
            if not tid or tid in seen:
                continue
            seen.add(tid)
            n += 1
            w.writerow([tid, acc, clean(r.get("current_status_id")), clean(r.get("current_status_name")), clean(r.get("cod")),
                        clean(r.get("receiver_name")), clean(r.get("receiver_city")), clean(r.get("receiver_phone")),
                        clean(r.get("sender_reference")), clean(r.get("created_at")), clean(r.get("last_update_at"))])
print(f"CSV: {n} parcels → {CSV}")
if "--csv-only" in sys.argv:
    sys.exit(0)

import datetime as dt
dump_iso = dt.datetime.fromtimestamp(dump_at, dt.timezone.utc).strftime("%Y-%m-%d %H:%M:%S+00")
sql = f"""
\\set ON_ERROR_STOP on
set statement_timeout = 0;
create temp table _dump (tracking_id text, account text, status_id text, status_name text, cod text, receiver_name text,
  receiver_city text, receiver_phone text, sender_reference text, created_at text, last_update_at text);
\\copy _dump from '{CSV.as_posix()}' with (format csv, header true, encoding 'UTF8')
insert into public.mex_history_stage (tracking_id, account, status_id, status_name, cod_mkd, receiver_name, receiver_city,
    receiver_phone_raw, phone8, sender_reference, created_at_mex, last_update_at, dump_at)
select d.tracking_id, d.account,
       case when btrim(d.status_id) ~ '^[0-9]{{1,9}}$' then btrim(d.status_id)::integer end,
       nullif(btrim(d.status_name), ''), public.mex_parse_cod(d.cod),
       nullif(btrim(d.receiver_name), ''), nullif(btrim(d.receiver_city), ''), nullif(d.receiver_phone, ''),
       case when length(regexp_replace(coalesce(d.receiver_phone, ''), '[^0-9]', '', 'g')) >= 8
            then right(regexp_replace(coalesce(d.receiver_phone, ''), '[^0-9]', '', 'g'), 8) end,
       nullif(btrim(d.sender_reference), ''), public.mex_parse_ts(d.created_at), public.mex_parse_ts(d.last_update_at),
       '{dump_iso}'::timestamptz
  from _dump d
on conflict (tracking_id) do nothing;
analyze public.mex_history_stage;
select 'stage rows', count(*), 'no created time', count(*) filter (where created_at_mex is null), 'status 2', count(*) filter (where status_id = 2),
       'status 7', count(*) filter (where status_id = 7), min(created_at_mex), max(last_update_at) from public.mex_history_stage;
"""
script = OUT / "stage-load.sql"
script.write_text(sql, encoding="utf-8")
env = dict(os.environ, PGPASSFILE=str(PGPASS), PGCLIENTENCODING="UTF8")
conn = f"host=aws-0-eu-central-1.pooler.supabase.com port=5432 dbname=postgres user=postgres.{MK_REF} sslmode=require"
r = subprocess.run([PSQL, conn, "-q", "-At", "-f", str(script)], env=env, capture_output=True, text=True, encoding="utf-8")
print(r.stdout.strip())
if r.returncode != 0:
    print(r.stderr.strip()[:2000])
    sys.exit(r.returncode)
