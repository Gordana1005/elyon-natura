import { describe, expect, it, vi } from "vitest";
import {
  MEX_PUSH_DEFAULTS, MEX_PUSH_HARD_CAP, MexNotConfiguredError, MexUnknownOutcomeError,
  accountOpen, applySettingsPatch, asciiFold, buildMexPayload, codMkd, createMexClient, csvEquivalent,
  decideAccount, doubleParcelWarnings, effectiveHomeParts, evaluateOrder, findExistingParcel, mexAutoSendPlan,
  noParcelDaysLeft, parseHomeAddress, parsePushBody, phoneNational, pushAuditPayload, readMexPushSettings,
  requestHash, runMexPush, skopjeStamp, splitName, stripPushMoney, transliterate, validateForPush,
  type ClaimReply, type MexClient, type PushDeps, type PushOrder, type RecordArgs,
} from "./mexPush.ts";
import { buildMexImportColumns, MEX_IMPORT_WEIGHT_KG } from "@/lib/mexImportCsv";
import { transliterate as appTransliterate } from "@/lib/transliterate";
import { effectiveHomeParts as appEffective, parseHomeAddress as appParse } from "@/lib/address";
import { codFor } from "@/lib/currency";
import { validateOrderForFulfilment } from "@/lib/fulfilmentValidation";

const ID1 = "11111111-1111-4111-8111-111111111111";
const ID2 = "22222222-2222-4222-8222-222222222222";
const ID3 = "33333333-3333-4333-8333-333333333333";
const NOW = new Date("2026-10-01T09:00:00Z");

const home: PushOrder = {
  id: ID1, display_id: "ORD-361496", status: "confirmed",
  customer_name: "Ана Марија Петровска", customer_phone: "+38976123456",
  street: "Партизанска", street_number: "12", floor: "3", apartment: "7",
  customer_city: "Скопје", postal_code: "1000", mex_city_id: 262, mex_city_name: "Skopje - Aerodrom",
  delivery_type: "home", delivery_instructions: "викни по 18ч, 2 кат", price_eur: 30.08,
  items: [{ product_id: "p1", product_name: "Alpha Male", quantity: 2, brand_line: "bio_natural" }],
  department: "elyon_crm", sale_source: "elyon_crm", sale_at: "2026-09-29T08:00:00Z",
};

/** The same order as the /orders CSV reads it (price, not price_eur). */
const asCsvRow = (o: PushOrder) => ({ ...o, price: o.price_eur as number });
const csvCells = (o: PushOrder) => buildMexImportColumns().map((c) => String(c.format ? c.format(asCsvRow(o) as never) : ""));

const CORPUS: PushOrder[] = [
  home,
  { ...home, id: ID2, display_id: "ORD-99999", customer_name: "Јован Стојановски", street: "Гоце Делчев 18", street_number: null,
    floor: null, apartment: null, customer_phone: "070111222", price_eur: 24.39, delivery_instructions: null },
  { ...home, id: ID3, display_id: "ORD-100001", customer_name: "Ѓорѓи Љубевски Џафер", street: null, street_number: null, floor: null,
    apartment: null, customer_address: "ул. Шипка 6 с. Ловско 7291", customer_city: "Велес", price_eur: 19.9,
    delivery_instructions: 'Ѕвони "двапати"\nна вратата' },
  { ...home, customer_name: "Ivana Petrova", quarter: "Карпош 4", block: "12", street: null, street_number: null, entry: "Б",
    customer_phone: "+38923123456", price_eur: 0.5 },
  { ...home, delivery_type: "mex_office", courier_office_code: "SK1", courier_office_name: "МЕХ Центар", courier_office_city: "Скопје" },
];

