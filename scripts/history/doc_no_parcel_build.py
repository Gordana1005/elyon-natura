# scripts/history/doc_no_parcel_build.py — READ-ONLY builder: paid orders with a collabBox document but NO MEX parcel, in a
# month MEX carried ≥ 90 % of that folder (audit verdict REVIEW_DOC_NO_PARCEL_MEX_PERIOD; hand-over 03.10.2026 §8 q.4).
#
# The audit could not tell whether such a document ever left. collabBox itself can: its per-document courier attributes
# ("Delivered", "Return to sender", "Shipment created", "In Delivery", "Picked Up", "Received at MEX station", …), read by
# scripts/collabbox-delivery-attrs.mjs. This builder joins them to the orders:
#   delivered / returned  → the same input shape as scripts/history/courier_outcomes_build.py, written to
#                           exports/repairs/doc-no-parcel/input.csv for `repair-courier-outcomes.mjs --input doc-no-parcel`
#   no courier trace at all (no flag of any kind) → exports/repairs/doc-no-parcel/never-shipped.csv (for the cancel rule)
#   a courier trace but no final flag             → listed, left alone
# Ids and document numbers only — no names, no phones.
import csv, json, glob, re, collections, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ATTR = ROOT / "exports/collabbox/delivery-attrs"
AUD = Path(r"D:/naturatherapy/_salesforce-plan/07-data-backups-PRIVATE/2026-10-03")
OUT = ROOT / "exports/repairs/doc-no-parcel"
OUT.mkdir(parents=True, exist_ok=True)
C = collections.Counter
TRACE = ("created", "inDelivery", "pickedUp", "problematic", "atMex", "paidKolporter", "atKolporter")


def wall_iso(at):
    m = re.match(r"^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}):(\d{2}):(\d{2})$", at or "")
    return f"{m[3]}-{m[2]}-{m[1]}T{m[4]}:{m[5]}:{m[6]}" if m else ""


attrs = {}
for f in sorted(glob.glob(str(ATTR / "*.json"))):
    j = json.load(open(f, encoding="utf-8"))
    for d in j["docs"]:
        d["day"] = j["date"]
        attrs[d["doc"]] = d

rows = list(csv.DictReader(open(AUD / "history-audit" / "orders_verdict_2023-01_2026-08-01.csv", encoding="utf-8-sig", newline="")))
out, never, stats, trace_stats = [], [], C(), C()
for r in rows:
    if r["verdict"] != "REVIEW_DOC_NO_PARCEL_MEX_PERIOD" or (r["paid_basis"] or "") == "operator_ruling":
        continue
    a = attrs.get(r["cb_doc"])
    if not a:
        stats["document's day not read / document not on its day"] += 1
        continue
    outcome = "returned" if a["returned"] == "Da" else "delivered" if a["delivered"] == "Da" else "neither"
    traces = [k for k in TRACE if a.get(k) == "Da"]
    base = dict(order_id=r["order_id"], display_id=r["display_id"], order_day=r["order_day"], audit_status=r["status"],
                audit_verdict=r["verdict"], audit_paid_basis=r["paid_basis"], dept=r["dept"], match=r["cb_check"],
                doc=r["cb_doc"], doc_type=a["type"], doc_at=wall_iso(a["at"]), doc_amount_mkd=a["amount"],
                courier="collabBox flag (no MEX parcel under the document number)", courier_mk="без MEX пратка под бројот на документот",
                outcome=outcome, paid_by_kolporter=a.get("paidKolporter", ""), resend_doc="", resend_at="", resend_outcome="", resend_via="",
                price_eur=r["price_eur"])
    if outcome != "neither":
        stats[outcome] += 1
        out.append(base)
    elif traces and traces != ["created"]:
        stats["in delivery / picked up, no final flag (left alone)"] += 1
        trace_stats["+".join(traces)] += 1
    elif a["amount"] <= 0:
        stats["zero / negative document"] += 1
    else:
        stats["only a label (Shipment created)" if traces else "no courier trace at all"] += 1
        never.append(dict(trace="label only" if traces else "none", order_id=r["order_id"], display_id=r["display_id"], order_day=r["order_day"], audit_status=r["status"],
                          dept=r["dept"], match=r["cb_check"], doc=r["cb_doc"], doc_type=a["type"], doc_at=wall_iso(a["at"]),
                          doc_amount_mkd=a["amount"], price_eur=r["price_eur"], paid_basis=r["paid_basis"]))

for name, data in (("input.csv", out), ("never-shipped.csv", never)):
    if data:
        with open(OUT / name, "w", encoding="utf-8-sig", newline="") as f:
            w = csv.DictWriter(f, fieldnames=list(data[0].keys()))
            w.writeheader()
            w.writerows(data)
with open(OUT / "owned-orders.csv", "w", encoding="utf-8", newline="") as f:
    print("order_id", file=f)
    for r in rows:
        if r["cb_doc"] or r["mex_tracking_id"]:
            print(r["order_id"], file=f)

sys.stdout.reconfigure(encoding="utf-8")
print("orders with a document, no MEX parcel, in a MEX month (not yet proven):", sum(stats.values()))
for k, v in stats.most_common():
    print(f"   {v:5d}  {k}")
print("   traces:", dict(trace_stats))
print("   never shipped by year / folder:", sorted(C((z["order_day"][:4], z["doc_type"]) for z in never).items()))
print("   delivered / returned by match:", dict(C((z["outcome"], z["match"]) for z in out)))
print("→", OUT)
