import { describe, expect, it } from "vitest";
import {
  ACCESS_LEVELS, STAFF_LEVELS, accessSetErrorCode, canReadAccess, canWriteAccess, fallbackLevel, isLastSuperAdmin,
  normalizeDepts, shapeAccessPeople, validateAccessPut, type AccessListInput,
} from "./accessAdmin.ts";

const STAFF = { roles: ["manager", "pending_agent"] };
const PARTNER = { roles: ["affiliate"] };

describe("who reads / writes Пристап и улоги", () => {
  it("reads: super_admin and owner with an active profile (can_see_margins)", () => {
    expect(canReadAccess("super_admin", true)).toBe(true);
    expect(canReadAccess("owner", true)).toBe(true);
    expect(canReadAccess("finance", true)).toBe(false);
    expect(canReadAccess("administrator", false)).toBe(false);
    expect(canReadAccess("dept_admin", false)).toBe(false);
    // a suspended super admin keeps the level but can_see_margins is false
    expect(canReadAccess("super_admin", false)).toBe(false);
    expect(canReadAccess(null, true)).toBe(false);
  });

  it("writes: super_admin only", () => {
    expect(canWriteAccess("super_admin", true)).toBe(true);
    expect(canWriteAccess("owner", true)).toBe(false);
    expect(canWriteAccess("super_admin", false)).toBe(false);
  });

  it("staff levels never include partner", () => {
    expect(STAFF_LEVELS).toEqual(ACCESS_LEVELS.filter((l) => l !== "partner"));
    expect(STAFF_LEVELS).not.toContain("partner");
  });
});

describe("the no-row rule (access_level)", () => {
  it("business_owners → owner, active admin → administrator, manager → team_lead, …", () => {
    expect(fallbackLevel({ roles: ["manager"], isActive: true, onOwnersList: true })).toBe("owner");
    expect(fallbackLevel({ roles: ["admin", "manager"], isActive: true, onOwnersList: false })).toBe("administrator");
    expect(fallbackLevel({ roles: ["admin"], isActive: false, onOwnersList: false })).toBe("operator");
    expect(fallbackLevel({ roles: ["manager", "pending_agent"], isActive: true, onOwnersList: false })).toBe("team_lead");
    expect(fallbackLevel({ roles: ["warehouse"], isActive: true, onOwnersList: false })).toBe("warehouse");
    expect(fallbackLevel({ roles: ["warehouse", "pending_agent"], isActive: true, onOwnersList: false })).toBe("operator");
    expect(fallbackLevel({ roles: ["affiliate"], isActive: true, onOwnersList: false })).toBe("partner");
    expect(fallbackLevel({ roles: [], isActive: true, onOwnersList: false })).toBe("operator");
  });
});

describe("validateAccessPut — access_write's refusals, before the SQL", () => {
  it("normalizes departments: trimmed, lower-case, distinct, display order", () => {
    expect(normalizeDepts([" Social ", "teleshop_out", "social", "", null])).toEqual({ depts: ["teleshop_out", "social"], unknown: [] });
    expect(normalizeDepts(["altercpa", "bogus"])).toEqual({ depts: ["altercpa"], unknown: ["bogus"] });
  });

  it("accepts a dept_admin with Тим Центар's three departments", () => {
    const r = validateAccessPut({ level: "dept_admin", departments: ["social", "teleshop_other", "teleshop_out"], note: " Тим Центар " }, STAFF);
    expect(r).toEqual({ ok: true, value: { level: "dept_admin", departments: ["teleshop_out", "teleshop_other", "social"], note: "Тим Центар" } });
  });

  it("note: omitted = keep (undefined), null = clear, too long refused", () => {
    expect(validateAccessPut({ level: "administrator", departments: [] }, STAFF)).toMatchObject({ ok: true, value: { note: undefined } });
    expect(validateAccessPut({ level: "administrator", departments: [], note: null }, STAFF)).toMatchObject({ ok: true, value: { note: "" } });
    expect(validateAccessPut({ level: "administrator", note: "x".repeat(501) }, STAFF)).toEqual({ ok: false, error: "note_too_long" });
  });

  it("refuses an unknown level or department", () => {
    expect(validateAccessPut({ level: "emperor" }, STAFF)).toEqual({ ok: false, error: "invalid_level" });
    expect(validateAccessPut({ level: "dept_admin", departments: ["altercpa", "mars"] }, STAFF)).toEqual({ ok: false, error: "invalid_department" });
  });

  it("a dept_admin needs a department; departments only for dept_admin / team_lead", () => {
    expect(validateAccessPut({ level: "dept_admin", departments: [] }, STAFF)).toEqual({ ok: false, error: "dept_required" });
    expect(validateAccessPut({ level: "administrator", departments: ["web"] }, STAFF)).toEqual({ ok: false, error: "depts_not_allowed" });
    expect(validateAccessPut({ level: "team_lead", departments: ["altercpa", "elyon_crm"] }, STAFF))
      .toEqual({ ok: true, value: { level: "team_lead", departments: ["altercpa", "elyon_crm"], note: undefined } });
    expect(validateAccessPut({ level: "team_lead", departments: [] }, STAFF)).toMatchObject({ ok: true });
  });

  it("the partner wall both ways", () => {
    expect(validateAccessPut({ level: "partner" }, STAFF)).toEqual({ ok: false, error: "partner_only_for_affiliates" });
    expect(validateAccessPut({ level: "operator" }, PARTNER)).toEqual({ ok: false, error: "partner_login" });
    expect(validateAccessPut({ level: "partner" }, PARTNER)).toMatchObject({ ok: true });
  });
});

