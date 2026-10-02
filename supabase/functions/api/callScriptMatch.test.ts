import { describe, expect, it } from "vitest";
import listsFixture from "../../../src/components/insights/lists/__fixtures__/lists.sample.json";
import {
  ALL_GROUPS, LEAD_GROUPS, PREDICTION_GROUPS, buildTwins, groupOfLeadStatus, groupOfListName, lintScript,
  matchScripts, nameTokens, proposeProductsForTitle, resolveTargetedScript, sectionsToText, segmentsToText,
  sinceText, substitute, validateSections, whereItWins,
  type MatchableScript, type ScriptVarsLite,
} from "./callScriptMatch.ts";

// ── groups ──────────────────────────────────────────────────────────────────

describe("groups", () => {
  it("lead + prediction = all, in the contract order", () => {
    expect(LEAD_GROUPS).toEqual(["lead_new", "lead_callback"]);
    expect(PREDICTION_GROUPS).toEqual(["newcomers", "d21", "d57", "m4_6", "m6_12", "y1_2", "y2plus", "cancels", "never_converted", "trash"]);
    expect(ALL_GROUPS).toEqual([...LEAD_GROUPS, ...PREDICTION_GROUPS]);
  });
  it("lead status → group, no fallback from callback to new", () => {
    expect(groupOfLeadStatus("pending")).toBe("lead_new");
    expect(groupOfLeadStatus("take")).toBe("lead_new");
    expect(groupOfLeadStatus("call_again")).toBe("lead_callback");
    expect(groupOfLeadStatus("confirmed")).toBeNull();
    expect(groupOfLeadStatus(null)).toBeNull();
  });
});

describe("groupOfListName — all 59 live names", () => {
  const names: string[] = (listsFixture as any).lists.map((l: any) => l.name);
  it("the fixture is the 59 live names", () => expect(names).toHaveLength(59));

  it("every live name maps to a group or to the documented null set", () => {
    const nulls = new Set(["Current Returns", "Due to Reorder"]);
    for (const n of names) {
      const g = groupOfListName(n);
      if (nulls.has(n)) expect(g, n).toBeNull();
      else expect(ALL_GROUPS as readonly string[], n).toContain(g);
    }
  });

  it("the recency bands by first token", () => {
    const expected: Record<string, string> = {
      "NEWCOMERS (1-3 orders)": "newcomers", "NEWCOMERS (7+ orders)": "newcomers",
      "21d 26+ (1-3 orders)": "d21", "21d ≤26 (7+ orders)": "d21",
      "57d 26+ (5+ orders)": "d57", "57d ≤26 (1-3 orders)": "d57",
      "4-6m 26+ (1-3 orders)": "m4_6", "4-6m ≤26 (7+ orders)": "m4_6",
      "6-12m ≤26 (3+ orders)": "m6_12", "6-12m 26+ (7+ orders)": "m6_12",
      "1-2yr 26+ (1-3 orders)": "y1_2", "1-2yr ≤26 (5+ orders)": "y1_2",
      "2yr+ 26+ (1-3 orders)": "y2plus", "2yr+ ≤26 (7+ orders)": "y2plus",
    };
    for (const [n, g] of Object.entries(expected)) expect(groupOfListName(n), n).toBe(g);
    // every band name of the fixture is covered by one of the 7 recency groups
    const bands = names.filter((n) => /^(NEWCOMERS|21d|57d|4-6m|6-12m|1-2yr|2yr\+) /.test(n));
    expect(bands).toHaveLength(52);
    for (const n of bands) expect(["newcomers", "d21", "d57", "m4_6", "m6_12", "y1_2", "y2plus"], n).toContain(groupOfListName(n));
  });

  it("the pens by exact name", () => {
    expect(groupOfListName("Current Cancels")).toBe("cancels");
    expect(groupOfListName("Cancelled Pendings")).toBe("cancels");
    expect(groupOfListName("Never-Converted Recent")).toBe("never_converted");
    expect(groupOfListName("Never-Converted Old")).toBe("never_converted");
    expect(groupOfListName("Trash List")).toBe("trash");
    expect(groupOfListName("Current Returns")).toBeNull();
    expect(groupOfListName("Due to Reorder")).toBeNull();
    expect(groupOfListName("FULL MONAD LIST")).toBeNull();
  });

  it("uploaded / unknown names → null; the name is never changed", () => {
    expect(groupOfListName("Кампања Простатол октомври")).toBeNull();
    expect(groupOfListName("trash list")).toBeNull();
    expect(groupOfListName("")).toBeNull();
    expect(groupOfListName(null)).toBeNull();
    expect(groupOfListName(undefined)).toBeNull();
    const n = "21d 26+ (1-3 orders)";
    groupOfListName(n);
    expect(n).toBe("21d 26+ (1-3 orders)");
  });
});

