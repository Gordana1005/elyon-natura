import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Activity } from 'lucide-react';
import { usePermissions } from '@/contexts/PermissionsContext';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { OPEN_PRESENCE_EVENT } from '@/lib/presence/ui';
import { PresenceDayPanel } from './PresenceDayPanel';

/**
 * Top-bar entry to the owners' "Who is working" sheet. Rendered for the
 * business owners only (canSeeBusiness — the same named list the api gates
 * GET /presence/day on); everyone else gets nothing. Also opens when an owner
 * clicks an inactivity notification (openPresencePanel()).
 */
export function PresenceHeaderButton() {
  const { t } = useTranslation();
  const { canSeeBusiness } = usePermissions();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!canSeeBusiness) return;
    const onOpen = () => setOpen(true);
    window.addEventListener(OPEN_PRESENCE_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_PRESENCE_EVENT, onOpen);
  }, [canSeeBusiness]);

  if (!canSeeBusiness) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={t('presence.button')}
        aria-label={t('presence.button')}
        className="relative flex h-9 w-9 items-center justify-center rounded-lg border bg-background hover:bg-muted transition-colors"
      >
        <Activity className="h-4 w-4 text-muted-foreground" />
      </button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-4xl">
          <SheetHeader>
            <SheetTitle>{t('presence.title')}</SheetTitle>
            <SheetDescription>{t('presence.subtitle')}</SheetDescription>
          </SheetHeader>
          {open && <PresenceDayPanel />}
        </SheetContent>
      </Sheet>
    </>
  );
}
