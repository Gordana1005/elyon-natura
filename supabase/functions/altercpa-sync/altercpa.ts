/**
 * AlterCPA vocabulary and fetch contract — Deno port of scripts/lib/altercpa.mjs
 * and the window logic in scripts/export-altercpa-mk.mjs.
 *
 * This is a PORT, not a rewrite. Everything here was derived from the LIVE API
 * during the 2026-08 history import, not from the published docs — the docs list
 * cancel reasons 1-15 while the data also carries 16-19, and they describe an
 * `items` map that is empty on every real order (the product actually lives in
 * `goods`). Keep the two files in step: the scripts are how a human inspects the
 * same data offline, and a divergence means the preview stops matching what the
 * bridge will actually store.
 *
 * The script version cannot simply be imported — it uses node:fs and ships in a
 * Node-only toolchain.
 */

/** AlterCPA `phase` — the reliable outcome field. `status` (1-12) is noisier. */
export const PHASE: Record<number, string> = {
  1: "processing", 2: "hold", 3: "approved", 4: "cancelled", 5: "trash",
};

/**
 * phase → Elyon order_status — history import only — never used by the live
 * bridge. Approved counted as paid per the 2026-08-05 decision, which fitted
 * long-settled history and is wrong for a live lead: AlterCPA never moves this
 * account past status 6 "Packing", even for parcels MEX delivered. The bridge
 * maps through resolveRemoteOutcome / insertStatusFor (B′) instead.
 *
 * Renamed from PHASE_TO_STATUS 2026-09-27: the insert path still used it, and
 * the 2026-09-18 import_scope='all' backfill created 1.344 orders directly as
 * `paid` from their "approved" — ~345 of them never had a parcel.
 * outcome.test.ts fails if index.ts references it again. scripts/lib/
 * altercpa.mjs keeps the old name on purpose: it IS the history importer.
 */
export const HISTORY_PHASE_TO_STATUS: Record<number, string> = {
  1: "pending", 2: "pending", 3: "paid", 4: "cancelled", 5: "trashed",
};

/**
 * AlterCPA cancel reasons. 1-15 are documented; 16-19 are this account's own
 * custom codes and the API exposes no lookup for them. Their meaning was
 * recovered from the comments operators left alongside them.
 */
export const REASON: Record<number, string> = {
  0: "—", 1: "incorrect phone", 2: "changed mind", 3: "did not order",
  4: "requires certificate", 5: "wrong geo", 6: "errors/fakes", 7: "duplicate",
  8: "ordered elsewhere", 9: "expensive", 10: "unhappy with delivery",
  11: "could not reach", 12: "possible fraud", 13: "different language",
  14: "product didn't fit", 15: "offer disabled",
  16: "само консултација",   // rang for advice, not to buy
  17: "недостапен",          // phone off / never answered
  18: "враќа нарачки",       // known parcel returner; a do-not-ship flag
  19: "custom-19",
};

/**
 * AlterCPA `status` (1-12) labels, docs order. `phase` remains the reliable
 * outcome field; `status` refines phase 3 with the fulfilment lifecycle, which
 * is the only thing the status-sync kind reads it for.
 */
export const STATUS_LABEL: Record<number, string> = {
  1: "New", 2: "Processing", 3: "Callback", 4: "Hold", 5: "Cancelled",
  6: "Packing", 7: "Sending", 8: "Transfer", 9: "Arrived", 10: "Completed",
  11: "Return", 12: "Deleted",
};

/**
 * AlterCPA cancel/trash reason → Elyon reason columns. PORT of the CANCEL/TRASH
 * tables in scripts/backfill-altercpa-reasons.mjs — keep the two in step, the
 * same way this whole file mirrors scripts/lib/altercpa.mjs. Values must stay
 * inside orders_cancellation_reason_check / orders_trash_reason_check.
 */
export const CANCEL_REASON_TO_CRM: Record<number, string> = {
  2: "changed_mind", 9: "price_too_high", 8: "bought_elsewhere",
  10: "not_satisfied", 14: "wrong_product", 7: "duplicate_order",
};
export const TRASH_REASON_TO_CRM: Record<number, string> = {
  1: "wrong_number", 3: "wrong_person", 11: "not_reachable",
};

/**
 * Reason value + notes for the CRM columns, mirroring the backfill's notes
 * logic exactly: the _notes column carries the OPERATOR'S OWN words; only when
 * the reason flattens into 'other' is the original AlterCPA disposition label
 * kept ahead of the comment (unless the operator typed the reason back at us).
 * Sliced to 1000 — the api zod schema caps these columns there.
 */
