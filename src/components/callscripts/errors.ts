import type { TFunction } from 'i18next';
import { apiErrorText } from '@/i18n/apiErrors';
import { CallScriptsError } from '@/lib/callScriptsApi';

/** The codes the call-scripts routes answer with (contract docs/CALL-SCRIPTS.md) → callScripts.errors.*. */
const CODES: Record<string, string> = {
  stale: 'callScripts.errors.stale',
  forbidden: 'callScripts.errors.forbidden',
  admin_only: 'callScripts.errors.adminOnly',
  owners_only: 'callScripts.errors.adminOnly',
  not_found: 'callScripts.errors.notFound',
  use_new_editor: 'callScripts.errors.useNewEditor',
  too_many: 'callScripts.errors.tooMany',
  invalid: 'callScripts.errors.invalid',
  publish_needs_text: 'callScripts.errors.publishNeedsText',
  rate_limited: 'callScripts.errors.rateLimited',
};

/** A failed call-scripts request in the reader's language (code first, then status, then the message). */
export function scriptsErrorText(e: unknown, t: TFunction): string {
  if (e instanceof CallScriptsError) {
    if (e.code && CODES[e.code]) return t(CODES[e.code], { version: e.currentVersion ?? '' });
    // The writers' field-level refusals (bad_title, bad_sections, unknown_product, legacy_field, note_too_long,
    // too_many_products, expected_version_required, bad_transition, invalid_body …) → one translated "invalid".
    if (e.code && /^(bad_|unknown_|legacy_|invalid_|note_too_long$|too_many_products$|expected_version_required$|script_text_derived$)/.test(e.code)) {
      return t('callScripts.errors.invalid');
    }
    if (e.status === 403) return t('callScripts.errors.forbidden');
    if (e.status === 404) return t('callScripts.errors.notFound');
    if (e.status === 409) return t('callScripts.errors.stale', { version: e.currentVersion ?? '' });
    if (e.status === 429) return t('callScripts.errors.rateLimited');
    if (e.status >= 500 || e.status === 0) return t('callScripts.errors.server');
    return e.message ? apiErrorText(e) : t('callScripts.errors.server');
  }
  if (e instanceof Error && /timeout|aborted/i.test(e.message)) return t('callScripts.errors.timeout');
  return apiErrorText(e);
}
