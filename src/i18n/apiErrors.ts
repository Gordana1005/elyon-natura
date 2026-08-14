import i18n from './index';

// Backend error messages arrive as English strings (err.message from
// apiFetch). Known messages map to translation keys here; anything unknown
// falls through verbatim — an untranslated technical error beats a wrong one.
// Source of the exact strings: sanitizeDbError + business-rule responses in
// supabase/functions/api/index.ts.

const EXACT: Record<string, string> = {
  'Operation failed': 'apiErrors.operationFailed',
  'Duplicate entry': 'apiErrors.duplicateEntry',
  'Referenced record not found': 'apiErrors.refNotFound',
  'Required field missing': 'apiErrors.requiredMissing',
  'Invalid value': 'apiErrors.invalidValue',
  'Permission denied': 'apiErrors.permissionDenied',
  'Forbidden': 'apiErrors.permissionDenied',
  'Forbidden — admin only': 'apiErrors.adminOnly',
  'Forbidden — segment members are admin-only': 'apiErrors.adminOnly',
  'Unauthorized': 'apiErrors.unauthorized',
  'API error': 'apiErrors.generic',
  'Internal server error': 'apiErrors.internalError',
  'Invalid JSON': 'apiErrors.invalidValue',
  'Order not found': 'apiErrors.orderNotFound',
  'Item not found': 'apiErrors.itemNotFound',
  'Product not found': 'apiErrors.productNotFound',
  'Agent not found': 'apiErrors.agentNotFound',
  'Target agent not found': 'apiErrors.agentNotFound',
  'Segment not found': 'apiErrors.segmentNotFound',
  'Template not found': 'apiErrors.templateNotFound',
  'Webhook not found': 'apiErrors.webhookNotFound',
  'Webhook is disabled': 'apiErrors.webhookDisabled',
  'Cannot modify products — order is locked.': 'apiErrors.orderLocked',
  'Product and price locked because order is Shipped, Delivered, or Paid.': 'apiErrors.productPriceLocked',
  'Name, Telephone, City, and delivery information (Address or Courier Office) must be filled before changing to this status': 'apiErrors.fieldsBeforeStatus',
  'Phone is required': 'apiErrors.phoneRequired',
  'phone required': 'apiErrors.phoneRequired',
  'Current phone must have at least 8 digits': 'apiErrors.currentPhone8',
  'New phone must have at least 8 digits': 'apiErrors.newPhone8',
  'Phone looks corrupted (scientific notation). Re-enter the digits.': 'apiErrors.phoneCorrupted',
  'Provide a new name or phone': 'apiErrors.provideNameOrPhone',
  'Note text is required': 'apiErrors.noteRequired',
  'Product name is required (max 200 chars)': 'apiErrors.productNameRequired',
  'Invalid courier': 'apiErrors.invalidCourier',
  'Missing courier or code': 'apiErrors.missingCourierCode',
  'At least one role is required': 'apiErrors.oneRoleRequired',
  'Cannot change your own role': 'apiErrors.cannotChangeOwnRoles',
  'Cannot change your own roles': 'apiErrors.cannotChangeOwnRoles',
  'Cannot delete yourself': 'apiErrors.cannotDeleteSelf',
  'Cannot suspend yourself': 'apiErrors.cannotSuspendSelf',
  'Managers can only assign Pending Agent or Prediction Agent roles': 'apiErrors.managerRoleLimit',
  'Managers can only create Pending Agent or Prediction Agent users': 'apiErrors.managerCreateLimit',
  'Lead is already assigned to another agent': 'apiErrors.leadAlreadyAssigned',
  'No phone extension available — ask an admin to add more lines.': 'apiErrors.noExtension',
  'Agent has no telephony extension assigned': 'apiErrors.agentNoExtension',
  'Caller ID must be one of the owned numbers': 'apiErrors.callerIdNotOwned',
  'Too many rows (max 1000 per upload)': 'apiErrors.tooManyRows',
  'Recordings service error': 'apiErrors.recordingsError',
  'Recordings service unavailable': 'apiErrors.recordingsUnavailable',
  'No updates provided': 'apiErrors.noUpdates',
  'No valid fields': 'apiErrors.noUpdates',
  'No rates provided': 'apiErrors.noUpdates',
};

type Vars = (m: RegExpMatchArray) => Record<string, unknown>;
const PATTERNS: Array<[RegExp, string, Vars?]> = [
  [/^Rate limit exceeded/i, 'apiErrors.rateLimited'],
  [
    /^Insufficient stock: (.+) has (\d+) available, but order requires (\d+)/,
    'apiErrors.insufficientStock',
    (m) => ({ name: m[1], have: m[2], need: m[3] }),
  ],
  [/^Already claimed by (.+) until (.+)$/, 'apiErrors.alreadyClaimed', (m) => ({ agent: m[1], until: m[2] })],
  [/^You already have (\d+) customers in your Personal List/, 'apiErrors.personalListFull', (m) => ({ count: Number(m[1]) })],
  [/^You can only set status to: (.+)$/, 'apiErrors.agentAllowedStatuses', (m) => ({ statuses: m[1] })],
];

export function apiErrorText(err: unknown): string {
  // AbortSignal.timeout in apiFetch → TimeoutError; a user-initiated cancel →
  // AbortError. Both mean "no response", not a backend message.
  if (err instanceof DOMException && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
    return i18n.t('apiErrors.timeout');
  }
  const msg = err instanceof Error ? err.message : String(err ?? '');
  if (!msg) return i18n.t('apiErrors.generic');
  // apiFetch throws `HTTP <status>` when an error response has no JSON body
  // (e.g. an edge function killed over its CPU budget returns 546 with HTML).
  const http = msg.match(/^HTTP (\d{3})$/);
  if (http) return i18n.t('apiErrors.httpStatus', { status: http[1] });
  const exact = EXACT[msg];
  if (exact) return i18n.t(exact);
  for (const [re, key, vars] of PATTERNS) {
    const m = msg.match(re);
    if (m) return i18n.t(key, vars ? vars(m) : undefined);
  }
  return msg;
}