export function crmReasonFor(
  kind: "cancel" | "trash",
  reason: number,
  comment: unknown,
): { value: string; notes: string | null } {
  const table = kind === "cancel" ? CANCEL_REASON_TO_CRM : TRASH_REASON_TO_CRM;
  const value = table[reason] || "other";
  const label = REASON[reason] ?? `reason ${reason}`;
  const c = String(comment ?? "").replace(/\s+/g, " ").trim();
  let notes = c;
  if (value === "other") {
    const same = c.toLowerCase().startsWith(label.toLowerCase());
    notes = c ? (same ? c : `${label} — ${c}`) : label;
  }
  notes = notes.slice(0, 1000);
  return { value, notes: notes || null };
}

/**
 * Rank for the status-sync forward-only rule: the bridge may only move an order
 * UP this ladder, and a terminal status is never rewritten. take/call_again sit
 * with pending — they are still "being decided", and the ownership guard (not
 * this rank) is what protects an agent mid-call.
 */
export const CRM_STATUS_RANK: Record<string, number> = {
  pending: 0, take: 0, call_again: 0,
  confirmed: 1, shipped: 2, delivered: 3,
  paid: 9, returned: 9, cancelled: 9, trashed: 9, duplicated: 9,
};
export const CRM_TERMINAL = new Set(["paid", "returned", "cancelled", "trashed", "duplicated"]);

/**
 * The B′ outcome map (2026-08-11 decision): what a remote record means for a
 * mirrored order that is still open here. Returns null while the remote lead is
 * itself still open, otherwise ONLY confirmed | cancelled | trashed — never
 * shipped, delivered, paid or returned, whatever their status or o.paid stamp
 * says. outcome.test.ts proves it for every phase × status × reason × CRM
 * status. scripts/verify-altercpa-status.mjs carries a copy — keep in step.
 *
 * Deliberately NOT HISTORY_PHASE_TO_STATUS: that table books phase 3 as
 * `paid`, which was correct for the settled history import and is wrong for a
 * live mirror — approval happens while the COD parcel is merely Packing, and a
 * wrong `paid` is locked, moves commissions/sticky-trash/revenue, and can
 * never be corrected.
 */
export function resolveRemoteOutcome(o: AlterCpaOrder, currentCrmStatus: string): string | null {
  const phase = Number(o.phase) || 0;
  // 2026-08-11 final doctrine (operator): AlterCPA decides only whether a sale
  // is CONFIRMED or dead. Everything physical — shipped, paid, returned — is
  // MEX's alone (mex-reconcile): an order shows `shipped` only when the courier
  // actually holds the parcel, and money lands only on a courier delivery.
  // AlterCPA's own fulfilment statuses (Packing…Completed) are NOT trusted for
  // any of that; the first design mapped them to shipped/paid and orders showed
  // "shipped" that MEX had never seen.
  const atCourier = currentCrmStatus === "shipped" || currentCrmStatus === "delivered";
  if (phase === 1 || phase === 2) return null;
  if (phase === 3) return atCourier ? null : "confirmed";   // approved = a sale; MEX does the rest
  if (phase === 4) {
    // Manager rule: a cancel whose reason has no CRM equivalent (custom codes,
    // certificate, offer disabled — everything CANCEL_REASON_TO_CRM flattens
    // into 'other') marks a CONFIRMED sale awaiting fulfilment, not money and
    // not a cancel. reason 0 = "no reason recorded" stays a cancel.
    const r = Number(o.reason) || 0;
    if (r > 0 && !CANCEL_REASON_TO_CRM[r]) return "confirmed";
    // A real cancel applies only while the parcel hasn't reached the courier;
    // once it has, the physical outcome (delivered/returned) is MEX's to call.
    return atCourier ? null : "cancelled";
  }
  if (phase === 5) return atCourier ? null : "trashed";
  return null;                              // unknown phase → touch nothing
}

/**
 * The forward-only B′ step for an order that is `cur` here: the status to move
 * it to, or null when there is nothing to do — their lead is still open, the
 * order is already there, it is terminal here, or the move would go backwards
 * (CRM_STATUS_RANK). The ownership guard is NOT part of this: it needs a fresh
 * read of the order, and a guarded step is still a step (a note, a count).
 *
 * applyOutcomeToExistingOrder decides with it on the order it just read; a
 * sweep page also uses it to skip that read when the status it prefetched
 * already says null. The status kind keeps its own spelled-out checks, one
 * count per reason.
 */
