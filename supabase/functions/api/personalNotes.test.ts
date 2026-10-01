import { describe, expect, it } from "vitest";
import {
  LIMITS, auditNotePayload, auditViewedOther, canRead, canWrite, charLength, daysLeft, errorBody,
  escapeIlike, isRestorable, orIlike, parseNoteBody, parseNotePatch, parseNotebookBody, parseQuery,
  pgrstQuote, reorder, shapeAuthors, shapeNoteListItem, snippet, sortNotes, statusFor, versionedPatch,
  visibleAuthors,
} from "./personalNotes.ts";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const D = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const agent = { id: A, isAdmin: false, isManager: false };
const manager = { id: B, isAdmin: false, isManager: true };
const admin = { id: C, isAdmin: true, isManager: false };

describe("canRead / canWrite — the owner's rules", () => {
  it("the operator reads and writes their own", () => {
    expect(canRead(agent, { id: A, isAdmin: false })).toBe(true);
    expect(canWrite(agent, A)).toBe(true);
  });
  it("an agent never reads someone else's", () => {
    expect(canRead(agent, { id: D, isAdmin: false })).toBe(false);
    expect(canRead(agent, { id: C, isAdmin: true })).toBe(false);
  });
  it("a manager reads operators and other managers — never an admin", () => {
    expect(canRead(manager, { id: A, isAdmin: false })).toBe(true);
    expect(canRead(manager, { id: D, isAdmin: false })).toBe(true);
    expect(canRead(manager, { id: C, isAdmin: true })).toBe(false);
  });
  it("an admin reads everyone's, admins included", () => {
    expect(canRead(admin, { id: A, isAdmin: false })).toBe(true);
    expect(canRead(admin, { id: D, isAdmin: true })).toBe(true);
  });
  it("an admin (or manager) holding the admin role still reads their own", () => {
    expect(canRead({ id: C, isAdmin: true, isManager: true }, { id: C, isAdmin: true })).toBe(true);
  });
  it("nobody but the operator writes — not a manager, not an admin", () => {
    expect(canWrite(manager, A)).toBe(false);
    expect(canWrite(admin, A)).toBe(false);
    expect(canWrite(admin, null)).toBe(false);
    expect(canWrite({ id: "" }, "")).toBe(false);
  });
  it("visibleAuthors: managers do not see admins, nobody sees themselves", () => {
    const rows = [
      { owner_id: A, is_admin: false }, { owner_id: B, is_admin: false },
      { owner_id: C, is_admin: true }, { owner_id: D, is_admin: true },
    ];
    expect(visibleAuthors(manager, rows).map((r) => r.owner_id)).toEqual([A]);
    expect(visibleAuthors(admin, rows).map((r) => r.owner_id)).toEqual([A, B, D]);
    expect(visibleAuthors(agent, rows)).toEqual([]);
  });
});

describe("parseNotebookBody", () => {
  it("trims and folds the title, requires 1–80 characters", () => {
    expect(parseNotebookBody({ title: "  Клиенти   Скопје " }, "create")).toEqual({ ok: true, value: { title: "Клиенти Скопје" } });
    expect(parseNotebookBody({ title: "   " }, "create")).toEqual({ ok: false, error: "bad_title" });
    expect(parseNotebookBody({ title: "я".repeat(80) }, "create").ok).toBe(true);
    expect(parseNotebookBody({ title: "я".repeat(81) }, "create")).toEqual({ ok: false, error: "bad_title" });
    expect(parseNotebookBody({}, "create")).toEqual({ ok: false, error: "bad_title" });
  });
  it("colour: one of six, or null to clear", () => {
    expect(parseNotebookBody({ title: "x", color: "rose" }, "create")).toEqual({ ok: true, value: { title: "x", color: "rose" } });
    expect(parseNotebookBody({ color: null }, "patch")).toEqual({ ok: true, value: { color: null } });
    expect(parseNotebookBody({ color: "red" }, "patch")).toEqual({ ok: false, error: "bad_color" });
  });
  it("a patch needs something to change", () => {
    expect(parseNotebookBody({}, "patch")).toEqual({ ok: false, error: "nothing_to_change" });
    expect(parseNotebookBody(null, "patch")).toEqual({ ok: false, error: "nothing_to_change" });
  });
});