describe("the CSV contract — the push sends exactly what the /orders MEX CSV would", () => {
  it.each(CORPUS.map((o, i) => [i, o] as const))("order #%s: every field equals its CSV cell", (_i, o) => {
    const [kod, ime, adresa, grad, telefon, otkup, opis, tezina] = csvCells(o);
    const p = buildMexPayload(o);
    const c = csvEquivalent(o);
    expect(c).toEqual({ ime, adresa, grad, telefon, otkup, opis, tezina });
    expect(`${p.first_name} ${p.last_name}`).toBe(ime);
    expect(p.receiver_address ?? "").toBe(adresa);
    expect(p.receiver_phone).toBe(telefon);
    expect(p.cod).toBe(otkup);
    expect(p.instructions ?? "").toBe(opis);
    expect(String(p.weight)).toBe(tezina);
    expect(String(p.weight)).toBe(MEX_IMPORT_WEIGHT_KG);
    // the reference: the CSV's digits-only code is the same order number
    expect(p.tracking_id.replace(/\D/g, "")).toBe(kod);
    expect(p.tracking_id).toBe(o.display_id);
    expect(p.sender_reference).toBe(o.display_id);
    expect(p.receiver_city_id).toBe(Number(o.mex_city_id));
  });

  it("the example order, field by field", () => {
    expect(buildMexPayload(home)).toEqual({
      tracking_id: "ORD-361496", sender_reference: "ORD-361496",
      first_name: "Ana", last_name: "Marija Petrovska",
      receiver_phone: "076123456", receiver_address: "Partizanska br. 12 kat 3 stan 7",
      receiver_city_id: 262, cod: "1850", weight: 1, instructions: "vikni po 18ch 2 kat",
    });
  });

  it("transliterate / parseHomeAddress / effectiveHomeParts are the app's own", () => {
    const words = ["Ѓорѓи", "Љубица Њаги", "Џабир", "Ѕвездан", "Щастлив", "ул. Мара", "СП Трговија", "ѝ ѐ", "Kočani"];
    for (const w of words) expect(transliterate(w)).toBe(appTransliterate(w));
    const blobs = ["ул. Шипка 6  с. Ловско обл. Разград 7291", "жк Тракия, бл 183, вх Г, ет. 4, ап 12", "Гоце Делчев 18", "", "Speedy офис Центар"];
    for (const b of blobs) {
      expect(parseHomeAddress(b, "Скопје")).toEqual(appParse(b, "Скопје"));
      expect(effectiveHomeParts({ customer_address: b, customer_city: "Велес" })).toEqual(appEffective({ customer_address: b, customer_city: "Велес" }));
    }
    expect(effectiveHomeParts({ street: "Илинденска 5", quarter: "" })).toEqual(appEffective({ street: "Илинденска 5", quarter: "" }));
  });

  it("COD is a STRING of whole denars — codFor, the frozen 61.5, rounded to 10", () => {
    for (const eur of [30.08, 24.39, 19.9, 0.5, 0, 45, 99.99, "12.34"]) {
      expect(codMkd(eur as number)).toBe(codFor(eur as number).amount);
      expect(typeof buildMexPayload({ ...home, price_eur: eur as number }).cod).toBe("string");
    }
    expect(buildMexPayload({ ...home, price_eur: 29.9 }).cod).toBe("1840");
  });

  it("phone: stored +389 E.164 → the national 07… form MEX dials", () => {
    expect(phoneNational("+38970123456")).toBe("070123456");
    expect(phoneNational("38975123456")).toBe("075123456");
    expect(phoneNational("+38923123456")).toBe("023123456");
    expect(phoneNational("070 123 456")).toBe("070123456");
  });

  it("ASCII only: diacritics folded, dashes / quotes plain, nothing else changed", () => {
    expect(asciiFold("Kočani – “x” … Štip")).toBe('Kocani - "x" ... Stip');
    expect(asciiFold("Partizanska br. 12")).toBe("Partizanska br. 12");
    const p = buildMexPayload({ ...home, customer_name: "Zoran Ković", street: "Ulica Čair", street_number: "1", floor: null, apartment: null });
    expect(`${p.first_name} ${p.last_name}`).toBe("Zoran Kovic");
    expect(p.receiver_address).toBe("Ulica Cair br. 1");
    for (const v of Object.values(p)) expect(String(v)).toMatch(/^[\x20-\x7e]*$/);
  });

  it("one-word names still get a last name; long Opis is capped at 10 000", () => {
    expect(splitName("Ana")).toEqual({ first_name: "Ana", last_name: "-" });
    const p = buildMexPayload({ ...home, delivery_instructions: "а".repeat(12_000) });
    expect(p.instructions?.length).toBe(10_000);
  });
});

