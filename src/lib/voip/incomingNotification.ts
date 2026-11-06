/**
 * A system notification for an inbound Teleshop call when the CRM tab is not visible (05.11.2026).
 * Permission is asked only for people who receive these calls (the caller passes that decision), once, after a
 * user gesture; the notification stays until the ring ends (requireInteraction) and a click focuses the tab.
 */
const TAG = 'elyon-incoming';
let current: Notification | null = null;

export function notificationsSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

export async function ensureNotificationPermission(): Promise<NotificationPermission | 'unsupported'> {
  if (!notificationsSupported()) return 'unsupported';
  if (Notification.permission !== 'default') return Notification.permission;
  try { return await Notification.requestPermission(); } catch { return Notification.permission; }
}

export function showIncomingNotification(title: string, body: string): void {
  if (!notificationsSupported() || Notification.permission !== 'granted') return;
  if (typeof document !== 'undefined' && document.visibilityState === 'visible') return;
  try {
    closeIncomingNotification();
    current = new Notification(title, { body, tag: TAG, requireInteraction: true, silent: false });
    current.onclick = () => { try { window.focus(); } catch { /* ignore */ } closeIncomingNotification(); };
  } catch { current = null; }
}

export function closeIncomingNotification(): void {
  if (current) { try { current.close(); } catch { /* ignore */ } current = null; }
}
