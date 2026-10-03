# scripts/history/courier_outcomes_build.py — READ-ONLY builder of the input list for scripts/repair-courier-outcomes.mjs
#
# Owner 03.10.2026: the parcels MEX did not carry (Kolporter Post 22.01–27.11.2024, Eko Logistik 09.10.2025–22.01.2026,
# Jon Express 12 days of May–June 2026) are judged by the delivery flag collabBox itself holds per document
# ("Delivered" / "Return to sender", read by scripts/collabbox-delivery-attrs.mjs; on 38.412 documents MEX carried the
# flag equals MEX's final status in 98,4 %).
#
# Sources (all local, private, gitignored — nothing is fetched and nothing is written to any system):
#   exports/collabbox/delivery-attrs/<day>.json                  the flags per document
#   exports/collabbox/collab-out-2026-10-01/                     the document crawl (number, type, komitent, amount, time) + komitent phones
#   exports/db-move/2026-10-03/courier-investigation/other_courier_days.csv   which courier carried which folder on which day
#   D:/naturatherapy/_salesforce-plan/07-data-backups-PRIVATE/2026-10-03/     the history audit (order ↔ document) + the MEX register dump
#
# Output: exports/repairs/courier-outcomes/input.csv — one row per CRM order whose document went with another courier.
# It holds order ids and document numbers only (no names, no phones). The repair script re-validates every row against
# the live database before it plans anything.
#
# A returned document is checked for a RE-SEND: a later sales document of the same komitent (or the same phone), 1–45 days
# on, that no order owns. If that one was delivered (its own collabBox flag, or MEX's status when MEX carried it) the
# order was paid in the end and must not be marked returned.
import csv, json, glob, re, collections, datetime as dt, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ATTR = ROOT / "exports/collabbox/delivery-attrs"
CB = ROOT / "exports/collabbox/collab-out-2026-10-01"
DAYS = ROOT / "exports/db-move/2026-10-03/courier-investigation/other_courier_days.csv"
AUD = Path(r"D:/naturatherapy/_salesforce-plan/07-data-backups-PRIVATE/2026-10-03")
OUT = ROOT / "exports/repairs/courier-outcomes"
OUT.mkdir(parents=True, exist_ok=True)
C = collections.Counter
RESEND_DAYS = 45
SALE_TYPES = {"10036", "10050", "10106", "10055", "10111", "10114"}
FAMILY = {"Нарачка LEADS": "LEADS", "LEADS-OUT Нарачка": "LEADS", "Нарачка in": "teleshop", "Нарачка out": "teleshop",
          "Нарачка Социјални Мрежи": "social", "Нарачка С. Мрежи-Продавница": "social"}
COURIER_MK = {"Kolporter Post": "Колпортер Пост", "Eko Logistik": "Еко Логистик", "Jon Express": "Јон Експрес"}


def p8(s):
    x = re.sub(r"\D", "", str(s or ""))[-8:]
    return x if len(x) == 8 and len(set(x)) > 1 else ""


def flag_outcome(d):
    if d["returned"] == "Da":
        return "returned"
    if d["delivered"] == "Da":
        return "delivered"
    return "neither"


def mex_outcome(name):
    return "delivered" if name == "Delivered" else "returned" if name in ("Return to sender", "Rejected") else "open"


def wall_iso(at):  # "30.01.2024 20:16:25" (Skopje wall time) → "2024-01-30T20:16:25"
    m = re.match(r"^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}):(\d{2}):(\d{2})$", at or "")
    return f"{m[3]}-{m[2]}-{m[1]}T{m[4]}:{m[5]}:{m[6]}" if m else ""


# the flags
attrs = {}
for f in sorted(glob.glob(str(ATTR / "*.json"))):
    j = json.load(open(f, encoding="utf-8"))
    for d in j["docs"]:
        d["day"] = j["date"]
        attrs[d["doc"]] = d

# the MEX register (a document number MEX carried is its tracking id)
mex = {}
for fn in ("mex_NATURA.json", "mex_BIO_NATURAL.json"):
    for r in json.load(open(AUD / "mex-register" / fn, encoding="utf-8")):
        mex[str(r.get("tracking_id") or "")] = r.get("current_status_name") or ""

# which courier carried a folder on a day
days = {}
for r in csv.DictReader(open(DAYS, encoding="utf-8-sig")):
    days[(r["date"], r["folder_group"].split("(")[0])] = (r["day_class"], r["courier"].split(" (")[0])

other = {}  # document → (courier, outcome)
for no, d in attrs.items():
    if no in mex or d["amount"] <= 0:
        continue
    fam = FAMILY.get(d["type"], "other")
    cls = days.get((d["day"], fam)) or days.get((d["day"], "teleshop")) or ("?", "?")
    if cls[0] == "MEX":
        continue
    courier = cls[1] if cls[1] not in ("MEX", "?") else ("Kolporter Post" if d["day"] < "2025-01-01" else "Eko Logistik" if d["day"] < "2026-03-01" else "Jon Express")
    other[no] = (courier, flag_outcome(d))