describe("validation — the CSV gate plus the push's own", () => {
  it("never looser than validateOrderForFulfilment", () => {
    const cases: PushOrder[] = [...CORPUS,
      { ...home, customer_name: "Ана" }, { ...home, postal_code: "" }, { ...home, mex_city_id: null },
      { ...home, items: [], product_name: "" }, { ...home, price_eur: 0 }, { ...home, street: "", street_number: "" },
      { ...home, street_number: "" }, { ...home, delivery_type: "mex_office", courier_office_code: "" }];
    for (const o of cases) {
      const app = validateOrderForFulfilment({ ...asCsvRow(o), order_items: o.items as never } as never);
      const mine = validateForPush(o, NOW);
      for (const code of app.missing) expect(mine.missing).toContain(code);
    }
  });
  it("the 383 AlterCPA orders without an address cannot go", () => {
    const o = { ...home, street: null, street_number: null, floor: null, apartment: null, customer_address: null, department: "altercpa" };
    expect(validateForPush(o, NOW).missing).toContain("address");
  });
  it("push-only codes: not confirmed, a parcel, web, test phone, ship later", () => {
    expect(validateForPush({ ...home, status: "shipped" }, NOW).missing).toContain("not_confirmed");
    expect(validateForPush({ ...home, mex_tracking_id: "002-9103-1/2026" }, NOW).missing).toContain("has_parcel");
    expect(validateForPush({ ...home, department: "web" }, NOW).missing).toContain("web_order");
    expect(validateForPush({ ...home, test_phone: true }, NOW).missing).toContain("test_phone");
    expect(validateForPush({ ...home, ship_after_date: "2026-10-02" }, NOW).missing).toContain("ship_later");
    expect(validateForPush({ ...home, ship_after_date: "2026-10-01" }, NOW).missing).not.toContain("ship_later");
    expect(validateForPush(home, NOW)).toEqual({ ok: true, missing: [] });
  });
});

describe("the MEX profile — product line first, department fallback, disagreement = a manual pick", () => {
  const item = (brand_line: string | null) => ({ product_name: "x", quantity: 1, brand_line });
  it("Bio Natural / Dr.Becker → BIO NATURAL; agreeing department → no pick", () => {
    const d = decideAccount({ items: [item("bio_natural"), item("dr_becker")], department: "altercpa" });
    expect(d).toMatchObject({ account: "bio_natural", basis: "product_line", needs_pick: false, reasons: [] });
  });
  it("Natura Therapy / Ad Astra → NATURA; a department that says otherwise → warning + pick", () => {
    const d = decideAccount({ items: [item("natura_therapy"), item("ad_astra")], department: "elyon_crm" });
    expect(d).toMatchObject({ account: "natura", basis: "product_line", needs_pick: true, reasons: ["department_disagrees"] });
  });
  it("the SQL's resolved line_profile wins over the TS mirror", () => {
    const d = decideAccount({ items: [{ product_name: "x", quantity: 1, brand_line: "future_line", line_profile: "natura" }], department: "teleshop_out" });
    expect(d).toMatchObject({ account: "natura", needs_pick: false });
  });
  it("a mixed basket → no suggestion, a pick", () => {
    const d = decideAccount({ items: [item("bio_natural"), item("natura_therapy")], department: "altercpa" });
    expect(d).toMatchObject({ account: null, needs_pick: true, reasons: ["mixed_basket"] });
  });
  it("no line yet (20260943001300 absent) → the department's account, flagged for a pick", () => {
    expect(decideAccount({ items: [item(null)], department: "altercpa" })).toMatchObject({ account: "bio_natural", basis: "department", needs_pick: true, reasons: ["line_missing"] });
    expect(decideAccount({ items: [], department: "teleshop_other" })).toMatchObject({ account: "natura", basis: "department" });
    expect(decideAccount({ items: [item(null)], department: "unknown" })).toMatchObject({ account: null, reasons: ["line_missing", "no_department_profile"] });
  });
  it("a partly tagged basket → the known line, flagged", () => {
    expect(decideAccount({ items: [item("bio_natural"), item(null)], department: "altercpa" })).toMatchObject({ account: "bio_natural", needs_pick: true, reasons: ["line_partial"] });
  });
  it("the seller's team only disagrees, never decides", () => {
    expect(decideAccount({ items: [item("bio_natural")], department: "altercpa", seller_team: "crm_prediction" })).toMatchObject({ account: "bio_natural", reasons: ["team_disagrees"], needs_pick: true });
    expect(decideAccount({ items: [item("bio_natural")], department: "altercpa", seller_team: "altercpa_leads" })).toMatchObject({ needs_pick: false });
    expect(decideAccount({ items: [item("natura_therapy")], department: "teleshop_out", seller_team: "teleshop:in" })).toMatchObject({ needs_pick: false });
  });
  it("a web order is never sent from the CRM", () => {
    expect(decideAccount({ items: [item("natura_therapy")], department: "web" })).toMatchObject({ account: null, reasons: ["web_order"], needs_pick: false });
    const ev = evaluateOrder({ ...home, department: "web" }, { account: "natura", reason: "try it" }, NOW);
    expect(ev.ok).toBe(false);
    expect(ev.blockers).toContain("web_order");
  });
});

