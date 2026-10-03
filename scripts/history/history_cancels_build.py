# scripts/history/history_cancels_build.py — READ-ONLY builder of the input list for scripts/repair-history-cancels.mjs
#
# The owner's rules for the history up to 01.08.2026 (hand-over of 03.10.2026, §4):
#   SET_CANCELLED             paid, no MEX parcel, no collabBox document, nothing on the phone within ±45 days
#                             → cancelled ("платена + нема MEX + нема collabBox = откажана")
#   SET_CANCELLED_DUPLICATE   paid, no proof of its own; the parcel in its window belongs to another order of the customer
#                             → cancelled as a duplicate of that order
#   SET_CANCELLED_LABEL_ONLY  the parcel never left MEX status 8 ("Shipment created")
#                             → cancelled ("етикета направена, MEX никогаш не ја подигна")
# This builder adds the evidence that must STOP a cancel:
#   - a NAME match: an unclaimed MEX parcel or collabBox document in the order's window (−1 … +10 days) whose receiver
#     has the order's first + last name and a compatible city — the sale probably went out under another phone;
#   - for a "duplicate": a collabBox document of its own that another courier carried, with collabBox's Delivered /
#     Return-to-sender flag — then it is a sale of its own and is judged by the flag;
#   - for a label: a parcel MEX delivered on the same phone up to 45 days later that no order owns (the real shipment).
#
# Sources (local, private, gitignored): the fresh history audit (order ↔ parcel / document), the MEX register dump, the
# collabBox crawl + komitent register, the delivery flags, and — read-only, in memory only — the customers' names of
# the SET_CANCELLED orders from the live database (never written to the output).
# Output: exports/repairs/history-cancels/input.csv — order ids, display ids, tracking / document numbers only.
import csv, json, glob, re, collections, sys, datetime as dt
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
AUD = Path(r"D:/naturatherapy/_salesforce-plan/07-data-backups-PRIVATE/2026-10-03")
CB = ROOT / "exports/collabbox/collab-out-2026-10-01"
ATTR = ROOT / "exports/collabbox/delivery-attrs"
OUT = ROOT / "exports/repairs/history-cancels"
OUT.mkdir(parents=True, exist_ok=True)
sys.path.insert(0, str(AUD / "history-audit"))
import mkcrm_ro  # read-only SELECT through the Management API (read_only: true)

C = collections.Counter
WIN_LO, WIN_HI, RESEND_DAYS = -1, 10, 45
SALE_TYPES = {"10036", "10050", "10106", "10055", "10111", "10114"}
CYR = dict(zip("абвгдѓежзѕијклљмнњопрстќуфхцчџш", ["a", "b", "v", "g", "d", "g", "e", "z", "z", "dz", "i", "j", "k", "l", "lj", "m", "n", "nj", "o", "p", "r", "s", "t", "k", "u", "f", "h", "c", "c", "dz", "s"]))


def fold(s):  # the repair kit's fold(): Cyrillic → Latin, zh / sh / ch flattened, letters only
    s = "".join(CYR.get(ch, ch) for ch in str(s or "").lower())
    s = s.replace("zh", "z").replace("sh", "s").replace("ch", "c").replace("ž", "z").replace("š", "s").replace("č", "c").replace("ć", "c").replace("đ", "dj")
    return re.sub(r"\s+", " ", re.sub(r"[^a-z ]", " ", s)).strip()


tokens = lambda s: {t for t in fold(s).split(" ") if len(t) >= 3}


def within_one(a, b):
    if a == b:
        return True
    if abs(len(a) - len(b)) > 1 or min(len(a), len(b)) < 5:
        return False
    i = j = e = 0
    while i < len(a) and j < len(b):
        if a[i] == b[j]:
            i += 1; j += 1; continue
        e += 1
        if e > 1:
            return False
        if len(a) > len(b): i += 1
        elif len(b) > len(a): j += 1
        else: i += 1; j += 1
    return e + (len(a) - i) + (len(b) - j) <= 1


name_hits = lambda a, b: sum(1 for x in a if any(within_one(x, y) for y in b))
city_ok = lambda a, b: (not a) or (not b) or a.startswith(b[:4]) or b.startswith(a[:4])


def p8(s):
    x = re.sub(r"\D", "", str(s or ""))[-8:]
    return x if len(x) == 8 and len(set(x)) > 1 else ""