describe("the last super admin", () => {
  const people = [
    { user_id: "a", level: "super_admin", explicit: true },
    { user_id: "b", level: "owner", explicit: true },
    { user_id: "c", level: "administrator", explicit: false },
  ];
  it("is the only active super admin", () => {
    expect(isLastSuperAdmin(people, "a")).toBe(true);
    expect(isLastSuperAdmin(people, "b")).toBe(false);
    expect(isLastSuperAdmin(people, "nobody")).toBe(false);
  });
  it("is not last when another explicit, active super admin exists", () => {
    const two = [...people, { user_id: "d", level: "super_admin", explicit: true }];
    expect(isLastSuperAdmin(two, "a")).toBe(false);
    expect(isLastSuperAdmin([...people, { user_id: "d", level: "super_admin", explicit: true, is_active: false }], "a")).toBe(true);
  });
});

describe("access_set errors → codes", () => {
  it("maps the SQL exceptions", () => {
    expect(accessSetErrorCode("refused: Mile Stoev is the last active super admin")).toEqual({ code: "last_super_admin", status: 422 });
    expect(accessSetErrorCode("only a super admin sets access levels")).toEqual({ code: "super_admins_only", status: 403 });
    expect(accessSetErrorCode("a dept_admin needs at least one department")).toEqual({ code: "dept_required", status: 400 });
    expect(accessSetErrorCode("departments apply only to dept_admin / team_lead (level owner)")).toEqual({ code: "depts_not_allowed", status: 400 });
    expect(accessSetErrorCode("an affiliate (partner) login can only hold level partner")).toEqual({ code: "partner_login", status: 422 });
    expect(accessSetErrorCode("level partner is only for affiliate (partner) logins")).toEqual({ code: "partner_only_for_affiliates", status: 400 });
    expect(accessSetErrorCode('unknown level "x" (one of …)')).toEqual({ code: "invalid_level", status: 400 });
    expect(accessSetErrorCode("unknown department(s) mars")).toEqual({ code: "invalid_department", status: 400 });
    expect(accessSetErrorCode("no profile for user 123")).toEqual({ code: "unknown_user", status: 404 });
    expect(accessSetErrorCode("connection reset")).toBeNull();
    expect(accessSetErrorCode(null)).toBeNull();
  });
});

describe("shapeAccessPeople — the GET list", () => {
  const input: AccessListInput = {
    profiles: [
      { user_id: "u-mile", full_name: "Mile Stoev", email: "mile@x", is_active: true },
      { user_id: "u-nina", full_name: "Nina", email: "nina@x", is_active: true },
      { user_id: "u-teo", full_name: "Teodora Krstevska", email: "teo@x", is_active: true },
      { user_id: "u-agent", full_name: "Ana", email: "ana@x", is_active: true },
      { user_id: "u-old", full_name: "Old Admin", email: "old@x", is_active: false },
      { user_id: "u-wm", full_name: "Webmaster", email: "wm@x", is_active: true },
      { user_id: "u-boss", full_name: "Boss", email: "boss@x", is_active: true },
    ],
    roles: [
      { user_id: "u-mile", role: "admin" }, { user_id: "u-nina", role: "admin" },
      { user_id: "u-teo", role: "manager" }, { user_id: "u-teo", role: "pending_agent" },
      { user_id: "u-agent", role: "pending_agent" }, { user_id: "u-old", role: "admin" },
      { user_id: "u-wm", role: "affiliate" }, { user_id: "u-boss", role: "manager" },
    ],
    access: [
      { user_id: "u-mile", level: "super_admin", note: null, updated_at: "2026-10-02T18:00:00Z", updated_by: "u-mile" },
      { user_id: "u-nina", level: "administrator", note: null, updated_at: "2026-10-02T18:00:00Z", updated_by: "u-mile" },
      { user_id: "u-teo", level: "dept_admin", note: "Тим Центар", updated_at: "2026-10-02T18:00:00Z", updated_by: "u-gone" },
      { user_id: "u-old", level: "super_admin", note: null, updated_at: null, updated_by: null },
    ],
    departments: [
      { user_id: "u-teo", dept: "social", valid_to: null },
      { user_id: "u-teo", dept: "teleshop_out", valid_to: null },
      { user_id: "u-teo", dept: "altercpa", valid_to: "2026-10-01" },
    ],
    owners: [{ user_id: "u-boss" }],
    names: { "u-mile": "Mile Stoev" },
  };
  const people = shapeAccessPeople(input);

  it("lists active staff only (no inactive, no affiliate-only partner), by level then name", () => {
    expect(people.map((p) => p.user_id)).toEqual(["u-mile", "u-boss", "u-nina", "u-teo", "u-agent"]);
  });

  it("explicit rows vs the no-row rule", () => {
    const by = Object.fromEntries(people.map((p) => [p.user_id, p]));
    expect(by["u-mile"]).toMatchObject({ level: "super_admin", explicit: true, updated_by_name: "Mile Stoev" });
    expect(by["u-boss"]).toMatchObject({ level: "owner", explicit: false, note: null, updated_at: null });
    expect(by["u-agent"]).toMatchObject({ level: "operator", explicit: false });
    expect(by["u-teo"]).toMatchObject({ level: "dept_admin", departments: ["teleshop_out", "social"], note: "Тим Центар", updated_by_name: null });
  });

  it("flags the last active super admin (an inactive super admin does not count)", () => {
    expect(people.filter((p) => p.last_super_admin).map((p) => p.user_id)).toEqual(["u-mile"]);
  });
});
