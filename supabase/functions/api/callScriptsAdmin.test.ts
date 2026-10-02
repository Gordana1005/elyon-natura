import { describe, expect, it } from "vitest";
import {
  buildCallContext, duplicateTargets, mapWriterError, modeOf, parseBulk, parseCreateBody, parseDuplicate, parseLibraryQuery,
  parseMode, parseRestore, parseScriptPatch, parseUpdateBody, redactVars, scriptsEnabledFor, shapeCoverage, shapeLibrary,
  shapeScriptRow, type DemandRow, type ScriptRow,
} from "./callScriptsAdmin.ts";

const P1 = "11111111-1111-4111-8111-111111111111";
const P2 = "22222222-2222-4222-8222-222222222222";
const P2_TWIN = "22222222-2222-4222-8222-999999999999";
const L21 = "aaaaaaaa-0000-4000-8000-000000000021";
const LTRASH = "aaaaaaaa-0000-4000-8000-0000000000aa";
const LRET = "aaaaaaaa-0000-4000-8000-0000000000bb";
const NOW = new Date("2026-10-02T10:00:00Z");

describe("mode", () => {
  it("unknown values are off; preview is for admins / managers only", () => {
    expect(modeOf({ mode: "on" })).toBe("on");
    expect(modeOf({ mode: "live" })).toBe("off");
    expect(modeOf(null)).toBe("off");
    expect(scriptsEnabledFor("off", true)).toBe(false);
    expect(scriptsEnabledFor("preview", true)).toBe(true);
    expect(scriptsEnabledFor("preview", false)).toBe(false);
    expect(scriptsEnabledFor("on", false)).toBe(true);
  });
  it("parseMode", () => {
    expect(parseMode({ mode: "preview", note: " test " })).toEqual({ ok: true, mode: "preview", note: "test" });
    expect(parseMode({ mode: "x" })).toMatchObject({ ok: false, code: "bad_mode" });
    expect(parseMode({ mode: "on", note: "x".repeat(501) })).toMatchObject({ ok: false, code: "note_too_long" });
  });
});

describe("patch parsers", () => {
  it("accepts the contract fields and refuses the rest with the writer's codes", () => {
    expect(parseScriptPatch({ title: "A", groups: ["d21"], product_ids: [P1], priority: 5, sections: [{ id: "pitch", key: "pitch", text: "x" }] }).ok).toBe(true);
    expect(parseScriptPatch({ colour: 1 })).toMatchObject({ code: "unknown_field" });
    expect(parseScriptPatch({ groups: ["d22"] })).toMatchObject({ code: "bad_group" });
    expect(parseScriptPatch({ product_ids: ["nope"] })).toMatchObject({ code: "unknown_product" });
    expect(parseScriptPatch({ priority: 101 })).toMatchObject({ code: "bad_priority" });
    expect(parseScriptPatch({ priority: 1.5 })).toMatchObject({ code: "bad_priority" });
    expect(parseScriptPatch({ status: "live" })).toMatchObject({ code: "bad_status" });
    expect(parseScriptPatch({ sections: [{ id: "x", key: "pitch", text: "" }] })).toMatchObject({ code: "bad_sections" });
    expect(parseScriptPatch([])).toMatchObject({ code: "invalid_body" });
  });
  it("create refuses script_text and archived; update needs the expected version", () => {
    expect(parseCreateBody({ patch: { title: "A" } })).toEqual({ ok: true, patch: { title: "A" }, note: null });
    expect(parseCreateBody({ patch: { script_text: "x" } })).toMatchObject({ code: "script_text_derived" });
    expect(parseCreateBody({ patch: { status: "archived" } })).toMatchObject({ code: "bad_status" });
    expect(parseUpdateBody({ patch: {} })).toMatchObject({ code: "expected_version_required", status: 400 });
    expect(parseUpdateBody({ expected_version: 3, patch: { status: "published" }, note: "go" })).toEqual({ ok: true, expected_version: 3, patch: { status: "published" }, note: "go" });
    expect(parseRestore({ version: 0 })).toMatchObject({ code: "bad_version" });
    expect(parseRestore({ version: 4 })).toEqual({ ok: true, version: 4, note: null });
  });
});