describe("evaluateOrder — overrides and the double-parcel guard", () => {
  const tagged = { ...home, department: "altercpa" };
  it("a clean, tagged order goes with the suggestion", () => {
    const ev = evaluateOrder(tagged, null, NOW);
    expect(ev).toMatchObject({ ok: true, account: "bio_natural", blockers: [] });
    expect(ev.payload?.tracking_id).toBe("ORD-361496");
  });
  it("a pick needs an override WITH a reason", () => {
    const o = { ...home, items: [{ product_name: "x", quantity: 1, brand_line: null }] };
    expect(evaluateOrder(o, null, NOW).blockers).toContain("needs_pick");
    expect(evaluateOrder(o, { account: "natura", reason: "" }, NOW).blockers).toContain("bad_override");
    expect(evaluateOrder(o, { account: "natura", reason: "Natura производ" }, NOW)).toMatchObject({ ok: true, account: "natura" });
  });
  it("an unlinked parcel or a collabBox document on the phone blocks, unless confirmed with a reason", () => {
    const o = { ...tagged, unlinked_parcels: [{ tracking_id: "002-9110-1/2026", account: "bio_natural", created_at: "2026-09-29T09:00:00Z" }] };
    expect(evaluateOrder(o, null, NOW).blockers).toContain("double_parcel_risk");
    expect(evaluateOrder(o, { account: "bio_natural", reason: "проверив во MEX", double_ok: true }, NOW).ok).toBe(true);
    const doc = { ...tagged, collabbox_docs: [{ doc_number: "002-9103-5/2026", doc_at: "2026-09-29T10:00:00Z" }] };
    expect(evaluateOrder(doc, null, NOW).blockers).toContain("double_parcel_risk");
    const older = { ...tagged, collabbox_docs: [{ doc_number: "002-9103-4/2026", doc_at: "2026-09-20T10:00:00Z" }] };
    expect(doubleParcelWarnings(older)).toEqual([expect.objectContaining({ code: "collabbox_doc", blocking: false })]);
    expect(evaluateOrder(older, null, NOW).ok).toBe(true);
  });
  it("hints never block: another order's parcel, an unanswered earlier push, a failed attempt", () => {
    const o = { ...tagged, other_parcels: [{ tracking_id: "002-9102-9/2026", order_display_id: "ORD-1", created_at: "2026-09-29T10:00:00Z" }],
      mex_sent_at: "2026-09-30T10:00:00Z", last_attempt: { status: "error", error: "mex_refused: x" } };
    const w = doubleParcelWarnings(o).map((x) => x.code);
    expect(w).toEqual(["other_parcel", "sent_unconfirmed", "last_attempt_failed"]);
    expect(evaluateOrder(o, null, NOW).ok).toBe(true);
  });
  it("the 10-day no-parcel clock", () => {
    expect(noParcelDaysLeft({ ...home, no_parcel_rule: { days: 10, cancel_after: "2026-10-03T09:00:00Z" } }, NOW)).toBe(2);
    expect(noParcelDaysLeft(home, NOW)).toBeNull();
  });
});

describe("settings — OFF unless an admin says otherwise", () => {
  it("defaults and malformed values read as off", () => {
    expect(readMexPushSettings(null)).toEqual(MEX_PUSH_DEFAULTS);
    expect(readMexPushSettings({ enabled: "yes", accounts: { natura: 1 }, max_per_send: 500 })).toEqual(MEX_PUSH_DEFAULTS);
    const s = readMexPushSettings({ enabled: true, accounts: { natura: true, bio_natural: false }, max_per_send: 20, auto_send_at: "11:00" });
    expect(accountOpen(s, "natura")).toBe(true);
    expect(accountOpen(s, "bio_natural")).toBe(false);
    expect(accountOpen({ ...s, enabled: false }, "natura")).toBe(false);
    expect(s.max_per_send).toBe(20);
  });
  it("the admin patch", () => {
    expect(applySettingsPatch(MEX_PUSH_DEFAULTS, { enabled: true, accounts: { natura: true } })).toEqual({
      ok: true, settings: { ...MEX_PUSH_DEFAULTS, enabled: true, accounts: { natura: true, bio_natural: false } } });
    expect(applySettingsPatch(MEX_PUSH_DEFAULTS, { accounts: { other: true } })).toEqual({ ok: false, error: "invalid_accounts" });
    expect(applySettingsPatch(MEX_PUSH_DEFAULTS, { max_per_send: 51 })).toEqual({ ok: false, error: "invalid_max_per_send" });
    expect(applySettingsPatch(MEX_PUSH_DEFAULTS, {})).toEqual({ ok: false, error: "nothing_to_change" });
  });
});

