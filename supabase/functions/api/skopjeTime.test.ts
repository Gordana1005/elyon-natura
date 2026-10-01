import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addDaysYmd, isValidYmd, skopjeBound, skopjeDayEndIso, skopjeDayRangeOf, skopjeDayStartOf, skopjeHour,
  skopjeMidnightIso, skopjeTodayYmd, skopjeWallToUtcMs, skopjeYmd,
} from "./skopjeTime.ts";

// Reference instants checked against PostgreSQL on the live MK database
// (`'…'::timestamp AT TIME ZONE 'Europe/Skopje'`, 01.10.2026):
//   2026-10-25 00:00 → 2026-10-24T22:00Z   (CEST, the 25-hour day begins)
//   2026-10-26 00:00 → 2026-10-25T23:00Z   (CET)
//   2026-03-29 00:00 → 2026-03-28T23:00Z   (CET, the 23-hour day begins)
//   2026-03-30 00:00 → 2026-03-29T22:00Z   (CEST)
//   2026-10-25 02:30 (twice) → 01:30Z (the later one) · 2026-03-29 02:30 (gap) → 01:30Z

/** Skopje wall time "YYYY-MM-DD HH:MM" → Date, for readable fixtures. */
const at = (iso: string) => new Date(iso);

describe("skopjeTime — today at the edges of the Skopje day", () => {
  it("00:30 Skopje is already the new day (the UTC date is still yesterday)", () => {
    // 00:30 CEST on 01.10.2026 = 22:30Z on 30.09
    const now = at("2026-09-30T22:30:00Z");
    expect(now.toISOString().slice(0, 10)).toBe("2026-09-30");     // the old, wrong answer
    expect(skopjeTodayYmd(now)).toBe("2026-10-01");
    expect(skopjeYmd(now)).toBe("2026-10-01");
    expect(skopjeHour(now)).toBe(0);
    expect(skopjeDayStartOf(now)).toEqual({ day: "2026-10-01", startISO: "2026-09-30T22:00:00.000Z" });
  });

  it("23:30 Skopje is still the same day", () => {
    const now = at("2026-10-01T21:30:00Z");   // 23:30 CEST
    expect(skopjeTodayYmd(now)).toBe("2026-10-01");
    expect(skopjeHour(now)).toBe(23);
    expect(skopjeDayStartOf(now).startISO).toBe("2026-09-30T22:00:00.000Z");
    expect(skopjeDayRangeOf(null, now)).toEqual({
      day: "2026-10-01", today: "2026-10-01",
      startISO: "2026-09-30T22:00:00.000Z", endISO: "2026-10-01T22:00:00.000Z",
    });
  });

  it("winter: 00:30 CET and 23:30 CET", () => {
    expect(skopjeTodayYmd(at("2026-11-09T23:30:00Z"))).toBe("2026-11-10");   // 00:30 CET
    expect(skopjeTodayYmd(at("2026-11-10T22:30:00Z"))).toBe("2026-11-10");   // 23:30 CET
    expect(skopjeMidnightIso("2026-11-10")).toBe("2026-11-09T23:00:00.000Z");
  });
});

describe("skopjeTime — DST changeover days are exact", () => {
  it("25.10.2026 is a 25-hour day", () => {
    const r = skopjeDayRangeOf("2026-10-25", at("2026-10-26T12:00:00Z"));
    expect(r.startISO).toBe("2026-10-24T22:00:00.000Z");
    expect(r.endISO).toBe("2026-10-25T23:00:00.000Z");
    expect((Date.parse(r.endISO) - Date.parse(r.startISO)) / 3_600_000).toBe(25);
    expect(skopjeDayEndIso("2026-10-24")).toBe("2026-10-24T21:59:59.999999Z");
    expect(skopjeDayEndIso("2026-10-25")).toBe("2026-10-25T22:59:59.999999Z");
  });

  it("25.10.2026: today's start is right before AND after the 03:00 → 02:00 change", () => {
    // 01:30 CEST (before the change) and 10:00 CET (after) both start at 22:00Z
    expect(skopjeDayStartOf(at("2026-10-24T23:30:00Z")).startISO).toBe("2026-10-24T22:00:00.000Z");
    expect(skopjeDayStartOf(at("2026-10-25T09:00:00Z")).startISO).toBe("2026-10-24T22:00:00.000Z");
    // 00:30 the next day (CET)
    expect(skopjeDayStartOf(at("2026-10-25T23:30:00Z"))).toEqual({ day: "2026-10-26", startISO: "2026-10-25T23:00:00.000Z" });
  });

  it("29.03.2026 is a 23-hour day", () => {
    expect(skopjeMidnightIso("2026-03-29")).toBe("2026-03-28T23:00:00.000Z");
    expect(skopjeMidnightIso("2026-03-30")).toBe("2026-03-29T22:00:00.000Z");
    expect(skopjeDayStartOf(at("2026-03-29T10:00:00Z")).startISO).toBe("2026-03-28T23:00:00.000Z");
  });

  it("wall time → UTC matches PostgreSQL in the repeated hour and the gap", () => {
    expect(new Date(skopjeWallToUtcMs(2026, 10, 25, 2, 30)).toISOString()).toBe("2026-10-25T01:30:00.000Z");
    expect(new Date(skopjeWallToUtcMs(2026, 3, 29, 2, 30)).toISOString()).toBe("2026-03-29T01:30:00.000Z");
    expect(new Date(skopjeWallToUtcMs(2026, 10, 25, 0, 30)).toISOString()).toBe("2026-10-24T22:30:00.000Z");
    expect(new Date(skopjeWallToUtcMs(2026, 10, 25, 23, 30)).toISOString()).toBe("2026-10-25T22:30:00.000Z");
  });
});