// ── matching ────────────────────────────────────────────────────────────────

const PROSTATOL = "p-prostatol";
const PROSTATOL_TWIN = "p-prostatol-twin";
const NEUROFIX = "p-neurofix";
const NEFROFIX = "p-nefrofix";
const OTHER = "p-other";

let seq = 0;
const s = (id: string, groups: string[], product_ids: string[] = [], extra: Partial<MatchableScript> = {}): MatchableScript => ({
  id, context_type: "targeted", status: "published", groups, product_ids, priority: 0,
  published_at: `2026-10-01T08:${String(10 + (seq++ % 40)).padStart(2, "0")}:00Z`, updated_at: "2026-10-01T08:00:00Z", ...extra,
});

const A = s("A", ["d21"]);
const B = s("B", ["d21", "d57"], [PROSTATOL]);
const C = s("C", [], [PROSTATOL]);
const D = s("D", ["y2plus"]);
const E = s("E", ["lead_new"]);
const F = s("F", ["lead_new", "lead_callback"], [NEUROFIX]);
const G = s("G", []);
const T = s("T", ["trash"]);
const LIB = [A, B, C, D, E, F, G, T];
const twins = { [PROSTATOL]: [PROSTATOL_TWIN], [PROSTATOL_TWIN]: [PROSTATOL] };
const ids = (r: ReturnType<typeof matchScripts>) => r.alternatives.map((x) => x.script.id);

