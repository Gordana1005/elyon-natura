# -*- coding: utf-8 -*-
"""VAT rate per product, from Sigma (Natura's ERP) — one table for the MK CRM and for naturatherapy.mk.

EVIDENCE (read-only, Sigma export 29–30.09.2026, D:\\naturatherapy\\_salesforce-plan\\05-sigma-export\\raw-export):
  * Item.csv          — the item master: every item carries VatId (0 = 0 %, 1 = 18 %, 2 = 5 %, 3 = 10 %).
  * WorkDocInLine.csv — every invoice line with the VAT actually charged (VatID, VatValue). For each item we count
                        the 2025–2026 sales-invoice lines (ПН1) by rate, and those on МЕКС ПОШТА (client 000217),
                        the monthly COD invoices.
LINK product → Sigma item, in this order:
  1. S2 crosswalk (S2-product-crosswalk.csv), best confidence first (VERIFIED > HIGH > MEDIUM)
  2. FORCE: manual corrections where the crosswalk is wrong (reviewed 01.10.2026, see FORCE below)
  3. NAME: a keyword in the product name → the Sigma item of that product (same table as the September report)
  4. RULE: no Sigma item — cosmetics / devices → 18 %, otherwise the food-supplement 5 %; every RULE row is listed
     for a human in review.csv.
Outputs (data/): sigma_items_vat.csv, crm_products_vat.csv/.json, t2_products_vat.csv/.json, review.csv, summary.json
"""
import csv, json, os, re, collections
csv.field_size_limit(10 ** 9)
HERE = os.path.dirname(os.path.abspath(__file__))
SIGMA = r"D:\naturatherapy\_salesforce-plan\05-sigma-export\raw-export"
RESEARCH = r"D:\naturatherapy\_salesforce-plan\02-knowledge\research"
OUT = os.path.join(HERE, "data")
RATE = {"0": 0.0, "1": 0.18, "2": 0.05, "3": 0.10}

# ---------------------------------------------------------------- Sigma: item master + invoice evidence
items = {}
for r in csv.DictReader(open(os.path.join(SIGMA, "Item.csv"), encoding="utf-8-sig")):
    items[r["ItemID"].strip()] = dict(code=r["ItemID"].strip(), name=r["Name"].strip(), cls=r["AccountPG"].strip(),
                                      vat_id=r["VatId"].strip(), inactive=r["isUnactive"].strip())
ev = collections.defaultdict(lambda: collections.Counter())
for r in csv.DictReader(open(os.path.join(SIGMA, "WorkDocInLine.csv"), encoding="utf-8-sig")):
    if r["DocType"] != "ПН1" or r["WYear"] not in ("25", "26"):
        continue
    code = r["CodeID"].strip()
    v = r["VatValue"].strip()
    ev[code][f"20{r['WYear']}@{v}"] += 1
    if r["ClientTo"].strip() == "000217":
        ev[code][f"mex@{v}"] += 1
def evidence(code):
    c = ev.get(code, {})
    return "; ".join(f"{k}: {n}" for k, n in sorted(c.items())) or "no 2025–2026 sales invoice"

with open(os.path.join(OUT, "sigma_items_vat.csv"), "w", encoding="utf-8-sig", newline="") as f:
    w = csv.writer(f)
    w.writerow(["sigma_code", "sigma_name", "class", "VatId", "rate", "inactive", "invoice_lines_2025_2026_by_rate"])
    for code, it in sorted(items.items()):
        if it["cls"] in ("АРТИКЛ", "ТС", "ЛОЈАЛИТИ") or code in ev:
            w.writerow([code, it["name"], it["cls"], it["vat_id"], RATE.get(it["vat_id"], ""), it["inactive"], evidence(code)])

def sigma_rate(code):
    it = items.get(code)
    return RATE.get(it["vat_id"]) if it else None

# ---------------------------------------------------------------- name keywords → Sigma item (most specific first)
def find(rx):
    """Active finished-goods item whose name matches rx (prefer items that sold in 2025–26)."""
    hits = [c for c, it in items.items() if it["cls"] == "АРТИКЛ" and re.search(rx, it["name"], re.I)]
    hits.sort(key=lambda c: (-sum(ev.get(c, {}).values()), c))
    return hits[0] if hits else None
