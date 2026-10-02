// Поставки — the grouped section list. On lg+ it is the sticky left pane next
// to the open section; below lg it IS the /settings page (list → detail).
// Every item: icon · name · one line of what it is · a status (icon AND word),
// e.g. Интеграции "сите фидови OK" / "N проблеми" from the same
// integrations-health data the section shows (shared react-query cache).
import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import {
  Activity, AlertTriangle, Banknote, CheckCircle2, ChevronRight, Eye, Handshake, KeyRound, ListChecks, Network,
  Phone, ShieldCheck, Truck, TrendingUp, Tv, UserCog, Users, Warehouse, type LucideIcon,
} from 'lucide-react';
import { usePermissions } from '@/contexts/PermissionsContext';
import { useLanguage } from '@/contexts/LanguageContext';
import { cn } from '@/lib/utils';
import { eurToDen } from '@/lib/currency';
import {
  apiGetBusinessOwners, apiGetCourierRates, apiGetIntegrationsHealth, apiGetLeaderboardAdmin, apiGetSalesUnmapped, apiGetUsers,
} from '@/lib/api';
import { issueCount } from './integrationsHealthModel';
import { DEAD_MODULES } from './AccessSection';
import { groupedSections, type SettingsSectionId, type SettingsViewer } from './sections';

export const SECTION_ICONS: Record<SettingsSectionId, LucideIcon> = {
  users: Users, levels: ShieldCheck, teams: Network, access: KeyRound, money: Banknote, rules: ListChecks,
  integrations: Activity, tv: Tv, courier: Truck, partners: Handshake, warehouse: Warehouse, telephony: Phone,
  engine: TrendingUp, personal: UserCog,
};

type Tone = 'ok' | 'warn' | 'muted';
interface NavBadge { text: string; tone: Tone }

const TONE: Record<Tone, { cls: string; icon: LucideIcon | null }> = {
  ok: { cls: 'text-emerald-700 dark:text-emerald-400', icon: CheckCircle2 },
  warn: { cls: 'text-amber-700 dark:text-amber-400', icon: AlertTriangle },
  muted: { cls: 'text-muted-foreground', icon: null },
};

const STALE = 5 * 60_000;

