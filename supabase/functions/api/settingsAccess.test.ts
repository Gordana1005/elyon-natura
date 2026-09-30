import { describe, expect, it } from "vitest";
import {
  buildSettingsMeta, DEAD_MODULES, EDITABLE_ROLES, moduleRefusal, nextPermission, ownerRemovalBlocked,
  parseCourierRates, parseModulePut, parsePermissionPut, parsePrivacyPut, PRIVACY_FLAGS, statusForSettingsCode,
} from "./settingsAccess.ts";

describe("parseModulePut", () => {
  it("accepts a module key and a boolean", () => {
    expect(parseModulePut({ module_key: "webhooks", is_enabled: false })).toEqual({ ok: true, value: { module_key: "webhooks", is_enabled: false } });
    expect(parseModulePut({ module_key: " orders ", is_enabled: true })).toEqual({ ok: true, value: { module_key: "orders", is_enabled: true } });
  });
  it("refuses a bad body, a bad key, a non-boolean and a dead module", () => {
    expect(parseModulePut(null)).toEqual({ ok: false, error: "invalid_body" });
    expect(parseModulePut([])).toEqual({ ok: false, error: "invalid_body" });
    expect(parseModulePut({ module_key: "Orders; drop", is_enabled: true })).toEqual({ ok: false, error: "invalid_module" });
    expect(parseModulePut({ module_key: "orders", is_enabled: "false" })).toEqual({ ok: false, error: "invalid_value" });
    for (const m of DEAD_MODULES) expect(parseModulePut({ module_key: m, is_enabled: false })).toEqual({ ok: false, error: "dead_module" });
  });
});

describe("moduleRefusal", () => {
  it("refuses unknown and protected modules (by list or by the row's flag)", () => {
    expect(moduleRefusal(null)).toBe("unknown_module");
    expect(moduleRefusal({ module_key: "settings", is_protected: false })).toBe("protected_module");
    expect(moduleRefusal({ module_key: "dashboard" })).toBe("protected_module");
    expect(moduleRefusal({ module_key: "voip_health", is_protected: true })).toBe("protected_module");
    expect(moduleRefusal({ module_key: "webhooks", is_protected: false })).toBeNull();
  });
});

describe("parsePermissionPut", () => {
  it("takes view and/or edit for an editable role", () => {
    expect(parsePermissionPut({ role: "manager", module_key: "orders", can_edit: true }))
      .toEqual({ ok: true, value: { role: "manager", module_key: "orders", can_edit: true } });
    expect(parsePermissionPut({ role: "warehouse", module_key: "products", can_view: false, can_edit: false }))
      .toEqual({ ok: true, value: { role: "warehouse", module_key: "products", can_view: false, can_edit: false } });
  });
  it("never edits admin, affiliate or the Bulgarian roles", () => {
    for (const role of ["admin", "affiliate", "agent", "inbound_agent", "", 42]) {
      expect(parsePermissionPut({ role, module_key: "orders", can_view: true })).toEqual({ ok: false, error: "role_not_editable" });
    }
    expect(EDITABLE_ROLES).not.toContain("admin");
  });
  it("refuses the columns nothing reads, non-booleans, an empty patch and dead modules", () => {
    expect(parsePermissionPut({ role: "manager", module_key: "orders", can_delete: true })).toEqual({ ok: false, error: "invalid_flag" });
    expect(parsePermissionPut({ role: "manager", module_key: "orders", can_view: 1 })).toEqual({ ok: false, error: "invalid_value" });
    expect(parsePermissionPut({ role: "manager", module_key: "orders" })).toEqual({ ok: false, error: "invalid_value" });
    expect(parsePermissionPut({ role: "manager", module_key: "ads", can_view: true })).toEqual({ ok: false, error: "dead_module" });
    expect(parsePermissionPut({ role: "manager", module_key: "", can_view: true })).toEqual({ ok: false, error: "invalid_module" });
  });
});

describe("nextPermission", () => {
  it("edit implies view; no view clears edit", () => {
    expect(nextPermission(null, { can_edit: true })).toEqual({ can_view: true, can_edit: true });
    expect(nextPermission({ can_view: true, can_edit: true }, { can_view: false })).toEqual({ can_view: false, can_edit: false });
    expect(nextPermission({ can_view: true, can_edit: false }, { can_edit: true })).toEqual({ can_view: true, can_edit: true });
    expect(nextPermission({ can_view: true, can_edit: true }, { can_edit: false })).toEqual({ can_view: true, can_edit: false });
    expect(nextPermission(null, { can_view: true })).toEqual({ can_view: true, can_edit: false });
  });
});

