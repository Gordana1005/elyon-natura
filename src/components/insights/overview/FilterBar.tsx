import { Check } from 'lucide-react';
import type { OverviewSourceKey } from '@/lib/api';
import { cn } from '@/lib/utils';
import { SOURCE_ORDER, sourceColorVar } from './palette';
import type { OverviewFilters } from './model';
import type { OverviewFormat } from './useOverviewFormat';

const chip = 'inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
const chipOff = 'bg-card text-foreground hover:bg-muted';

/**
 * The Overview's own chips — sources and teams. The PERIOD (presets, custom
 * days, compare) is the page's one InsightsFilterBar, shared by every tab
 * (../shared/useInsightsPeriod), so a tab switch keeps it.
 */
export function FilterBar({
  filters, onChange, teams, f,
}: {
  filters: OverviewFilters;
  onChange: (next: Partial<OverviewFilters>) => void;
  teams: { key: string; name: string }[];
  f: OverviewFormat;
}) {
  const { t } = f;
  const toggleIn = <T extends string>(list: T[], v: T): T[] => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  return (
    <div className="rounded-xl border bg-card/80 px-3 py-2 shadow-sm">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div role="group" aria-label={t('overview.sourcesLabel')} className="flex flex-wrap items-center gap-1.5">
          <span className="mr-0.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{t('overview.sourcesLabel')}</span>
          {SOURCE_ORDER.map((s: OverviewSourceKey) => {
            const on = filters.sources.includes(s);
            return (
              <button key={s} type="button" aria-pressed={on} onClick={() => onChange({ sources: toggleIn(filters.sources, s) })}
                className={cn(chip, on ? 'border-foreground/60 bg-muted' : chipOff)}>
                <span className="h-[3px] w-3 rounded-full" style={{ background: sourceColorVar(s) }} aria-hidden />
                {f.source(s)}
                {on && <Check className="h-3 w-3" aria-hidden />}
              </button>
            );
          })}
          {filters.sources.length > 0 && (
            <button type="button" onClick={() => onChange({ sources: [] })} className="text-xs text-muted-foreground underline-offset-2 hover:underline">
              {t('overview.allSources')}
            </button>
          )}
        </div>
        {teams.length > 0 && (
          <div role="group" aria-label={t('overview.teamsLabel')} className="flex flex-wrap items-center gap-1.5">
            <span className="mr-0.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{t('overview.teamsLabel')}</span>
            {teams.map((tm) => {
              const on = filters.teams.includes(tm.key);
              return (
                <button key={tm.key} type="button" aria-pressed={on} onClick={() => onChange({ teams: toggleIn(filters.teams, tm.key) })}
                  className={cn(chip, on ? 'border-foreground/60 bg-muted' : chipOff)}>
                  {tm.name}
                  {on && <Check className="h-3 w-3" aria-hidden />}
                </button>
              );
            })}
            {filters.teams.length > 0 && (
              <button type="button" onClick={() => onChange({ teams: [] })} className="text-xs text-muted-foreground underline-offset-2 hover:underline">
                {t('overview.allTeams')}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