describe("skopjeTime — bounds and validation", () => {
  it("skopjeBound pins a bare day and passes an instant through", () => {
    expect(skopjeBound("2026-10-01", "start")).toBe("2026-09-30T22:00:00.000Z");
    expect(skopjeBound("2026-10-01", "end")).toBe("2026-10-01T21:59:59.999999Z");
    expect(skopjeBound("2026-10-01T05:00:00.000Z", "end")).toBe("2026-10-01T05:00:00.000Z");
    expect(skopjeBound("", "start")).toBeNull();
    expect(skopjeBound(null, "end")).toBeNull();
    expect(skopjeBound("  ", "end")).toBeNull();
  });

  it("an impossible day falls back to today in a day range", () => {
    expect(isValidYmd("2026-02-31")).toBe(false);
    expect(skopjeDayRangeOf("2026-02-31", at("2026-10-01T10:00:00Z")).day).toBe("2026-10-01");
  });

  it("the day end leaves no gap before the next midnight", () => {
    for (const d of ["2026-10-01", "2026-10-24", "2026-10-25", "2026-03-28", "2026-03-29", "2026-12-31"]) {
      const end = Date.parse(skopjeDayEndIso(d));
      expect(Date.parse(skopjeMidnightIso(addDaysYmd(d, 1))) - end).toBe(1);
    }
  });

  it("skopjeYmd of an unreadable value is empty, not a crash", () => {
    expect(skopjeYmd("garbage")).toBe("");
  });
});

describe("skopjeTime — independent of the machine's own time zone", () => {
  const saved = process.env.TZ;
  afterEach(() => { process.env.TZ = saved; });

  for (const tz of ["UTC", "America/New_York", "Asia/Tokyo", "Pacific/Kiritimati"]) {
    it(`same answers with TZ=${tz}`, () => {
      process.env.TZ = tz;
      expect(skopjeTodayYmd(at("2026-09-30T22:30:00Z"))).toBe("2026-10-01");
      expect(skopjeMidnightIso("2026-10-25")).toBe("2026-10-24T22:00:00.000Z");
      expect(skopjeDayEndIso("2026-10-25")).toBe("2026-10-25T22:59:59.999999Z");
      expect(skopjeHour(at("2026-10-01T21:30:00Z"))).toBe(23);
    });
  }
});

describe("skopjeTime — the default clock (fake timers)", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("at 00:30 Skopje the defaults already answer the new day", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-30T22:30:00Z"));   // 01.10 00:30 CEST
    expect(skopjeTodayYmd()).toBe("2026-10-01");
    expect(skopjeDayStartOf().startISO).toBe("2026-09-30T22:00:00.000Z");
    expect(skopjeDayRangeOf().day).toBe("2026-10-01");
    expect(skopjeHour()).toBe(0);
  });

  it("at 23:30 Skopje the defaults still answer the same day", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-01T21:30:00Z"));   // 01.10 23:30 CEST
    expect(skopjeTodayYmd()).toBe("2026-10-01");
    expect(skopjeDayRangeOf().endISO).toBe("2026-10-01T22:00:00.000Z");
  });

  it("on 25.10.2026 at 23:30 CET (the 25th hour has passed) today is still 25.10", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-25T22:30:00Z"));
    expect(skopjeDayRangeOf()).toEqual({
      day: "2026-10-25", today: "2026-10-25",
      startISO: "2026-10-24T22:00:00.000Z", endISO: "2026-10-25T23:00:00.000Z",
    });
  });
});