export function forwardOutcome(o: AlterCpaOrder, cur: string): string | null {
  const target = resolveRemoteOutcome(o, cur);
  if (target == null || target === cur) return null;
  if (CRM_TERMINAL.has(cur)) return null;
  if ((CRM_STATUS_RANK[target] ?? 0) <= (CRM_STATUS_RANK[cur] ?? 0)) return null;
  return target;
}

/**
 * The only statuses the bridge may CREATE an order in. Everything physical —
 * shipped, delivered, paid, returned — is MEX's alone (mex-reconcile), so an
 * insert that resolves to anything else is a bug upstream, never data: it
 * throws, and the run fails loudly instead of booking it.
 */
export const INSERT_STATUSES: ReadonlySet<string> = new Set(["pending", "confirmed", "cancelled", "trashed"]);

export function assertInsertStatus(status: string, o?: AlterCpaOrder): string {
  if (!INSERT_STATUSES.has(status)) {
    throw new Error(
      `AlterCPA #${o?.id ?? "?"} (phase ${o?.phase ?? "?"}, reason ${o?.reason ?? "?"}) resolved to insert status '${status}'`
        + " — only pending/confirmed/cancelled/trashed may be inserted; shipped/delivered/paid/returned are MEX's alone",
    );
  }
  return status;
}

/**
 * Status for a NEW mirrored order: B′ as if it were a fresh pending, so an
 * insert can never disagree with what the status kind would do to the same
 * record one run later.
 *
 *   phase 1/2 (or unknown) → pending · 3 → confirmed · 4 → cancelled, or
 *   confirmed when the reason flattens into 'other' (2026-08-11 manager
 *   rule) · 5 → trashed
 */
export function insertStatusFor(o: AlterCpaOrder): string {
  return assertInsertStatus(resolveRemoteOutcome(o, "pending") ?? "pending", o);
}

/**
 * Outcome timestamps taken from AlterCPA's own clock rather than ours.
 *
 * orders has NULL-only BEFORE triggers for paid_at / cancelled_at / trashed_at
 * (20260727000000, 20260711000000, 20260913000100), so anything we set
 * explicitly wins and anything we omit gets stamped now().
 *
 * Letting them default to now() would be wrong in a way that MOVES MONEY AND
 * MEMBERSHIPS: a lead trashed on their side five days ago would get
 * trashed_at = now(), restarting the engine v3.7 21-day Trash List parking
 * period from today, and a COD paid last week would land in this week's paid
 * window on every agent dashboard and payout report.
 *
 * `paid` and `done` are epoch seconds on their record. Guarded against zero and
 * against times before creation, either of which would be worse than a NULL.
 * The paid/returned branches are unreachable from the bridge (B′ never yields
 * those statuses); they stay so this is the one place that knows which column
 * each outcome stamps. `confirmed` stamps nothing — no confirmed_at, same as
 * every B′ update, so the ownership guard still reads the order as untouched.
 */
export function outcomeTimestamps(o: AlterCpaOrder, status: string): Record<string, string> {
  const created = Number(o.time) || 0;
  const at = (v: unknown): string | null => {
    const n = Number(v) || 0;
    if (n <= 0) return null;
    if (created && n < created) return null;
    if (n > Math.floor(Date.now() / 1000) + 86400) return null;   // clock skew / bad data
    return new Date(n * 1000).toISOString();
  };
  const done = at(o.done);
  const out: Record<string, string> = {};
  if (status === "paid") {
    const p = at(o.paid) ?? done;
    if (p) out.paid_at = p;
  } else if (status === "cancelled") {
    if (done) out.cancelled_at = done;
  } else if (status === "trashed") {
    if (done) out.trashed_at = done;
  } else if (status === "returned") {
    // returned_at has no NULL-only trigger (20260514110000), so it must be set
    // here explicitly or the return carries no date at all.
    if (done) out.returned_at = done;
  }
  return out;
}

/**
 * The columns that travel WITH an outcome status: its timestamp from their
 * clock and, for cancelled/trashed only, the reason pair (reason 0 = none
 * recorded → no reason). One definition for the insert, the rolling apply and
 * the status kind — the insert path kept its own map, and that is how 1.344
 * orders were born paid. `status` itself stays with the caller, in plain sight.
 */