describe("duplicate", () => {
  const name = (id: string) => (id === P1 ? "Простатол" : id === P2 ? "Неурофикс" : null);
  it("none / product / group / cell", () => {
    const d = parseDuplicate({ groups: ["d57", "d21"], product_ids: [P1, P2, P1], split: "cell" });
    expect(d).toMatchObject({ ok: true, groups: ["d21", "d57"], product_ids: [P1, P2], split: "cell" });
    if (!d.ok) return;
    const t = duplicateTargets("Предикција", d, name);
    expect(t.ok && t.targets.map((x) => x.title)).toEqual([
      "Предикција · 21–57 дена · Простатол", "Предикција · 21–57 дена · Неурофикс",
      "Предикција · 57–120 дена · Простатол", "Предикција · 57–120 дена · Неурофикс",
    ]);
    const none = duplicateTargets("Општа", { groups: [], product_ids: [], split: "none" }, name);
    expect(none.ok && none.targets).toEqual([{ title: "Општа", groups: [], product_ids: [] }]);
    const byProduct = duplicateTargets("X", { groups: ["d21"], product_ids: [P1, P2], split: "product" }, name);
    expect(byProduct.ok && byProduct.targets.map((x) => [x.groups, x.product_ids])).toEqual([[["d21"], [P1]], [["d21"], [P2]]]);
  });
  it("needs products / groups for the split and refuses more than 50", () => {
    expect(parseDuplicate({ groups: [], product_ids: [], split: "product" })).toMatchObject({ code: "bad_targets" });
    expect(parseDuplicate({ split: "diagonal" })).toMatchObject({ code: "bad_targets" });
    const many = Array.from({ length: 6 }, (_, i) => `33333333-3333-4333-8333-00000000000${i}`);
    const r = duplicateTargets("X", { groups: ["lead_new", "lead_callback", "newcomers", "d21", "d57", "m4_6", "m6_12", "y1_2", "y2plus"], product_ids: many, split: "cell" }, () => "p");
    expect(r).toMatchObject({ ok: false, code: "too_many" });
  });
});

describe("parseBulk", () => {
  it("validates ids and the op", () => {
    expect(parseBulk({ ids: [P1, P1], op: { add_groups: ["trash"], status: "published" } })).toEqual({ ok: true, ids: [P1], op: { add_groups: ["trash"], status: "published" }, note: null });
    expect(parseBulk({ ids: [], op: { status: "draft" } })).toMatchObject({ code: "bad_op" });
    expect(parseBulk({ ids: [P1], op: {} })).toMatchObject({ code: "bad_op" });
    expect(parseBulk({ ids: [P1], op: { rename: "x" } })).toMatchObject({ code: "bad_op" });
    expect(parseBulk({ ids: [P1], op: { add_products: ["x"] } })).toMatchObject({ code: "unknown_product" });
    expect(parseBulk({ ids: Array.from({ length: 201 }, (_, i) => `44444444-4444-4444-8444-${String(i).padStart(12, "0")}`), op: { status: "draft" } })).toMatchObject({ code: "too_many" });
  });
});

describe("mapWriterError", () => {
  it("SQLSTATE + HINT → HTTP", () => {
    expect(mapWriterError({ code: "CS409", hint: "stale", details: "7", message: "x" })).toEqual({ status: 409, body: expect.objectContaining({ code: "stale", current_version: 7 }) });
    expect(mapWriterError({ code: "CS404", hint: "not_found", message: "gone" })).toEqual({ status: 404, body: { error: "gone", code: "not_found" } });
    expect(mapWriterError({ code: "42501", hint: "admin_only", message: "only admins" })).toMatchObject({ status: 403, body: { code: "admin_only" } });
    expect(mapWriterError({ code: "22023", hint: "publish_needs_text", details: "text_required", message: "m" })).toMatchObject({ status: 400, body: { code: "publish_needs_text", detail: "text_required" } });
    expect(mapWriterError({ code: "XX000", message: "boom" })).toMatchObject({ status: 500, body: { code: "failed" } });
    expect(mapWriterError(null)).toMatchObject({ status: 500 });
  });
});

// ── library ─────────────────────────────────────────────────────────────────