describe("parseNoteBody / parseNotePatch", () => {
  it("a blank note is a valid start", () => {
    expect(parseNoteBody({})).toEqual({ ok: true, value: { title: "", body: "", pinned: false } });
    expect(parseNoteBody(undefined)).toEqual({ ok: true, value: { title: "", body: "", pinned: false } });
  });
  it("trims the title, keeps the body's whitespace exactly", () => {
    const body = "  ред 1\n\n\tред 2  \n";
    expect(parseNoteBody({ title: "  Наслов ", body })).toEqual({ ok: true, value: { title: "Наслов", body, pinned: false } });
  });
  it("limits: title 120, body 20.000 (code points, like char_length)", () => {
    expect(parseNoteBody({ title: "a".repeat(121) })).toEqual({ ok: false, error: "bad_title" });
    expect(parseNoteBody({ body: "ж".repeat(LIMITS.body) }).ok).toBe(true);
    expect(parseNoteBody({ body: "ж".repeat(LIMITS.body + 1) })).toEqual({ ok: false, error: "bad_body" });
    expect(charLength("😀".repeat(3))).toBe(3);
    expect(parseNoteBody({ body: "😀".repeat(LIMITS.body) }).ok).toBe(true);
  });
  it("a patch needs base_version and at least one field", () => {
    expect(parseNotePatch({ body: "x" })).toEqual({ ok: false, error: "bad_version" });
    expect(parseNotePatch({ body: "x", base_version: 0 })).toEqual({ ok: false, error: "bad_version" });
    expect(parseNotePatch({ body: "x", base_version: 1.5 })).toEqual({ ok: false, error: "bad_version" });
    expect(parseNotePatch({ base_version: 3 })).toEqual({ ok: false, error: "nothing_to_change" });
    expect(parseNotePatch({ base_version: 3, body: "x ", title: " t ", pinned: true, notebook_id: B })).toEqual({
      ok: true, value: { base_version: 3, patch: { body: "x ", title: "t", pinned: true, notebook_id: B } },
    });
    expect(parseNotePatch({ base_version: 3, pinned: "yes" })).toEqual({ ok: false, error: "bad_pinned" });
    expect(parseNotePatch({ base_version: 3, notebook_id: "nope" })).toEqual({ ok: false, error: "bad_id" });
  });
  it("the versioned write moves the version by exactly one", () => {
    expect(versionedPatch({ body: "x" }, 7)).toEqual({ body: "x", version: 8 });
  });
});

describe("errors", () => {
  it("map to statuses and carry a stable code", () => {
    expect(statusFor("version_conflict")).toBe(409);
    expect(statusFor("notebook_limit")).toBe(409);
    expect(statusFor("note_limit")).toBe(409);
    expect(statusFor("forbidden")).toBe(403);
    expect(statusFor("not_found")).toBe(404);
    expect(statusFor("restore_expired")).toBe(410);
    expect(statusFor("rate_limited")).toBe(429);
    expect(errorBody("version_conflict", { current: { id: A } })).toEqual({
      error: "The note was changed in another window", code: "version_conflict", current: { id: A },
    });
    expect(errorBody("notebook_limit").error).toBe("At most 50 notebooks");
    expect(errorBody("note_limit").error).toBe("At most 500 notes in a notebook");
  });
});

describe("search helpers", () => {
  it("parseQuery: trim, fold, ≤ 100, empty = none", () => {
    expect(parseQuery("  a   b ")).toEqual({ ok: true, value: "a b" });
    expect(parseQuery("   ")).toEqual({ ok: true, value: null });
    expect(parseQuery(null)).toEqual({ ok: true, value: null });
    expect(parseQuery("x".repeat(101))).toEqual({ ok: false, error: "bad_query" });
  });
  it("escapeIlike makes % _ \\ literal", () => {
    expect(escapeIlike("50%_off\\x")).toBe("50\\%\\_off\\\\x");
  });
  it("orIlike quotes the pattern so commas / dots / parentheses stay literal", () => {
    expect(pgrstQuote('a"b\\c')).toBe('"a\\"b\\\\c"');
    expect(orIlike(["title", "body"], "д-р (Скопје), 5.")).toBe(
      'title.ilike."%д-р (Скопје), 5.%",body.ilike."%д-р (Скопје), 5.%"',
    );
    expect(orIlike(["title"], "100%")).toBe('title.ilike."%100\\\\%%"');
  });
  it("snippet: the start when short or unmatched, centred on the match otherwise", () => {
    expect(snippet("кратко\n\nтекст", null)).toBe("кратко текст");
    const long = `${"а".repeat(300)} КЛУЧ ${"б".repeat(300)}`;
    const s = snippet(long, "клуч", 160);
    expect(s).toContain("КЛУЧ");
    expect(s.startsWith("…") && s.endsWith("…")).toBe(true);
    expect(Array.from(s).length).toBeLessThanOrEqual(160);
    const head = snippet("x".repeat(500), "missing", 160);
    expect(head.endsWith("…")).toBe(true);
    expect(Array.from(head).length).toBe(160);
    const tail = snippet(`${"x".repeat(400)} крај`, "крај", 160);
    expect(tail.startsWith("…")).toBe(true);
    expect(tail.endsWith("крај")).toBe(true);
    expect(Array.from(tail).length).toBeLessThanOrEqual(160);
    const front = snippet(`почеток ${"x".repeat(400)}`, "почеток", 160);
    expect(front.startsWith("почеток")).toBe(true);
  });
});