describe("matchScripts — the six worked examples", () => {
  it("1. a 21d client whose last purchase was Простатол → B; alternatives A, C, G", () => {
    const r = matchScripts(LIB, { group: "d21", primary: PROSTATOL, products: [PROSTATOL], twins });
    expect(r.best?.script.id).toBe("B");
    expect(r.best?.match.tier).toBe(1);
    expect(r.best?.match.reasons).toEqual(["group:d21", `product:${PROSTATOL}`]);
    expect(ids(r)).toEqual(["A", "C", "G"]);
    expect(r.alternatives.map((x) => x.match.tier)).toEqual([2, 3, 4]);
  });

  it("1b. … or its twin → B, with the twin reason", () => {
    const r = matchScripts(LIB, { group: "d21", primary: PROSTATOL_TWIN, products: [PROSTATOL_TWIN], twins });
    expect(r.best?.script.id).toBe("B");
    expect(r.best?.match.reasons).toEqual(["group:d21", `product:${PROSTATOL}`, "twin"]);
    expect(r.best?.match.matched_product_id).toBe(PROSTATOL);
    expect(ids(r)).toEqual(["A", "C", "G"]);
  });

  it("2. a 2yr+ client with Нефрофикс (last_sale_product) → D", () => {
    const r = matchScripts(LIB, { group: "y2plus", primary: NEFROFIX, products: [NEFROFIX], twins });
    expect(r.best?.script.id).toBe("D");
    expect(r.best?.match.tier).toBe(2);
    expect(r.best?.match.reasons).toEqual(["group:y2plus", "all_products"]);
    expect(ids(r)).toEqual(["G"]);
  });

  it("3. a fresh lead for Неурофикс (take) → F; alternative E", () => {
    const r = matchScripts(LIB, { group: groupOfLeadStatus("take"), primary: NEUROFIX, products: [NEUROFIX] });
    expect(r.best?.script.id).toBe("F");
    expect(r.best?.match.tier).toBe(1);
    expect(ids(r)[0]).toBe("E");
    expect(ids(r)).toEqual(["E", "G"]);
  });

  it("4. the same lead in call_again → F; with F on lead_new only, G wins (no fallback to new)", () => {
    const ctx = { group: groupOfLeadStatus("call_again"), primary: NEUROFIX, products: [NEUROFIX] };
    expect(matchScripts(LIB, ctx).best?.script.id).toBe("F");
    const F2 = { ...F, groups: ["lead_new"] };
    const r = matchScripts([A, B, C, D, E, F2, G, T], ctx);
    expect(r.best?.script.id).toBe("G");
    expect(ids(r)).toEqual([]);
  });

  it("5. a Trash List customer opened by hand → the trash script", () => {
    const r = matchScripts(LIB, { group: groupOfListName("Trash List"), primary: OTHER, products: [OTHER] });
    expect(r.best?.script.id).toBe("T");
    expect(ids(r)).toEqual(["G"]);
  });

  it("6. an uploaded list or Current Returns (G null) → only C (product matches) or G", () => {
    for (const name of ["Кампања октомври", "Current Returns"]) {
      const g = groupOfListName(name);
      expect(g).toBeNull();
      const withP = matchScripts(LIB, { group: g, primary: PROSTATOL, products: [PROSTATOL], twins });
      expect(withP.best?.script.id).toBe("C");
      expect(ids(withP)).toEqual(["G"]);
      const without = matchScripts(LIB, { group: g, primary: OTHER, products: [OTHER] });
      expect(without.best?.script.id).toBe("G");
      expect(ids(without)).toEqual([]);
    }
  });
});

