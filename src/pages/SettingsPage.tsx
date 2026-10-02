// Поставки (Phase 10, 2026-10-01). /settings is the grouped section list,
// /settings/:section one section. lg and up: two panes — the sticky list
// (240 px) and the open section. Below lg: list → detail with a back arrow.
// Which sections exist and who sees them: src/components/settings/sections.ts
// (owners see money = every active admin + the owners list; managers see only
// Лично, the rules read-only and the link to Корисници). The old ?tab= and
// #hash deep links land on the new sections.
//
// Removed from here (git keeps the history): Users & roles (it duplicated
// /users — now a link card), Financial visibility (it controlled nothing), the
// Warehouse tab (low-stock thresholds moved to Warehouse → Залихи), the
// appearance switches that did nothing, the system switches that saved
// nothing and the static status flows. Telephony shows only while VOIP is on.
import { useMemo } from 'react';
import { Link, Navigate, useLocation, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, MousePointerClick, Shield, ShieldOff } from 'lucide-react';
import { AppLayout } from '@/layouts/AppLayout';
import { useAuth } from '@/contexts/AuthContext';
import { usePermissions } from '@/contexts/PermissionsContext';
import { EmptyState } from '@/components/EmptyState';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { PBX_CONFIG } from '@/lib/voip/pbxConfig';
import { SettingsNav } from '@/components/settings/SettingsNav';
import {
  sectionAccess, sectionById, sectionFromLegacy, type SettingsSectionId, type SettingsViewer,
} from '@/components/settings/sections';
import { TeamsTab } from '@/components/settings/TeamsTab';
import { IntegrationsHealthTab } from '@/components/settings/IntegrationsHealthTab';
import { OwnersTab } from '@/components/settings/OwnersTab';
import { AccessSection } from '@/components/settings/AccessSection';
import { RulesSection } from '@/components/settings/RulesSection';
import { TvSection } from '@/components/settings/TvSection';
import { CourierSection } from '@/components/settings/CourierSection';
import { PredictionEngineTab } from '@/components/settings/PredictionEngineTab';
import { TelephonyTab } from '@/components/settings/TelephonyTab';
import { PartnersSection, PersonalSection, UsersLinkSection, WarehouseLinkSection } from '@/components/settings/LinkSections';

function SectionBody({ id, viewer }: { id: SettingsSectionId; viewer: SettingsViewer }) {
  switch (id) {
    case 'users': return <UsersLinkSection />;
    case 'teams': return <TeamsTab />;
    case 'access': return <AccessSection />;
    case 'money': return <OwnersTab />;
    case 'rules': return <RulesSection readOnly={!viewer.isAdmin} />;
    case 'integrations': return <IntegrationsHealthTab />;
    case 'tv': return <TvSection />;
    case 'courier': return <CourierSection />;
    case 'partners': return <PartnersSection />;
    case 'warehouse': return <WarehouseLinkSection />;
    case 'telephony': return <TelephonyTab />;
    case 'engine': return <PredictionEngineTab />;
    case 'personal': return <PersonalSection />;
  }
}

export default function SettingsPage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const { canSeeBusiness, canSeeMargins, canAccessModule } = usePermissions();
  const { section } = useParams<{ section?: string }>();
  const [sp] = useSearchParams();
  const location = useLocation();
  const isAdmin = user?.isAdmin ?? false;
  const isManager = user?.isManager ?? false;
  const canUsers = canAccessModule('users');

  const viewer = useMemo<SettingsViewer>(() => ({
    isAdmin, isManager, isOwner: canSeeBusiness, canSeeMargins: !!canSeeMargins, canUsers, voipOn: PBX_CONFIG.useRealVoip,
  }), [isAdmin, isManager, canSeeBusiness, canSeeMargins, canUsers]);

  if (!isAdmin && !isManager) {
    return (
      <AppLayout title={t('nav.settings')}>
        <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
          <Shield className="mb-4 h-12 w-12 opacity-40" />
          <p className="text-lg font-medium">{t('settings.adminAccessRequired')}</p>
          <p className="mt-1 text-sm">{t('settings.noPermissionSettings')}</p>
        </div>
      </AppLayout>
    );
  }

  // Old deep links: /settings?tab=teams, /settings#leaderboard → /settings/teams, /settings/tv.
  if (!section) {
    const legacy = sectionFromLegacy(sp.get('tab') ?? (location.hash || null));
    if (legacy) return <Navigate to={`/settings/${legacy}`} replace />;
  }
  const access = section ? sectionAccess(section, viewer) : null;
  if (access === 'unknown') return <Navigate to="/settings" replace />;
  const current = access === 'ok' ? sectionById(section) : null;

  return (
    <AppLayout title={t('nav.settings')}>
      <div className="lg:grid lg:grid-cols-[240px_minmax(0,1fr)] lg:items-start lg:gap-6">
        <nav
          aria-label={t('settingsPage.navLabel')}
          className={cn(
            section ? 'hidden lg:block' : 'block',
            'lg:sticky lg:top-0 lg:max-h-[calc(100dvh-7rem)] lg:overflow-y-auto lg:pb-2',
          )}
        >
          <SettingsNav viewer={viewer} active={section ?? null} />
        </nav>

        <div className={cn(section ? 'block' : 'hidden lg:block', 'min-w-0')}>
          {section && (
            <Link
              to="/settings"
              className="mb-3 inline-flex min-h-10 items-center gap-1.5 rounded-lg pr-2 text-sm font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:hidden"
            >
              <ArrowLeft className="h-4 w-4" aria-hidden /> {t('settingsPage.back')}
            </Link>
          )}
          {current ? (
            <SectionBody id={current.id} viewer={viewer} />
          ) : section ? (
            <EmptyState
              icon={<ShieldOff className="h-6 w-6" />}
              title={t('settingsPage.noAccess')}
              description={t('settingsPage.noAccessDesc')}
              size="sm"
              className="rounded-xl shadow-sm"
              action={<Button asChild variant="outline" size="sm"><Link to="/settings">{t('settingsPage.back')}</Link></Button>}
            />
          ) : (
            <EmptyState
              icon={<MousePointerClick className="h-6 w-6" />}
              title={t('settingsPage.pick')}
              description={t('settingsPage.pickDesc')}
              size="sm"
              className="rounded-xl shadow-sm"
            />
          )}
        </div>
      </div>
    </AppLayout>
  );
}