const row = (o: Partial<ScriptRow>): ScriptRow => ({
  id: "s", context_type: "targeted", status: "published", title: "T", description: null, script_text: "", sections: [], helpers: [], translations: {},
  groups: [], product_ids: [], priority: 0, version: 1, created_at: "2026-10-01T08:00:00Z", created_by: null, updated_at: "2026-10-01T08:00:00Z",
  updated_by: null, published_at: "2026-10-01T08:00:00Z", published_by: null, copied_from: null, ...o,
});

describe("shapeLibrary", () => {
  const rows = [
    row({ id: "a", title: "Пред 21", groups: ["d21"], updated_at: "2026-10-01T09:00:00Z", updated_by: "u1" }),
    row({ id: "b", title: "Нацрт", status: "draft", product_ids: [P1], updated_at: "2026-10-02T09:00:00Z", script_text: "Цена 30 евро" }),
    row({ id: "c", title: "Стара", status: "archived" }),
    row({ id: "d", context_type: "product", title: "Prostatol Complex 30 caps", script_text: "Еконт" }),
    row({ id: "e", context_type: "order", title: "Order Script" }),
  ];
  const names = new Map([["u1", "Мила"]]);
  const q = (o: Partial<ReturnType<typeof parseLibraryQuery> extends { query: infer Q } ? Q : never> = {}) =>
    ({ status: "all" as const, group: null, product: null, q: null, ...o });
  it("targeted + legacy product rows; published first; lint and names", () => {
    const r = shapeLibrary(rows, { canSeeDrafts: true, query: q(), names });
    expect(r.map((x) => x.id)).toEqual(["a", "d", "b", "c"]);
    expect(r[0].updated_by_name).toBe("Мила");
    // a targeted row is linted on its sections (script_text is derived from them)
    expect(r.find((x) => x.id === "b")?.lint).toEqual([]);
    expect(r.find((x) => x.id === "d")?.lint?.map((i: any) => i.match)).toEqual(["Еконт"]);
  });
  it("agents see published only; filters", () => {
    expect(shapeLibrary(rows, { canSeeDrafts: false, query: q(), names }).map((x) => x.id)).toEqual(["a", "d"]);
    expect(shapeLibrary(rows, { canSeeDrafts: true, query: q({ status: "draft" }), names }).map((x) => x.id)).toEqual(["b"]);
    expect(shapeLibrary(rows, { canSeeDrafts: true, query: q({ group: "d21" }), names }).map((x) => x.id)).toEqual(["a"]);
    expect(shapeLibrary(rows, { canSeeDrafts: true, query: q({ group: "none", status: "published" }), names }).map((x) => x.id)).toEqual(["d"]);
    expect(shapeLibrary(rows, { canSeeDrafts: true, query: q({ product: P1 }), names }).map((x) => x.id)).toEqual(["b"]);
    expect(shapeLibrary(rows, { canSeeDrafts: true, query: q({ q: "евро" }), names }).map((x) => x.id)).toEqual(["b"]);
  });
  it("parseLibraryQuery", () => {
    expect(parseLibraryQuery(new URLSearchParams("status=draft&group=d21&q=%20x%20"))).toEqual({ ok: true, query: { status: "draft", group: "d21", product: null, q: "x" } });
    expect(parseLibraryQuery(new URLSearchParams("group=zz"))).toMatchObject({ code: "bad_group" });
  });
  it("shapeScriptRow keeps only sq translations and never-null arrays", () => {
    const s = shapeScriptRow(row({ translations: { sq: { title: "X" }, en: { title: "Y" } } as any, sections: null, groups: null as any }));
    expect(s.translations).toEqual({ sq: { title: "X" } });
    expect(s.sections).toEqual([]);
    expect(s.groups).toEqual([]);
  });
});

// ── call context ────────────────────────────────────────────────────────────

const PRODUCTS = new Map([[P1, { name: "Prostatol Complex", price: 26 }], [P2, { name: "Neurofix", price: 32.5 }]]);

