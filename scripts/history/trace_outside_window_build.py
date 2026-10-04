# scripts/history/trace_outside_window_build.py — READ-ONLY builder: the paid orders whose only trace is 11–45 days away
# (audit verdict REVIEW_TRACE_OUTSIDE_WINDOW — paid, no MEX parcel and no collabBox document in the order's own window
# −1 … +10 days, but something on the phone within ±45 days).
#
# The question the audit left open: is that trace the order's OWN late shipment, or another sale of the same customer?
#   only another order's parcel / document   every trace within ±45 days is owned by ANOTHER order → this "paid" has no
#                                            shipment of its own → the owner's rule: paid + no MEX + no collabBox = cancelled
#   only a web parcel                        the same: a web-shop parcel is the web's sale
#   unclaimed parcel / unclaimed document    a parcel or document no order owns → possibly its own late shipment → left
#                                            alone (the late-sale law makes such a parcel a NEW order when it is imported)
# Output: exports/repairs/history-cancels/trace-outside-window.csv — order ids, display ids and the class only.
# The cancel itself: node scripts/repair-history-cancels.mjs --input trace  (it re-validates every order live).
import csv, json, re, collections, datetime as dt, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
AUD = Path(r"D:/naturatherapy/_salesforce-plan/07-data-backups-PRIVATE/2026-10-03")
CB = ROOT / "exports/collabbox/collab-out-2026-10-01"
OUT = ROOT / "exports/repairs/history-cancels"
OUT.mkdir(parents=True, exist_ok=True)
C = collections.Counter
WIDE = 45
SALE_TYPES = {"10036", "10050", "10106", "10055", "10111", "10114"}


def p8(s):
    x = re.sub(r"\D", "", str(s or ""))[-8:]
    return x if len(x) == 8 and len(set(x)) > 1 else ""


def series(t):
    m = re.match(r"^\d{3}-([^-]+)-", str(t))
    return m.group(1) if m else ("M" if re.match(r"^M\d", str(t)) else "NTMK" if str(t).startswith("NTMK") else "other")


rows = list(csv.DictReader(open(AUD / "history-audit" / "orders_verdict_2023-01_2026-08-01.csv", encoding="utf-8-sig", newline="")))
claimed_p = {r["mex_tracking_id"] for r in rows if r["mex_tracking_id"]} | {r["crm_mex_tracking_id"] for r in rows if r["crm_mex_tracking_id"]}
claimed_d = {r["cb_doc"] for r in rows if r["cb_doc"]}

mex_by_phone = collections.defaultdict(list)
for fn in ("mex_NATURA.json", "mex_BIO_NATURAL.json"):
    for r in json.load(open(AUD / "mex-register" / fn, encoding="utf-8")):
        ph = p8(r.get("receiver_phone"))
        if ph and (r.get("created_at") or "") >= "2024-11":
            mex_by_phone[ph].append((str(r["tracking_id"]), (r.get("created_at") or "")[:10]))
kom = collections.defaultdict(set)
with open(CB / "komitenti_full.csv", encoding="utf-8-sig") as f:
    for row in csv.DictReader(f):
        for fld in ("Telefon", "Mobilen"):
            for part in re.split(r"[,;/]| {2,}", row.get(fld) or ""):
                if p8(part):
                    kom[row["Sifra"]].add(p8(part))
cb_by_phone = collections.defaultdict(list)
cbj = json.load(open(next(CB.glob("collabbox_01.01.2023_*.json")), encoding="utf-8"))
for h in cbj["headers"]:
    if h["datetime"][:7] >= "2024-11" and str(h["typeId"]) in SALE_TYPES and (h.get("amount") or 0) > 0:
        for ph in kom.get(str(h["customerId"] or ""), ()):
            cb_by_phone[ph].append((h["docNumber"], h["datetime"][:10]))
del cbj

D = lambda s: dt.date.fromisoformat(s[:10])
near = lambda d, d0: abs((D(d) - d0).days) <= WIDE
out, kinds = [], C()
for r in rows:
    if r["verdict"] != "REVIEW_TRACE_OUTSIDE_WINDOW":
        continue
    d0, ph = D(r["order_day"]), r["phone8"]
    parcels = [(t, d) for t, d in mex_by_phone.get(ph, ()) if near(d, d0)]
    docs = [(n, d) for n, d in cb_by_phone.get(ph, ()) if near(d, d0)]
    free_parcel = any(t not in claimed_p and series(t) not in ("M", "NTMK") for t, d in parcels)
    free_doc = any(n not in claimed_d and n not in claimed_p for n, d in docs)
    owned = any(t in claimed_p for t, d in parcels) or any(n in claimed_d or n in claimed_p for n, d in docs)
    web = any(series(t) in ("M", "NTMK") and t not in claimed_p for t, d in parcels)
    k = ("unclaimed parcel" if free_parcel else "unclaimed document" if free_doc else "another order's" if owned else "web parcel only" if web else "nothing now")
    kinds[k] += 1
    out.append(dict(order_id=r["order_id"], display_id=r["display_id"], order_day=r["order_day"], audit_status=r["status"], dept=r["dept"],
                    price_eur=r["price_eur"], trace=k))
with open(OUT / "trace-outside-window.csv", "w", encoding="utf-8-sig", newline="") as f:
    w = csv.DictWriter(f, fieldnames=list(out[0].keys()))
    w.writeheader()
    w.writerows(out)
sys.stdout.reconfigure(encoding="utf-8")
print("paid, trace only 11–45 days away:", len(out))
for k, v in kinds.most_common():
    print(f"   {v:5d}  {k}")
print("→", OUT / "trace-outside-window.csv")