describe("parsePrivacyPut", () => {
  it("takes one of the five customer flags", () => {
    for (const flag of PRIVACY_FLAGS) {
      expect(parsePrivacyPut({ role: "pending_agent", flag, value: false })).toEqual({ ok: true, value: { role: "pending_agent", flag, value: false } });
    }
  });
  it("refuses the recording columns (VOIP is off), admin, and non-booleans", () => {
    expect(parsePrivacyPut({ role: "manager", flag: "can_hear_recordings", value: true })).toEqual({ ok: false, error: "invalid_flag" });
    expect(parsePrivacyPut({ role: "manager", flag: "can_hear_own_recordings", value: true })).toEqual({ ok: false, error: "invalid_flag" });
    expect(parsePrivacyPut({ role: "admin", flag: "show_customer_phone", value: false })).toEqual({ ok: false, error: "role_not_editable" });
    expect(parsePrivacyPut({ role: "manager", flag: "show_customer_phone", value: "yes" })).toEqual({ ok: false, error: "invalid_value" });
    expect(parsePrivacyPut("x")).toEqual({ ok: false, error: "invalid_body" });
  });
});

describe("statusForSettingsCode", () => {
  it("maps codes to HTTP", () => {
    expect(statusForSettingsCode("admins_only")).toBe(403);
    expect(statusForSettingsCode("unknown_module")).toBe(404);
    expect(statusForSettingsCode("protected_module")).toBe(422);
    expect(statusForSettingsCode("role_not_editable")).toBe(422);
    expect(statusForSettingsCode("invalid_value")).toBe(400);
    expect(statusForSettingsCode("whatever")).toBe(400);
  });
});

describe("buildSettingsMeta", () => {
  const names = { u1: "Миле", u2: "Хеди" };
  it("names the person from the row, or from the audit row the row does not name", () => {
    const meta = buildSettingsMeta(
      [
        { key: "personal_list_max_holds", updated_at: "2026-06-30T10:10:36Z", updated_by: null },
        { key: "altercpa_push_enabled", updated_at: "2026-08-17T09:21:36Z", updated_by: "u1" },
        { key: "unpaid_chase_days", updated_at: "2026-10-01T08:00:00Z", updated_by: null },
      ],
      [
        { action: "settings.app_settings", actor_id: "u2", target_id: "unpaid_chase_days", created_at: "2026-10-01T08:00:01Z" },
        { action: "settings.module_toggle", actor_id: "u1", target_id: "webhooks", created_at: "2026-09-30T10:00:00Z" },
        { action: "settings.module_toggle", actor_id: "u2", target_id: "orders", created_at: "2026-10-01T10:00:00Z" },
      ],
      names,
    );
    expect(meta.app_settings.personal_list_max_holds).toEqual({ at: "2026-06-30T10:10:36Z", by: null, by_name: null });
    expect(meta.app_settings.altercpa_push_enabled.by_name).toBe("Миле");
    expect(meta.app_settings.unpaid_chase_days.by_name).toBe("Хеди");
    expect(meta.audit["settings.module_toggle"]).toEqual({ at: "2026-10-01T10:00:00Z", by: "u2", by_name: "Хеди", target: "orders" });
  });
  it("an older audit row never overwrites a newer, named write", () => {
    const meta = buildSettingsMeta(
      [{ key: "altercpa_push_enabled", updated_at: "2026-09-01T00:00:00Z", updated_by: "u1" }],
      [{ action: "settings.altercpa_push_toggle", actor_id: "u2", target_id: "altercpa_push_enabled", created_at: "2026-08-01T00:00:00Z" }],
      names,
    );
    expect(meta.app_settings.altercpa_push_enabled).toEqual({ at: "2026-09-01T00:00:00Z", by: "u1", by_name: "Миле" });
  });
});

describe("ownerRemovalBlocked", () => {
  it("blocks only when nobody would see money any more", () => {
    expect(ownerRemovalBlocked({ listCountBefore: 1, activeAdmins: 10 })).toBe(false);
    expect(ownerRemovalBlocked({ listCountBefore: 2, activeAdmins: 0 })).toBe(false);
    expect(ownerRemovalBlocked({ listCountBefore: 1, activeAdmins: 0 })).toBe(true);
  });
});

describe("parseCourierRates", () => {
  it("accepts MEX (the carrier) with 4-decimal EUR", () => {
    expect(parseCourierRates({ rates: [{ courier: "mex", service: "door", deliver_cost: 150 / 61.5, return_cost: 0 }] }))
      .toEqual({ ok: true, value: [{ courier: "mex", service: "door", deliver_cost: 2.439, return_cost: 0 }] });
  });
  it("refuses unknown couriers, negative or absurd amounts and empty bodies", () => {
    expect(parseCourierRates({ rates: [] })).toEqual({ ok: false, error: "invalid_body" });
    expect(parseCourierRates({ rates: [{ courier: "dhl", service: "door", deliver_cost: 1, return_cost: 0 }] })).toEqual({ ok: false, error: "invalid_courier" });
    expect(parseCourierRates({ rates: [{ courier: "mex", service: "door", deliver_cost: -1, return_cost: 0 }] })).toEqual({ ok: false, error: "invalid_value" });
    expect(parseCourierRates({ rates: [{ courier: "mex", service: "door", deliver_cost: 150, return_cost: 0 }] })).toEqual({ ok: false, error: "invalid_value" });
  });
});