describe("the request", () => {
  it("caps at 50, needs uuids, needs a reason for an override", () => {
    const ids = Array.from({ length: 51 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    expect(parsePushBody({ order_ids: ids })).toEqual({ ok: false, error: "too_many_orders" });
    expect(parsePushBody({ order_ids: ids.slice(0, 50) })).toMatchObject({ ok: true });
    expect(parsePushBody({ order_ids: ids.slice(0, 10) }, 5)).toEqual({ ok: false, error: "too_many_orders" });
    expect(parsePushBody({ order_ids: ["x"] })).toEqual({ ok: false, error: "invalid_order_id" });
    expect(parsePushBody({ order_ids: [ID1], account_overrides: { [ID1]: { account: "natura" } } })).toEqual({ ok: false, error: "override_reason_required" });
    expect(parsePushBody({ order_ids: [ID1, ID1], dry_run: true, account_overrides: { [ID1]: { account: "natura", reason: " мешана кошничка ", double_ok: true } } }))
      .toEqual({ ok: true, req: { order_ids: [ID1], dry_run: true, overrides: { [ID1]: { account: "natura", reason: "мешана кошничка", double_ok: true } } } });
    expect(MEX_PUSH_HARD_CAP).toBe(50);
  });
});

// ── the client, with a mocked fetch (no MEX call ever leaves a test) ──────────────
function fakeFetch(handler: (url: string, init: { method?: string; headers?: Record<string, string>; body?: string }) => { status?: number; body: unknown } | Error) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: unknown }> = [];
  const fn = vi.fn(async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
    calls.push({ url, method: init.method ?? "GET", headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : undefined });
    const r = handler(url, init);
    if (r instanceof Error) throw r;
    const text = typeof r.body === "string" ? r.body : JSON.stringify(r.body);
    return { status: r.status ?? 200, text: async () => text };
  });
  return { fn, calls };
}

describe("the MEX client", () => {
  it("AuthKey per account, POST JSON to add_shipment.php, GET status by id / ref", async () => {
    const f = fakeFetch((url) => url.includes("add_shipment") ? { body: { success: 1, tracking_id: "ORD-1" } } : { body: { success: 0, error: "No shipment found" } });
    const c = createMexClient({ keys: { bio_natural: "KEY-B", natura: "KEY-N" }, fetch: f.fn });
    await c.status("natura", "ORD-1");
    await c.statusByRef("bio_natural", "ORD-1");
    await c.addShipment("bio_natural", buildMexPayload(home));
    expect(f.calls[0]).toMatchObject({ url: "https://mex.mk/api/json/get_shipment_status.php?tracking_id=ORD-1", method: "GET", headers: { AuthKey: "KEY-N" } });
    expect(f.calls[1]).toMatchObject({ url: "https://mex.mk/api/json/get_shipment_status_by_ref.php?sender_reference=ORD-1", headers: { AuthKey: "KEY-B" } });
    expect(f.calls[2]).toMatchObject({ url: "https://mex.mk/api/json/add_shipment.php", method: "POST", headers: { AuthKey: "KEY-B", "Content-Type": "application/json" } });
    expect(f.calls[2].body).toEqual(buildMexPayload(home));
  });
  it("no key / a rejected key / a network failure / a non-JSON body", async () => {
    const f = fakeFetch((url) => url.includes("tracking_id=A") ? { status: 401, body: "no" } : url.includes("tracking_id=B") ? new Error("timeout") : { body: "<html>" });
    const c = createMexClient({ keys: { natura: "K" }, fetch: f.fn });
    expect(c.hasKey("bio_natural")).toBe(false);
    await expect(c.status("bio_natural", "X")).rejects.toBeInstanceOf(MexNotConfiguredError);
    await expect(c.status("natura", "A")).rejects.toBeInstanceOf(MexNotConfiguredError);
    await expect(c.status("natura", "B")).rejects.toBeInstanceOf(MexUnknownOutcomeError);
    await expect(c.status("natura", "C")).rejects.toBeInstanceOf(MexUnknownOutcomeError);
  });
  it("findExistingParcel asks by tracking id, by reference, then the CSV's digits", async () => {
    const f = fakeFetch((url) => url.includes("tracking_id=361496") ? { body: { success: 1, current_status_id: "8", current_status_name: "Shipment created" } } : { body: { success: 0 } });
    const c = createMexClient({ keys: { natura: "K" }, fetch: f.fn });
    expect(await findExistingParcel(c, "natura", "ORD-361496")).toEqual({ tracking_id: "361496", status_id: 8, status_name: "Shipment created", probe: "csv_code" });
    expect(f.calls.map((x) => x.url.split("?")[1])).toEqual(["tracking_id=ORD-361496", "sender_reference=ORD-361496", "tracking_id=361496"]);
    const g = fakeFetch(() => ({ body: { success: 0, error: "No shipment found" } }));
    expect(await findExistingParcel(createMexClient({ keys: { natura: "K" }, fetch: g.fn }), "natura", "ORD-1")).toBeNull();
  });
});