describe("matchScripts — rules", () => {
  it("only targeted rows; published only unless drafts are included; archived never", () => {
    const legacy = { ...G, id: "legacy", context_type: "product" };
    const draft = s("draft", ["d21"], [], { status: "draft" });
    const archived = s("arch", ["d21"], [PROSTATOL], { status: "archived" });
    const lib = [legacy, draft, archived, G];
    expect(matchScripts(lib, { group: "d21", primary: PROSTATOL, products: [PROSTATOL] }).best?.script.id).toBe("G");
    const r = matchScripts(lib, { group: "d21", primary: PROSTATOL, products: [PROSTATOL] }, { includeDrafts: true });
    expect(r.best?.script.id).toBe("draft");
    expect(r.ranked.map((x) => x.script.id)).toEqual(["draft", "G"]);
  });

  it("primary product before another product of the call, inside a tier", () => {
    const onPrimary = s("onPrimary", ["d21"], [PROSTATOL], { priority: -5 });
    const onOther = s("onOther", ["d21"], [OTHER], { priority: 50 });
    const r = matchScripts([onOther, onPrimary], { group: "d21", primary: PROSTATOL, products: [PROSTATOL, OTHER] });
    expect(r.best?.script.id).toBe("onPrimary");
    expect(r.best?.match.tie_break).toBe("primary_product");
    expect(r.alternatives[0].match.reasons).toEqual(["group:d21", `product:${OTHER}`]);
  });

  it("then priority, then the newest, then id", () => {
    const lo = s("lo", ["d21"], [], { priority: 0, published_at: "2026-10-02T09:00:00Z" });
    const hi = s("hi", ["d21"], [], { priority: 10, published_at: "2026-09-01T09:00:00Z" });
    let r = matchScripts([lo, hi], { group: "d21", primary: null, products: [] });
    expect(r.best?.script.id).toBe("hi");
    expect(r.best?.match.tie_break).toBe("priority");

    const old = s("old", ["d21"], [], { published_at: "2026-09-01T09:00:00Z" });
    const fresh = s("fresh", ["d21"], [], { published_at: "2026-10-01T09:00:00Z" });
    r = matchScripts([old, fresh], { group: "d21", primary: null, products: [] });
    expect(r.best?.script.id).toBe("fresh");
    expect(r.best?.match.tie_break).toBe("newest");

    const noPub = s("noPub", ["d21"], [], { published_at: null, updated_at: "2026-10-03T09:00:00Z" });
    expect(matchScripts([fresh, noPub], { group: "d21", primary: null, products: [] }, { includeDrafts: true }).best?.script.id).toBe("noPub");

    const same = "2026-10-01T09:00:00Z";
    const b = s("b", ["d21"], [], { published_at: same });
    const a = s("a", ["d21"], [], { published_at: same });
    r = matchScripts([b, a], { group: "d21", primary: null, products: [] });
    expect(r.best?.script.id).toBe("a");
    expect(r.best?.match.tie_break).toBeNull();
  });

  it("the tier decides before priority; tie_break is null across tiers", () => {
    const general = s("general", [], [], { priority: 100 });
    const group = s("group", ["d57"], [], { priority: -100 });
    const r = matchScripts([general, group], { group: "d57", primary: null, products: [] });
    expect(r.best?.script.id).toBe("group");
    expect(r.best?.match.tie_break).toBeNull();
  });

  it("a script with products never matches a call with no product", () => {
    expect(matchScripts([C, G], { group: "d21", primary: null, products: [] }).best?.script.id).toBe("G");
  });

  it("at most 4 alternatives; nothing matches → best null", () => {
    const many = Array.from({ length: 8 }, (_, i) => s(`m${i}`, []));
    const r = matchScripts(many, { group: null, primary: null, products: [] });
    expect(r.alternatives).toHaveLength(4);
    expect(r.ranked).toHaveLength(8);
    expect(matchScripts([A], { group: null, primary: null, products: [] }).best).toBeNull();
  });
});

describe("buildTwins", () => {
  it("same normalised name = twins; unique names have none", () => {
    const t = buildTwins([
      { id: "1", name: "Prostatol Complex" }, { id: "2", name: " prostatol  complex " }, { id: "3", name: "Neurofix" },
    ]);
    expect(t).toEqual({ "1": ["2"], "2": ["1"] });
  });
});

// ── variables ───────────────────────────────────────────────────────────────

const VARS: ScriptVarsLite = {
  customer_name: "Марија Петровска", first_name: null, agent_name: "Ана", product: "Prostatol Complex", price_eur: 26,
  last_product: "Hepatol", last_purchase_at: "2026-07-01T22:30:00Z", days_since_purchase: 93, city: "Битола", order_id: "M-100234",
};