/** One status per section, from data the sections load anyway (same cache keys). */
function useSectionBadges(v: SettingsViewer): Partial<Record<SettingsSectionId, NavBadge>> {
  const { t } = useTranslation();
  const { modules } = usePermissions();
  const { language } = useLanguage();
  const staffQ = useQuery({ queryKey: ['settings-staff'], queryFn: apiGetUsers, enabled: v.isAdmin || v.isManager, staleTime: STALE });
  const healthQ = useQuery({ queryKey: ['integrations-health'], queryFn: apiGetIntegrationsHealth, enabled: v.isOwner, staleTime: 60_000, retry: 0 });
  const unmappedQ = useQuery({ queryKey: ['sales-unmapped', 90], queryFn: () => apiGetSalesUnmapped(90), enabled: v.isOwner, staleTime: STALE, retry: 0 });
  const ownersQ = useQuery({ queryKey: ['business-owners'], queryFn: apiGetBusinessOwners, enabled: v.isOwner, staleTime: STALE, retry: 0 });
  const tvQ = useQuery({ queryKey: ['lb-admin', 'prediction'], queryFn: () => apiGetLeaderboardAdmin('prediction'), enabled: v.isAdmin, staleTime: STALE, retry: 0 });
  const courierQ = useQuery({ queryKey: ['courier-rates'], queryFn: apiGetCourierRates, enabled: v.canSeeMargins, staleTime: STALE, retry: 0 });

  return useMemo(() => {
    const b: Partial<Record<SettingsSectionId, NavBadge>> = {};
    const staff = (staffQ.data ?? []) as { user_id: string; is_active: boolean; roles?: string[] }[];
    if (staffQ.data) b.users = { text: t('settingsPage.badge.usersActive', { count: staff.filter((u) => u.is_active).length }), tone: 'muted' };
    if (healthQ.data) {
      const n = issueCount(healthQ.data);
      b.integrations = n === 0 ? { text: t('settingsPage.badge.feedsOk'), tone: 'ok' } : { text: t('settingsPage.badge.feedsIssues', { count: n }), tone: 'warn' };
    }
    if (unmappedQ.data) {
      const u = unmappedQ.data;
      const n = (u.altercpa?.length ?? 0) + (u.unnamed?.length ?? 0) + (u.logins ?? []).filter((l) => l.is_active).length + (u.orders?.length ?? 0);
      b.teams = n === 0 ? { text: t('settingsPage.badge.allLinked'), tone: 'ok' } : { text: t('settingsPage.badge.unmapped', { count: n }), tone: 'warn' };
    }
    const live = modules.filter((m) => !DEAD_MODULES.includes(m.module_key));
    if (live.length) {
      const off = live.filter((m) => !m.is_enabled).length;
      b.access = off === 0 ? { text: t('settingsPage.badge.modulesAllOn'), tone: 'muted' } : { text: t('settingsPage.badge.modulesOff', { count: off }), tone: 'warn' };
    }
    if (ownersQ.data && staffQ.data) {
      const admins = new Set(staff.filter((u) => u.is_active && (u.roles ?? []).includes('admin')).map((u) => u.user_id));
      const extra = ownersQ.data.filter((o) => o.is_active && !admins.has(o.user_id)).length;
      b.money = { text: t('settingsPage.badge.seeMoney', { count: admins.size + extra }), tone: 'muted' };
    }
    if (!v.isAdmin) b.rules = { text: t('settingsPage.badge.readOnly'), tone: 'muted' };
    if (tvQ.data) {
      const n = (tvQ.data.tokens ?? []).filter((tok) => tok.is_active).length;
      b.tv = n === 0 ? { text: t('settingsPage.badge.noTvLink'), tone: 'warn' } : { text: t('settingsPage.badge.tvLinks', { count: n }), tone: 'muted' };
    }
    const mex = (courierQ.data ?? []).find((r) => r.courier === 'mex' && r.service === 'door');
    if (mex) b.courier = { text: t('settingsPage.badge.courier', { den: eurToDen(mex.deliver_cost) }), tone: 'muted' };
    b.partners = { text: t('settingsPage.badge.partnersEur'), tone: 'muted' };
    b.engine = { text: 'v3.7-mk', tone: 'muted' };
    b.personal = { text: t(`languages.${language}`), tone: 'muted' };
    return b;
  }, [t, modules, language, v.isAdmin, staffQ.data, healthQ.data, unmappedQ.data, ownersQ.data, tvQ.data, courierQ.data]);
}

export function SettingsNav({ viewer, active }: { viewer: SettingsViewer; active: string | null }) {
  const { t } = useTranslation();
  const groups = groupedSections(viewer);
  const badges = useSectionBadges(viewer);
  return (
    <div className="space-y-4">
      {groups.map(({ group, sections }) => (
        <section key={group} aria-labelledby={`settings-group-${group}`} className="space-y-1.5">
          <h2 id={`settings-group-${group}`} className="px-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            {t(`settingsPage.group.${group}`)}
          </h2>
          <ul className="divide-y overflow-hidden rounded-xl border bg-card shadow-sm">
            {sections.map((s) => {
              const Icon = SECTION_ICONS[s.id];
              const on = active === s.id;
              const badge = badges[s.id];
              const tone = badge ? TONE[badge.tone] : null;
              const BadgeIcon = tone?.icon ?? (s.readOnly?.(viewer) ? Eye : null);
              return (
                <li key={s.id}>
                  <Link
                    to={`/settings/${s.id}`}
                    aria-current={on ? 'page' : undefined}
                    className={cn(
                      'flex min-h-14 items-start gap-3 px-3 py-2.5 transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                      on && 'bg-primary/10 hover:bg-primary/10',
                    )}
                  >
                    <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', on ? 'text-primary' : 'text-muted-foreground')} aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className={cn('block break-words text-sm font-medium leading-snug', on && 'text-primary')}>{t(s.labelKey)}</span>
                      <span className="block break-words text-xs leading-snug text-muted-foreground">{t(s.descKey)}</span>
                      {badge && (
                        <span className={cn('mt-1 inline-flex items-center gap-1 text-[11px] font-medium leading-tight', tone?.cls)}>
                          {BadgeIcon && <BadgeIcon className="h-3 w-3 shrink-0" aria-hidden />}
                          <span className="break-words">{badge.text}</span>
                        </span>
                      )}
                    </span>
                    <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground lg:hidden" aria-hidden />
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