def series(t):
    m = re.match(r"^\d{3}-([^-]+)-", str(t or ""))
    return m.group(1) if m else ("NTMK" if str(t).startswith("NTMK") else "M" if re.match(r"^M\d", str(t)) else "other")


D = lambda s: dt.date.fromisoformat(s[:10])
iso = lambda s: s[:19].replace(" ", "T")

# the fresh audit
rows = list(csv.DictReader(open(AUD / "history-audit" / "orders_verdict_2023-01_2026-08-01.csv", encoding="utf-8-sig", newline="")))
claimed_parcels = {r["mex_tracking_id"] for r in rows if r["mex_tracking_id"]} | {r["crm_mex_tracking_id"] for r in rows if r["crm_mex_tracking_id"]}
claimed_docs = {r["cb_doc"] for r in rows if r["cb_doc"]}
by_display = {r["display_id"]: r for r in rows}

# the MEX register
mex, mex_by_day, mex_by_phone = {}, collections.defaultdict(list), collections.defaultdict(list)
for acc, fn in (("NATURA", "mex_NATURA.json"), ("BIO NATURAL", "mex_BIO_NATURAL.json")):
    for r in json.load(open(AUD / "mex-register" / fn, encoding="utf-8")):
        tid = str(r.get("tracking_id") or "")
        m = dict(tid=tid, acc=acc, st=r.get("current_status_name") or "", c=r.get("created_at") or "", lu=r.get("last_update_at") or "",
                 p8=p8(r.get("receiver_phone")), ser=series(tid), nm=tokens(r.get("receiver_name")), city=fold(r.get("receiver_city")))
        mex[tid] = m
        if m["c"][:4] >= "2024" and m["ser"] not in ("M", "NTMK"):
            mex_by_day[m["c"][:10]].append(m)
        if m["p8"]:
            mex_by_phone[m["p8"]].append(m)

# the collabBox crawl (sales documents with the komitent's name)
cb_by_day = collections.defaultdict(list)
cbj = json.load(open(next(CB.glob("collabbox_01.01.2023_*.json")), encoding="utf-8"))
for h in cbj["headers"]:
    if str(h["typeId"]) in SALE_TYPES and (h.get("amount") or 0) > 0 and h["datetime"][:4] >= "2024":
        cb_by_day[h["datetime"][:10]].append(dict(no=h["docNumber"], nm=tokens(h.get("customerName")), at=h["datetime"]))
del cbj

# the delivery flags of the documents another courier carried
flags, flag_at = {}, {}
for f in glob.glob(str(ATTR / "*.json")):
    for d in json.load(open(f, encoding="utf-8"))["docs"]:
        flags[d["doc"]] = "returned" if d["returned"] == "Da" else "delivered" if d["delivered"] == "Da" else "neither"
        t = re.match(r"^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}:\d{2}:\d{2})$", d.get("at") or "")
        flag_at[d["doc"]] = f"{t[3]}-{t[2]}-{t[1]}T{t[4]}" if t else ""

# the names of the SET_CANCELLED orders — read-only, in memory only
want = [r["order_id"] for r in rows if r["verdict"] == "SET_CANCELLED"]
names = {}
for i in range(0, len(want), 400):
    ids = ",".join("'" + x + "'" for x in want[i:i + 400])
    for x in mkcrm_ro.q("new", f"select id, customer_name, customer_city from orders where id in ({ids})"):
        names[x["id"]] = (tokens(x.get("customer_name")), fold(x.get("customer_city")))


def name_match(r):
    nm, city = names.get(r["order_id"], (set(), ""))
    if len(nm) < 2:
        return None
    d0 = D(r["order_day"])
    for k in range(WIN_LO, WIN_HI + 1):
        day = (d0 + dt.timedelta(days=k)).isoformat()
        for m in mex_by_day.get(day, ()):
            if m["tid"] not in claimed_parcels and name_hits(nm, m["nm"]) >= 2 and city_ok(city, m["city"]):
                return ("mex", m["tid"], m["st"])
        for x in cb_by_day.get(day, ()):
            if x["no"] not in claimed_docs and x["no"] not in mex and name_hits(nm, x["nm"]) >= 2:
                return ("collabbox", x["no"], flags.get(x["no"], "no flag read"))
    return None