describe("reorder", () => {
  const existing = [{ id: A, position: 0 }, { id: B, position: 1 }, { id: C, position: 2 }];
  it("returns only the positions that change", () => {
    expect(reorder([B, A, C], existing)).toEqual({
      ok: true, value: { order: [B, A, C], updates: [{ id: B, position: 0 }, { id: A, position: 1 }] },
    });
    expect(reorder([A, B, C], existing)).toEqual({ ok: true, value: { order: [A, B, C], updates: [] } });
  });
  it("keeps a notebook missing from the list (made in another tab) after the given ones", () => {
    const r = reorder([C, A], existing);
    expect(r.ok && r.value.order).toEqual([C, A, B]);
  });
  it("refuses duplicates, strangers and junk", () => {
    expect(reorder([A, A], existing)).toEqual({ ok: false, error: "bad_ids" });
    expect(reorder([A, D], existing)).toEqual({ ok: false, error: "bad_ids" });
    expect(reorder([], existing)).toEqual({ ok: false, error: "bad_ids" });
    expect(reorder("A,B", existing)).toEqual({ ok: false, error: "bad_ids" });
    expect(reorder(["x"], existing)).toEqual({ ok: false, error: "bad_ids" });
  });
});

describe("restore window", () => {
  const now = Date.parse("2026-10-31T12:00:00Z");
  it("30 days, then gone", () => {
    expect(isRestorable("2026-10-01T12:00:00Z", now)).toBe(true);
    expect(isRestorable("2026-10-01T11:59:00Z", now)).toBe(false);
    expect(isRestorable(null, now)).toBe(false);
    expect(daysLeft("2026-10-30T12:00:00Z", now)).toBe(29);
    expect(daysLeft("2026-10-01T12:00:00Z", now)).toBe(0);
  });
});

describe("shapes", () => {
  it("a list item carries a snippet and the size, never the body", () => {
    const item = shapeNoteListItem({ id: A, notebook_id: B, title: "t", body: "ред\nдва", pinned: true, updated_at: "2026-10-01T10:00:00Z", version: 4 }, null);
    expect(item).toEqual({ id: A, notebook_id: B, title: "t", snippet: "ред два", pinned: true, updated_at: "2026-10-01T10:00:00Z", version: 4, chars: 7 });
    expect("body" in item).toBe(false);
  });
  it("sortNotes: pinned first, then newest", () => {
    const rows = [
      { id: "1", pinned: false, updated_at: "2026-10-01T10:00:00Z" },
      { id: "2", pinned: true, updated_at: "2026-09-01T10:00:00Z" },
      { id: "3", pinned: false, updated_at: "2026-10-02T10:00:00Z" },
    ];
    expect(sortNotes(rows).map((r) => r.id)).toEqual(["2", "3", "1"]);
  });
  it("shapeAuthors: names, the inactive flag, managers never see admins, newest first", () => {
    const agg = [
      { owner_id: A, notebook_count: 2, note_count: 5, last_updated: "2026-10-01T09:00:00Z" },
      { owner_id: C, notebook_count: 1, note_count: 1, last_updated: "2026-10-01T11:00:00Z" },
      { owner_id: D, notebook_count: 1, note_count: 0, last_updated: "2026-10-01T10:00:00Z" },
    ];
    const profiles = new Map([
      [A, { full_name: "Ана", is_active: true }],
      [C, { full_name: "Админ", is_active: true }],
      [D, { full_name: null, email: "d@elyon-mk.local", is_active: false }],
    ]);
    const asManager = shapeAuthors(manager, agg, profiles, new Set([C]));
    expect(asManager.map((a) => a.name)).toEqual(["d@elyon-mk.local", "Ана"]);
    expect(asManager[0].is_active).toBe(false);
    const asAdmin = shapeAuthors({ id: B, isAdmin: true, isManager: false }, agg, profiles, new Set([C]));
    expect(asAdmin.map((a) => a.owner_id)).toEqual([C, D, A]);
  });
});

describe("audit payloads never carry the body", () => {
  it("note payload = ids, title, char count", () => {
    const p = auditNotePayload({ id: A, notebook_id: B, title: "т", body: "тајна содржина" });
    expect(p).toEqual({ note_id: A, notebook_id: B, title: "т", chars: 14 });
    expect(JSON.stringify(p)).not.toContain("тајна");
  });
  it("viewed_other names viewer, owner and notebook", () => {
    expect(auditViewedOther(B, A, { kind: "notes", notebook_id: C })).toEqual({ viewer: B, owner_id: A, kind: "notes", notebook_id: C });
    expect(auditViewedOther(B, A, { kind: "note", notebook_id: C, note_id: D })).toEqual({ viewer: B, owner_id: A, kind: "note", notebook_id: C, note_id: D });
  });
});
