import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { openPresencePanel } from '@/lib/presence/ui';
import { extractCallerPhone, type NotificationRow } from '@/lib/notifications/localize';

/**
 * Clicking a notification marks it read and jumps to its target page (if any).
 * Missed calls deep-link straight to that caller in the inbox (?phone=…) so the
 * operator lands on the exact row instead of hunting through the list.
 */
export function useOpenNotification(markRow: (n: NotificationRow) => Promise<void>, after?: () => void) {
  const navigate = useNavigate();
  return useCallback((n: NotificationRow) => {
    void markRow(n);
    after?.();
    // An owner's copy of an idle alert opens the "Who is working" sheet in
    // place (it exists for owners only; for anyone else this is a no-op).
    if (n.type === 'inactivity' && !n.meta?.self) {
      openPresencePanel();
      return;
    }
    if (n.type === 'missed_call') {
      const phone = extractCallerPhone(n);
      navigate(phone ? `/missed-calls?phone=${encodeURIComponent(phone)}` : (n.link || '/missed-calls'));
      return;
    }
    if (n.link) navigate(n.link);
  }, [markRow, after, navigate]);
}
