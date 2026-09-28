import { describe, expect, it } from "vitest";
import { isTestOrder, TEST_PHONE8 } from "./altercpa.ts";
import type { AlterCpaOrder } from "./altercpa.ts";

const lead = (name: string, phone: string) => ({ id: 1, name, phone } as unknown as AlterCpaOrder);

describe("isTestOrder — the owner's test phones (28.09.2026)", () => {
  it("catches both test numbers in every spelling, on the last 8 digits", () => {
    for (const phone of ["070123456", "+38970123456", "389 70 123 456", "70123456",
                         "23123123", "023123123", "+38923123123", "(02) 3123-123"]) {
      expect(isTestOrder(lead("Марија Петровска", phone))).toBe(true);
    }
    expect([...TEST_PHONE8].sort()).toEqual(["23123123", "70123456"]);
  });

  it("leaves real customers alone (a near miss is not a test)", () => {
    for (const phone of ["070123457", "071123456", "+38975123456", "23123124", "", "0701234"]) {
      expect(isTestOrder(lead("Марија Петровска", phone))).toBe(false);
    }
  });

  it("still catches the smoke-test names", () => {
    expect(isTestOrder(lead("Test Ninja", "+38975111222"))).toBe(true);
    expect(isTestOrder(lead("Пробный_Заказ", "+38975111222"))).toBe(true);
  });
});