describe("buildCallContext", () => {
  it("a lead: group from the status, products = the order + its items, order id var", () => {
    const b = buildCallContext({
      source: "lead", basis: "order_status",
      order: { id: "o1", display_id: "104233", status: "call_again", created_at: "2026-10-01T15:00:00Z", product_id: P2, product_name: "Neurofix", customer_name: " Петар Петровски ", customer_city: "Куманово" },
      orderItems: [{ product_id: P1, product_name: "Prostatol" }, { product_id: P2, product_name: "Neurofix" }],
      products: PRODUCTS, agentName: "Ана", now: NOW,
    });
    expect(b.context).toMatchObject({ group: "lead_callback", group_basis: "order_status", callback: true, order: { id: "o1", display_id: "104233", status: "call_again" } });
    expect(b.match).toEqual({ group: "lead_callback", primary: P2, products: [P2, P1] });
    expect(b.vars).toMatchObject({ customer_name: "Петар Петровски", first_name: "Петар", agent_name: "Ана", product: "Neurofix", price_eur: 32.5, city: "Куманово", order_id: "104233" });
    expect(b.context.last_purchase).toBeNull();
  });
  it("prediction: group from the list name, product from the trigger order, last purchase from the member", () => {
    const b = buildCallContext({
      source: "prediction", basis: "list_name", list: { id: L21, name: "21d 26+ (1-3 orders)" },
      member: { customer_name: "Марија Петровска", last_paid_at: "2026-09-10T09:00:00Z", trigger_order_id: "t1", product_name: "Prostatol Complex" },
      triggerOrder: { product_id: P1, product_name: "Prostatol Complex", customer_city: "Битола" }, triggerItems: [],
      lastSale: { product_id: P2, product_name: "Neurofix", sale_at: "2026-09-12T09:00:00Z" },
      products: PRODUCTS, agentName: "Ана", now: NOW,
    });
    expect(b.context).toMatchObject({ group: "d21", group_basis: "list_name", list_name: "21d 26+ (1-3 orders)", days_since_purchase: 22, product: { id: P1, price_eur: 26 } });
    expect(b.match.primary).toBe(P1);
    expect(b.vars).toMatchObject({ last_product: "Neurofix", last_purchase_at: "2026-09-10T09:00:00Z", days_since_purchase: 22, city: "Битола", order_id: null });
  });
  it("prediction without a trigger product → last_sale_product; a null-group list", () => {
    const b = buildCallContext({
      source: "manual", basis: "attribution", list: { id: LRET, name: "Current Returns" }, member: null, triggerOrder: null,
      lastSale: { product_id: P2, product_name: "Neurofix", sale_at: "2026-07-01T09:00:00Z" }, knownName: "Ана Анова",
      products: PRODUCTS, agentName: null, now: NOW,
    });
    expect(b.context.group).toBeNull();
    expect(b.match).toEqual({ group: null, primary: P2, products: [P2] });
    expect(b.vars.customer_name).toBe("Ана Анова");
    expect(b.context.days_since_purchase).toBe(93);
  });
  it("no basis at all", () => {
    const b = buildCallContext({ source: "manual", basis: "none", products: PRODUCTS, agentName: "Ана", now: NOW });
    expect(b.context).toMatchObject({ group: null, group_basis: "none", product: null, products: [] });
    expect(b.vars.product).toBeNull();
  });
  it("redactVars drops name / city / last_* by the caller's flags", () => {
    const b = buildCallContext({
      source: "prediction", basis: "list_name", list: { id: L21, name: "21d 26+ (1-3 orders)" },
      member: { customer_name: "Марија", last_paid_at: "2026-09-10T09:00:00Z", trigger_order_id: null, product_name: null },
      triggerOrder: { product_id: P1, product_name: "Prostatol", customer_city: "Битола" }, products: PRODUCTS, agentName: "Ана", now: NOW,
    });
    const r = redactVars(b, { name: false, addr: false }, false);
    expect(r.vars).toMatchObject({ customer_name: null, first_name: null, city: null, last_product: null, last_purchase_at: null, days_since_purchase: null, agent_name: "Ана", product: "Prostatol Complex" });
    expect(r.context.last_purchase).toBeNull();
    expect(b.vars.customer_name).toBe("Марија");
    expect(redactVars(b, { name: true, addr: true }, true).vars).toEqual(b.vars);
  });
});

// ── coverage ────────────────────────────────────────────────────────────────