KEYS = [
    (r"jojoba|јојоба", r"^ELIXY Масло од јојоба"), (r"rosehip|шипка", r"^ELIXY Масло од шипка"), (r"marula|марула", r"^ELIXY Масло од марула"),
    (r"avocado|авокадо", r"^ELIXY Масло од авокадо"), (r"olive oil|масло од маслинка", r"^ELIXY Масло од маслинка"),
    (r"anti-?\s?acne|антикни", r"^ELIXY- Антикни"), (r"beta glucan|бета глукан", r"^ELIXY-Бета Глукан"), (r"vitamin b3|витамин б3|vit b3", r"^ELIXY- Витамин Б3"),
    (r"\baha\b", r"^ELIXY-АХА Ацид"), (r"collagen serum|колаген серум|i.am collagen", r"^ELIXY-Колаген серум"), (r"vitamin c.{0,12}(serum|серум)", r"^ELIXY Серум со витамин Ц"),
    (r"thermo|термо", r"^ELIXY-ТЕРМО ГЕЛ 200"), (r"cryo|крио", r"^ELIXY-КРИО ГЕЛ 200"),
    (r"(elixy|snail repair).{0,40}(ноќ|night|nokn)", r"^ELIXY-Ноќен крем снаил"), (r"(elixy|snail repair).{0,40}(дневн|day|dnevn|face cream)", r"^ELIXY-Дневенкрем снаил"),
    (r"elixy.{0,40}(serum|серум)|snail repair|snail serum", r"^ELIXY Серум со 20%снаил"),
    (r"(elixy )?hyaluronic ?& ?aloe|hyaluronic.{0,6}collagen.{0,6}aloe", r"^ELIXY-hyaluronic acid-collagen"),
    (r"collagen matrix", r"^HYALURONIC ACID & COLLAGEN MATRIX"),
    (r"arthro blue|артро блу", r"^АРТРО БЛУ ГЕЛ 200 МЛ$"), (r"venogel|веногел", r"^ВЕНОГЕЛ гел 100ml$"),
    (r"hemoro.{0,8}gel|хеморо гел", r"^ХЕМОРО ГЕЛ"), (r"snail.{0,10}cream|снаил крема", r"^СНАИЛ КРЕМА 100ml антиревматска"),
    (r"r&r|melem|мелем", r"^МЕЛЕМ R&R"), (r"aloe vera gel 99|aloe body|алое боди", r"^АЛОЕ БОДИ ГЕЛ"),
    (r"aloe.{0,40}(aronia|aronija|аронија)|алое.{0,30}аронија", r"^АЛОЕ ВЕРА ГЕЛ СО АРОНИЈА 1Л"),
    (r"(aloe|алое).{0,30}(resveratrol|ресвератрол)", r"^АЛОЕ ВЕРА ГЕЛ СО РЕСВЕРАТРОЛ 1Л"),
    (r"whey.{0,20}(2 ?кг|2 ?kg|2000)", r"^100% WHEY ВАНИЛА 2000"), (r"whey.{0,20}400", r"^100% WHEY ВАНИЛА 400"),
    (r"whey|вej|протеин 2|protein \(", r"^100% WHEY ВАНИЛА 500"), (r"mass gainer|гејнер", r"^MASS GAINER 3 kg"),
    (r"creatin|креатин", r"^КРЕАТИН во прав  ?200"), (r"bcaa|бцаа", r"^БЦАА"), (r"glutamin|глутамин", r"^Л-ГЛУТАМИН"),
    (r"pre[- ]?workout", r"^PRE WORKOUT"), (r"amino energy|амино", r"^АМИНО ЕНЕРЏИ"), (r"iso ?max|изо ?макс", r"^ИЗО МАКС ЈАГОДА 250"),
    (r"matcha|мача", r"^МАЧА СО КОЛАГЕН"), (r"coconut|кокос", r"^COLLAGEN & COCONUT"), (r"beauty collagen|liquid collagen|течен колаген", r"^ТЕЧЕН КОЛАГЕН"),
    (r"collagen|колаген", r"^Колаген Пептид -БЕЗ ВКУС"), (r"nutri soup|нутри супа", r"^НУТРИ СУПА"), (r"nutri shake|нутри шејк", r"^НУТРИ ШЕЈК"),
    (r"diet shake|диет шејк", r"^ДИЕТ ШЕЈК"), (r"dr\.? ?slim|др\.? ?слим", r"^ДР. СЛИМ 210"),
    (r"bisglycinat|бисглицинат", r"^MAGNESIUM BISGLYCINATE"), (r"magnesium ?\+ ?zinc", r"^MAGNESIUM \+ZINC"), (r"magnesium ?\+ ?b6", r"^MAGNESIUM\+ B6"),
    (r"magnesium gel", r"^MAGNESIUM GEL"), (r"magnesium|магнезиум", r"^MAGNESIUM CITRAT"), (r"d3 ?\+ ?k2|д3 ?\+ ?к2", r"^VITAMIN D3\+K2\+BOR 180"),
    (r"zinc ?\+ ?chrom", r"^ZINC\+CHROM"), (r"liquid vitamin c|vitamin c complex|вит.? ?ц за возрасни", r"^Витамин Ц за ВОЗРАСНИ"),
    (r"c ?1000|ц-? ?1000", r"^ВИТАМИН Ц-1000"), (r"kid'?s multi|кидс", r"^КИДС МУЛТИВИТАМИНС"), (r"мега мулти|mega multi", r"^МЕГА МУЛТИВИТАМИН 250"),
    (r"vitamin d3|витамин д3|\bd3\b", r"^VITAMIN D3 120"), (r"zinc|цинк", r"^ZINC 120/1 tab $"), (r"melatonin|мелатонин", r"^MELATONIN 1mg 120"),
    (r"\bb6\b|витамин б6", r"^VITAMIN B6 120"), (r"alpha ?male|алфа мале", r"^ALPHA  MALE"), (r"tribulus|трибулус", r"^ТРИБУЛУС ТЕРЕСТРИС 30"),
    (r"snail|снаил", r"^СНАИЛ КОМПЛЕКС cps 30"), (r"brain active|браин актив", r"^БРАИН АКТИВ"), (r"max brain|макс бреин", r"^МАКС БРЕИН"),
    (r"prostatol|простатол", r"^ПРОСТАТОЛ КОМПЛЕКС cps 30"), (r"femme|фемме", r"^ФЕММЕ 7"), (r"carnitin|карнитин", r"^Л-КАРНИТИН"),
    (r"ashwagand|ашваганд", r"^АШВАГАНДА  ЕКСТРАКТ 30"), (r"shilajit|шилаџит", r"^SHILAJIT"), (r"glucosamin|глукозамин", r"^ГЛУКОЗАМИН СУЛФАТ"),
    (r"broncho|бронхо", r"^БРОНХО ПРОТЕКТ 250"), (r"pulmo|пулмо", r"^ПУЛМО КОМПЛЕКС"), (r"slim fiber|слим фибер", r"^СЛИМ ФИБЕР"),
    (r"slim complex|слим комплекс", r"^СЛИМ КОМПЛЕКС 30"), (r"night burn", r"^NIGHT BURN"), (r"glucatol|глукатол", r"^ГЛУКАТОЛ"),
    (r"diabetol|диабетол", r"^ДИАБЕТОЛ ФОРТЕ"), (r"liver detox|ливер", r"^ЛИВЕР ДЕТОКС"), (r"para detox|пара детокс", r"^ПАРА ДЕТОКС"),
    (r"hemoro|хеморо", r"^ХЕМОРО ФОРТЕ"), (r"cholestol|холестол", r"^ХОЛЕСТОЛ КОМПЛЕКС"), (r"uro protect|уро протект", r"^УРО ПРОТЕКТ"),
    (r"tongkat|тонгкат", r"^TONGAKT ALI"), (r"\bmaca\b|мака", r"^МАКА ЕКСТРАКТ"), (r"\bnmn\b", r"^NMN"), (r"neuro activ|неуро", r"^НЕУРО АКТИВ"),
    (r"bilberry|билбери", r"^БИЛБЕРИ"), (r"reishi|реиши", r"^РЕИШИ КАПСУЛИ"), (r"curcumactiv|куркумактив", r"^КУРКУМАКТИВ 500"),
    (r"turmeric|турмерик", r"^ТУРМЕРИК КУРКУМИН"), (r"curcumin|куркумин", r"^КУРКУМИН ЕКСТРАКТ"), (r"immuno boost|имуно буст", r"^Имуно буст"),
    (r"green tea|зелен чај", r"^ЗЕЛЕН ЧАЈ ЕКСТРАКТ 60"), (r"d-?mannose|д-?маноза", r"^Д-МАНОЗА"), (r"resveratrol|ресвератрол", r"^РЕСВЕРАТРОЛ КОМПЛЕКС 30 cps"),
    (r"chia|чиа", r"^ЧИА ТЕРАПИЈА"), (r"chlorophyll|хлорофил", r"^ХЛОРОФИЛ"), (r"hepatol|хепатол", r"^ХЕПАТОЛ ФОРТЕ 30 cps"),
    (r"spirulina|спирулина", r"^СПИРУЛИНА"), (r"red yeast|црвен ориз", r"^ЦРВЕН ОРИЗ"), (r"osteo ?fix|остео фикс", r"^ОСТЕО ФИКС"),
    (r"allergo|алерго", r"^АЛЕРГО ПРОТЕКТ 500"), (r"laxative|лаксатив", r"^NATURAL LAXATIVE"), (r"protein ice cream|сладолед", r"^ПРОТЕИНСКИ СЛАДОЛЕД"),
    (r"epimedium|епимедиум", r"^ЕПИМЕДИУМ"), (r"\bcalm\b", r"^CALM антистрес"), (r"saw palmetto|сау палмето", r"^САУ ПАЛМЕТТО"),
    (r"gastro protect|гастро протект", r"^ГАСТРО ПРОТЕКТ 500"), (r"gastro aloe|гастро алое", r"^ГАСТРО АЛОЕ"),
    (r"i.am\b|оливал|olival|elixy|serum|серум|крем\b|крема|cream(?!.*ice)|aura\b|wet n wild|\bbabe\b|scheller|végane|vegane", "RULE_COS"),
]
KEYS = [(re.compile(k, re.I), (t if t == "RULE_COS" else find(t))) for k, t in KEYS]
COSMETIC = re.compile(r"face care|mascara|eyeliner|туш за очи|молив|пудра|concealer|palette|трепки|лепак|шминка|make ?up|highlight|contour|brush|sponge|тупфер|micellar|ампули|primer|hidrogen|крем|cream|серум|serum|шампон|shampoo|балсам|лосион|lotion|маска|mask|spf|elixy|гел за кожа|"
                      r"body gel|derma|after sun|масло од|oil\b|сапун|soap|дезодоран|deodor", re.I)
