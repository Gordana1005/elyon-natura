/**
 * Inbound Teleshop calls (05.11.2026): what the browser reads off the INVITE the PBX queue sends it.
 *
 * The PBX dialplan ([elyon-tv-in], extensions_custom.conf) sets the caller-ID NAME to "TV8888" / "TV2515" before it
 * rings queue 700, so the From display name tells which TV number the customer dialled; the From user is the
 * caller's number as Telekom delivers it (+389…, sometimes 0… / 389… from other sources). Pure — unit-tested.
 */

export interface TvDid {
  /** E.164, what telephony_extensions / the caller-ID map use */
  number: string;
  /** the way staff write the number */
  pretty: string;
}

/** The caller-ID name prefix each TV number carries → the number behind it. */
export const TV_DIDS: Record<string, TvDid> = {
  TV8888: { number: '+38925128888', pretty: '02 512 8888' },
  TV2515: { number: '+38926202515', pretty: '02 620 2515' },
};

/**
 * A Macedonian caller in E.164. '070123456' → '+38970123456'; '38970123456' → '+38970123456';
 * '+38970123456' unchanged. Anything else keeps its digits behind a '+' (a foreign caller stays recognisable);
 * no digits at all → ''. Never a rewrite of a foreign number into +389 (normalizeMkPhone is for stored data).
 */
export function normalizeMkCaller(raw: string | null | undefined): string {
  const digits = String(raw ?? '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('389') && digits.length >= 10 && digits.length <= 12) return `+${digits}`;
  if (digits.startsWith('0') && digits.length >= 8 && digits.length <= 10) return `+389${digits.slice(1)}`;
  if (digits.length >= 7 && digits.length <= 9) return `+389${digits}`; // a bare national number without the 0
  return `+${digits}`;
}

/** '+38970123456' → '070 123 456'; '+38925128888' → '02 512 8888'; anything else → the input. */
export function prettyMkPhone(e164: string | null | undefined): string {
  const s = String(e164 ?? '');
  const m = s.match(/^\+389(\d{7,9})$/);
  if (!m) return s;
  const n = `0${m[1]}`;
  if (n.length === 9 && n.startsWith('02')) return `${n.slice(0, 2)} ${n.slice(2, 5)} ${n.slice(5)}`; // Skopje 02 xxx xxxx
  if (n.length === 9) return `${n.slice(0, 3)} ${n.slice(3, 6)} ${n.slice(6)}`; // mobile 07x xxx xxx, areas 0xx xxx xxx
  return n;
}

export interface InboundIdentity {
  /** the caller, E.164 */
  phone: string;
  /** the caller-ID name prefix (TV8888 / TV2515), or null when the PBX sent none we know */
  did_label: string | null;
  /** the TV number dialled, E.164, or null */
  did_number: string | null;
  /** the TV number as staff write it, or null */
  did_pretty: string | null;
}

/**
 * The INVITE's remote identity → the caller + the TV number. The display name may carry more than the prefix
 * (FreePBX appends the caller's number when Telekom sends no CNAM: "TV8888 070123456"), so only the leading
 * TVnnnn token counts.
 */
export function parseInboundIdentity(user: string | null | undefined, displayName: string | null | undefined): InboundIdentity {
  const phone = normalizeMkCaller(user);
  const m = String(displayName ?? '').trim().match(/^(TV\d{4})\b/i);
  const label = m ? m[1].toUpperCase() : null;
  const did = label ? TV_DIDS[label] ?? null : null;
  return { phone, did_label: label, did_number: did?.number ?? null, did_pretty: did?.pretty ?? null };
}
