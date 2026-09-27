import { useEffect, useState } from 'react';
import { Check, Loader2 } from 'lucide-react';
import type { OverviewSourceKey } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { SOURCE_ORDER, sourceColorVar } from './palette';
import { MAX_SPAN_DAYS, RANGE_PRESETS, addDays, isYmd, presetRange, type OverviewFilters, type RangePreset } from './model';
import type { OverviewFormat } from './useOverviewFormat';

const chip = 'inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
const chipOn = 'border-foreground/80 bg-foreground text-background';
const chipOff = 'bg-card text-foreground hover:bg-muted';

/**
 * The ONE filter row: it scopes every block below it. Period presets are the
 * shop panel's (rolling 1 / 7 / 30 / 365 days, Skopje), then compare, sources, teams.
 */
export function FilterBar({
  filters, onChange, today, teams, fetching, slowSecs, onCancel, f,
}: {
  filters: OverviewFilters;
  onChange: (next: Partial<OverviewFilters>) => void;
  today: string;
  teams: { key: string; name: string }[];
  fetching: boolean;
  slowSecs: number;
  onCancel: () => void;
  f: OverviewFormat;
}) {
  const { t } = f;
  const [showCustom, setShowCustom] = useState(filters.preset === 'custom');
  const [draft, setDraft] = useState(filters.range);
  useEffect(() => { setDraft(filters.range); }, [filters.range.from, filters.range.to]);
  useEffect(() => { if (filters.preset === 'custom') setShowCustom(true); }, [filters.preset]);

  const pickPreset = (p: RangePreset) => {
    if (p === 'custom') { setShowCustom(true); return; }
    setShowCustom(false);
    onChange({ preset: p, range: presetRange(p, today) });
  };
  const applyCustom = (e: React.FormEvent) => {
    e.preventDefault();
    if (!isYmd(draft.from) || !isYmd(draft.to)) return;
    onChange({ preset: 'custom', range: presetRange('custom', today, draft) });
  };
  const toggleIn = <T extends string>(list: T[], v: T): T[] => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  return (
    <div className="space-y-2 rounded-xl border bg-card/80 p-3 shadow-sm backdrop-blur-sm">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div role="group" aria-label={t('overview.range.label')} className="flex flex-wrap gap-1.5">
          {RANGE_PRESETS.map((p) => {
            const active = p === 'custom' ? (filters.preset === 'custom' || showCustom) : filters.preset === p && !showCustom;
            return (
              <button key={p} type="button" aria-pressed={active} onClick={() => pickPreset(p)} className={cn(chip, active ? chipOn : chipOff)}>
                {t(`overview.range.${p}`)}
              </button>
            );
          })}
        </div>
        <span className="text-xs tabular-nums text-muted-foreground">{f.period(filters.range.from, filters.range.to)}</span>
        <label className="flex items-center gap-2 text-xs">
          <Switch checked={filters.compare} onCheckedChange={(v) => onChange({ compare: v })} aria-label={t('overview.compare')} />
          <span>{t('overview.compare')}</span>
        </label>
        <div className="ml-auto flex min-h-8 items-center gap-2 text-xs text-muted-foreground" aria-live="polite">
          {fetching && slowSecs >= 3 ? (
            <>
              <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden />
              <span>{t('insights.slowLoading', { s: slowSecs })}</span>
              <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={onCancel}>{t('common.cancel')}</Button>
            </>
          ) : fetching ? (
            <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-label={t('overview.refreshing')} />
          ) : null}
        </div>
      </div>

      {showCustom && (
        <form onSubmit={applyCustom} className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
            {t('overview.range.from')}
            <Input type="date" value={draft.from} max={today} min={addDays(today, -3 * 365)}
              onChange={(e) => setDraft((d) => ({ ...d, from: e.target.value }))} className="h-8 w-[150px] text-xs" />
          </label>
          <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
            {t('overview.range.to')}
            <Input type="date" value={draft.to} max={today}
              onChange={(e) => setDraft((d) => ({ ...d, to: e.target.value }))} className="h-8 w-[150px] text-xs" />
          </label>
          <Button type="submit" size="sm" className="h-8">{t('overview.range.apply')}</Button>
          <span className="text-[11px] text-muted-foreground">{t('overview.range.maxSpan', { n: MAX_SPAN_DAYS })}</span>
        </form>
      )}

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