def later_delivered(m):
    best = None
    for y in mex_by_phone.get(m["p8"], ()):
        if y["tid"] == m["tid"] or y["tid"] in claimed_parcels or y["st"] != "Delivered" or y["ser"] in ("M", "NTMK") or not y["c"] or not m["c"]:
            continue
        gap = (dt.datetime.fromisoformat(iso(y["c"])) - dt.datetime.fromisoformat(iso(m["c"]))).total_seconds() / 86400
        if 0 < gap <= RESEND_DAYS and (best is None or y["c"] < best["c"]):
            best = y
    return best


out, stats = [], C()
for r in rows:
    v = r["verdict"]
    if v not in ("SET_CANCELLED", "SET_CANCELLED_DUPLICATE", "SET_CANCELLED_LABEL_ONLY"):
        continue
    base = dict(order_id=r["order_id"], display_id=r["display_id"], order_day=r["order_day"], audit_status=r["status"], audit_verdict=v,
                dept=r["dept"], price_eur=r["price_eur"], tracking="", mex_status="", mex_created="", match="",
                duplicate_of="", duplicate_of_day="", own_doc="", own_doc_flag="", own_doc_at="", rescue_kind="", rescue_ref="", rescue_state="")
    if v == "SET_CANCELLED":
        hit = name_match(r)
        if hit:
            base.update(rescue_kind=hit[0], rescue_ref=hit[1], rescue_state=hit[2])
        stats[(v, "name match: " + hit[0] if hit else "no trace")] += 1
    elif v == "SET_CANCELLED_DUPLICATE":
        twin = by_display.get(r["duplicate_of"])
        base.update(duplicate_of=r["duplicate_of"], duplicate_of_day=twin["order_day"] if twin else "", own_doc=r["cb_doc"],
                    own_doc_flag=flags.get(r["cb_doc"], "") if r["cb_doc"] else "", own_doc_at=flag_at.get(r["cb_doc"], "") if r["cb_doc"] else "")
        stats[(v, "own document: " + (base["own_doc_flag"] or "no flag read") if r["cb_doc"] else "no document")] += 1
    else:
        m = mex.get(r["mex_tracking_id"])
        re_ = later_delivered(m) if m else None
        base.update(tracking=r["mex_tracking_id"], mex_status=m["st"] if m else "", mex_created=iso(m["c"]) if m else "", match=r["mex_check"],
                    rescue_kind="mex" if re_ else "", rescue_ref=re_["tid"] if re_ else "", rescue_state="Delivered later" if re_ else "")
        stats[(v, r["status"], "delivered later" if re_ else "")] += 1
    out.append(base)
out.sort(key=lambda z: (z["audit_verdict"], z["order_day"], z["display_id"]))
with open(OUT / "input.csv", "w", encoding="utf-8-sig", newline="") as f:
    w = csv.DictWriter(f, fieldnames=list(out[0].keys()))
    w.writeheader()
    w.writerows(out)
sys.stdout.reconfigure(encoding="utf-8")
print(f"orders: {len(out)} · names read for {len(names)} SET_CANCELLED orders")
for k, n in sorted(stats.items(), key=lambda kv: (kv[0][0], -kv[1])):
    print("  ", k, n)
print("→", OUT / "input.csv")

if "--diag" in sys.argv:  # how strong is the name check? (aggregates only)
    sc = [r for r in rows if r["verdict"] == "SET_CANCELLED"]
    print("SET_CANCELLED names with < 2 tokens:", sum(1 for r in sc if len(names.get(r["order_id"], (set(), ""))[0]) < 2))
    loose = C()
    for r in sc:
        nm, city = names.get(r["order_id"], (set(), ""))
        if len(nm) < 2:
            continue
        d0 = D(r["order_day"]); hit = None
        for k in range(WIN_LO, WIN_HI + 1):
            day = (d0 + dt.timedelta(days=k)).isoformat()
            for m in mex_by_day.get(day, ()):
                if name_hits(nm, m["nm"]) >= 2 and city_ok(city, m["city"]):
                    hit = hit or ("mex claimed by another order" if m["tid"] in claimed_parcels else "mex unclaimed")
            for x in cb_by_day.get(day, ()):
                if name_hits(nm, x["nm"]) >= 2:
                    hit = hit or ("document claimed by another order" if (x["no"] in claimed_docs or x["no"] in mex) else "document unclaimed")
        loose[hit or "nothing on the name"] += 1
    print("same first + last name in the window, claimed or not:", dict(loose))
    print("by month:", sorted(C(r["order_day"][:7] for r in sc).items()))
