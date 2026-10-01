// Dialling from the agent's OWN handset (VOIP is off — plan Фаза 11, /calls).
//
// A Macedonian number is stored E.164 (+389 7X XXX XXX / +389 2 XXX XXXX); the phone
// app wants the local form an agent would type: 0 + the national number
// (070 123 456, 02 312 3456). A foreign number keeps its + form — 0 would dial a
// Macedonian number that does not exist.

/** Digits a `tel:` link should carry, or '' when there is nothing dialable. */
export function toLocalDial(phone: string | null | undefined): string {
  const raw = String(phone ?? '').trim();
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 6) return '';
  // +389 / 00389 + 8 national digits → 0 + national
  const intl = digits.startsWith('00') ? digits.slice(2) : digits;
  if (intl.startsWith('389') && intl.length === 11) return `0${intl.slice(3)}`;
  // already local (0 + 8 digits)
  if (digits.length === 9 && digits.startsWith('0')) return digits;
  // a bare national number (7X XXX XXX)
  if (digits.length === 8 && !raw.startsWith('+')) return `0${digits}`;
  // anything else is foreign — dial it international
  return `+${intl}`;
}

/** The number the way it is read out: "070 123 456", "02 312 3456". Foreign: unchanged. */
export function formatLocalDisplay(local: string): string {
  if (!/^0\d{8}$/.test(local)) return local;
  if (local.startsWith('02')) return `${local.slice(0, 2)} ${local.slice(2, 5)} ${local.slice(5)}`;
  return `${local.slice(0, 3)} ${local.slice(3, 6)} ${local.slice(6)}`;
}

export function telHref(phone: string | null | undefined): string | null {
  const local = toLocalDial(phone);
  return local ? `tel:${local}` : null;
}
