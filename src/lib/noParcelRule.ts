// The no-parcel rule's window, in days, for UI labels. The rule reads
// app_settings.no_parcel_rule.days through public.no_parcel_rule_days()
// (20260940000300, owner 28.09: 7 → 10) and the api hands the number over —
// the Overview attention item `approved_no_parcel_7d` carries `days`, the
// Integrations-health rule card `days_n`. Labels take it from there; this is
// only the fallback for a payload without it (an older api, a bare URL).
//
// The stored codes keep their historical names on purpose — cancellation
// reason `no_parcel_7d`, attention kind `approved_no_parcel_7d` — the "7" in
// them is an identifier, not the window.
export const NO_PARCEL_DEFAULT_DAYS = 10;

/** A payload's days, or the default when missing / not a positive integer. */
export function noParcelDaysOr(v: unknown): number {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : NO_PARCEL_DEFAULT_DAYS;
}