describe("shapeCoverage", () => {
  const lists = [{ id: L21, name: "21d 26+ (1-3 orders)" }, { id: LTRASH, name: "Trash List" }, { id: LRET, name: "Current Returns" }];
  const demand: DemandRow[] = [
    { kind: "member", list_id: L21, lead_group: null, product_id: P1, product_name: "Prostatol Complex", waiting: 40, assigned: 10 },
    { kind: "member", list_id: L21, lead_group: null, product_id: null, product_name: null, waiting: 5, assigned: 0 },
    { kind: "member", list_id: LTRASH, lead_group: null, product_id: P2, product_name: "Neurofix", waiting: 7, assigned: 0 },
    { kind: "member", list_id: LTRASH, lead_group: null, product_id: P2_TWIN, product_name: "NEUROFIX", waiting: 3, assigned: 1 },
    { kind: "member", list_id: LRET, lead_group: null, product_id: P1, product_name: "Prostatol Complex", waiting: 9, assigned: 0 },
    { kind: "lead", list_id: null, lead_group: "lead_callback", product_id: P2, product_name: "Neurofix", waiting: 4, assigned: 4 },
  ];
  const products = [
    { id: P1, name: "Prostatol Complex", brand_line: "natura_therapy", kind: "product", is_active: true },
    { id: P2, name: "Neurofix", brand_line: "bio_natural", kind: "product", is_active: true },
    { id: P2_TWIN, name: "NEUROFIX", brand_line: "bio_natural", kind: "product", is_active: false },
  ];
  const sc = (id: string, groups: string[], product_ids: string[], status = "published") => ({
    id, title: id, context_type: "targeted", status, groups, product_ids, priority: 0, published_at: "2026-10-01T08:00:00Z", updated_at: "2026-10-01T08:00:00Z",
  });
  const scripts = [sc("d21-prostatol", ["d21"], [P1]), sc("trash-all", ["trash"], []), sc("draft-general", [], [], "draft")];

  it("folds twins into one row; winners, draft winners, totals", () => {
    const c = shapeCoverage(demand, lists, scripts, products, { families: true, now: NOW });
    expect(c.rows.map((r) => [r.key, r.product_ids, r.waiting])).toEqual([[P1, [P1], 40], ["neurofix", [P2, P2_TWIN], 14]]);
    const p1 = c.rows[0].cells;
    expect(p1.d21).toMatchObject({ waiting: 40, assigned: 10, winner: { script_id: "d21-prostatol", tier: 1 }, draft_winner: null, overlap: 1 });
    expect(p1.d57).toMatchObject({ waiting: 0, winner: null, draft_winner: { script_id: "draft-general", tier: 4 } });
    const nf = c.rows[1].cells;
    expect(nf.trash).toMatchObject({ waiting: 10, assigned: 1, winner: { script_id: "trash-all", tier: 2 } });
    expect(nf.lead_callback).toMatchObject({ waiting: 4, winner: null });
    expect(c.all_products.d21).toMatchObject({ waiting: 45, winner: null, draft_winner: { script_id: "draft-general" } });
    expect(c.outside).toEqual({ waiting: 9, lists: [{ list_id: LRET, name: "Current Returns", waiting: 9 }] });
    // 40 (covered) + 5 no-product d21 (empty) + 10 trash (covered) + 4 callback (empty)
    expect(c.totals).toEqual({ waiting: 59, covered: 50, covered_pct: 84.7, empty_cells_with_waiting: 2, published: 2, drafts: 1 });
  });
  it("one row per product without families; assigned only", () => {
    const c = shapeCoverage(demand, lists, scripts, products, { families: false, assignedOnly: true, now: NOW });
    expect(c.rows.map((r) => r.key)).toEqual([P1, P2, P2_TWIN]);
    expect(c.totals.waiting).toBe(15);
  });
  it("a product a script names gets a row even with nobody waiting", () => {
    const extra = { id: "33333333-3333-4333-8333-333333333333", name: "GlucoFix", brand_line: null, kind: "product", is_active: true };
    const c = shapeCoverage([], lists, [sc("gluco", [], [extra.id])], [...products, extra], { families: true, now: NOW });
    expect(c.rows.map((r) => r.name)).toEqual(["GlucoFix"]);
    expect(c.rows[0].cells.d21.winner).toMatchObject({ script_id: "gluco", tier: 3 });
  });
});