describe("substitute", () => {
  it("fills both syntaxes and returns segments, never HTML", () => {
    const segs = substitute("Добар ден {{customer_name}}, јас сум [Your Name]. <b>{{ product }}</b> чини {{price}}.", VARS);
    expect(segmentsToText(segs)).toBe("Добар ден Марија Петровска, јас сум Ана. <b>Prostatol Complex</b> чини 1.599 ден.");
    expect(segs.every((x) => typeof (x as any).text === "string" || x.kind === "missing")).toBe(true);
    expect(segs.find((x) => x.kind === "text" && x.text.includes("<b>"))).toBeTruthy();
    expect(segs.filter((x) => x.kind === "var").map((x) => (x as any).name)).toEqual(["customer_name", "agent_name", "product", "price"]);
  });

  it("first_name falls back to the first word of the name; dates are Skopje days", () => {
    expect(segmentsToText(substitute("{{first_name}} · {{last_purchase_date}} · {{days_since_purchase}} · {{since_purchase}}", VARS)))
      .toBe("Марија · 02.07.2026 · 93 · пред 3 месеци");
    expect(segmentsToText(substitute("{{since_purchase}}", VARS, "sq"))).toBe("para 3 muajsh");
  });

  it("a missing / hidden value → a missing segment with the raw token", () => {
    const segs = substitute("Здраво [Customer Name] од {{city}}!", { ...VARS, customer_name: null, city: "  " });
    expect(segs).toEqual([
      { kind: "text", text: "Здраво " },
      { kind: "missing", name: "customer_name", raw: "[Customer Name]" },
      { kind: "text", text: " од " },
      { kind: "missing", name: "city", raw: "{{city}}" },
      { kind: "text", text: "!" },
    ]);
    expect(substitute("{{product}}", null)).toEqual([{ kind: "missing", name: "product", raw: "{{product}}" }]);
  });

  it("unknown variables and unknown brackets stay as written", () => {
    expect(substitute("{{foo}} [Company] [Order ID]", VARS)).toEqual([
      { kind: "text", text: "{{foo}} [Company] " },
      { kind: "var", name: "order_id", text: "M-100234", raw: "[Order ID]" },
    ]);
    expect(substitute("", VARS)).toEqual([]);
  });

  it("legacy [Agent Name] and [Your Name] are both the agent", () => {
    expect(segmentsToText(substitute("[Agent Name]/[Your Name]/[Price]/[City]/[Product]", VARS))).toBe("Ана/Ана/1.599 ден/Битола/Prostatol Complex");
  });

  it("since text", () => {
    expect(sinceText(0)).toBe("денес");
    expect(sinceText(1)).toBe("пред 1 ден");
    expect(sinceText(5)).toBe("пред 5 дена");
    expect(sinceText(21)).toBe("пред 3 недели");
    expect(sinceText(800)).toBe("пред 2 години");
    expect(sinceText(400, "sq")).toBe("para 13 muajsh");
  });
});

// ── sections, language ──────────────────────────────────────────────────────

const SECTIONS = [
  { id: "opening", key: "opening" as const, text: "Добар ден {{first_name}}!\n" },
  { id: "pitch", key: "pitch" as const, text: "  \n" },
  { id: "custom-abc123", key: "custom" as const, title: " Гаранција ", text: "30 дена враќање." },
  { id: "closing", key: "closing" as const, text: "Ви благодарам." },
];

describe("sectionsToText (twin of call_script_sections_text)", () => {
  it("heading + text blocks, empty sections skipped, CR/LF/space trimmed", () => {
    expect(sectionsToText(SECTIONS)).toBe("Отворање\nДобар ден {{first_name}}!\n\nГаранција\n30 дена враќање.\n\nЗатворање\nВи благодарам.");
    expect(sectionsToText(SECTIONS, "sq")).toBe("Hapja\nДобар ден {{first_name}}!\n\nГаранција\n30 дена враќање.\n\nMbyllja\nВи благодарам.");
    expect(sectionsToText([])).toBe("");
    expect(sectionsToText(null)).toBe("");
  });
});

describe("validateSections", () => {
  it("accepts the contract shape", () => expect(validateSections(SECTIONS).ok).toBe(true));
  it("refuses duplicates, bad ids, untitled custom sections, long text, > 12 sections", () => {
    const codes = (x: unknown) => validateSections(x).errors.map((e) => e.code);
    expect(codes([{ id: "pitch", key: "pitch", text: "" }, { id: "pitch", key: "pitch", text: "" }])).toEqual(["duplicate_key", "duplicate_id"]);
    expect(codes([{ id: "x", key: "opening", text: "" }])).toEqual(["bad_id"]);
    expect(codes([{ id: "custom-AB", key: "custom", title: "", text: "" }])).toEqual(["bad_id", "title_required"]);
    expect(codes([{ id: "custom-abcdef", key: "custom", title: "x".repeat(81), text: "" }])).toEqual(["title_too_long"]);
    expect(codes([{ id: "pitch", key: "pitch", text: "x".repeat(8001) }])).toEqual(["text_too_long"]);
    expect(codes([{ id: "pitch", key: "nope", text: "" }])).toEqual(["bad_key"]);
    expect(codes(Array.from({ length: 13 }, (_, i) => ({ id: `custom-sec${String(i).padStart(3, "0")}`, key: "custom", title: "t", text: "" })))).toContain("too_many");
    expect(codes({})).toEqual(["not_array"]);
  });
});