DEVICE = re.compile(r"roller|roler|ролер|massager|масажер|блендер|бленде|правосмукалка|глукометар|оксиметар|\bтаблет\b|телефон|тава|бокал|бастун|подлога|јога|постур|апарат|телевизор|фритеза|готвач|еспресо|нескафе|сецко|степер|топка|ластици|вага|чистач|велосипед|инхалатор|nebulizer|monitor|slimbox|6 in 1|shaker|шејкер|ќебе|blanket|уред|device|cooler|клима|стегач|хеланки|чаша|bottle|шише|торба|bag", re.I)

def by_name(name):
    """The EARLIEST product named wins (a bundle's main product); also says whether the name mixes rates."""
    hits = []
    for idx, (rx, code) in enumerate(KEYS):
        m = rx.search(name) if code else None
        if m:
            hits.append((m.start(), idx, code))
    if not hits:
        return None, False
    hits.sort()
    rates = {0.18 if c == "RULE_COS" else sigma_rate(c) for _, _, c in hits}
    return hits[0][2], len(rates) > 1

# ---------------------------------------------------------------- crosswalk links
cw = list(csv.DictReader(open(os.path.join(RESEARCH, "S2-product-crosswalk.csv"), encoding="utf-8-sig")))
CONF = {"VERIFIED": 0, "HIGH": 1, "MEDIUM": 2, "LOW": 3}
def links(col, idrx):
    best = {}
    for r in cw:
        if r["row_type"] != "SIGMA_ITEM" or r["sigma_item_code"] not in items:
            continue
        for pid, conf in re.findall(idrx, r[col]):
            cur = best.get(pid)
            if cur is None or CONF.get(conf, 9) < CONF.get(cur[1], 9):
                best[pid] = (r["sigma_item_code"], conf)
    return best
