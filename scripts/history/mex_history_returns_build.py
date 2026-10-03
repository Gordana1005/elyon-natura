# scripts/history/mex_history_returns_build.py — READ-ONLY builder of the input list for scripts/repair-mex-history-returns.mjs
#
# The history audit of 03.10.2026 (MEX register from 18.03.2020 × collabBox × CRM) found orders the CRM calls PAID while
# MEX's own final status of their parcel is "Return to sender" (verdict SET_RETURNED). Most are the teleshop history
# import, whose orders were written as paid by default; the CRM's live parcel register only starts on 10.11.2025, so
# nothing ever corrected them. MEX alone decides paid / returned (owner law).
#
# Sources (local, private, gitignored — nothing is fetched, nothing is written to any system):
#   D:/naturatherapy/_salesforce-plan/07-data-backups-PRIVATE/2026-10-03/history-audit/orders_verdict_…csv   order ↔ parcel
#   …/mex-register/mex_NATURA.json, mex_BIO_NATURAL.json                                                    the MEX dump
#
# Output: exports/repairs/mex-history-returns/input.csv — order ids and tracking ids only (no names, no phones). The
# repair script re-validates every row against the live database.
#
# A returned parcel is checked for a RE-SEND: another parcel on the same phone, created up to 45 days after it, that MEX
# delivered and that no audited order owns. Then the customer paid in the end and the order must not be marked returned.
import csv, json, re, collections, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
AUD = Path(r"D:/naturatherapy/_salesforce-plan/07-data-backups-PRIVATE/2026-10-03")
OUT = ROOT / "exports/repairs/mex-history-returns"
OUT.mkdir(parents=True, exist_ok=True)
RESEND_DAYS = 45
C = collections.Counter


def p8(s):
    x = re.sub(r"\D", "", str(s or ""))[-8:]
    return x if len(x) == 8 and len(set(x)) > 1 else ""


def series(t):
    m = re.match(r"^\d{3}-([^-]+)-", str(t or ""))
    return m.group(1) if m else ("NTMK" if str(t).startswith("NTMK") else "M" if re.match(r"^M\d", str(t)) else "other")


mex, by_phone = {}, collections.defaultdict(list)
for acc, fn in (("NATURA", "mex_NATURA.json"), ("BIO NATURAL", "mex_BIO_NATURAL.json")):
    for r in json.load(open(AUD / "mex-register" / fn, encoding="utf-8")):
        tid = str(r.get("tracking_id") or "")
        m = dict(tid=tid, acc=acc, st=r.get("current_status_name") or "", c=(r.get("created_at") or ""), lu=(r.get("last_update_at") or ""),
                 p8=p8(r.get("receiver_phone")), ser=series(tid))
        mex[tid] = m
        if m["p8"]:
            by_phone[m["p8"]].append(m)

rows = list(csv.DictReader(open(AUD / "history-audit" / "orders_verdict_2023-01_2026-08-01.csv", encoding="utf-8-sig", newline="")))
claimed = {r["mex_tracking_id"] for r in rows if r["mex_tracking_id"]} | {r["crm_mex_tracking_id"] for r in rows if r["crm_mex_tracking_id"]}

from datetime import datetime
D = lambda s: datetime.fromisoformat(s[:19].replace(" ", "T"))
iso = lambda s: s[:19].replace(" ", "T")


def resend_of(m):
    best = None
    for y in by_phone.get(m["p8"], ()):
        if y["tid"] == m["tid"] or y["tid"] in claimed or y["st"] != "Delivered" or y["ser"] in ("M", "NTMK") or not y["c"] or not m["c"]:
            continue
        gap = (D(y["c"]) - D(m["c"])).total_seconds() / 86400
        if 0 < gap <= RESEND_DAYS and (best is None or y["c"] < best["c"]):
            best = y
    return best


out, stats = [], C()
for r in rows:
    if r["verdict"] != "SET_RETURNED":
        continue
    m = mex.get(r["mex_tracking_id"])
    if not m:
        stats["parcel not in the dump"] += 1
        continue
    re_ = resend_of(m)
    stats[(r["status"], r["mex_check"], "re-send delivered" if re_ else "")] += 1
    out.append(dict(order_id=r["order_id"], display_id=r["display_id"], order_day=r["order_day"], audit_status=r["status"],
                    audit_verdict=r["verdict"], match=r["mex_check"], dept=r["dept"], tracking=m["tid"], account=m["acc"], series=m["ser"],
                    mex_status=m["st"], mex_created=iso(m["c"]), mex_last_update=iso(m["lu"]), cod_mkd=r["mex_cod_mkd"],
                    resend_tracking=re_["tid"] if re_ else "", resend_created=iso(re_["c"]) if re_ else "", price_eur=r["price_eur"]))
out.sort(key=lambda z: (z["mex_created"], z["display_id"]))
with open(OUT / "input.csv", "w", encoding="utf-8-sig", newline="") as f:
    w = csv.DictWriter(f, fieldnames=list(out[0].keys()))
    w.writeheader()
    w.writerows(out)
sys.stdout.reconfigure(encoding="utf-8")
print(f"MEX parcels in the dump: {len(mex)} · orders MEX says were returned while the CRM says paid: {len(out)}")
for k, v in sorted(stats.items(), key=lambda kv: -kv[1]):
    print("  ", k, v)
print("→", OUT / "input.csv")
