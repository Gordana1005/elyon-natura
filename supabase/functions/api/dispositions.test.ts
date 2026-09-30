import { describe, expect, it } from "vitest";
import { isSyntheticProductName, needsServerProduct, productFromLastSale } from "./dispositions.ts";

describe("isSyntheticProductName", () => {
  it("flags the placeholders and blanks", () => {
    for (const n of ["", "  ", "—", null, undefined, "No prior product on file", "Cancelled — x", "trashed"]) {
      expect(isSyntheticProductName(n as any)).toBe(true);
    }
  });
  it("keeps real products", () => {
    expect(isSyntheticProductName("Neurofix")).toBe(false);
    expect(isSyntheticProductName("КУРКУМА АКТИВ, ВИТАМИН Б6 365/1 таб")).toBe(false);
  });
});

describe("needsServerProduct", () => {
  it("fills a cancel/trash record that has no items and a placeholder", () => {
    expect(needsServerProduct({ status: "cancelled", hasItems: false, productName: "No prior product on file" })).toBe(true);
    expect(needsServerProduct({ status: "trashed", hasItems: false, productName: "" })).toBe(true);
  });
  it("never touches real orders, item orders or a real product name", () => {
    expect(needsServerProduct({ status: "confirmed", hasItems: false, productName: "No prior product on file" })).toBe(false);
    expect(needsServerProduct({ status: "cancelled", hasItems: true, productName: "No prior product on file" })).toBe(false);
    expect(needsServerProduct({ status: "cancelled", hasItems: false, productName: "Neurofix" })).toBe(false);
  });
});

describe("productFromLastSale", () => {
  it("returns the sale's product", () => {
    expect(productFromLastSale({ product_id: "p1", product_name: "Parafix" })).toEqual({ productId: "p1", productName: "Parafix" });
    expect(productFromLastSale({ product_id: null, product_name: "Hemorofix, Veno Gel" })).toEqual({ productId: null, productName: "Hemorofix, Veno Gel" });
  });
  it("no sale or a placeholder → keep what the client sent", () => {
    expect(productFromLastSale(null)).toBeNull();
    expect(productFromLastSale({ product_id: null, product_name: "No prior product on file" })).toBeNull();
    expect(productFromLastSale({ product_id: null, product_name: " " })).toBeNull();
  });
});