describe("resolveTargetedScript", () => {
  const script = {
    title: "Простатол 21д", description: "За клиенти од 21 ден",
    sections: SECTIONS,
    helpers: [{ title: "Цена", content: "1.599 ден" }],
    translations: { sq: {
      title: "Prostatol 21d", description: "",
      sections: [
        { id: "opening", key: "opening" as const, text: "Mirëdita {{first_name}}!" },
        { id: "closing", key: "closing" as const, text: "  " },
        { id: "custom-abc123", key: "custom" as const, title: "Garancia", text: "30 ditë kthim." },
        { id: "custom-sqonly1", key: "custom" as const, title: "Vetëm sq", text: "Shtesë." },
      ],
    } },
  };
  it("mk = the base", () => {
    const r = resolveTargetedScript(script, "mk");
    expect(r.lang).toBe("mk");
    expect(r.sections.map((x) => x.text)).toEqual(SECTIONS.map((x) => x.text));
    expect(r.fallback_section_ids).toEqual([]);
    expect(resolveTargetedScript(script, "en").lang).toBe("mk");
  });
  it("sq falls back to mk per section id; sq-only sections follow", () => {
    const r = resolveTargetedScript(script, "sq-MK");
    expect(r.lang).toBe("sq");
    expect(r.title).toBe("Prostatol 21d");
    expect(r.description).toBe("За клиенти од 21 ден");
    expect(r.sections.map((x) => x.id)).toEqual(["opening", "pitch", "custom-abc123", "closing", "custom-sqonly1"]);
    expect(r.sections.map((x) => x.text)).toEqual(["Mirëdita {{first_name}}!", "  \n", "30 ditë kthim.", "Ви благодарам.", "Shtesë."]);
    expect(r.sections[2].title).toBe("Garancia");
    expect(r.fallback_section_ids).toEqual(["closing"]);
    expect(r.fallback_fields).toEqual(["description", "helpers"]);
    expect(r.helpers).toEqual(script.helpers);
  });
});

// ── lint ────────────────────────────────────────────────────────────────────

describe("lintScript", () => {
  it("flags BG content, terminology, unknown vars, legacy placeholders; missing sq is information", () => {
    const issues = lintScript({
      context_type: "targeted", title: "Тест", description: null,
      sections: [
        { id: "opening", key: "opening", text: "Здраво [Customer Name], јас сум ______. Цената е 30 евро, 59 лв, испорака со Еконт." },
        { id: "pitch", key: "pitch", text: "Според прогнозата, нарачката е на чекање. {{customer_name}} {{ime}} лвов" },
      ],
      helpers: [],
      translations: { sq: { sections: [{ id: "opening", key: "opening", text: "Dërgesa me Speedy." }] } },
    });
    const by = (code: string) => issues.filter((i) => i.code === code).map((i) => `${i.lang}:${i.field}:${i.match}`);
    expect(by("bg_content")).toEqual(["mk:section:opening:евро", "mk:section:opening:лв", "mk:section:opening:Еконт", "sq:section:opening:Speedy"]);
    expect(by("terminology")).toEqual(["mk:section:pitch:прогноз", "mk:section:pitch:на чекање"]);
    expect(by("unknown_var")).toEqual(["mk:section:pitch:{{ime}}"]);
    expect(by("legacy_placeholder")).toEqual(["mk:section:opening:[Customer Name]", "mk:section:opening:______"]);
    expect(by("missing_sq")).toEqual(["sq:section:pitch:pitch"]);
    expect(issues.find((i) => i.code === "missing_sq")?.severity).toBe("info");
  });
  it("a legacy row is linted on script_text; a clean script has no issues", () => {
    expect(lintScript({ context_type: "product", title: "X", description: null, sections: [], script_text: "Плаќање при Спиди" })
      .map((i) => i.match)).toEqual(["Спиди"]);
    expect(lintScript({ context_type: "targeted", title: "X", description: null, sections: [{ id: "pitch", key: "pitch", text: "Цена {{price}}." }],
      translations: { sq: { sections: [{ id: "pitch", key: "pitch", text: "Çmimi {{price}}." }] } } })).toEqual([]);
  });
});

