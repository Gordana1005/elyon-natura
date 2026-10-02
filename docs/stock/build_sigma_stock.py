# -*- coding: utf-8 -*-
"""Stock v2 — the Sigma side: articles, purchase costs, the 22.09 opening variants, kits, product recipes and the
first Sigma batch (owner decisions 01.10.2026; contract docs/STOCK-V2.md "Data files from build_sigma_stock.py").

EVIDENCE (read only):
  * the Sigma CSV export (29–30.09.2026) in D:\\naturatherapy\\_salesforce-plan\\05-sigma-export\\raw-export —
    Item, ItemGroup, DocType, Client, StockObject, InventoryHead/InventoryLine (posted stock documents),
    WorkDocInHead/WorkDocInLine (work documents incl. drafts);
  * the S2 research crosswalk (02-knowledge/research/S2-product-crosswalk.csv);
  * the CRM, read only, through docs/stock/crm_snapshot.mjs → exports/stock/crm-inputs.json (products, collabBox
    lines that carry both a product_id and a code, single-line orders vs their collabBox document, web items).

THE SIGN RULE (tools/sigma-connector/sigma-fields.json `sign_rule`, checked here against StockObject): an
InventoryLine quantity is signed by Sigma; a transfer (DocType.TransferDoc = 1) is −qty at the From object and
+qty at the To object; InOut I… is +qty at the To object; InOut O… is −qty at the From object. Summed over all
lines this reproduces StockObject on every (company, object, item) except Ф00001-04 / 001684 (+10, a document
posted after the StockObject file was cut) — the build prints that check and stops if anything else differs.

OUTPUTS (exports/stock/, gitignored — business-confidential costs, never committed):
  articles.json, costs.json, openings.json, kits.json, recipes.json, sigma-batch-since-2209.json   (the contract)
  aliases.json        stock_article_alias_set() proposals (collabBox codes / names, web products / skus)
  exempt.json         products that never move stock (delivery, points, flyers)
  local-articles.json articles that collabBox ships but Sigma does not have (code L00001…)
  review-*.json       the detail behind each sheet of the owner's workbook (docs/stock/mapping_review_xlsx.py)
  sigma-mex-invoices.json  Sigma MEX COD invoice units per month × company × article (scripts/stock/sigma-month-check.mjs)
  summary.json        the numbers of this run

  python docs/stock/build_sigma_stock.py [--out DIR] [--sigma DIR] [--research DIR] [--refresh-crm]
"""
import argparse, collections, csv, datetime, functools, hashlib, json, os, re, statistics, subprocess, sys
from zoneinfo import ZoneInfo

csv.field_size_limit(10 ** 9)
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, "..", ".."))
FIELDS = json.load(open(os.path.join(ROOT, "tools", "sigma-connector", "sigma-fields.json"), encoding="utf-8"))
SKOPJE = ZoneInfo("Europe/Skopje")
OPENING_DAY = "2026-09-22"
OPENING_AT = "2026-09-22T00:00:00+02:00"
MKD_PER_EUR = 61.5            # the frozen peg — only to show the OLD CRM cost (EUR) in денари
ARTICLE_CLASSES = set(FIELDS["article_classes"])
DOC_OBJECTS = set(FIELDS["objects"]["docs"])
BAL_OBJECTS = set(FIELDS["objects"]["balances"])

ap = argparse.ArgumentParser()
ap.add_argument("--out", default=os.path.join(ROOT, "exports", "stock"))
ap.add_argument("--sigma", default=r"D:\naturatherapy\_salesforce-plan\05-sigma-export\raw-export")
ap.add_argument("--research", default=r"D:\naturatherapy\_salesforce-plan\02-knowledge\research")
ap.add_argument("--crm-inputs", default=None)
ap.add_argument("--refresh-crm", action="store_true")
ARGS = ap.parse_args()
OUT = os.path.abspath(ARGS.out)
os.makedirs(OUT, exist_ok=True)
CRM_INPUTS = ARGS.crm_inputs or os.path.join(OUT, "crm-inputs.json")


def log(*a):
    print(*a, flush=True)