// ── the send loop, every dependency faked ────────────────────────────────────────
const OPEN = readMexPushSettings({ enabled: true, accounts: { bio_natural: true, natura: true } });
const tagged: PushOrder = { ...home, department: "altercpa" };

function harness(opts: {
  orders?: Record<string, PushOrder>;
  claim?: (id: string) => ClaimReply;
  mex?: Partial<MexClient>;
  register?: PushDeps["registerLookup"];
  settings?: typeof OPEN;
  record?: (a: RecordArgs) => { status: string; error?: string };
  clock?: () => Date;
}) {
  const orders = opts.orders ?? { [ID1]: tagged };
  const records: RecordArgs[] = [];
  const claims: string[] = [];
  const client: MexClient = {
    hasKey: () => true,
    status: vi.fn(async () => ({ success: 0 })),
    statusByRef: vi.fn(async () => ({ success: 0 })),
    addShipment: vi.fn(async (_a, p) => ({ success: 1, tracking_id: p.tracking_id })),
    ...opts.mex,
  };
  const deps: PushDeps = {
    settings: opts.settings ?? OPEN,
    client,
    facts: vi.fn(async (ids: string[]) => ids.map((id) => orders[id]).filter(Boolean)),
    claim: vi.fn(async (id: string) => {
      claims.push(id);
      return opts.claim ? opts.claim(id) : orders[id] ? { claimed: true, claimed_at: "2026-10-01T09:00:00Z", order: orders[id] } : { claimed: false, reason: "not_found" };
    }),
    record: vi.fn(async (a: RecordArgs) => { records.push(a); return opts.record ? opts.record(a) : { status: a.status }; }),
    registerLookup: opts.register ?? vi.fn(async () => null),
    now: opts.clock ?? (() => NOW),
  };
  return { deps, client, records, claims };
}