export function outcomeColumns(o: AlterCpaOrder, status: string): Record<string, string> {
  const out = outcomeTimestamps(o, status);
  const reason = Number(o.reason) || 0;
  if (status === "cancelled" && reason > 0) {
    const r = crmReasonFor("cancel", reason, o.comment);
    out.cancellation_reason = r.value;
    if (r.notes) out.cancellation_reason_notes = r.notes;
  } else if (status === "trashed" && reason > 0) {
    const r = crmReasonFor("trash", reason, o.comment);
    out.trash_reason = r.value;
    if (r.notes) out.trash_reason_notes = r.notes;
  }
  return out;
}

/**
 * Order note for the 2026-08-11 manager rule, or null when it did not fire (it
 * fires only when a phase-4 cancel resolved to confirmed). Keeps their original
 * disposition wording on the order, or the confirmed status reads as a mystery.
 */
export function cancelOtherConfirmedNote(o: AlterCpaOrder, status: string): string | null {
  if (status !== "confirmed" || Number(o.phase) !== 4) return null;
  const reason = Number(o.reason) || 0;
  const comment = o.comment == null ? "" : String(o.comment).trim().slice(0, 300);
  return `AlterCPA cancelled (${REASON[reason] ?? reason}) — confirmed disposition per the 2026-08-11 manager rule; status set to confirmed. MEX tracking will move it to shipped/paid/returned.`
    + (comment ? ` Their comment: ${comment}` : "");
}

/** Note for an outcome the ownership guard kept off an order someone here is working. */
export function guardedOutcomeNote(o: AlterCpaOrder): string {
  const phase = Number(o.phase) || 0;
  const reason = Number(o.reason) || 0;
  return `AlterCPA moved this to "${PHASE[phase] ?? "?"}"`
    + (reason ? ` (${REASON[reason] ?? reason})` : "")
    + " — not applied, this order is already being worked here.";
}

/**
 * MKD_PER_EUR is FROZEN at 61.5 — see src/lib/currency.ts. Never "update" it:
 * the denar is a managed NBRM peg, and changing the constant silently re-prices
 * every historical order. Re-price the catalogue in EUR instead.
 */
export const MKD_PER_EUR = 61.5;

/**
 * Per-currency divisor to EUR. Only rates we can defend belong here.
 *
 * A currency that is absent yields NULL, and the lead is mirrored WITHOUT a EUR
 * figure rather than with a guessed one — once a fabricated number is in a
 * report there is nothing to distinguish it from a real one. As the bridge takes
 * on more geos this table is the thing to extend, deliberately, per currency.
 */
export const FX_TO_EUR: Record<string, number> = {
  eur: 1,
  mkd: MKD_PER_EUR,
  bgn: 1.95583,   // fixed BNB peg — legally fixed, exact
  bam: 1.95583,   // Bosnian convertible mark — pegged to EUR at the old DEM rate, exact
  all: 100,       // Albanian lek, approximate
  rsd: 117,       // Serbian dinar, approximate
  ron: 4.97,      // Romanian leu, approximate
  huf: 395,       // Hungarian forint, approximate
  pln: 4.3,       // Polish złoty, approximate
  czk: 25.3,      // Czech koruna, approximate
  uah: 45,        // Ukrainian hryvnia, approximate
  try: 38,        // Turkish lira, approximate — moves fast, treat as indicative only
};
/** Legally fixed or hard-pegged: these convert exactly, the rest are indicative. */
export const EXACT_FX = new Set(["eur", "mkd", "bgn", "bam"]);

/**
 * Macedonian place-name key — port of scripts/lib/mk-translit.mjs
 * `normalizeMkGeo`. Needed so AlterCPA's Latin "Skopje" / "Kicevo" resolves to
 * the same mk_settlements.name_norm as Cyrillic Скопје / Кичево. Lossy on
 * purpose (ш/с → s); a missed match leaves mex_city_id NULL rather than
 * guessing a zone. Keep in step with the script and src/lib/transliterate.ts.
 */
