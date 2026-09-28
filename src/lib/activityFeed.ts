import i18n from '@/i18n';
import { statusLabel } from '@/types';

// Dashboard activity feed (GET /api/recent-activity) → text in the reader's
// language. Module-level helpers → `i18n.t`, re-rendered by the page's
// useTranslation() subscription.

/**
 * One activity-feed row as a sentence in the reader's language. The api sends
 * an i18n key (dashboard.feed.*) plus structured fields; an older api sent a
 * ready English `description` and no key — shown as-is so a stale api still
 * renders. Statuses, call outcomes and context types are enum values and are
 * translated here; order ids, names and note text are data and never are.
 */
export function activityText(item: any): string {
  const key = typeof item?.i18n === 'string' && item.i18n.startsWith('dashboard.feed.') ? item.i18n : null;
  if (!key) return item?.description ?? '';
  const m = item.metadata || {};
  const vars: Record<string, unknown> =
    item.type === 'status_change' ? {
      order: item.display_id || '?',
      from: m.from ? statusLabel(m.from) : i18n.t('dashboard.feed.newOrder'),
      to: m.to ? statusLabel(m.to) : '—',
    }
    : item.type === 'call' ? {
      outcome: m.outcome ? i18n.t(`outcome.${m.outcome}`, { defaultValue: String(m.outcome).replace(/_/g, ' ') }) : '—',
      context: i18n.t(`dashboard.feed.context.${m.context_type}`, { defaultValue: String(m.context_type ?? '') }),
    }
    : { order: item.display_id || i18n.t('dashboard.feed.anOrder'), text: item.note_excerpt ?? '' };
  return i18n.t(key, { ...vars, defaultValue: item.description ?? '' });
}

/** The actor's name; unknown → "System" for a status change, "Agent" for a call. */
export function activityActor(item: any): string {
  if (item?.actor) return item.actor;
  return item?.type === 'call' ? i18n.t('dashboard.feed.agent') : i18n.t('dashboard.feed.system');
}