# the crawl: komitent + phones per document
cbj = json.load(open(next(CB.glob("collabbox_01.01.2023_*.json")), encoding="utf-8"))
kom_p8 = collections.defaultdict(set)
with open(CB / "komitenti_full.csv", encoding="utf-8-sig") as f:
    for row in csv.DictReader(f):
        for fld in ("Telefon", "Mobilen"):
            for part in re.split(r"[,;/]| {2,}", row.get(fld) or ""):
                if p8(part):
                    kom_p8[row["Sifra"]].add(p8(part))
crawl = {}
by_kid, by_phone = collections.defaultdict(list), collections.defaultdict(list)
for h in cbj["headers"]:
    x = dict(no=h["docNumber"], type=str(h["typeId"]), kid=str(h["customerId"] or ""), at=h["datetime"], amt=h.get("amount") or 0)
    if x["no"] in crawl:
        continue
    crawl[x["no"]] = x
    if x["type"] in SALE_TYPES and x["amt"] > 0:
        if x["kid"]:
            by_kid[x["kid"]].append(x)
        for ph in kom_p8.get(x["kid"], ()):
            by_phone[ph].append(x)

# the audit: order ↔ document
verdict_rows = list(csv.DictReader(open(AUD / "history-audit" / "orders_verdict_2023-01_2026-08-01.csv", encoding="utf-8-sig", newline="")))
claimed = {r["cb_doc"] for r in verdict_rows if r["cb_doc"]}
claimed |= {r["mex_tracking_id"] for r in verdict_rows if r["mex_tracking_id"]}

D = lambda s: dt.datetime.fromisoformat(s[:19])


def resend_of(no):
    """The best later document no order owns: delivered beats open beats returned; the earliest of that kind."""
    x = crawl.get(no)
    if not x:
        return None
    t0 = D(x["at"])
    seen, cands = set(), []
    pool = list(by_kid.get(x["kid"], ()))
    for ph in kom_p8.get(x["kid"], ()):
        pool.extend(by_phone.get(ph, ()))
    for y in pool:
        if y["no"] == no or y["no"] in seen or y["no"] in claimed:
            continue
        seen.add(y["no"])
        gap = (D(y["at"]) - t0).total_seconds() / 86400
        if not (0 < gap <= RESEND_DAYS):
            continue
        if y["no"] in mex:
            out, via = mex_outcome(mex[y["no"]]), "mex"
        elif y["no"] in attrs:
            out, via = flag_outcome(attrs[y["no"]]), "collabbox"
        else:
            out, via = "unknown", "none"
        cands.append((({"delivered": 0, "open": 1, "unknown": 1, "neither": 1, "returned": 2}[out]), y["at"], y["no"], out, via))
    if not cands:
        return None
    cands.sort()
    _, at, rno, out, via = cands[0]
    return dict(doc=rno, at=at[:19], outcome=out, via=via, n=len(cands))


rows, stats, rs = [], C(), C()
for r in verdict_rows:
    no = r["cb_doc"]
    if not no or no not in other:
        continue
    courier, outcome = other[no]
    a = attrs[no]
    re_ = resend_of(no) if outcome == "returned" else None
    if re_:
        rs[(r["status"], re_["outcome"], re_["via"])] += 1
    stats[(r["status"], outcome)] += 1
    rows.append(dict(order_id=r["order_id"], display_id=r["display_id"], order_day=r["order_day"], audit_status=r["status"],
                     audit_verdict=r["verdict"], audit_paid_basis=r["paid_basis"], dept=r["dept"], match=r["cb_check"],
                     doc=no, doc_type=a["type"], doc_at=wall_iso(a["at"]), doc_amount_mkd=a["amount"],
                     courier=courier, courier_mk=COURIER_MK.get(courier, courier), outcome=outcome,
                     paid_by_kolporter=a.get("paidKolporter", ""),
                     resend_doc=re_["doc"] if re_ else "", resend_at=re_["at"] if re_ else "",
                     resend_outcome=re_["outcome"] if re_ else "", resend_via=re_["via"] if re_ else "",
                     price_eur=r["price_eur"]))
rows.sort(key=lambda z: (z["doc_at"], z["display_id"]))
cols = list(rows[0].keys())
with open(OUT / "input.csv", "w", encoding="utf-8-sig", newline="") as f:
    w = csv.DictWriter(f, fieldnames=cols)
    w.writeheader()
    w.writerows(rows)

# every audited order that owns evidence of its own (a document or a MEX parcel) — ids only; the repair's twin guard reads it
with open(OUT / "owned-orders.csv", "w", encoding="utf-8", newline="") as f:
    print("order_id", file=f)
    for r in verdict_rows:
        if r["cb_doc"] or r["mex_tracking_id"]:
            print(r["order_id"], file=f)

out = sys.stdout
out.reconfigure(encoding="utf-8")
print(f"documents with flags: {len(attrs)} · carried by another courier: {len(other)} · CRM orders on them: {len(rows)}")
print("audit status × collabBox outcome:")
for k, v in sorted(stats.items(), key=lambda kv: -kv[1]):
    print(f"   {k[0]:10s} {k[1]:10s} {v}")
print("returned documents with a later document of the same customer that no order owns (≤ 45 days):")
for k, v in sorted(rs.items(), key=lambda kv: -kv[1]):
    print(f"   order {k[0]:10s} · re-send {k[1]:10s} via {k[2]:9s} {v}")
print("missing doc time:", sum(1 for z in rows if not z["doc_at"]))
print("→", OUT / "input.csv")