const MK_GEO_CYR: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", ѓ: "g", е: "e",
  ж: "z", з: "z", ѕ: "d", и: "i", ј: "j", к: "k", л: "l",
  љ: "l", м: "m", н: "n", њ: "n", о: "o", п: "p", р: "r",
  с: "s", т: "t", ќ: "k", у: "u", ф: "f", х: "h", ц: "c",
  ч: "c", џ: "d", ш: "s",
  й: "j", щ: "st", ъ: "a", ь: "j", ю: "u", я: "a",
  ы: "i", э: "e", ё: "e", ђ: "d", ћ: "c", ѐ: "e", ѝ: "i",
};
const MK_GEO_MARKS = /[\u0300-\u036f]/g;
const MK_GEO_DIGRAPHS: Array<[string, string]> = [
  ["dzh", "d"], ["zh", "z"], ["sh", "s"], ["ch", "c"], ["dz", "d"],
  ["dj", "d"], ["gj", "g"], ["kj", "k"], ["lj", "l"], ["nj", "n"], ["ts", "c"],
];
export function normalizeMkGeo(s: string): string {
  if (!s) return "";
  let out = String(s).toLowerCase();
  out = out.split("").map((c) => MK_GEO_CYR[c] ?? c).join("");
  out = out.normalize("NFD").replace(MK_GEO_MARKS, "");
  out = out.replace(/ç/g, "c").replace(/đ/g, "d").replace(/ł/g, "l").replace(/ø/g, "o");
  for (const [from, to] of MK_GEO_DIGRAPHS) out = out.split(from).join(to);
  return out.replace(/[^a-z0-9]/g, "");
}

export function toEur(price: unknown, currency: unknown): number | null {
  const cur = String(currency || "mkd").toLowerCase();
  const div = FX_TO_EUR[cur];
  if (!div) return null;
  const n = Number(price);
  if (!Number.isFinite(n)) return null;
  return Math.round((n / div) * 100) / 100;
}

/**
 * AlterCPA and its affiliates smoke-test the funnel against the live account:
 * 314 MK orders were named "Пробный_Заказ", "Test Ninja", "Test Add Lead" and so
 * on, some from localhost or a Russian office IP, with cities like St Petersburg
 * and Helsinki. Every one was cancelled or trash, so excluding them costs no
 * revenue — but importing them invents customers who do not exist and parks them
 * in the Trash List forever.
 *
 * The pattern is deliberately narrow — anchored at the start of the name, so a
 * real surname containing those letters is never caught.
 */
const TEST_NAME = /^\s*(test\b|тест|проб|probn)/i;
/**
 * The owner's own test phones (ruling 2026-09-28): 070 123 456 and 23 123 123,
 * matched on the last 8 digits like every phone match here. Their CRM orders
 * are deleted (scripts/repair-test-phones.mjs) and they never count in a
 * report (public.report_excluded_phones, 20260940000300) — a lead of theirs
 * must not bring an order back, so it stays in the ledger as test_order.
 */
export const TEST_PHONE8: ReadonlySet<string> = new Set(["70123456", "23123123"]);
const phone8 = (v: unknown) => String(v ?? "").replace(/\D/g, "").slice(-8);
export const isTestOrder = (o: AlterCpaOrder) =>
  TEST_NAME.test(String(o?.name ?? "")) || TEST_PHONE8.has(phone8(o?.phone));

/** The product name for an order: goods[0] wins, then the offer name. */
export function productNameOf(o: AlterCpaOrder): string {
  const g = (o.goods || [])[0];
  const fromGoods = String(g?.name ?? "").trim();
  if (fromGoods) return fromGoods;
  return String(o.offername ?? "").trim();
}

export function quantityOf(o: AlterCpaOrder): number {
  const g = (o.goods || [])[0];
  const q = Number(g?.count ?? o.count ?? 1);
  return Number.isFinite(q) && q >= 1 ? Math.floor(q) : 1;
}

/**
 * Country calling codes, by ISO-3166 alpha-2.
 *
 * This exists so a foreign lead shows ITS OWN real number. The api function's
 * normalizeMkPhone is a REWRITER, not a validator: it strips any country code it
 * does not recognise and prefixes +389 regardless, so a Romanian
 * +40 721 234 567 comes back as +38940721234567 — a number that does not exist,
 * stored, dialled and matched as if it did. Nothing here may ever do that.
 *
 * Calling codes are facts, not guesses (Romania IS +40), so covering the geos an
 * affiliate network actually runs is safe. Add a country the moment traffic
 * appears from it — an absent geo yields null, never a wrong number.
 */
