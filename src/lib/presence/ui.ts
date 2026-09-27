import { toast } from 'sonner';
import i18n from '@/i18n';

/**
 * The person's OWN idle alert, as one sticky toast per tab.
 *
 * Two paths call this with the same toast id: the activity beat (tracker.ts,
 * when the server answers should_alert) and the realtime notification
 * (NotificationsDropdown, for the `meta.self` copy). Sonner replaces a toast
 * that shares an id, so the tab that sent the beat shows ONE toast, and every
 * other open CRM tab still shows it through realtime.
 *
 * Module-level on purpose → i18n.t, never a hook's t.
 */
export const IDLE_SELF_TOAST_ID = 'presence-idle-self';

export function showIdleSelfToast(minutes: number): void {
  const m = Math.max(0, Math.round(Number(minutes) || 0));
  toast.warning(i18n.t('notif.inactivitySelf.title', { minutes: m }), {
    id: IDLE_SELF_TOAST_ID,
    description: i18n.t('notif.inactivitySelf.body', { minutes: m }),
    // Sticky: the alert fires while the person is away from the screen, so a
    // timed toast would be gone before they are back. They close it.
    duration: Infinity,
  });
}

/** Opens the owners' "Who is working" sheet from anywhere (e.g. a click on an
 *  inactivity notification). PresenceHeaderButton listens for it. */
export const OPEN_PRESENCE_EVENT = 'elyon:open-presence';

export function openPresencePanel(): void {
  window.dispatchEvent(new CustomEvent(OPEN_PRESENCE_EVENT));
}