// ── proposals ───────────────────────────────────────────────────────────────

describe("proposeProductsForTitle", () => {
  const products = [
    { id: "1", name: "Prostatol Complex (2+2) + Цинк 120тбл", kind: "bundle", is_active: true },
    { id: "2", name: "PROSTATOL COMPLEX 2+1 + EPIMEDIUM COMPLEX", kind: "bundle", is_active: false },
    { id: "3", name: "Prostatol Complex", kind: "product", is_active: true },
    { id: "4", name: "Hepatol", kind: "product", is_active: true },
    { id: "5", name: "Нефрофикс", kind: "product", is_active: true },
    { id: "6", name: "Enduro Max 30 капсули", kind: "product", is_active: true },
  ];
  it("every significant title word must be in the name; exact + products first", () => {
    const r = proposeProductsForTitle("Prostatol Complex 30 caps", products);
    expect(r.map((x) => x.product_id)).toEqual(["3", "1", "2"]);
    expect(r[0].exact).toBe(true);
  });
  it("the description after the dash is ignored; Cyrillic matches Latin", () => {
    expect(proposeProductsForTitle("Hepatol Forte 30 caps – За црн дроб", products)).toEqual([]);
    expect(proposeProductsForTitle("Hepatol – За црн дроб", products).map((x) => x.product_id)).toEqual(["4"]);
    expect(proposeProductsForTitle("Nefrofix", products).map((x) => x.product_id)).toEqual(["5"]);
    expect(proposeProductsForTitle("Enduro Max 30 caps", products).map((x) => x.product_id)).toEqual(["6"]);
    expect(proposeProductsForTitle("30 caps", products)).toEqual([]);
  });
  it("tokens", () => expect(nameTokens("Нефрофикс 30/1")).toEqual(["nefrofiks", "30", "1"]));
});

// ── where it wins ───────────────────────────────────────────────────────────

describe("whereItWins", () => {
  it("a group script wins its group for products without their own script, loses where a product script exists", () => {
    const draftA = { ...A, status: "draft" };
    const r = whereItWins(draftA, LIB, { productIds: [PROSTATOL, OTHER], twins });
    expect(r.cells.map((c) => `${c.group}/${c.product_id}:${c.winner_id}`)).toEqual([
      "d21/null:A", `d21/${PROSTATOL}:B`, `d21/${OTHER}:A`,
    ]);
    expect(r.wins).toBe(2);
    expect(r.loses).toBe(1);
  });
  it("a general script is evaluated on every group", () => {
    const r = whereItWins(G, LIB, { productIds: [] });
    expect(r.cells).toHaveLength(ALL_GROUPS.length);
    // lead_callback: F needs Неурофикс, E is lead_new only · d57: B needs Простатол
    expect(r.cells.filter((c) => c.wins).map((c) => c.group)).toEqual(["lead_callback", "newcomers", "d57", "m4_6", "m6_12", "y1_2", "cancels", "never_converted"]);
  });
});
