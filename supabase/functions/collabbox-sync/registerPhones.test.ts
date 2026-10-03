/**
 * The register loader (scripts/load-komitent-register-phones.mjs, owner 03.10.2026) reads a register row
 * exactly as the sync reads a komitent CARD — registerCard (scripts/lib/komitent-register.mjs) is the twin of
 * komitentCard (collabbox.ts) — and loads only what is missing.
 */
import { describe, expect, it } from "vitest";
import { komitentCard } from "./collabbox.ts";
import type { KomitentRow } from "./collabbox.ts";
// @ts-expect-error — a plain .mjs module (no types)
import { registerCard, registerSource } from "../../../scripts/lib/komitent-register.mjs";
// @ts-expect-error — a plain .mjs module (no types)
import { plan, planLines, applySql } from "../../../scripts/load-komitent-register-phones.mjs";

type Reg = Record<string, string>;
const reg = (o: Partial<Reg>): Reg => ({
  Sifra: "40200", VnatresenID: "5550002", Ime: "Марко Марковски", Ime_lat: "", Adresa: "ул. Прва 1", Adresa_lat: "", Grad: "Тетово",
  Drzava: "Македонија", Datum_raganje: "", Telefon: "", Mobilen: "070 111 222", Email: "", Ziro_smetka: "", Broj_kartica: "",
  Danocen_broj: "", Faks: "", Lice_kontakt: "", DDV_broj: "", EMBS: "", Vraboten: "Не", ...o,
});
const asRow = (r: Reg): KomitentRow => ({
  komitentId: r.Sifra, objectId: r.VnatresenID || null, name: r.Ime, nameLat: r.Ime_lat, address: r.Adresa, addressLat: r.Adresa_lat,
  city: r.Grad, country: r.Drzava, phone: r.Telefon, mobile: r.Mobilen, email: r.Email, bankAccount: r.Ziro_smetka,
  cardNo: r.Broj_kartica, taxNumber: r.Danocen_broj, vraboten: r.Vraboten,
});

describe("registerCard = komitentCard (twins)", () => {
  const cases: Partial<Reg>[] = [
    {}, { Mobilen: "", Telefon: "076 471 785" }, { Mobilen: "+389 70 123 456" }, { Mobilen: "+40 721 234 567", Telefon: "" },
    { Mobilen: "071234567 или 072345678" }, { Mobilen: "3.89e+11" }, { Mobilen: "", Telefon: "" }, { Mobilen: "02/3111-222" },
    { Vraboten: "Да" }, { Sifra: "1200", Vraboten: "Да" }, { Ime: "Петар вработена" }, { Danocen_broj: "4030999123456" },
    { Ziro_smetka: "300000000000000" }, { Ime: "АПТЕКА ЗДРАВЈЕ ДООЕЛ" }, { Ime: "Петар Петровски почина" },
    { Ime: "Петар (не го контактирај)" }, { Ime: "Ана ВРАЌА НАРАЧКИ" }, { Ime: "ТЕСТ НАРАЧКА" }, { Ime: "Марија Тестова" },
    { Ime: "погрешен број" }, { Ime: "  Марко&nbsp; Марковски &#40;Скопје&#41; " }, { VnatresenID: "" },
  ];
  for (const c of cases) {
    it(JSON.stringify(c), () => {
      const r = reg(c);
      expect(registerCard(r)).toEqual(komitentCard(asRow(r)));
    });
  }
  it("the source tag is the harvest's day", () => {
    expect(registerSource("2026-10-01")).toBe("register_20261001");
    expect(() => registerSource("01.10.2026")).toThrow();
  });
});

describe("the plan loads only what is missing", () => {
  const D = (o: Record<string, unknown>) => ({ dn: "002-9110-1/2026", t: "10111", k: "1", sd: "2026-10-02", o: "credit_pending", dead: false,
    c1: false, c2: false, c3: false, cc_row: false, ...o });
  const register = new Map<string, Reg>([
    ["1", reg({ Sifra: "1", Mobilen: "070111222" })],
    ["2", reg({ Sifra: "2", Mobilen: "070111223" })],
    ["45003", reg({ Sifra: "45003", Mobilen: "070111224", Vraboten: "Да" })],   // a current-register employee
    ["4", reg({ Sifra: "4", Mobilen: "+40 721 234 567" })],
    ["5", reg({ Sifra: "5", Mobilen: "070123456" })],
    ["6", reg({ Sifra: "6", Mobilen: "070111225" })],
  ]);
  const docs = [
    D({ dn: "a", k: "1" }), D({ dn: "a2", k: "1", t: "10114", sd: "2026-09-10" }),   // missing → load (one komitent, two documents)
    D({ dn: "b", k: "2", c2: true }),                                                  // the teleshop registry has a phone
    D({ dn: "c", k: "45003" }),                                                        // employee → never loaded
    D({ dn: "d", k: "4" }),                                                            // foreign number → NULL, never invented
    D({ dn: "e", k: "5" }),                                                            // a test phone
    D({ dn: "f", k: "6", cc_row: true }),                                              // a row exists → never overwritten
    D({ dn: "g", k: "7" }),                                                            // not in the register (new customer)
  ];
  const p = plan({ docs, register, testPhones: new Set(["70123456"]) });
  it("komitenti and their verdicts", () => {
    expect(p.rows.map((r: { komitent_id: string }) => r.komitent_id)).toEqual(["1"]);
    expect(p.verdicts).toEqual({ load: 1, skip_employee: 1, no_valid_phone_foreign: 1, test_phone: 1, has_row_without_phone: 1, not_in_register: 1 });
    expect(p.docsGet).toBe(2);
    expect(p.docsByType).toEqual({ "10111": 1, "10114": 1 });
    expect(p.docsByMonth).toEqual({ "2026-09": 1, "2026-10": 1 });
    expect(planLines(p.rows)).toEqual(["1:70111222"]);
    expect(p.stillMissing("2026-10-01")).toMatchObject({ "10111 · not_in_register": 1 });
  });
  it("the insert never overwrites and re-checks the phone", () => {
    const s = applySql({ rows: p.rows, source: "register_20261001", runId: "00000000-0000-4000-8000-000000000001",
      actor: { id: "00000000-0000-4000-8000-000000000002", email: "x@y" }, summary: {} });
    expect(s).toContain("on conflict (komitent_id) do nothing");
    expect(s).toContain("public.collabbox_mk_phone8(x.phone8) is not null");
    expect(s).toContain("'register_20261001'");
    expect(() => applySql({ rows: [], source: "card", runId: "00000000-0000-4000-8000-000000000001", actor: { id: "00000000-0000-4000-8000-000000000002", email: "x" }, summary: {} })).toThrow();
  });
});