const DIAL_CODES: Record<string, string> = {
  // Balkans / SEE
  MK: "389", AL: "355", RS: "381", BA: "387", ME: "382", XK: "383",
  BG: "359", RO: "40", GR: "30", HR: "385", SI: "386", HU: "36",
  // Central & Eastern Europe
  PL: "48", CZ: "420", SK: "421", LT: "370", LV: "371", EE: "372",
  UA: "380", MD: "373", BY: "375", RU: "7", KZ: "7", GE: "995", AM: "374", AZ: "994",
  // Western & Northern Europe
  DE: "49", AT: "43", CH: "41", IT: "39", ES: "34", PT: "351", FR: "33",
  BE: "32", NL: "31", LU: "352", GB: "44", IE: "353", DK: "45", SE: "46",
  NO: "47", FI: "358", IS: "354", MT: "356", CY: "357",
  // Others that show up in CPA traffic
  TR: "90", IL: "972", AE: "971", SA: "966", EG: "20", MA: "212", TN: "216", DZ: "213",
  US: "1", CA: "1", MX: "52", BR: "55", CL: "56", CO: "57", PE: "51", AR: "54",
  IN: "91", PH: "63", MY: "60", TH: "66", VN: "84", ID: "62",
};

/**
 * Minimum national-significant digits, where the default of 8 is wrong. Used
 * only to reject obvious junk, never to reshape a number.
 */
const MIN_NSN: Record<string, number> = { US: 10, CA: 10, RU: 10, KZ: 10, IN: 10, BR: 10 };

/**
 * Normalize a phone to true E.164 for its OWN country.
 *
 *   ("38923294286", "MK") → "+38923294286"
 *   ("0721234567",  "RO") → "+40721234567"     ← never +389…
 *   ("+40721234567","RO") → "+40721234567"
 *   ("0721234567",  "??") → null               ← unknown geo, never guess
 *
 * For MK input this is byte-identical to normalizeMkPhone, so mirrored
 * Macedonian orders still match the 81.657 already in the table.
 */
export function normalizePhoneForGeo(raw: unknown, geo: string): string | null {
  const cc = DIAL_CODES[String(geo || "").toUpperCase()];
  if (!cc) return null;                        // unknown geo → never invent one
  let digits = String(raw ?? "").replace(/\D/g, "");
  if (!digits) return null;

  if (digits.startsWith("00")) digits = digits.slice(2);          // 0049… → 49…
  if (digits.startsWith(cc)) digits = digits.slice(cc.length);    // already international

  // Strip the national trunk zero LAST and unconditionally. Sources write the
  // same number both ways — "387603531647" and "3870603531647" are one Bosnian
  // subscriber — and stripping only in the non-international branch produced two
  // different E.164 values for one person, which silently breaks dedupe and
  // double-calls them. This also matches normalizeMkPhone's unconditional
  // ^0+ strip, so mirrored MK orders stay byte-identical to the 80.360 already
  // in the table.
  digits = digits.replace(/^0+/, "");

  const min = MIN_NSN[String(geo).toUpperCase()] ?? 8;
  if (digits.length < min) return null;
  // Guard against a number so long it cannot be E.164 (max 15 incl. the code).
  if (cc.length + digits.length > 15) return null;
  return "+" + cc + digits;
}