crm_links = links("mk_crm_ids", r"([0-9a-f-]{36})(?:\[\w+\])?\{(\w+)\}")
t2_links = links("storefront_t2_ids", r"(\d+)\{(\w+)\}")

# manual corrections reviewed 01.10.2026 (the crosswalk linked these to the wrong item)
T2_FORCE = {"1324": "000957", "1327": "001331", "1092": "005007", "1342": "rule:device-18", "1252": "rule:cosmetic-18",
            "1094": "005019", "1093": "005006", "1259": "001619", "1198": "001529", "1128": "001527", "1246": "000604", "1124": "000448", "5354": "000604"}

# CRM corrections (01.10.2026): a value starting with "rule:" forces that rule.
CRM_FORCE = {"efc6db90-4fcd-42c3-8e71-e593d0d590fd": "rule:cosmetic-18",   # ОЛИВАЛ МАГНЕЗИУМ МАСЛО ≠ magnesium tablets
             "e48274ab-7855-43c5-9e05-b73836711363": "rule:cosmetic-18",  # ALOE VERA GEL 99% (skin gel; Sigma 000086 has no invoice since 2025; every skin gel in Sigma is 18 %)
             # CRM migration 20260944000910 (01.10.2026 evening): wrong crosswalk links, and one of Sigma's own errors
             "44b4eaad-24dd-43d2-867c-4f1ff9c44932": "rule:cosmetic-18",  # AURA BASE База за сенка Prime Me ≠ ZINC 120/1 tab
             "622e1b33-c225-46b9-bd34-76fa8ca1e2cd": "rule:cosmetic-18",  # AURA Апликатори за сенка за очи ≠ ZINC 365 tbl
             "b070ca90-697f-459f-ad93-defbbdd9b0d5": "rule:device-18",    # МАИЦИ (clothing) ≠ МАКА ЕКСТРАКТ
             "a84853ee-0171-4e60-98ee-61ea36adecde": "rule:device-18",    # МАИЦИ XL (clothing) ≠ МАКА ЕКСТРАКТ
             "ae4b09f0-ee8a-4f89-b93c-427c5d68c668": "rule:device-18"}    # ТАБЛЕТ-СТ95: Sigma 051668 carries it at 5 % — Sigma's error (anomalies sheet A)

