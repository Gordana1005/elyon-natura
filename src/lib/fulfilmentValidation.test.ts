import { describe, it, expect } from "vitest";
import { validateOrderForFulfilment } from "@/lib/fulfilmentValidation";

// A fully complete home (door) order — the baseline every test mutates.
const validHome = {
  id: "1",
  display_id: "1001",
  customer_name: "Иван Петров",
  customer_phone: "+38970123456",
  postal_code: "1000",
  price: 25,
  product_name: "Колаген",
  quantity: 1,
  delivery_type: "home",
  street: "ул. Партизански одреди",
  street_number: "18",
  customer_city: "Скопје",
  // Resolved server-side from the settlement. Without it the order cannot be
  // handed to MEX at all, so it is part of a complete order.
  mex_city_id: 185,
};

const validOffice = {
  id: "2",
  display_id: "1002",
  customer_name: "Мария Иванова",
  customer_phone: "+38970765432",
  postal_code: "4000",
  price: 40,
  order_items: [{ product_name: "Крем", quantity: 2 }],
  delivery_type: "mex_office",
  courier_office_code: "1234",
  courier_office_name: "МЕКС Визбегово",
  courier_office_city: "Скопје",
  mex_city_id: 185,
};

// A Bulgarian office order inherited from the fork. It must still validate —
// 80.388 orders hold the legacy delivery types.
const legacyEcontOffice = {
  ...validOffice,
  id: "3",
  display_id: "1003",
  delivery_type: "econt_office",
  courier_office_name: "Еконт Младост",
};

describe("validateOrderForFulfilment", () => {
  it("passes a complete home order", () => {
    expect(validateOrderForFulfilment(validHome).ok).toBe(true);
  });

  it("passes a complete office order", () => {
    expect(validateOrderForFulfilment(validOffice).ok).toBe(true);
  });

  it("passes a home order whose number is stuck in the street (auto-split)", () => {
    const r = validateOrderForFulfilment({ ...validHome, street: "Гоце Делчев 18", street_number: "" });
    expect(r.ok).toBe(true);
  });

  it("passes a quarter + block home order with no street", () => {
    const r = validateOrderForFulfilment({ ...validHome, street: "", street_number: "", quarter: "ж.к. Люлин 3", block: "12" });
    expect(r.ok).toBe(true);
  });

  it("treats a missing delivery_type as a home order", () => {
    const { delivery_type, ...noType } = validHome;
    expect(validateOrderForFulfilment(noType).ok).toBe(true);
  });

  it("flags a single-word name (needs first + last)", () => {
    expect(validateOrderForFulfilment({ ...validHome, customer_name: "Иван" }).missing).toContain("name");
  });

  it("flags an invalid / missing phone", () => {
    expect(validateOrderForFulfilment({ ...validHome, customer_phone: "123" }).missing).toContain("phone");
    expect(validateOrderForFulfilment({ ...validHome, customer_phone: "" }).missing).toContain("phone");
  });

  it("flags a missing / non-4-digit postal code", () => {
    expect(validateOrderForFulfilment({ ...validHome, postal_code: "" }).missing).toContain("postal_code");
    expect(validateOrderForFulfilment({ ...validHome, postal_code: "12" }).missing).toContain("postal_code");
  });

  it("flags a missing product / zero quantity", () => {
    expect(validateOrderForFulfilment({ ...validHome, product_name: "", quantity: 0 }).missing).toContain("product");
    expect(validateOrderForFulfilment({ ...validOffice, order_items: [{ product_name: "X", quantity: 0 }] }).missing).toContain("product");
  });

  it("flags a non-positive price", () => {
    expect(validateOrderForFulfilment({ ...validHome, price: 0 }).missing).toContain("price");
  });

  it("flags a home order missing the house number specifically", () => {
    const r = validateOrderForFulfilment({ ...validHome, street: "Гоце Делчев", street_number: "" });
    expect(r.missing).toContain("house_number");
  });

  it("flags a home order with no usable address at all", () => {
    const r = validateOrderForFulfilment({ ...validHome, street: "", street_number: "", customer_address: "" });
    expect(r.missing).toContain("address");
  });

  it("flags an office order missing its office", () => {
    expect(validateOrderForFulfilment({ ...validOffice, courier_office_code: "" }).missing).toContain("office");
  });

  it("surfaces a single data_hidden issue when the address is masked", () => {
    const r = validateOrderForFulfilment({ ...validHome, street: "•••", customer_address: "•••" });
    expect(r.missing).toEqual(["data_hidden"]);
  });

  it("holds back a value-hidden row (no price for this viewer) — never an Otkup of 0", () => {
    const { price: _p, ...noPrice } = validHome;
    const r = validateOrderForFulfilment({ ...noPrice, value_hidden: true });
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(["data_hidden"]);
  });
});

describe("MEX delivery zone", () => {
  it("holds back an order with no MEX zone", () => {
    // add_shipment.php routes on receiver_city_id alone — no postcode field and
    // a free-text address — so a missing zone means the parcel cannot be sent.
    // It must never be guessed: MEX has no cancellation endpoint.
    const { mex_city_id, ...noZone } = validHome;
    const r = validateOrderForFulfilment(noZone);
    expect(r.ok).toBe(false);
    expect(r.missing).toContain("mex_city");
  });

  it("holds back a zone of 0 or null", () => {
    expect(validateOrderForFulfilment({ ...validHome, mex_city_id: null }).missing).toContain("mex_city");
    expect(validateOrderForFulfilment({ ...validHome, mex_city_id: 0 }).missing).toContain("mex_city");
  });

  it("still validates a legacy Bulgarian office order", () => {
    expect(validateOrderForFulfilment(legacyEcontOffice).ok).toBe(true);
  });
});