/** The shape we actually receive. Only the fields the bridge reads are typed. */
export interface AlterCpaOrder {
  id: number | string;
  ext?: string;
  offer?: number | string;
  offername?: string;
  wm?: number | string;
  status?: number;
  reason?: number;
  phase?: number;
  time?: number;          // creation, epoch seconds
  done?: number;
  paid?: number;
  name?: string;
  phone?: string;
  email?: string;
  country?: string;
  index?: string;
  addr?: string;
  area?: string;
  city?: string;
  street?: string;
  comment?: string;
  count?: number;
  currency?: string;
  price?: number;
  goods?: Array<{ id?: number; name?: string; short?: string; count?: number; price?: number }>;
  // Undocumented in their API doc but present on every record. `exts` is the
  // traffic-source/stream code — the publisher under the webmaster — promoted
  // to orders.cpa_stream_id. `extu` is a PER-LEAD click id (81.551 distinct
  // across 81.637 measured) — never store it as attribution.
  tracking?: {
    source?: string; campaign?: string; content?: string; term?: string;
    medium?: string; click?: string; uid?: string; subid?: string;
    uuid?: string; extu?: string; exts?: string;
  };
  [k: string]: unknown;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Fetch one window, splitting it if the API chokes.
 *
 * Two contracts inherited from the export script, both load-bearing:
 *
 *  1. An ERROR comes back as an OBJECT ({"status":"error",...}), not an array.
 *     Treating that as end-of-stream is exactly how a sync silently truncates
 *     while reporting success, so a non-array body is a HARD failure.
 *  2. The API has no page cap but 500s on very large windows (94k records came
 *     back fine; ~150k died). A whole-range request is therefore not "one page"
 *     — it is an error. Any window that still fails is halved until it fits.
 *
 * `from`/`to` are epoch SECONDS.
 */
export async function fetchWindow(
  apiBase: string,
  token: string,
  from: number,
  to: number,
  depth = 0,
  onSplit?: (msg: string) => void,
): Promise<AlterCpaOrder[]> {
  const base = apiBase.replace(/\/+$/, "");
  const url = `${base}/comp/list.json?id=${encodeURIComponent(token)}&from=${from}&to=${to}`;
  let lastErr: Error | null = null;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { "Accept-Encoding": "gzip" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      let body: unknown;
      try { body = JSON.parse(text); } catch {
        throw new Error(`unparseable body (${text.slice(0, 120)})`);
      }
      if (!Array.isArray(body)) {
        throw new Error(`non-array body: ${JSON.stringify(body).slice(0, 200)}`);
      }
      return body as AlterCpaOrder[];
    } catch (e) {
      lastErr = e as Error;
      if (attempt < 3) await sleep(2000 * attempt);
    }
  }

  if (depth < 4 && to - from > 86400) {
    onSplit?.(`window ${from}..${to} too large (${lastErr?.message}) — splitting`);
    const mid = Math.floor((from + to) / 2);
    const a = await fetchWindow(apiBase, token, from, mid, depth + 1, onSplit);
    const b = await fetchWindow(apiBase, token, mid + 1, to, depth + 1, onSplit);
    return a.concat(b);
  }
  throw new Error(`window ${from}..${to} failed after retries and ${depth} splits: ${lastErr?.message}`);
}

/**
 * Fetch specific orders by their AlterCPA ids, regardless of creation date.
 *
 * `comp/list.json?oid=a,b,c` (documented; verified live 2026-08-11) is what the
 * status-sync kind runs on: the windowed fetch filters on CREATION time only,
 * so it can never observe a later phase change on an old lead — `oid` can.
 *
 * Same hard contract as fetchWindow: a non-array body is a FAILURE, never an
 * empty result. Batches of 100 (~800-char URLs); a batch that still fails after
 * retries is halved down to a single id before giving up. Ids absent from the
 * response (deleted on their side) are simply not in the returned map — the
 * caller counts them, nothing is fabricated.
 */
export async function fetchByIds(
  apiBase: string,
  token: string,
  ids: string[],
  onSplit?: (msg: string) => void,
): Promise<Map<string, AlterCpaOrder>> {
  const out = new Map<string, AlterCpaOrder>();
  const BATCH = 100;
  const base = apiBase.replace(/\/+$/, "");

  const fetchBatch = async (batch: string[], depth: number): Promise<void> => {
    const url = `${base}/comp/list.json?id=${encodeURIComponent(token)}&oid=${encodeURIComponent(batch.join(","))}`;
    let lastErr: Error | null = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetch(url, { headers: { "Accept-Encoding": "gzip" } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        let body: unknown;
        try { body = JSON.parse(text); } catch {
          throw new Error(`unparseable body (${text.slice(0, 120)})`);
        }
        if (!Array.isArray(body)) {
          throw new Error(`non-array body: ${JSON.stringify(body).slice(0, 200)}`);
        }
        for (const o of body as AlterCpaOrder[]) out.set(String(o.id), o);
        return;
      } catch (e) {
        lastErr = e as Error;
        if (attempt < 3) await sleep(2000 * attempt);
      }
    }
    if (batch.length > 1 && depth < 8) {
      onSplit?.(`oid batch of ${batch.length} failed (${lastErr?.message}) — halving`);
      const mid = Math.ceil(batch.length / 2);
      await fetchBatch(batch.slice(0, mid), depth + 1);
      await fetchBatch(batch.slice(mid), depth + 1);
      return;
    }
    throw new Error(`oid batch of ${batch.length} failed after retries: ${lastErr?.message}`);
  };

  for (let i = 0; i < ids.length; i += BATCH) {
    await fetchBatch(ids.slice(i, i + BATCH), 0);
  }
  return out;
}
