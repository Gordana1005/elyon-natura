import { useTranslation } from 'react-i18next';
import { AppLayout } from '@/layouts/AppLayout';
import { useAuth } from '@/contexts/AuthContext';
import { usePermissions } from '@/contexts/PermissionsContext';
import { AgentShiftsView } from '@/components/shifts/AgentShiftsView';
import { ManagerShiftsView } from '@/components/shifts/ManagerShiftsView';

/**
 * /shifts — "Смени", one page for everyone (plan Фаза 8, owner 30.09.2026; it replaces
 * Shifts Management + My Shifts, and /my-shifts redirects here).
 *
 * A shift is the LOGIN GATE: without one covering "now" an agent cannot log in (the owner kept
 * it). So an agent sees their own days with a red warning 5 days before they run out, and a
 * roster manager (admin / manager with the `shifts` module — the api checks the same) sees the
 * runway banner, the roster grid, the logins and the statistics.
 */
export default function ShiftsPage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const { canAccessModule } = usePermissions();
  const canManage = !!(user?.isAdmin || user?.isManager) && canAccessModule('shifts');

  return (
    <AppLayout title={t('shiftsPage.title')}>
      <div className="space-y-4">
        <div className="min-w-0">
          <h2 className="text-base font-semibold">{t('shiftsPage.title')}</h2>
          <p className="text-xs text-muted-foreground">
            {canManage ? t('shiftsPage.subtitleManager') : t('shiftsPage.subtitleAgent')}
          </p>
        </div>
        {canManage ? <ManagerShiftsView /> : <AgentShiftsView />}
      </div>
    </AppLayout>
  );
}