describe("runMexPush", () => {
  it("dry run: the exact payload, no claim, no ledger, no MEX call — and the switch shows", async () => {
    const h = harness({ settings: MEX_PUSH_DEFAULTS });
    const out = await runMexPush({ order_ids: [ID1], overrides: {}, dry_run: true }, h.deps);
    expect(out.results[0]).toMatchObject({ outcome: "dry_run", account: "bio_natural", payload: buildMexPayload(tagged), blockers: ["account_disabled"] });
    expect(h.deps.claim).not.toHaveBeenCalled();
    expect(h.deps.record).not.toHaveBeenCalled();
    expect(h.client.status).not.toHaveBeenCalled();
    expect(h.client.addShipment).not.toHaveBeenCalled();
  });
  it("creates the parcel once and records it (ledger ok, provisional register row at MEX 8)", async () => {
    const h = harness({});
    const out = await runMexPush({ order_ids: [ID1], overrides: {}, dry_run: false }, h.deps);
    expect(out.results[0]).toMatchObject({ outcome: "sent", tracking_id: "ORD-361496", account: "bio_natural" });
    expect(h.client.addShipment).toHaveBeenCalledTimes(1);
    expect(h.client.addShipment).toHaveBeenCalledWith("bio_natural", buildMexPayload(tagged));
    expect(h.records).toHaveLength(1);
    expect(h.records[0]).toMatchObject({ status: "ok", tracking_id: "ORD-361496", release: false, request_hash: requestHash(buildMexPayload(tagged)) });
    expect(h.records[0].parcel).toMatchObject({ tracking_id: "ORD-361496", current_status_id: "8", cod: "1850", created_at: skopjeStamp(NOW) });
  });
  it("IDEMPOTENT: a parcel MEX already has is re-linked, never re-created", async () => {
    const h = harness({ mex: { status: vi.fn(async () => ({ success: 1, tracking_id: "ORD-361496", current_status_id: 4, current_status_name: "Picked up" })) } });
    const out = await runMexPush({ order_ids: [ID1], overrides: {}, dry_run: false }, h.deps);
    expect(out.results[0]).toMatchObject({ outcome: "exists_linked", tracking_id: "ORD-361496" });
    expect(h.client.addShipment).not.toHaveBeenCalled();
    expect(h.records[0]).toMatchObject({ status: "exists_linked", tracking_id: "ORD-361496", release: false });
  });
  it("IDEMPOTENT: our own register already holds it → linked with no MEX call at all", async () => {
    const h = harness({ register: vi.fn(async () => ({ tracking_id: "ORD-361496", account: "natura" as const, status_id: 8, match: "ref" as const })) });
    const out = await runMexPush({ order_ids: [ID1], overrides: {}, dry_run: false }, h.deps);
    expect(out.results[0]).toMatchObject({ outcome: "exists_linked", account: "natura" });
    expect(h.client.status).not.toHaveBeenCalled();
    expect(h.client.addShipment).not.toHaveBeenCalled();
  });
  it("a CSV-imported parcel (digits code) is never duplicated and never guessed into a link", async () => {
    const h = harness({ register: vi.fn(async () => ({ tracking_id: "361496", account: "bio_natural" as const, status_id: 8, match: "csv_code" as const })) });
    const out = await runMexPush({ order_ids: [ID1], overrides: {}, dry_run: false }, h.deps);
    expect(out.results[0]).toMatchObject({ outcome: "skipped", reason: "csv_parcel_exists" });
    expect(h.client.addShipment).not.toHaveBeenCalled();
    expect(h.records[0]).toMatchObject({ status: "skipped", release: true });
  });
  it("IDEMPOTENT: a second press finds the order already claimed / with a parcel — nothing is sent", async () => {
    const h = harness({ claim: () => ({ claimed: false, reason: "has_parcel", tracking_id: "ORD-361496" }) });
    const out = await runMexPush({ order_ids: [ID1], overrides: {}, dry_run: false }, h.deps);
    expect(out.results[0]).toMatchObject({ outcome: "not_claimed", reason: "has_parcel" });
    expect(h.client.status).not.toHaveBeenCalled();
    expect(h.client.addShipment).not.toHaveBeenCalled();
    expect(h.records).toHaveLength(0);
  });
  it("MEX refuses → error, the claim is released", async () => {
    const h = harness({ mex: { addShipment: vi.fn(async () => ({ success: 0, error: "Invalid city" })) } });
    const out = await runMexPush({ order_ids: [ID1], overrides: {}, dry_run: false }, h.deps);
    expect(out.results[0]).toMatchObject({ outcome: "error", reason: "mex_refused: Invalid city" });
    expect(h.records[0]).toMatchObject({ status: "error", release: true });
  });
  it("a timeout AFTER sending → unknown outcome, the claim is KEPT (the next try asks MEX first)", async () => {
    const h = harness({ mex: { addShipment: vi.fn(async () => { throw new MexUnknownOutcomeError("timeout"); }) } });
    const out = await runMexPush({ order_ids: [ID1], overrides: {}, dry_run: false }, h.deps);
    expect(out.results[0]).toMatchObject({ outcome: "unknown_outcome" });
    expect(h.records[0]).toMatchObject({ status: "error", release: false });
  });
  it("the existence check failing blocks the send (could not ask ≠ does not exist)", async () => {
    const h = harness({ mex: { status: vi.fn(async () => { throw new MexUnknownOutcomeError("down"); }) } });
    const out = await runMexPush({ order_ids: [ID1], overrides: {}, dry_run: false }, h.deps);
    expect(out.results[0]).toMatchObject({ outcome: "error", reason: "existence_check_failed" });
    expect(h.client.addShipment).not.toHaveBeenCalled();
    expect(h.records[0]).toMatchObject({ release: true });
  });
  it("a closed account / a needed pick / a missing address → skipped, released, nothing sent", async () => {
    const orders = {
      [ID1]: tagged,
      [ID2]: { ...tagged, id: ID2, display_id: "ORD-2", items: [{ product_name: "x", quantity: 1, brand_line: null }] },
      [ID3]: { ...tagged, id: ID3, display_id: "ORD-3", street: null, street_number: null, customer_address: null },
    };
    const h = harness({ orders, settings: readMexPushSettings({ enabled: true, accounts: { natura: true } }) });
    const out = await runMexPush({ order_ids: [ID1, ID2, ID3], overrides: {}, dry_run: false }, h.deps);
    expect(out.results.map((r) => [r.outcome, r.reason])).toEqual([
      ["skipped", "account_disabled"], ["skipped", "needs_pick"], ["skipped", "address"],
    ]);
    expect(h.client.addShipment).not.toHaveBeenCalled();
    expect(h.records.every((r) => r.status === "skipped" && r.release)).toBe(true);
  });
  it("an override with a reason sends to the chosen account", async () => {
    const o = { ...tagged, items: [{ product_name: "x", quantity: 1, brand_line: null }] };
    const h = harness({ orders: { [ID1]: o } });
    const out = await runMexPush({ order_ids: [ID1], overrides: { [ID1]: { account: "natura", reason: "Natura производ" } }, dry_run: false }, h.deps);
    expect(out.results[0]).toMatchObject({ outcome: "sent", account: "natura" });
    expect(h.client.addShipment).toHaveBeenCalledWith("natura", expect.anything());
  });
  it("the time budget defers the rest (the UI sends them again)", async () => {
    let t = NOW.getTime();
    const orders = { [ID1]: tagged, [ID2]: { ...tagged, id: ID2, display_id: "ORD-2" } };
    const h = harness({ orders, clock: () => new Date((t += 60_000)) });
    const out = await runMexPush({ order_ids: [ID1, ID2], overrides: {}, dry_run: false }, { ...h.deps, budgetMs: 90_000 });
    expect(out.results.map((r) => r.outcome)).toEqual(["sent", "deferred"]);
    expect(out.stopped).toBe("time_budget");
  });
  it("a rejected key stops the batch", async () => {
    const orders = { [ID1]: tagged, [ID2]: { ...tagged, id: ID2, display_id: "ORD-2" } };
    const h = harness({ orders, mex: { status: vi.fn(async () => { throw new MexNotConfiguredError("bio_natural"); }) } });
    const out = await runMexPush({ order_ids: [ID1, ID2], overrides: {}, dry_run: false }, h.deps);
    expect(out.results.map((r) => r.outcome)).toEqual(["error", "deferred"]);
    expect(out.stopped).toBe("not_configured");
  });
  it("audit payload carries order numbers and tracking ids, never PII; money stripped for non-owners", async () => {
    const h = harness({});
    const req = { order_ids: [ID1], overrides: {}, dry_run: false };
    const out = await runMexPush(req, h.deps);
    const a = pushAuditPayload(req, out);
    expect(a).toMatchObject({ requested: 1, sent: [{ order: "ORD-361496", tracking_id: "ORD-361496", account: "bio_natural" }] });
    expect(JSON.stringify(a)).not.toContain("Петровска");
    const dry = await runMexPush({ ...req, dry_run: true }, h.deps);
    const s = stripPushMoney(dry.results[0]);
    expect(dry.results[0].payload?.cod).toBe("1850");
    expect(s.payload?.cod).toBe("");
    expect(s.csv?.otkup).toBe("");
  });
});