def dump(name, obj):
    with open(os.path.join(OUT, name), "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=1)


def read(name, cols):
    """Rows of a Sigma CSV restricted to `cols` (values trimmed — Sigma codes carry trailing blanks)."""
    with open(os.path.join(ARGS.sigma, name + ".csv"), encoding="utf-8-sig", newline="") as f:
        r = csv.reader(f)
        head = next(r)
        idx = [head.index(c) for c in cols]
        return [dict(zip(cols, (row[i].strip() for i in idx))) for row in r]


def num(s):
    try:
        return float(s) if s not in ("", None) else 0.0
    except ValueError:
        return 0.0


def r3(x):
    v = round(float(x), 3)
    return 0.0 if v == 0 else v


def local_iso(s):
    """A Sigma local timestamp ('2026-09-28 15:14:40', server time Europe/Skopje) → ISO with the offset."""
    if not s:
        return None
    dt = datetime.datetime.strptime(s[:19], "%Y-%m-%d %H:%M:%S").replace(tzinfo=SKOPJE)
    return dt.isoformat(timespec="seconds")


def file_iso(name):
    ts = os.path.getmtime(os.path.join(ARGS.sigma, name + ".csv"))
    return datetime.datetime.fromtimestamp(ts, SKOPJE).replace(microsecond=0).isoformat()


# ── text folding: a lossy phonetic key so that ZINC = ЦИНК, MAGNESIUM = МАГНЕЗИУМ, COLLAGEN = КОЛАГЕН ──────────
CYR = dict(zip("абвгдѓежзѕијклљмнњопрстќуфхцчџшйщъьюяыэёђћѐѝ",
               ["a", "b", "v", "g", "d", "g", "e", "s", "s", "s", "i", "j", "k", "l", "l", "m", "n", "n", "o", "p",
                "r", "s", "t", "k", "u", "f", "h", "s", "k", "d", "s", "j", "st", "a", "j", "u", "a", "i", "e", "e",
                "d", "k", "e", "i"]))
LAT = [("sh", "s"), ("ch", "k"), ("zh", "s"), ("ph", "f"), ("th", "t"), ("ck", "k"), ("q", "k"), ("w", "v"),
       ("x", "ks"), ("y", "i"), ("z", "s"), ("c", "k")]


def fold(s):
    s = (s or "").lower().replace("&amp;", "&")
    out = []
    for ch in s:
        out.append(CYR[ch] if ch in CYR else ch)
    s = "".join(out)
    s = re.sub(r"[^a-z0-9]+", " ", s)
    for a, b in LAT:
        s = s.replace(a, b)
    s = re.sub(r"([a-z])\1+", r"\1", s)
    return s.strip()


STOP = {fold(w) for w in ("cps", "tab", "tbl", "kom", "ml", "gr", "kg", "mg", "sirup", "caps", "kapsuli", "tableti",
                          "set", "the", "and", "za", "so", "na", "od", "vo", "dr", "сет", "со", "за", "од", "мл", "гр",
                          "таб", "табл", "капсули", "таблети", "цпс", "kapsule", "tablet", "tablets", "capsules")}


@functools.lru_cache(maxsize=None)
def tokens(s):
    """Distinctive words: 3+ letters, or a letter-digit code such as B6 / D3 / K2 / Q10 (never a size like 500ml)."""
    return tuple(t for t in fold(s).split() if t not in STOP and t[0].isalpha() and
                 (len(t) >= 3 or (len(t) >= 2 and re.search(r"[0-9]", t))))


def edit1(a, b):
    if abs(len(a) - len(b)) > 1:
        return False
    if len(a) == len(b):
        return sum(1 for x, y in zip(a, b) if x != y) <= 1
    if len(a) > len(b):
        a, b = b, a
    i = 0
    while i < len(a) and a[i] == b[i]:
        i += 1
    return a[i:] == b[i + 1:]


def tok_eq(a, b):
    """1 = the same word (or one letter off), 0.7 = one is a prefix of the other, 0 = different."""
    if a == b:
        return 1.0
    if len(a) >= 5 and len(b) >= 5 and edit1(a, b):
        return 1.0
    if len(a) >= 4 and len(b) >= 4 and (a.startswith(b) or b.startswith(a) or a[:5] == b[:5]):
        return 0.7
    return 0.0


def cover(ta, tb):
    """Share of the words ta found in tb (1 = same word, 0.9 = glued: 'КУРКУМА АКТИВ' / 'КУРКУМАКТИВ', 0.7 = prefix)."""
    if not ta or not tb:
        return 0.0
    joined = "".join(tb)

    def hit(t):
        best = max(tok_eq(t, u) for u in tb)
        if best < 0.9 and len(t) >= 5 and t in joined:
            best = 0.9
        return best
    return sum(hit(t) for t in ta) / len(ta)


def name_sim(a, b):
    """How well the shorter name's distinctive words are found in the other name (0..1)."""
    ta, tb = tokens(a), tokens(b)
    if len(ta) > len(tb):
        ta, tb = tb, ta
    return cover(ta, tb)


COMPANY_WORDS = {w.upper() for w in FIELDS["company_hint_words"]}


def company_name(name):
    """sigma-fields.json client_name_rule — a person's name never leaves Sigma."""
    n = (name or "").strip()
    if not n:
        return None
    words = re.findall(r"[^\W\d_]+", n.upper())
    if any(w in COMPANY_WORDS for w in words):
        return n
    if re.search(r"[0-9.*\-&\"()]", n):
        return n
    if len(words) == 1 or len(words) >= 4:
        return n
    return None


# ═══ 1. Sigma master data ══════════════════════════════════════════════════════════════════════════════════════
log("reading the Sigma export …")
ITEMS = {}
for r in read("Item", ["ItemID", "Name", "AccountPG", "MainUnitID", "ItemGroupID", "isUnactive", "sysdatetime"]):
    ITEMS[r["ItemID"]] = dict(code=r["ItemID"], name=r["Name"], cls=r["AccountPG"].strip(), unit=r["MainUnitID"],
                              group=r["ItemGroupID"], inactive=r["isUnactive"] == "1", created=r["sysdatetime"][:10])
DOCTYPES = {}
for r in read("DocType", ["DocType", "TypeDescription", "InOut", "TransferDoc", "HeaderTableName"]):
    DOCTYPES[r["DocType"]] = dict(name=r["TypeDescription"], inout=r["InOut"], transfer=r["TransferDoc"] == "1",
                                  table=r["HeaderTableName"])
CLIENTS = {r["ClientID"]: r["Name"] for r in read("Client", ["ClientID", "Name"])}
OBJECT_NAMES = {f'{r["ClientID"]}-{r["ObjectID"]}': r["Name"] for r in read("ClientObject", ["ObjectID", "ClientID", "Name"])}
EXPORT_AT = file_iso("StockObject")
EXPORT_DAY = EXPORT_AT[:10]
log(f"  {len(ITEMS)} items, {len(DOCTYPES)} doc types, {len(CLIENTS)} clients, StockObject file {EXPORT_AT}")

PRIVATE_LABEL = {"PRO NATURAL": "Private label AL (PRO NATURAL)", "MONE TIZE": "Private label BA (MONE TIZE)",
                 "BIOLAB": "Private label (BIOLAB)", "ХЕЛТИКОР ДОО": "Private label (Heltikor)"}


def brand_of(code):
    it = ITEMS.get(code)
    if not it:
        return None
    g, n, cls = it["group"], it["name"].upper(), it["cls"]
    if cls == "ЛОЈАЛИТИ":
        return "Loyalty gift"
    if cls == "ТС":
        return f"Third-party: {g}" if g else "Third-party (trade goods)"
    if g == "АД АСТРА":
        return "AD Astra"
    if g == "БИОНАТУРАЛ" or "BIONATURAL" in n or "БИОНАТУРАЛ" in n:
        return "BioNatural"
    if g == "ELIXY" or n.startswith("ELIXY"):
        return "ELIXY"
    if g == "DR BECKER" or "DR BECKER" in n:
        return "Dr Becker"
    if g == "НАТУРА- БУГАРИЈА":
        return "Natura Therapy (BG label)"
    if g in PRIVATE_LABEL:
        return PRIVATE_LABEL[g]
    if g:
        return f"Third-party: {g}"
    if code.startswith("011"):
        return "Food line"
    return "Natura Therapy" if cls == "АРТИКЛ" else None


SET_RX = re.compile(r"(?<![0-9])[1-5]\s*\+\s*[1-5](?![0-9])|\bсет\b|\bset\b|гратис|gratis|\+\s*[^\d\s]", re.I)

# ═══ 2. the ledger (InventoryLine = posted stock documents) ═════════════════════════════════════════════════════
IH = {}
for r in read("InventoryHead", FIELDS["sigma_tables"]["InventoryHead"]):
    IH[(r["WYear"], r["DocType"], r["DocNo"])] = r
IL = read("InventoryLine", FIELDS["sigma_tables"]["InventoryLine"] + ["BuyPrice"])
WH = {}
for r in read("WorkDocInHead", FIELDS["sigma_tables"]["WorkDocInHead"]):
    WH[(r["WYear"], r["DocType"], r["DocNo"])] = r
WL = collections.defaultdict(list)
for r in read("WorkDocInLine", FIELDS["sigma_tables"]["WorkDocInLine"]):
    if r["CodeType"] == "I":
        WL[(r["WYear"], r["DocType"], r["DocNo"])].append(r)
log(f"  {len(IH)} posted documents, {len(IL)} posted lines, {len(WH)} work documents")


def effects(l):
    """[(object key, signed qty)] of one InventoryLine — the sign rule."""
    dt = DOCTYPES.get(l["DocType"]) or {}
    q = num(l["Quantity"])
    frm, to = f'{l["ClientFrom"]}-{l["ObjectFrom"]}', f'{l["ClientTo"]}-{l["ObjectTo"]}'
    if dt.get("transfer"):
        return [(frm, -q), (to, q)]
    if dt.get("inout", "").startswith("I"):
        return [(to, q)]
    if dt.get("inout", "").startswith("O"):
        return [(frm, -q)]
    return []


def balances(cut_day=None, objects=None):
    """(object, item) → qty from every posted line with WDate ≤ cut_day (None = all)."""
    b = collections.defaultdict(float)
    for l in IL:
        if cut_day and l["WDate"][:10] > cut_day:
            continue
        for obj, q in effects(l):
            if objects is None or obj in objects:
                b[(obj, l["CodeID"])] += q
    return b


SO = read("StockObject", FIELDS["sigma_tables"]["StockObject"])
so_bal = collections.defaultdict(float)
for r in SO:
    so_bal[(f'{r["Client"]}-{r["Object"]}', r["ItemID"])] += num(r["InInventoryQuantity"]) - num(r["OutInventoryQuantity"])
ledger_all = balances()
diffs = [(k, so_bal.get(k, 0.0), ledger_all.get(k, 0.0)) for k in set(so_bal) | set(ledger_all)
         if abs(so_bal.get(k, 0.0) - ledger_all.get(k, 0.0)) > 0.0005]
log(f"sign-rule check: ledger vs StockObject on {len(set(so_bal) | set(ledger_all))} keys → {len(diffs)} differ: "
    + "; ".join(f"{k[0]}/{k[1]} StockObject {s:g} ledger {l:g}" for k, s, l in diffs[:5]))
if len(diffs) > 1 or (diffs and diffs[0][0] != ("Ф00001-04", "001684")):
    sys.exit("STOP: the ledger no longer reproduces StockObject within the one known difference — check the export.")

# ═══ 3. CRM inputs (read-only snapshot) ═════════════════════════════════════════════════════════════════════════
if ARGS.refresh_crm or not os.path.exists(CRM_INPUTS):
    log("refreshing the CRM snapshot (read only) …")
    subprocess.run(["node", os.path.join(HERE, "crm_snapshot.mjs"), "--out", CRM_INPUTS], check=True)
CRM = json.load(open(CRM_INPUTS, encoding="utf-8"))
for _key, _cols in (("products", ("cost_price", "price")), ("cooc", ("units",)),
                    ("cb_codes", ("units", "units_since_2209"))):
    for _r in CRM[_key]:                       # Postgres numeric arrives as a string
        for _c in _cols:
            if isinstance(_r.get(_c), str):
                _r[_c] = float(_r[_c])
PRODUCTS = {p["id"]: p for p in CRM["products"]}
log(f"CRM snapshot {CRM['generated_at']}: {len(PRODUCTS)} products, {len(CRM['cooc'])} collabBox product/code pairs")

# ═══ 4. activity: what sold / shipped ═════════════════════════════════════════════════════════════════════════
YEAR_AGO = (datetime.date.fromisoformat(EXPORT_DAY) - datetime.timedelta(days=365)).isoformat()
OWN = {"Ф00001", "Ф00002", "Ф00003"}
sold_12m = collections.Counter()      # external sales units (ПМ1/ПМ2/ПМ15/ПМ100) last 12 months, any own company
for l in IL:
    if l["DocType"] in ("ПМ1", "ПМ2", "ПМ15", "ПМ100") and l["WDate"][:10] >= YEAR_AGO and l["ClientTo"] not in OWN:
        sold_12m[l["CodeID"]] += num(l["Quantity"])
cb_goods = {}                          # collabBox goods codes (since 2026-03): lines, units, names
for r in CRM["cb_codes"]:
    if r["role"] == "goods" and r["code"]:
        cb_goods[r["code"]] = r
pos_now = {code for (obj, code), q in so_bal.items() if obj in ("Ф00001-04", "Ф00001-08", "Ф00002-00") and q > 0}


def cb_name_ok(code):
    """A collabBox code is the Sigma code only when the names agree (001685 is OPTICARE in collabBox, BENZOKAIN in Sigma)."""
    r = cb_goods.get(code)
    it = ITEMS.get(code)
    if not r or not it:
        return False
    return max((name_sim(n, it["name"]) for n in (r.get("names") or [])), default=0.0) >= 0.5


# ═══ 5. articles ══════════════════════════════════════════════════════════════════════════════════════════════
articles = {}
extra_reason = {}
for code, it in ITEMS.items():
    sold = sold_12m.get(code, 0) > 0
    in_cb = code in cb_goods and cb_name_ok(code)
    # finished goods, trade goods and loyalty gifts; plus anything ELSE the warehouse ships in parcels (a collabBox
    # goods line whose name agrees with Sigma). Raw materials / services that Sigma sells B2B are not stock articles.
    if not re.fullmatch(r"[0-9]{6}", code):
        if it["cls"] in ARTICLE_CLASSES:
            extra_reason[code] = "skipped: not a 6-digit code"
        continue                                       # stock_articles.code CHECK ^[0-9]{6}$ ('Тигрова маст', 'ХЕЛАНКИ')
    if it["cls"] in ARTICLE_CLASSES or in_cb:
        if it["cls"] not in ARTICLE_CLASSES:
            extra_reason[code] = "collabbox"
        articles[code] = dict(code=code, name=it["name"], unit=it["unit"] or "КОМ", sigma_class=it["cls"] or None,
                              brand=brand_of(code), is_set=bool(SET_RX.search(it["name"])),
                              active=bool(sold or code in pos_now or (code in cb_goods and cb_goods[code]["lines_since_2209"] > 0)
                                          or (code in cb_goods and cb_goods[code]["last_at"] >= YEAR_AGO and in_cb)))
log(f"articles: {len(articles)} ({sum(a['active'] for a in articles.values())} active; "
    f"outside the three classes / skipped: {extra_reason})")

# ═══ 6. kits (ММ2 assemblies at Ф00001-04) ═══════════════════════════════════════════════════════════════════════
mm2 = collections.defaultdict(list)
for l in IL:
    if l["DocType"] == "ММ2" and l["ClientTo"] == "Ф00001" and l["ObjectTo"] == "04":
        mm2[(l["WYear"], l["DocType"], l["DocNo"])].append(l)
assemblies = collections.defaultdict(list)
mm2_skipped = collections.Counter()
for key, ls in mm2.items():
    outs = [l for l in ls if l["ProductionFlag"] == "2" and num(l["Quantity"]) > 0]
    comps = [l for l in ls if num(l["Quantity"]) < 0]
    if len(outs) != 1 or not comps:
        mm2_skipped["multi_output" if len(outs) > 1 else "no_output" if not outs else "no_components"] += 1
        continue
    oq = num(outs[0]["Quantity"])
    comp = collections.defaultdict(float)
    for l in comps:
        comp[l["CodeID"]] += -num(l["Quantity"]) / oq
    assemblies[outs[0]["CodeID"]].append(dict(date=ls[0]["WDate"][:10], doc_key="|".join(key), out_qty=oq,
                                              comp={c: round(q, 3) for c, q in comp.items()}))
kits, kit_review = [], []
for kit_code, asm in assemblies.items():
    asm.sort(key=lambda a: (a["date"], a["doc_key"]))
    clean = [a for a in asm if all(q >= 1 and abs(q - round(q)) < 1e-6 for q in a["comp"].values())]
    shapes = collections.Counter(json.dumps(sorted(a["comp"].items())) for a in asm)
    mode = json.loads(shapes.most_common(1)[0][0])
    last = asm[-1]
    flags = []
    if all(q < 1 for q in last["comp"].values()):
        flags.append("unpack")
    if json.dumps(sorted(last["comp"].items())) != shapes.most_common(1)[0][0]:
        flags.append("last_differs_from_mode")
    if not clean:
        flags.append("no_whole_assembly")
    clean_shapes = collections.Counter(json.dumps(sorted(a["comp"].items())) for a in clean)
    if clean:
        top_shape = clean_shapes.most_common(1)[0][0]
        pick = [a for a in clean if json.dumps(sorted(a["comp"].items())) == top_shape][-1]
    else:
        pick = None
    if pick and pick is not last:
        flags.append("picked_most_frequent")
    name = ITEMS.get(kit_code, {}).get("name", "")
    # ММ2 at 04 also re-labels and re-packs (000042 ← 1 × 004508 BG label, ЦИНК 60 ← 2 × ЦИНК 30): only a SET is a kit
    set_like = bool(SET_RX.search(name) or re.search(r"бокс|box|пакет|pack", name, re.I) or (pick and len(pick["comp"]) >= 2))
    if pick and not set_like:
        flags.append("repack" if len(pick["comp"]) == 1 and list(pick["comp"].values())[0] != 1 else "relabel")
    row = dict(kit_code=kit_code, kit_name=name, assemblies=len(asm), first=asm[0]["date"], last=last["date"],
               last_doc=last["doc_key"], last_out_qty=last["out_qty"], last_components=last["comp"],
               mode_components=dict(mode), picked=pick["comp"] if pick else None,
               picked_doc=pick["doc_key"] if pick else None, flags=flags,
               in_kits_json=bool(pick) and set_like and "unpack" not in flags and kit_code in articles)
    kit_review.append(row)
    if row["in_kits_json"]:
        kits.append(dict(kit_code=kit_code,
                         components=[dict(code=c, qty=r3(q)) for c, q in sorted(pick["comp"].items())],
                         source_ref=f'Ф00001-04 {pick["doc_key"]}', observed_at=pick["date"]))
        articles[kit_code]["is_set"] = True
log(f"kits: {len(kits)} in kits.json of {len(assemblies)} assembled codes; ММ2 docs skipped {dict(mm2_skipped)}")

# ═══ 7. costs (Sigma CalcBuyPrice, Ф00001 only — BioNatural at production cost, never АД Астра's price) ═══════
buckets = collections.defaultdict(list)      # (object, item) → [(wyear, qty, price)]
for r in SO:
    if r["Client"] == "Ф00001":
        buckets[(r["Object"], r["ItemID"])].append(
            (r["WYear"], num(r["InInventoryQuantity"]) - num(r["OutInventoryQuantity"]), num(r["CalcBuyPrice"])))
sale_prices = collections.defaultdict(list)  # 2026 sales lines out of 04: BuyPrice = the cost Sigma booked
for l in IL:
    if (l["DocType"] in ("ПМ1", "ПМ2", "ПМ15") and l["ClientFrom"] == "Ф00001" and l["ObjectFrom"] == "04"
            and l["WDate"][:4] == "2026" and num(l["BuyPrice"]) > 0 and num(l["Quantity"]) > 0):
        sale_prices[l["CodeID"]].append(num(l["BuyPrice"]))
SO_REF = f"StockObject {EXPORT_DAY}"


def weighted(bs):
    q = sum(b[1] for b in bs)
    return sum(b[1] * b[2] for b in bs) / q


costs, cost_review = [], []
for code in sorted(articles):
    b04 = buckets.get(("04", code), [])
    stocked = [b for b in b04 if b[1] > 0 and b[2] > 0]
    priced = [b for b in b04 if b[2] > 0]
    flags = []
    if any(b[1] > 0 and b[2] == 0 for b in b04):
        flags.append("cost_zero")
    if len({round(b[2], 2) for b in priced}) > 1 and max(b[2] for b in priced) > 1.01 * min(b[2] for b in priced):
        flags.append("buckets_differ")
    cost = source = basis = ref = None
    if len(stocked) >= 2:
        cost, source, basis, ref = weighted(stocked), "sigma_calcbuyprice", "04_calcbuy_qtyweighted", f"Ф00001-04 {SO_REF}"
    elif len(stocked) == 1:
        cost, source, basis, ref = stocked[0][2], "sigma_calcbuyprice", "04_calcbuy_single", f"Ф00001-04 {SO_REF}"
    elif sale_prices.get(code):
        ps = sale_prices[code]
        cost, source, basis = statistics.median(ps), "sigma_last_buyprice", "04_last_buyprice_2026"
        ref = f"Ф00001-04 2026 sales lines, median of {len(ps)}"
        flags.append("no_stock_04")
    elif priced:
        best = max(priced, key=lambda b: abs(b[1]))
        cost, source, basis, ref = best[2], "sigma_calcbuyprice", "04_calcbuy_single", f"Ф00001-04 {SO_REF} (bucket {best[0]})"
        flags.append("no_stock_04")
    else:
        other = [(obj, b) for (obj, c), bs in buckets.items() if c == code and obj not in ("04", "08") for b in bs if b[2] > 0]
        if other:
            st = [(o, b) for o, b in other if b[1] > 0]
            use = st or other
            q = sum(max(b[1], 0) for _, b in use)
            cost = (sum(b[1] * b[2] for _, b in use) / q) if st and q > 0 else max(b[2] for _, b in use)
            objs = sorted({o for o, _ in use})
            source, basis, ref = "sigma_calcbuyprice", "other_object", f"Ф00001-{'/'.join(objs)} {SO_REF}"
            flags.append("other_object")
        else:
            basis = "none"
    if cost is not None and cost <= 0:
        cost, source, basis, ref = None, None, "none", None
    costs.append(dict(code=code, cost_mkd=round(cost, 4) if cost is not None else None, source=source, basis=basis,
                      source_ref=ref, flags=flags))
    cost_review.append(dict(code=code, buckets_04=[dict(wyear=b[0], qty=r3(b[1]), price=round(b[2], 4)) for b in b04],
                            sales_lines_2026=len(sale_prices.get(code, [])),
                            sales_price_2026_median=round(statistics.median(sale_prices[code]), 4) if sale_prices.get(code) else None))
COST = {c["code"]: c["cost_mkd"] for c in costs}
by_basis = collections.Counter(c["basis"] for c in costs)
act = [c for c in costs if articles[c["code"]]["active"]]
log(f"costs: {dict(by_basis)}; active articles costed {sum(1 for c in act if c['cost_mkd'] is not None)}/{len(act)}")

# ═══ 8. opening variants (22.09.2026) ═════════════════════════════════════════════════════════════════════════
VARIANTS = [
    ("04_morning_2209", ["Ф00001-04"], "2026-09-21",
     "Сигма 04 — документи со датум до 21.09 (утро на 22.09, пред испраќањето)"),
    ("04_end_2209", ["Ф00001-04"], "2026-09-22",
     "Сигма 04 — документи со датум до 22.09 (крај на 22.09; вклучен е ТН1 04-00045 04→08)"),
    ("04_plus_08_morning_2209", ["Ф00001-04", "Ф00001-08"], "2026-09-21",
     "Сигма 04 + 08 — документи со датум до 21.09 (утро на 22.09)"),
    ("08_end_2209", ["Ф00001-08"], "2026-09-22", "Сигма 08 — документи со датум до 22.09"),
]
openings = dict(generated_at=datetime.datetime.now(SKOPJE).replace(microsecond=0).isoformat(),
                sigma_export=EXPORT_AT, rule="balance by document date (WDate) from the posted ledger, content as exported",
                variants={})
opening_review = collections.defaultdict(dict)
for key, objs, cut, label in VARIANTS:
    b = balances(cut, set(objs))
    per = collections.defaultdict(float)
    for (obj, code), q in b.items():
        per[code] += q
    lines, negatives, fractional = [], [], []
    tot = collections.Counter()
    for code, q in sorted(per.items()):
        q = r3(q)
        if q == 0 or code not in articles:
            continue
        a = articles[code]
        tot["units_all"] += q
        if a["sigma_class"] == "АРТИКЛ":
            tot["units_fg"] += q
        opening_review[code][key] = q
        if q < 0:
            negatives.append(dict(code=code, qty=q))
            tot["negative_units"] += q
            continue
        if a["unit"] == "КОМ" and abs(q - round(q)) > 1e-9:
            fractional.append(dict(code=code, qty=q))
        lines.append(dict(code=code, qty=q))
        tot["positive_units"] += q
        if COST.get(code) is not None:
            tot["value_mkd"] += q * COST[code]
    totals = dict(articles=len(lines), units_fg_incl_negatives=r3(tot["units_fg"]), units_incl_negatives=r3(tot["units_all"]),
                  positive_units=r3(tot["positive_units"]), negatives=len(negatives), negative_units=r3(tot["negative_units"]),
                  fractional_kom=len(fractional), value_mkd=round(tot["value_mkd"]))
    openings["variants"][key] = dict(warehouse="main", at=OPENING_AT, label=label, objects=objs, doc_date_to=cut,
                                     lines=lines, totals=totals, negatives=negatives, fractional=fractional)
    log(f"opening {key}: FG {totals['units_fg_incl_negatives']:,.0f} incl. negatives · {len(lines)} articles · "
        f"{len(negatives)} negative ({totals['negative_units']:g}) · value {totals['value_mkd']:,.0f} ден")
for code in articles:                    # Sigma today (export day), for context in the workbook
    for obj, k in (("Ф00001-04", "04_now"), ("Ф00001-08", "08_now")):
        v = r3(so_bal.get((obj, code), 0.0))
        if v:
            opening_review[code][k] = v
CHECK = {"04_morning_2209": 261811, "04_end_2209": 229571, "08_end_2209": 131145}
for k, want in CHECK.items():
    got = openings["variants"][k]["totals"]["units_fg_incl_negatives"]
    log(f"  investigation check {k}: {got:,.0f} vs {want:,} → {'OK' if abs(got - want) < 0.5 else 'DIFFERS'}")

# ═══ 9. name resolution helpers ═══════════════════════════════════════════════════════════════════════════════
popularity = collections.Counter()           # what ships most decides between equally good name matches
for c, r in cb_goods.items():
    popularity[c] += float(r["units"] or 0)
for c, q in sold_12m.items():
    popularity[c] += q / 10.0
SIZE_RX = re.compile(r"(?<![0-9.,/])([0-9]+(?:[.,][0-9]+)?)\s*(kg|кг|л|l|lit|литар)?(?![0-9%])", re.I)


@functools.lru_cache(maxsize=None)
def sizes(s):
    """Pack sizes in a name, normalised: '2 kg' = '2000 гр' → '2000', '0,5 Л' → '500', '30cps' → '30'."""
    out = set()
    for m in SIZE_RX.finditer(s or ""):
        v = float(m.group(1).replace(",", "."))
        if m.group(2):
            v *= 1000
        if v >= 10:
            out.add(str(int(round(v))))
    return frozenset(out)


def resolve_name(part, min_sim=0.6, pool=None):
    """The article a free-text part names ('ЦИНК 30cps' → 000940 ЦИНК 30 tbl): best token match, the size decides
    between siblings, then singles before sets, then what ships most. → (code, score)."""
    ps, tp = sizes(part), tokens(part)
    best = []
    for c, a in (pool or articles).items():
        ta = tokens(a["name"])
        m = name_sim(part, a["name"])
        if m < min_sim:
            continue
        s = (cover(tp, ta) + cover(ta, tp)) / 2          # both ways: 'ЦИНК 30' must not win 'MAGNESIUM+ZINC+B COMPLEX'
        az = sizes(a["name"])
        if ps and az:
            s += 0.15 if ps & az else -0.15
        if popularity.get(c, 0) >= 50:                  # what Macedonian parcels really carry
            s += 0.15
        if (a["brand"] or "").startswith(("Private label", "Natura Therapy (BG")):
            s -= 0.3                                    # export / Bulgarian labels never ship in an MK parcel
        if not a["active"]:
            s -= 0.1
        best.append((-s, a["is_set"], -popularity.get(c, 0), c, m))
    best.sort()
    return (best[0][3], best[0][4]) if best else (None, 0.0)


PLUS_RX = re.compile(r"(?<![0-9.,])([1-9])\s*\+\s*([1-9])(?![0-9])")
GIFT_RX = re.compile(r"подарок|гратис|gratis|gift|бесплатн|\bfree\b", re.I)


def split_bundle(name):
    """'2+1 ПРОСТАТОЛ + ЦИНК 30cps' → [(3, 'ПРОСТАТОЛ', False), (1, 'ЦИНК 30cps', False)];
    '3 MAGNESIUM+ZINC+B COMPLEX + 2 MAGNESIUM GEL 50ml' → [(3, 'MAGNESIUM+ZINC+B COMPLEX', False), (2, …)];
    'Collagen 2+1 + подарок Витамин Д3' → […, (1, 'Витамин Д3', True)]. A '+' between two letters with no space
    belongs to a product name. None when the name is one product, once."""
    s = PLUS_RX.sub(lambda m: f"{m.group(1)}PLUS{m.group(2)}", name or "")
    s = re.sub(r"(?<=[^\s+])\+(?=[^\W\d_])", "JOIN", s)          # MAGNESIUM+ZINC, D3+K2 stay one name
    parts = [p.strip(" -–,") for p in s.split("+") if p.strip(" -–,")]
    out = []
    for p in parts:
        gift = bool(GIFT_RX.search(p))
        p = GIFT_RX.sub("", p).strip(" -–,:")
        n = 1
        m = re.match(r"^([1-9])PLUS([1-9])\s+(.+)$", p)
        if m:
            n, p = int(m.group(1)) + int(m.group(2)), m.group(3)
        else:
            m = re.match(r"^([1-9])\s*[xх×]?\s+(.+)$", p, re.I)
            if m:
                n, p = int(m.group(1)), m.group(2)
            else:
                m = re.search(r"^(.+?)\s*\(?([1-9])PLUS([1-9])\)?(.*)$", p)
                if m:
                    n, p = int(m.group(2)) + int(m.group(3)), (m.group(1) + " " + m.group(4)).strip()
        p = p.replace("PLUS", "+").replace("JOIN", "+").strip()
        if p:
            out.append((n, p, gift))
    if not out or (len(out) == 1 and out[0][0] == 1):
        return None
    return out


def pack_count(name):
    parts = split_bundle(name)
    return parts[0][0] if parts and len(parts) == 1 else None


# ═══ 10. collabBox codes that are not a Sigma article: bundle codes, new / wrong codes, local articles ═════════════
aliases, local_articles, cb_review = [], [], []
local_seq = 0
for r in sorted(CRM["cb_codes"], key=lambda r: (-(r["lines_since_2209"] or 0), r["role"], r["code"] or "")):
    code, role = r["code"], r["role"]
    names = list(dict.fromkeys(r.get("names") or []))[:4]
    if not (r["lines_since_2209"] or 0):
        continue                                   # the engine only meets codes shipped since the opening
    if role != "goods":
        show = names[0] if names and role == "marker" and code.upper().startswith("ПОЕН") else None
        cb_review.append(dict(code=code, role=role, name=show, lines_since_2209=r["lines_since_2209"],
                              units_since_2209=r["units_since_2209"], docs_since_2209=r["docs_since_2209"],
                              status="not_stock", confidence="high", lines=[],
                              proposal="не е стока" + (" (поени)" if show else f" ({role}: слободен текст, не се прикажува)")))
        aliases.append(dict(source="collabbox_code", key=code, kind="not_stock", lines=[], approve=True, confidence="high",
                            note=f"collabBox {role} line — never stock"))
        continue
    it = ITEMS.get(code)
    sim = max((name_sim(n, it["name"]) for n in names), default=0.0) if it else 0.0
    if code in articles and sim >= 0.5:
        continue                                   # the ordinary case: the collabBox code IS the Sigma article
    nm = names[0] if names else code
    parts = split_bundle(nm)
    lines, status, conf = [], None, "low"
    if parts:
        res = [(n, p, g, *resolve_name(p)) for n, p, g in parts]
        if all(c for _, _, _, c, _ in res):
            lines = [dict(code=c, qty=n) for n, _, _, c, _ in res]
            status = "bundle_code"
            conf = "medium" if all(s >= 0.9 for *_, s in res) else "low"
        else:
            status = "bundle_unresolved"
    else:
        c, s = resolve_name(nm, 0.75)
        if c and c != code:
            lines, status, conf = [dict(code=c, qty=1)], "alias_to_sigma", ("medium" if s >= 0.95 else "low")
    if code in articles and not lines:
        status = "name_differs"                    # keep the code; the owner looks at the name
    if not lines and status != "name_differs":
        local_seq += 1
        lcode = f"L{local_seq:05d}"
        local_articles.append(dict(code=lcode, name=nm, unit="КОМ", sigma_class=None, brand=None, is_set=False,
                                   active=True, collabbox_code=code,
                                   note=f"collabBox {code}; Сигма {code} = „{it['name'] if it else '—'}“ ({it['cls'] if it else 'нема'})"))
        lines, status, conf = [dict(code=lcode, qty=1)], (status or "local_article"), "low"
    if lines:
        aliases.append(dict(source="collabbox_code", key=code, kind="article", lines=lines, approve=False, confidence=conf,
                            note=f"collabBox {code} „{nm}“ ({status})"))
    cb_review.append(dict(code=code, role=role, name=nm, other_names=names[1:],
                          sigma_name=it["name"] if it else None, sigma_class=it["cls"] if it else None,
                          name_similarity=round(sim, 2), lines_since_2209=r["lines_since_2209"],
                          units_since_2209=r["units_since_2209"], docs_since_2209=r["docs_since_2209"],
                          lines_total=r["lines"], units_total=r["units"], status=status, confidence=conf, lines=lines))
LOCAL = {a["code"]: a for a in local_articles}
for row in cb_review:
    row["proposal"] = row.get("proposal") or " + ".join(
        f"{l['qty']:g} × {l['code']} {(articles.get(l['code']) or LOCAL.get(l['code']) or {}).get('name', '')}" for l in row["lines"])
CB_ALIAS = {a["key"]: a["lines"] for a in aliases if a["source"] == "collabbox_code" and a["kind"] == "article"}

# Dr Becker (articles created in Sigma on 28.09, after the collabBox names were typed): collabBox NAME → Sigma item
for r in CRM["cb_codes"]:
    if r["role"] != "goods":
        continue
    for n in dict.fromkeys(r.get("names") or []):
        if re.search(r"becker", n, re.I):
            cands = sorted(((name_sim(n, a["name"]), c) for c, a in articles.items() if a["brand"] == "Dr Becker"), reverse=True)
            if cands and cands[0][0] >= 0.75:
                c = cands[0][1]
                aliases.append(dict(source="collabbox_name", key=n.strip(), kind="article",
                                    lines=[dict(code=c, qty=1)], approve=True, confidence="high",
                                    note=f"Dr Becker: collabBox „{n}“ (шифра {r['code']}) = Сигма {c} {articles[c]['name']}"))

# ═══ 11. recipes: CRM product → articles ══════════════════════════════════════════════════════════════════════
xw_links = collections.defaultdict(list)    # product id → [(code, rel, conf)]
xw_kits = {}
CONF_RANK = {"VERIFIED": 0, "HIGH": 1, "MEDIUM": 2, "LOW": 3}
for r in csv.DictReader(open(os.path.join(ARGS.research, "S2-product-crosswalk.csv"), encoding="utf-8-sig")):
    if r["row_type"] == "SIGMA_ITEM":
        for pid, rel, conf in re.findall(r"([0-9a-f-]{36})(?:\[(\w+)\])?\{(\w+)\}", r["mk_crm_ids"]):
            xw_links[pid].append((r["sigma_item_code"], rel or "SAME", conf))
    elif r["row_type"] == "KIT":
        m = re.search(r"components:\s*([0-9+]+)", r["review_notes"])
        for pid in re.findall(r"([0-9a-f-]{36})", r["mk_crm_ids"]):
            if m:
                xw_kits[pid] = m.group(1).split("+")

cooc = collections.defaultdict(list)
for r in CRM["cooc"]:
    cooc[r["product_id"]].append(r)
single = collections.defaultdict(list)
for r in CRM["single_orders"]:
    single[r["product_id"]].append(r)
EXEMPT_RX = re.compile(r"достава|delivery|поштарина|\bпоен|\bpoen|флаер|flyer|ваучер|voucher|попуст|discount|"
                       r"програма за лојалност|loyalty point", re.I)


def parse_pattern(p):
    out = []
    for part in p.split(","):
        m = re.match(r"^(.+?)x([0-9.]+)(g?)$", part)
        if m:
            out.append((m.group(1), float(m.group(2)), m.group(3) == "g"))
    return out


def as_article(code):
    """A collabBox code → the article it stands for (itself, or its single-line collabBox alias, e.g. a local one)."""
    if code in articles:
        return code
    al = CB_ALIAS.get(code)
    if al and len(al) == 1 and al[0]["qty"] == 1:
        return al[0]["code"]
    return None


def art_name(code):
    return (articles.get(code) or LOCAL.get(code) or {}).get("name", "")


def recipe_single(p, name, sku6, vat, xw_same, cc, so, so_n):
    """One article per product unit: score every candidate code by its evidence."""
    cc_tot = sum(r["lines"] for r in cc) or 0
    cands = collections.defaultdict(lambda: dict(cooc=0, orders=0, static=[]))
    for r in cc:
        a = as_article(r["code"])
        if a:
            cands[a]["cooc"] += r["lines"]
    for r in so:
        pat = parse_pattern(r["pattern"])
        paid = [(c, n) for c, n, g in pat if not g]
        if len(paid) == 1 and r["q"] and abs(paid[0][1] - r["q"]) < 1e-9:
            a = as_article(paid[0][0])
            if a:
                cands[a]["orders"] += r["orders"]
    for label, code in (("sku", sku6), ("ДДВ", vat)):
        if code and code in articles:
            cands[code]["static"].append(label)
    for code, rel, conf in xw_same:
        if code in articles and conf in ("VERIFIED", "HIGH"):
            cands[code]["static"].append(f"crosswalk-{conf}")
    if not cands:
        return None
    psz = sizes(name)
    scored = []
    for c, e in cands.items():
        sh_c = e["cooc"] / cc_tot if cc_tot else 0
        sh_o = e["orders"] / so_n if so_n else 0
        strong = (e["cooc"] >= 20 and sh_c >= 0.9) or (e["orders"] >= 20 and sh_o >= 0.8)
        weak = (e["cooc"] >= 3 and sh_c >= 0.6) or (e["orders"] >= 3 and sh_o >= 0.6)
        sim = name_sim(name, art_name(c))
        size_conflict = bool(psz and sizes(art_name(c)) and not (psz & sizes(art_name(c))))
        pts = 3 * strong + 1 * weak + len(set(e["static"])) + (1 if sim >= 0.5 else 0) - (2 if size_conflict else 0)
        scored.append(dict(code=c, pts=pts, strong=strong, weak=weak, sim=sim, size_conflict=size_conflict, sh_c=sh_c,
                           sh_o=sh_o, n=e["cooc"] + e["orders"], static=sorted(set(e["static"]))))
    scored.sort(key=lambda x: (-x["pts"], -x["n"], x["code"]))
    b = scored[0]
    rivals = [x for x in scored[1:] if x["sh_c"] >= 0.2 or x["sh_o"] >= 0.2]
    if b["strong"] and b["pts"] >= 5 and not rivals and not b["size_conflict"] and (b["sim"] >= 0.34 or b["static"]):
        conf = "high"
    elif b["pts"] >= 3 and not b["size_conflict"]:
        conf = "medium"
    else:
        conf = "low"
    src = ("collabbox_cooccurrence" if b["sh_c"] >= 0.6 else "order_collabbox" if b["sh_o"] >= 0.6 else
           "sku" if "sku" in b["static"] else "crosswalk" if any(s.startswith("crosswalk") for s in b["static"]) else "vat_link")
    note = []
    if rivals:
        note.append("и други шифри: " + ", ".join(f"{x['code']} ({max(x['sh_c'], x['sh_o']):.0%})" for x in rivals[:3]))
    if b["size_conflict"]:
        note.append(f"големината во името не се совпаѓа со „{art_name(b['code'])}“")
    if b["sim"] < 0.34 and not b["static"]:
        note.append("името на производот не личи на артиклот")
    if b["code"].startswith("L"):                  # a local article the owner has not confirmed yet → never auto-approved
        conf = "medium" if conf == "high" else conf
        note.append("локален артикл (го нема во Сигма)")
    return [dict(code=b["code"], qty=1, role="main")], conf, src, "; ".join(note)


def recipe_bundle(p, name, sku6, vat, xw, cc, so, so_n, best_pat, best_n):
    """A bundle: what the warehouse packed for it (orders → collabBox), the Sigma set it ships as, the Sigma kit, or
    its name ('2+1 X + Y', '… + подарок Z' → gift only because the name says so)."""
    so_share = best_n / so_n if so_n else 0
    if best_pat and so_n >= 5 and so_share >= 0.6 and all(as_article(c) for c, _ in best_pat):
        lines = [dict(code=as_article(c), qty=q, role="main" if len(best_pat) == 1 else "component") for c, q in best_pat]
        return lines, ("high" if (so_n >= 20 and so_share >= 0.8) else "medium"), "order_collabbox", ""
    cc_tot = sum(r["lines"] for r in cc)
    top = cc[0] if cc else None
    if top and top["lines"] >= 3 and top["lines"] / cc_tot >= 0.9 and as_article(top["code"]):
        a = as_article(top["code"])
        if (articles.get(a) or {}).get("is_set") or name_sim(name, art_name(a)) >= 0.6:
            return [dict(code=a, qty=1, role="main")], ("medium" if top["lines"] >= 10 else "low"), "collabbox_cooccurrence", \
                "се праќа како Сигма сет"
    pk = pack_count(name)
    for code in (sku6, vat):                       # the product IS a Sigma set ('СЛИМ ФИБЕР 30 cps 1+1' = 000618)
        a = articles.get(code) if code else None
        if a and a["is_set"] and pk and pack_count(a["name"]) == pk and name_sim(name, a["name"]) >= 0.6:
            return [dict(code=code, qty=1, role="main")], "medium", "sku", "Сигма сет"
    parts = split_bundle(name)
    parsed = None
    if parts:
        res = [(n, part, g, *resolve_name(part)) for n, part, g in parts]
        if all(c for *_, c, _ in res):
            lines, dup = [], False
            for i, (n, part, g, c, s) in enumerate(res):
                same = next((l for l in lines if l["code"] == c), None)
                if same:                                # two parts named the same article: add up, and say so
                    same["qty"] += n
                    dup = True
                    continue
                lines.append(dict(code=c, qty=n, role="gift" if g else ("main" if i == 0 else "component")))
            one = lines[0] if len(lines) == 1 else None
            if one and (articles.get(one["code"]) or {}).get("is_set") and pack_count(art_name(one["code"])) == one["qty"]:
                lines[0]["qty"] = 1
            sure = all(s >= 0.9 for *_, s in res) and not dup
            ok = sure and (vat in {l["code"] for l in lines} or sku6 in {l["code"] for l in lines})
            parsed = (lines, ("medium" if ok else "low"), "name_pattern", "")
            if sure:
                return parsed
    for code in (sku6, vat):
        kit = next((k for k in kits if k["kit_code"] == code), None) if code else None
        if kit and name_sim(name, art_name(code)) >= 0.5:
            lines = [dict(code=c["code"], qty=c["qty"], role="component") for c in kit["components"]]
            return lines, "medium", "sigma_kit", f"Сигма сет {code} (ММ2), раставен"
    if parsed:
        return parsed
    if pid in xw_kits and all(c in articles for c in xw_kits[pid]):
        return [dict(code=c, qty=1, role="component") for c in xw_kits[pid]], "low", "crosswalk_kit", ""
    return None


recipes, recipe_review, exempt = [], [], []
for pid, p in PRODUCTS.items():
    name = p["name"] or ""
    if not (p["is_active"] or p["lines_2026"] > 0 or pid in cooc):
        continue
    if EXEMPT_RX.search(name) and not cooc.get(pid):
        exempt.append(dict(product_id=pid, product_name=name, reason="не е стока (достава / поени / флаер / попуст)"))
        continue
    sku6 = p["sku"] if re.fullmatch(r"[0-9]{6}", p["sku"] or "") else None
    vat = p["vat_sigma_code"] or None
    links = sorted(xw_links.get(pid, []), key=lambda t: CONF_RANK.get(t[2], 9))
    xw = links[0] if links else None
    parts = split_bundle(name)
    bundle = p["kind"] == "bundle" or bool(parts)
    cc = sorted(cooc.get(pid, []), key=lambda r: -r["lines"])
    so = single.get(pid, [])
    so_n = sum(r["orders"] for r in so)
    per_unit = collections.Counter()
    for r in so:
        q = r["q"] or 1
        paid = tuple(sorted((c, round(n / q, 3)) for c, n, g in parse_pattern(r["pattern"]) if not g))
        per_unit[paid] += r["orders"]
    best_pat, best_n = (per_unit.most_common(1)[0] if per_unit else ((), 0))
    ev = []
    if cc:
        ev.append("collabBox: " + ", ".join(f"{r['code']}×{r['lines']}" for r in cc[:3]))
    if so_n:
        ev.append(f"нарачки→collabBox: {best_n}/{so_n} = " + " + ".join(f"{q:g}×{c}" for c, q in best_pat))
    if sku6:
        ev.append(f"sku {sku6}")
    if vat:
        ev.append(f"ДДВ-врска {vat} ({p['vat_source']})")
    if xw:
        ev.append(f"crosswalk {xw[0]} {xw[1]}/{xw[2]}")
    out = (recipe_bundle(p, name, sku6, vat, xw, cc, so, so_n, best_pat, best_n) if bundle else
           recipe_single(p, name, sku6, vat, [l for l in links if l[1] == "SAME"], cc, so, so_n))
    if not out and bundle:                         # a "bundle" kind that is really one product
        out = recipe_single(p, name, sku6, vat, [l for l in links if l[1] == "SAME"], cc, so, so_n)
    lines, conf, source, note = out if out else (None, None, None, "")
    if lines and GIFT_RX.search(name) and not any(l["role"] == "gift" for l in lines):
        note = (note + "; " if note else "") + "името спомнува подарок што не е препознаен — проверете"
    recipe_review.append(dict(product_id=pid, product_name=name, kind=p["kind"], active=p["is_active"], sku=p["sku"],
                              vat_sigma_code=vat, lines_2026=p["lines_2026"], units_2026=p["units_2026"],
                              units_since_2209=p["units_since_2209"], bundle=bundle, evidence=ev, lines=lines,
                              confidence=conf, source=source, note=note, cost_price_eur=p["cost_price"], price_eur=p["price"]))
    if lines:
        recipes.append(dict(product_id=pid, product_name=name, kind=p["kind"], lines=lines, confidence=conf,
                            source=source, note=note))
rc = collections.Counter(r["confidence"] for r in recipes)
active_ids = [pid for pid, p in PRODUCTS.items() if p["is_active"]]
with_recipe = {r["product_id"] for r in recipes}
exempt_ids = {e["product_id"] for e in exempt}
log(f"recipes: {len(recipes)} ({dict(rc)}); active products {len(active_ids)}: with a proposal "
    f"{sum(1 for i in active_ids if i in with_recipe)}, exempt {sum(1 for i in active_ids if i in exempt_ids)}")


def recipe_cost(r):
    tot = 0.0
    for l in r["lines"]:
        c = COST.get(l["code"])
        if c is None:
            return None
        tot += c * l["qty"]
    return tot


costed_active = [r for r in recipes if r["product_id"] in set(active_ids) and recipe_cost(r) is not None]
costed_active_high = [r for r in costed_active if r["confidence"] == "high"]

# ═══ 12. web products (naturatherapy.mk) ══════════════════════════════════════════════════════════════════════
# web products (naturatherapy.mk): crosswalk storefront_t2 → Sigma item; a variant (flavour / size) by its name
t2_links = collections.defaultdict(list)
for r in csv.DictReader(open(os.path.join(ARGS.research, "S2-product-crosswalk.csv"), encoding="utf-8-sig")):
    if r["row_type"] == "SIGMA_ITEM":
        for sid, conf in re.findall(r"(\d+)\{(\w+)\}", r["storefront_t2_ids"]):
            t2_links[sid].append((r["sigma_item_code"], conf))
web_alias_map = {}
for a in CRM["web_aliases"]:
    web_alias_map[re.sub(r"\s+", " ", (a["alias_norm"] or "").strip().lower())] = a
recipe_by_pid = {r["product_id"]: r for r in recipes}
WEB_SINCE = "2026-01-01"
web_rows = [w for w in CRM["web_items"] if (w["last_at"] or "") >= WEB_SINCE]
sku_owners = collections.defaultdict(set)
for w in web_rows:
    if w["sku"] and w["variant_id"]:
        sku_owners[re.sub(r"\s+", " ", w["sku"].strip().lower())].add((w["product_id"], w["variant_id"]))
web_review = []
by_product = collections.defaultdict(list)
for w in web_rows:
    by_product[w["product_id"]].append(w)
for shop_pid, rows in sorted(by_product.items(), key=lambda kv: -sum(r["units_since_2209"] for r in kv[1])):
    variants = collections.defaultdict(list)
    for w in rows:
        variants[w["variant_id"]].append(w)
    links = sorted(t2_links.get(str(shop_pid), []), key=lambda t: CONF_RANK.get(t[1], 9))
    has_variants = any(v for v in variants)
    for vid, ws in sorted(variants.items(), key=lambda kv: -sum(w["units_since_2209"] for w in kv[1])):
        latest = max(ws, key=lambda w: w["last_at"] or "")      # the shop re-uses products: the NEWEST name rules
        nm = latest["name"] or ""
        label = latest["variant_label"] or next((w["variant_label"] for w in ws if w["variant_label"]), "") or ""
        skus = sorted({w["sku"].strip() for w in ws if w["sku"]})
        units = sum(w["units_since_2209"] for w in ws)
        lines_all = sum(w["lines"] for w in ws)
        kinds = sorted({w["kind"] for w in ws if w["kind"]})
        full = f"{nm} {label} {' '.join(skus)}".strip()
        cand, conf, src = None, None, None
        pack = pack_count(nm)
        is_variant = bool(vid) or bool(label) or bool(re.search(r"\(.*?(вкус|пакување|flavou?r)", nm, re.I))
        parts = split_bundle(nm)
        multi = None
        if parts and len(parts) > 1:                             # '3 DIABETOL FORTE + ZINC (30tbl)'
            res = [(n, part, g, *resolve_name(part)) for n, part, g in parts]
            if all(c for *_, c, _ in res):
                multi = [dict(code=c, qty=n) for n, _, _, c, _ in res]
        xw_ok = bool(links and links[0][0] in articles and name_sim(nm, articles[links[0][0]]["name"]) >= 0.5)
        if multi and not xw_ok:
            cand, conf, src = multi[0]["code"], "low", "name_bundle"
        elif links and links[0][0] in articles:
            multi = None
            base = links[0][0]
            if is_variant:
                c, s = resolve_name(full, 0.6)
                if c and name_sim(articles[base]["name"], articles[c]["name"]) >= 0.5:
                    cand, conf, src = c, "medium", "crosswalk+variant_name"
            if not cand:
                cand, src = base, "crosswalk_t2"
                conf = "high" if links[0][1] in ("VERIFIED", "HIGH") and not is_variant and not has_variants else "medium"
        if not cand:
            a = web_alias_map.get(re.sub(r"\s+", " ", nm.strip().lower()))
            if a and a.get("product_id") in recipe_by_pid and len(recipe_by_pid[a["product_id"]]["lines"]) == 1:
                cand, conf, src = recipe_by_pid[a["product_id"]]["lines"][0]["code"], "low", "web_alias→crm_recipe"
        if not cand:
            c, s = resolve_name(full, 0.75)
            if c:
                cand, conf, src = c, "low", "name"
        qty = pack if (pack and pack > 1) else 1
        alias_lines = multi or [dict(code=cand, qty=qty)]
        # the resolver (stock_v2_parcel_lines) tries web_sku, then web_product = the shop product id; keys are
        # normalised by stock_v2_alias_key() (upper-trimmed) — a variant is found by its own SKU only
        keys = []
        for sk in skus:
            if vid and len(sku_owners.get(re.sub(r"\s+", " ", sk.lower()), ())) == 1:
                keys.append(("web_sku", sk))
        if not has_variants:
            keys.append(("web_product", str(shop_pid)))
        if cand:
            for src_key, key in keys:
                aliases.append(dict(source=src_key, key=key, kind="article", lines=alias_lines,
                                    approve=(conf == "high"), confidence=conf, note=f"web „{full[:80]}“ ({src})"))
        web_review.append(dict(shop_product_id=shop_pid, variant_id=vid, skus=skus, name=nm, variant_label=label or None,
                               kinds=kinds, units_since_2209=units, lines_all=lines_all,
                               last_at=max((w["last_at"] or "") for w in ws), article=cand, lines=alias_lines if cand else [],
                               article_name=articles[cand]["name"] if cand else None, qty=qty if cand else None,
                               confidence=conf, source=src, alias_keys=[f"{s}:{k}" for s, k in keys]))
# one alias per (source, key) — keys as stock_v2_alias_key() will normalise them; the first (best-ranked) wins
seen, uniq = set(), []
for a in aliases:
    k = (a["source"], a["key"].strip().upper() if a["source"] in ("collabbox_code", "web_sku", "web_product")
         else re.sub(r"\s+", " ", a["key"].strip().lower()))
    if k in seen:
        continue
    seen.add(k)
    uniq.append(a)
aliases = uniq
log(f"aliases: {len(aliases)} ({dict(collections.Counter(a['source'] for a in aliases))}); local articles {len(local_articles)}; "
    f"web variants {len(web_review)} (mapped {sum(1 for w in web_review if w['article'])})")

# ═══ 13. the Sigma batch: every posted document dated ≥ 22.09 touching 04 / 08 / 11 ══════════════════════════════
def work_type(inv_type):
    return "МН2" if inv_type == "ММ2" else inv_type[0] + "Н" + inv_type[2:]


def doc_lines(rows, doctype, qty_of):
    dt = DOCTYPES.get(doctype) or {}
    agg = collections.defaultdict(float)
    for l in rows:
        q = qty_of(l)
        if dt.get("transfer"):
            agg[(l["CodeID"], "out")] += q
            agg[(l["CodeID"], "in")] += q
        elif dt.get("inout", "").startswith("I"):
            agg[(l["CodeID"], "in")] += q
        else:
            agg[(l["CodeID"], "out")] += q
    return [dict(item_code=c, qty=r3(q), side=s) for (c, s), q in sorted(agg.items()) if r3(q) != 0]


def counterparty(doctype, cfrom, cto):
    dt = DOCTYPES.get(doctype) or {}
    if dt.get("transfer"):
        return None
    return cfrom if dt.get("inout", "").startswith("I") else cto


def obj_or_none(o):
    return o or None


il_by_doc = collections.defaultdict(list)
for l in IL:
    il_by_doc[(l["WYear"], l["DocType"], l["DocNo"])].append(l)
docs = []
for key, ls in sorted(il_by_doc.items(), key=lambda kv: (kv[1][0]["WDate"], kv[0])):
    if ls[0]["WDate"][:10] < OPENING_DAY or key[1] not in FIELDS["posted_doc_types"]:
        continue
    touched = {f'{l["ClientFrom"]}-{l["ObjectFrom"]}' for l in ls} | {f'{l["ClientTo"]}-{l["ObjectTo"]}' for l in ls}
    if not touched & DOC_OBJECTS:
        continue
    h = IH.get(key)
    w = WH.get((h["SourceYear"], h["SourceDocType"], h["SourceDocNo"])) if h and h.get("SourceDocType") else None
    w = w or WH.get((key[0], work_type(key[1]), key[2]))
    first = ls[0]
    cf, of, ct, ot = ((h["ClientFrom"], h["ObjectFrom"], h["ClientTo"], h["ObjectTo"]) if h else
                      (first["ClientFrom"], first["ObjectFrom"], first["ClientTo"], first["ObjectTo"]))
    client = counterparty(key[1], cf, ct)
    docs.append(dict(
        doc_key="|".join(key), wyear=key[0], doc_type=key[1], doc_no=key[2],
        doc_date=(h["WDate"] if h else first["WDate"])[:10],
        posted_at=local_iso(h["SysDateTime"]) if h else (local_iso(w["LastChangeDateTime"]) if w else None),
        created_at_sigma=local_iso(w["SysDateTime"]) if w else None,
        created_by=(w["SysUser"] if w else (h["SysUser"] if h else None)) or None,
        last_change_by=(w["LastChangeUser"] if w else (h["SysUser"] if h else None)) or None,
        status="posted",
        company_from=cf or None, object_from=obj_or_none(of), company_to=ct or None, object_to=obj_or_none(ot),
        client_code=client or None, client_name=company_name(CLIENTS.get(client)) if client else None,
        lines=doc_lines(ls, key[1], lambda l: num(l["Quantity"]))))
posted_twins = {(k[0], work_type(k[1]), k[2]) for k in il_by_doc}


def draft_qty(l):
    for c in FIELDS["draft_qty_columns"]:
        v = num(l[c])
        if v:
            return v
    return 0.0


drafts = []
for key, h in sorted(WH.items(), key=lambda kv: (kv[1]["WDate"], kv[0])):
    if h["Status"] == "4" or key in posted_twins or key[1] not in FIELDS["draft_doc_types"] or h["WDate"][:10] < OPENING_DAY:
        continue
    ls = WL.get(key, [])
    touched = {f'{h["ClientFrom"]}-{h["ObjectFrom"]}', f'{h["ClientTo"]}-{h["ObjectTo"]}'}
    touched |= {f'{l["ClientFrom"]}-{l["ObjectFrom"]}' for l in ls} | {f'{l["ClientTo"]}-{l["ObjectTo"]}' for l in ls}
    if not touched & DOC_OBJECTS:
        continue
    client = counterparty(key[1], h["ClientFrom"], h["ClientTo"])
    drafts.append(dict(
        doc_key="|".join(key), wyear=key[0], doc_type=key[1], doc_no=key[2], doc_date=h["WDate"][:10],
        posted_at=None, created_at_sigma=local_iso(h["SysDateTime"]), created_by=h["SysUser"] or None,
        last_change_by=h["LastChangeUser"] or None, status="draft",
        company_from=h["ClientFrom"] or None, object_from=obj_or_none(h["ObjectFrom"]),
        company_to=h["ClientTo"] or None, object_to=obj_or_none(h["ObjectTo"]),
        client_code=client or None, client_name=company_name(CLIENTS.get(client)) if client else None,
        lines=doc_lines(ls, key[1], draft_qty)))
items = [dict(code=a["code"], name=a["name"], unit=a["unit"], sigma_class=a["sigma_class"], brand=a["brand"], active=a["active"])
         for a in sorted(articles.values(), key=lambda a: a["code"])]
bal_rows = []
for r in SO:
    obj = f'{r["Client"]}-{r["Object"]}'
    if obj not in BAL_OBJECTS:
        continue
    q = r3(num(r["InInventoryQuantity"]) - num(r["OutInventoryQuantity"]))
    p = round(num(r["CalcBuyPrice"]), 4)
    if q == 0 and p == 0:
        continue
    bal_rows.append(dict(company=r["Client"], object=r["Object"], item_code=r["ItemID"], wyear=r["WYear"], qty=q,
                         calc_buy_price=p if p else None))
bal_rows.sort(key=lambda b: (b["company"], b["object"], b["item_code"], b["wyear"]))
body = dict(docs=docs, drafts=drafts, items=items, balances=bal_rows)
digest = hashlib.sha256(json.dumps(body, ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()[:10]
batch = dict(batch_id=f"csv-{EXPORT_DAY}-since-2209-{digest}", source="csv", mode="delta", exported_at=EXPORT_AT,
             window={"from": OPENING_DAY, "to": EXPORT_DAY}, docs=docs, drafts=drafts, items=items,
             balances=bal_rows, balances_taken_at=EXPORT_AT)
for d in docs + drafts:                       # the contract shape, nothing more
    assert set(d) == set(FIELDS["doc_fields"]), set(d) ^ set(FIELDS["doc_fields"])
dump("sigma-batch-since-2209.json", batch)
log(f"sigma batch {batch['batch_id']}: {len(docs)} posted documents, {len(drafts)} drafts, {len(items)} items, "
    f"{len(bal_rows)} balance rows; {len(json.dumps(batch, ensure_ascii=False).encode('utf-8')):,} bytes")

# review of the documents: what the default rules would do (the server decides — stock_sigma_rules + doc types)
INCLUDE_TYPES = set(FIELDS["posted_doc_types"])


def would(doc):
    objs = {f"{doc['company_from']}-{doc['object_from']}", f"{doc['company_to']}-{doc['object_to']}"}
    if doc["status"] == "draft":
        return "drafted", "најавено (нацрт) — не мрда залиха"
    if doc["client_code"] == "000217":
        return "excluded", "MEX фактура (000217) — излезот го даваат пратките"
    if doc["client_code"] == "000549":
        return "excluded", "АД Астра (000549) — BioNatural, хартиена препродажба"
    if objs == {"Ф00001-04", "Ф00001-08"}:
        return "excluded", "пренос 04↔08 — 08 е на преглед"
    if doc["doc_type"] not in INCLUDE_TYPES:
        return "excluded", f"тип {doc['doc_type']} не мрда залиха"
    if doc["doc_date"] < OPENING_DAY:
        return "excluded", "пред пописот"
    kind = {"ТМ1": "transfer", "ТМ2": "transfer", "ММ2": "production", "ПМ15": "export_out"}.get(doc["doc_type"])
    if doc["doc_type"] in ("ТМ1", "ТМ2") and "Ф00001-11" in objs:
        kind = "writeoff"
    elif doc["doc_type"] in ("ПМ1", "ПМ2", "ПМ9"):
        kind = "shop_out" if doc["client_code"] == "000001" else "b2b_out"
    elif doc["doc_type"] in ("ПМ4", "ПМ11"):
        kind = "shop_return_in" if doc["client_code"] == "000001" else "b2b_return_in"
    elif doc["doc_type"].startswith("Н"):
        kind = "b2b_out" if doc["doc_type"] == "НМ4" else "receipt"
    return "included", kind or doc["doc_type"]


doc_review = []
for d in docs + drafts:
    verdict, why = would(d)
    eff = collections.Counter()                 # the signed effect of the ARTICLE lines on 04 / 08 / 11
    for l in d["lines"]:
        if l["item_code"] not in articles:
            continue
        obj = f"{d['company_from']}-{d['object_from']}" if l["side"] == "out" else f"{d['company_to']}-{d['object_to']}"
        if obj in DOC_OBJECTS:
            eff[obj] += -l["qty"] if l["side"] == "out" else l["qty"]
    h = IH.get((d["wyear"], d["doc_type"], d["doc_no"]))
    doc_review.append(dict(doc_key=d["doc_key"], doc_type=d["doc_type"], type_name=(DOCTYPES.get(d["doc_type"]) or {}).get("name"),
                           doc_date=d["doc_date"], status=d["status"], posted_at=d["posted_at"], posted_by=h["SysUser"] if h else None,
                           created_at_sigma=d["created_at_sigma"], created_by=d["created_by"], last_change_by=d["last_change_by"],
                           from_obj=f"{d['company_from']}-{d['object_from'] or ''}", to_obj=f"{d['company_to']}-{d['object_to'] or ''}",
                           from_name=OBJECT_NAMES.get(f"{d['company_from']}-{d['object_from']}") or CLIENTS.get(d["company_from"]),
                           to_name=OBJECT_NAMES.get(f"{d['company_to']}-{d['object_to']}") or CLIENTS.get(d["company_to"]),
                           client_code=d["client_code"], client_name=d["client_name"], lines=len(d["lines"]),
                           units_all=r3(sum(abs(l["qty"]) for l in d["lines"]) / (2 if (DOCTYPES.get(d["doc_type"]) or {}).get("transfer") else 1)),
                           effect_04=r3(eff["Ф00001-04"]), effect_08=r3(eff["Ф00001-08"]), effect_11=r3(eff["Ф00001-11"]),
                           header_in_export=bool(h) or d["status"] == "draft",
                           verdict=verdict, reason=why,
                           days_late=((datetime.date.fromisoformat(d["posted_at"][:10]) - datetime.date.fromisoformat(d["doc_date"])).days
                                      if d["posted_at"] else None)))

# ═══ 14. Sigma MEX COD invoices per month × company × article (for scripts/stock/sigma-month-check.mjs) ══════════
mex_inv = collections.defaultdict(float)
mex_docs = collections.defaultdict(set)
for l in IL:
    if l["DocType"] == "ПМ1" and l["ClientTo"] == "000217" and l["WDate"][:4] >= "2025":
        k = (l["WDate"][:7], l["ClientFrom"], l["CodeID"])
        mex_inv[k] += num(l["Quantity"])
        mex_docs[(l["WDate"][:7], l["ClientFrom"])].add(f'{l["WYear"]}|{l["DocType"]}|{l["DocNo"]}')
dump("sigma-mex-invoices.json", dict(
    generated_at=openings["generated_at"], sigma_export=EXPORT_AT,
    rule="ПМ1 lines to client 000217 (МЕКС ПОШТА) by document month; Ф00001 = MEX account NATURA, Ф00003 = BIO NATURAL",
    docs={f"{m}|{c}": sorted(v) for (m, c), v in sorted(mex_docs.items())},
    lines=[dict(month=m, company=c, code=code, name=ITEMS.get(code, {}).get("name"), units=r3(q))
           for (m, c, code), q in sorted(mex_inv.items()) if r3(q) != 0]))

# ═══ 15. write ═══════════════════════════════════════════════════════════════════════════════════════════════════
dump("articles.json", [dict(code=a["code"], name=a["name"], unit=a["unit"], sigma_class=a["sigma_class"], brand=a["brand"],
                            is_set=a["is_set"], active=a["active"]) for a in sorted(articles.values(), key=lambda a: a["code"])])
dump("local-articles.json", local_articles)
dump("costs.json", costs)
dump("openings.json", openings)
dump("kits.json", kits)
dump("recipes.json", recipes)
dump("aliases.json", aliases)
dump("exempt.json", exempt)
dump("review-costs.json", cost_review)
dump("review-openings.json", opening_review)
dump("review-kits.json", sorted(kit_review, key=lambda k: (not k["in_kits_json"], k["kit_code"])))
dump("review-recipes.json", recipe_review)
dump("review-collabbox-codes.json", cb_review)
dump("review-web.json", web_review)
dump("review-sigma-docs.json", doc_review)
summary = dict(
    generated_at=openings["generated_at"], sigma_export=EXPORT_AT, crm_snapshot=CRM["generated_at"],
    ledger_check=dict(keys=len(set(so_bal) | set(ledger_all)), differ=[f"{k[0]}/{k[1]}: StockObject {s:g}, ledger {l:g}" for k, s, l in diffs]),
    articles=dict(total=len(articles), active=sum(a["active"] for a in articles.values()),
                  by_class=dict(collections.Counter(a["sigma_class"] for a in articles.values())),
                  sets=sum(a["is_set"] for a in articles.values()), local_proposed=len(local_articles)),
    costs=dict(by_basis=dict(by_basis), active_articles=len(act), active_costed=sum(1 for c in act if c["cost_mkd"] is not None),
               flags=dict(collections.Counter(f for c in costs for f in c["flags"]))),
    openings={k: v["totals"] for k, v in openings["variants"].items()},
    openings_check={k: dict(want=w, got=openings["variants"][k]["totals"]["units_fg_incl_negatives"]) for k, w in CHECK.items()},
    kits=dict(in_file=len(kits), assembled_codes=len(assemblies), mm2_docs_skipped=dict(mm2_skipped)),
    recipes=dict(total=len(recipes), by_confidence=dict(rc), by_source=dict(collections.Counter(r["source"] for r in recipes)),
                 active_products=len(active_ids), active_with_proposal=sum(1 for i in active_ids if i in with_recipe),
                 active_exempt=sum(1 for i in active_ids if i in exempt_ids),
                 active_costed=len(costed_active), active_costed_high=len(costed_active_high), exempt=len(exempt)),
    aliases=dict(total=len(aliases), by_source=dict(collections.Counter(a["source"] for a in aliases)),
                 auto_approve=sum(1 for a in aliases if a["approve"])),
    web=dict(variants=len(web_review), mapped=sum(1 for w in web_review if w["article"]),
             units_since_2209=sum(w["units_since_2209"] for w in web_review),
             units_mapped_since_2209=sum(w["units_since_2209"] for w in web_review if w["article"])),
    batch=dict(batch_id=batch["batch_id"], docs=len(docs), drafts=len(drafts), items=len(items), balances=len(bal_rows),
               verdicts=dict(collections.Counter(r["verdict"] for r in doc_review)),
               by_type=dict(collections.Counter(d["doc_type"] for d in docs))),
    parcels_since_2209=CRM["parcels"])
dump("summary.json", summary)
log(json.dumps({k: summary[k] for k in ("articles", "costs", "recipes", "batch")}, ensure_ascii=False, indent=1))
log(f"→ {OUT}")
