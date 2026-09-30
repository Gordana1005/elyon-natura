import type { ReactNode } from 'react';
import { Check, Circle, CircleCheck, CirclePause, Users, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { STATUS_TEXT } from '@/components/insights/shared/cohortPalette';
import { roleChips, type UserFilterState } from '@/lib/users/filterUsers';
import type { InsightsFormat } from '@/components/insights/shared/useInsightsFormat';
import { roleIcon, roleLabel } from './roleMeta';

export interface UsersKpiCounts {
  total: number;
  active: number;
  suspended: number;
  /** null = the payload carries no last_seen_at, so the tile is not shown. */
  online: number | null;
  roles: Record<string, number>;
}

/**
 * The accounts at a glance, in the Insights tile language (insights/returns/RsBits
 * Tile): total, active, suspended, online now, and the count per role. Every
 * tile is a button that applies its filter; pressed again it lifts it.
 */
export function UsersKpis({ counts, filters, onFilters, f }: {
  counts: UsersKpiCounts;
  filters: UserFilterState;
  onFilters: (next: Partial<Omit<UserFilterState, 'query'>>) => void;
  f: InsightsFormat;
}) {
  const { t } = f;
  const hasOnline = counts.online != null;
  const share = (n: number) => t('users.kpi.shareOfAll', { share: f.share(n, counts.total) });
  const onlyRole = (r: string) => filters.roles.length === 1 && filters.roles[0] === r;

  return (
    <section aria-labelledby="users-kpi-title">
      <h2 id="users-kpi-title" className="sr-only">{t('users.kpi.title')}</h2>
      <ul className={cn('grid grid-cols-2 gap-3', hasOnline ? 'lg:grid-cols-4 xl:grid-cols-6' : 'lg:grid-cols-3 xl:grid-cols-5')}>
        {/* Total = "show everyone": it lifts status, online and roles (the search stays). */}
        <KpiTile icon={Users} label={t('users.kpi.total')} value={f.int(counts.total)} sub={t('users.kpi.totalSub')}
          className={cn(!hasOnline && 'col-span-2 lg:col-span-1')}
          onClick={() => onFilters({ status: 'all', online: false, roles: [] })} />
        <KpiTile icon={CircleCheck} label={t('users.filter.active')} value={f.int(counts.active)} sub={share(counts.active)}
          tone={STATUS_TEXT.good} pressed={filters.status === 'active'}
          onClick={() => onFilters({ status: filters.status === 'active' ? 'all' : 'active' })} />
        <KpiTile icon={CirclePause} label={t('users.filter.suspended')} value={f.int(counts.suspended)} sub={share(counts.suspended)}
          tone={counts.suspended > 0 ? STATUS_TEXT.critical : undefined} pressed={filters.status === 'suspended'}
          onClick={() => onFilters({ status: filters.status === 'suspended' ? 'all' : 'suspended' })} />
        {hasOnline && (
          <KpiTile icon={Circle} iconClass="fill-emerald-500 text-emerald-500" label={t('users.kpi.online')}
            value={f.int(counts.online ?? 0)} sub={t('users.kpi.onlineSub')} pressed={filters.online}
            onClick={() => onFilters({ online: !filters.online })} />
        )}

        <li className="col-span-2 flex min-w-0 flex-col gap-2 rounded-xl border bg-card p-3 shadow-sm lg:col-span-full xl:col-span-2">
          <span className="text-[11px] font-medium leading-tight text-muted-foreground">{t('users.kpi.byRole')}</span>
          <ul className="grid grid-cols-2 gap-1 sm:grid-cols-3 xl:grid-cols-2">
            {roleChips(counts.roles).map((r) => {
              const Icon = roleIcon(r);
              const on = onlyRole(r);
              return (
                <li key={r} className="min-w-0">
                  <button type="button" aria-pressed={on} onClick={() => onFilters({ roles: on ? [] : [r] })}
                    className={cn(
                      'flex min-h-9 w-full min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-xs transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:min-h-0',
                      on && 'bg-muted font-medium',
                    )}>
                    <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="min-w-0 flex-1 break-words leading-tight">{roleLabel(r)}</span>
                    <span className="font-semibold tabular-nums">{f.int(counts.roles[r])}</span>
                    {on && <Check className="h-3 w-3 shrink-0" aria-hidden />}
                  </button>
                </li>
              );
            })}
          </ul>
        </li>
      </ul>
    </section>
  );
}

function KpiTile({ icon: Icon, iconClass, label, value, sub, tone, pressed, onClick, className }: {
  icon: LucideIcon; iconClass?: string; label: string; value: ReactNode; sub?: ReactNode; tone?: string;
  /** Omitted = a plain action (no on/off state). */
  pressed?: boolean; onClick: () => void; className?: string;
}) {
  return (
    <li className={cn('min-w-0', className)}>
      <button type="button" aria-pressed={pressed} onClick={onClick}
        className={cn(
          'flex h-full w-full min-w-0 flex-col gap-0.5 rounded-xl border bg-card p-3 text-left shadow-sm transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          pressed && 'border-foreground/60 bg-muted/60',
        )}>
        <span className="flex w-full items-start gap-1.5 text-[11px] font-medium leading-tight text-muted-foreground">
          <Icon className={cn('h-3.5 w-3.5 shrink-0', iconClass)} aria-hidden />
          <span className="min-w-0 break-words">{label}</span>
          {pressed && <Check className="ml-auto h-3 w-3 shrink-0 text-foreground" aria-hidden />}
        </span>
        <span className={cn('text-2xl font-semibold leading-tight tabular-nums', tone ?? 'text-card-foreground')}>{value}</span>
        {sub && <span className="text-[11px] leading-snug text-muted-foreground">{sub}</span>}
      </button>
    </li>
  );
}