describe("mexAutoSendPlan — built, NOT scheduled", () => {
  it("oldest first, only what needs no human, capped", () => {
    const rows: PushOrder[] = [
      { ...tagged, id: "a", display_id: "ORD-A", sale_at: "2026-09-30T08:00:00Z" },
      { ...tagged, id: "b", display_id: "ORD-B", sale_at: "2026-09-28T08:00:00Z" },
      { ...tagged, id: "c", display_id: "ORD-C", sale_at: "2026-09-29T08:00:00Z", items: [{ product_name: "x", quantity: 1 }] },
      { ...tagged, id: "d", display_id: "ORD-D", sale_at: "2026-09-27T08:00:00Z", street: null, street_number: null },
      { ...tagged, id: "e", display_id: "ORD-E", sale_at: "2026-09-27T09:00:00Z", unlinked_parcels: [{ tracking_id: "x", created_at: "2026-09-28T00:00:00Z" }] },
      { ...tagged, id: "f", display_id: "ORD-F", sale_at: "2026-09-26T09:00:00Z", mex_sent_at: "2026-09-30T09:00:00Z" },
    ];
    const plan = mexAutoSendPlan(rows, OPEN, NOW, 1);
    expect(plan.toSend.map((x) => x.order.id)).toEqual(["b"]);
    expect(plan.truncated).toBe(true);
    expect(plan.needsPick.map((o) => o.id)).toEqual(["c"]);
    expect(plan.invalid.map((x) => x.order.id)).toEqual(["d"]);
    expect(plan.doubleParcel.map((o) => o.id)).toEqual(["e"]);
    expect(plan.unconfirmedEarlier.map((o) => o.id)).toEqual(["f"]);
    expect(mexAutoSendPlan(rows, MEX_PUSH_DEFAULTS, NOW).accountClosed.map((o) => o.id)).toEqual(["b", "a"]);
  });
});