def classify(name, link, force=None):
    if force and force.startswith("rule:"):
        return "", force, 0.18 if force.endswith("18") else 0.05
    if force:
        return force, "sigma:manual", sigma_rate(force)
    if link:
        return link[0], f"sigma:crosswalk-{link[1]}", sigma_rate(link[0])
    code, mixed = by_name(name)
    if code == "RULE_COS":
        return "", "rule:cosmetic-18" + ("+mixed" if mixed else ""), 0.18
    if code:
        return code, "sigma:by-name" + ("+mixed" if mixed else ""), sigma_rate(code)
    if DEVICE.search(name):
        return "", "rule:device-18", 0.18
    if COSMETIC.search(name):
        return "", "rule:cosmetic-18", 0.18
    return "", "rule:supplement-5", 0.05

def build(products, link_map, id_key, name_key, extra, force_map=None, tag=""):
    rows = []
    for p in products:
        pid = str(p[id_key])
        code, source, rate = classify(p[name_key] or "", link_map.get(pid), (force_map or {}).get(pid))
        it = items.get(code, {})
        rows.append(dict(id=pid, name=p[name_key], **{k: p.get(k) for k in extra}, vat_rate=rate, vat_source=source,
                         sigma_code=code, sigma_name=it.get("name", ""), sigma_vat_id=it.get("vat_id", ""),
                         evidence=evidence(code) if code else ""))
    return rows

crm = json.load(open(os.path.join(OUT, "crm_products.json"), encoding="utf-8"))
t2 = json.load(open(os.path.join(OUT, "t2_products.json"), encoding="utf-8"))
crm_rows = build(crm, crm_links, "id", "name", ["kind", "brand_line", "is_active", "sku", "lines_since_2025"], CRM_FORCE)
t2_rows = build(t2, t2_links, "id", "name", ["slug", "status", "price", "lines"], T2_FORCE)

def write(rows, name):
    json.dump(rows, open(os.path.join(OUT, name + ".json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    with open(os.path.join(OUT, name + ".csv"), "w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys())); w.writeheader(); w.writerows(rows)
write(crm_rows, "crm_products_vat")
write(t2_rows, "t2_products_vat")

review = [dict(system="crm", **r) for r in crm_rows if r["vat_source"].startswith(("rule", "sigma:by-name")) and (r.get("lines_since_2025") or r.get("is_active"))] + \
         [dict(system="t2", **r) for r in t2_rows if r["vat_source"].startswith(("rule", "sigma:by-name")) and (r.get("lines") or r.get("status"))]
with open(os.path.join(OUT, "review.csv"), "w", encoding="utf-8-sig", newline="") as f:
    keys = sorted({k for r in review for k in r}, key=lambda k: (k not in ("system", "id", "name", "vat_rate", "vat_source", "sigma_code", "sigma_name"), k))
    w = csv.DictWriter(f, fieldnames=keys); w.writeheader(); w.writerows(review)

def summ(rows, act_key, lines_key):
    c = collections.Counter((r["vat_source"].split("-")[0] if r["vat_source"].startswith("sigma:crosswalk") else r["vat_source"], r["vat_rate"]) for r in rows)
    sold = collections.Counter((r["vat_rate"]) for r in rows if r.get(lines_key))
    return dict(by_source_rate={f"{k[0]} @ {k[1]}": v for k, v in sorted(c.items())}, products_with_sales_by_rate={str(k): v for k, v in sold.items()})
summary = dict(crm=summ(crm_rows, "is_active", "lines_since_2025"), t2=summ(t2_rows, "status", "lines"), review_rows=len(review))
json.dump(summary, open(os.path.join(OUT, "summary.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print(json.dumps(summary, ensure_ascii=False, indent=1))
