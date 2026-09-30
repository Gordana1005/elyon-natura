import { useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowDown, ArrowUp, Check, Circle, Search, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useIsMobile } from '@/hooks/use-mobile';
import {
  USER_SORT_KEYS, defaultDir, hasActiveFilters, highlightParts, roleChips,
  type UserFilterState, type UserSort, type UserSortKey, type UserStatusFilter,
} from '@/lib/users/filterUsers';
import { roleIcon, roleLabel } from './roleMeta';

// The chips of the Insights filter bars: a single choice is a filled chip
// (InsightsFilterBar's period presets), a multi-select chip is muted + a check
// (insights/overview/FilterBar.tsx).
// 36 px tall on phones and tablets (touch), the Insights 32 px from lg.
const chip = 'inline-flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:h-8';
const chipOne = 'border-foreground/80 bg-foreground text-background';
const chipMany = 'border-foreground/60 bg-muted';
const chipOff = 'bg-card text-foreground hover:bg-muted';
const groupLabel = 'text-[11px] font-medium uppercase tracking-wide text-muted-foreground';

const STATUSES: UserStatusFilter[] = ['all', 'active', 'suspended'];

interface UserFiltersProps {
  filters: UserFilterState;
  onQueryChange: (query: string) => void;
  onFilters: (next: Partial<Omit<UserFilterState, 'query'>>) => void;
  onClear: () => void;
  sort: UserSort;
  onSort: (sort: UserSort) => void;
  /** roleCounts() of ALL users — a chip's number does not move as you type. */
  counts: Record<string, number>;
  shown: number;
  total: number;
  /** The payload carries last_seen_at: offer "online only" and the last-activity sort. */
  hasPresence: boolean;
}

/**
 * The toolbar above the user list: search (name / e-mail, Cyrillic or Latin;
 * Esc clears), status, online only, sort, "N од M", clear, and one chip per
 * role (several = anyone holding one of them). Presentational — the state lives
 * in the URL (useUserFilterParams), the matching in lib/users/filterUsers.ts.
 */
export function UserFilters({
  filters, onQueryChange, onFilters, onClear, sort, onSort, counts, shown, total, hasPresence,
}: UserFiltersProps) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const isMobile = useIsMobile();
  const chips = roleChips(counts, filters.roles);
  const active = hasActiveFilters(filters);
  const sortKeys = USER_SORT_KEYS.filter((k) => hasPresence || k !== 'last');

  // Focus the search on a desktop only: on a phone the keyboard would cover the list.
  useEffect(() => {
    if (window.matchMedia?.('(min-width: 768px) and (pointer: fine)').matches) {
      inputRef.current?.focus({ preventScroll: true });
    }
  }, []);

  const toggleRole = (r: string) =>
    onFilters({ roles: filters.roles.includes(r) ? filters.roles.filter((x) => x !== r) : [...filters.roles, r] });

  return (
    <div role="search" aria-label={t('settings.searchNameEmail')} className="space-y-2 rounded-xl border bg-card/80 p-3 shadow-sm">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="relative min-w-0 basis-full sm:basis-auto sm:flex-1 lg:max-w-xl">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <input
            ref={inputRef}
            type="search"
            value={filters.query}
            onChange={(e) => onQueryChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && filters.query) {
                e.preventDefault();
                onQueryChange('');
              }
            }}
            placeholder={isMobile ? t('users.filter.searchShort') : t('settings.searchNameEmail')}
            aria-label={t('settings.searchNameEmail')}
            autoComplete="off"
            spellCheck={false}
            enterKeyHint="search"
            className={cn(
              // 16 px below md: iOS Safari zooms into any smaller input on focus.
              'h-9 w-full rounded-lg border bg-background pl-8 text-base focus:outline-none focus:ring-2 focus:ring-ring md:text-sm [&::-webkit-search-cancel-button]:hidden',
              filters.query ? 'pr-9' : 'pr-3',
            )}
          />
          {filters.query && (
            <button
              type="button"
              onClick={() => { onQueryChange(''); inputRef.current?.focus(); }}
              aria-label={t('users.filter.clearSearch')}
              title={t('users.filter.clearSearch')}
              className="absolute right-0 top-0 flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X className="h-3.5 w-3.5" aria-hidden />
            </button>
          )}
        </div>

        <div className="ml-auto flex shrink-0 items-center gap-3">
          <span className="text-xs tabular-nums text-muted-foreground" aria-live="polite" data-testid="users-shown">
            {t('users.filter.shown', { shown, total })}
          </span>
          {active && (
            <button
              type="button"
              onClick={onClear}
              className="inline-flex h-9 items-center gap-1.5 whitespace-nowrap rounded-lg border px-3 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:h-8"
            >
              <X className="h-3.5 w-3.5" aria-hidden />
              {t('settings.clearFilters')}
            </button>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div role="group" aria-label={t('settings.colStatus')} className="flex flex-wrap items-center gap-1.5">
          <span className={cn(groupLabel, 'mr-0.5')}>{t('settings.colStatus')}</span>
          {STATUSES.map((s) => (
            <button key={s} type="button" aria-pressed={filters.status === s} onClick={() => onFilters({ status: s })}
              className={cn(chip, filters.status === s ? chipOne : chipOff)}>
              {t(`users.filter.${s}`)}
            </button>
          ))}
          {hasPresence && (
            <button type="button" aria-pressed={filters.online} onClick={() => onFilters({ online: !filters.online })}
              className={cn(chip, filters.online ? chipMany : chipOff)}>
              <Circle className="h-2.5 w-2.5 fill-emerald-500 text-emerald-500" aria-hidden />
              {t('users.filter.online')}
              {filters.online && <Check className="h-3 w-3" aria-hidden />}
            </button>
          )}
        </div>

        <div className="flex min-w-0 basis-full items-center gap-1.5 sm:ml-auto sm:basis-auto">
          <label htmlFor="users-sort" className={cn(groupLabel, 'shrink-0')}>{t('users.filter.sort')}</label>
          <select
            id="users-sort"
            value={sort.key}
            onChange={(e) => { const key = e.target.value as UserSortKey; onSort({ key, dir: defaultDir(key) }); }}
            className="h-9 min-w-0 flex-1 rounded-lg border bg-background px-2 text-xs focus:outline-none focus:ring-2 focus:ring-ring sm:flex-none lg:h-8"
          >
            {sortKeys.map((k) => <option key={k} value={k}>{t(`users.filter.sortBy.${k}`)}</option>)}
          </select>
          <button
            type="button"
            onClick={() => onSort({ key: sort.key, dir: sort.dir === 'asc' ? 'desc' : 'asc' })}
            aria-label={sort.dir === 'asc' ? t('users.filter.asc') : t('users.filter.desc')}
            title={sort.dir === 'asc' ? t('users.filter.asc') : t('users.filter.desc')}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border bg-background text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:h-8 lg:w-8"
          >
            {sort.dir === 'asc' ? <ArrowUp className="h-3.5 w-3.5" aria-hidden /> : <ArrowDown className="h-3.5 w-3.5" aria-hidden />}
          </button>
        </div>

      </div>

      {chips.length > 0 && (
        // On a phone the chips scroll inside their own row (no scrollbar shown); from md they wrap.
        <div role="group" aria-label={t('usersPage.colRoles')}
          className="-mx-3 flex items-center gap-1.5 overflow-x-auto px-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden md:mx-0 md:flex-wrap md:overflow-visible md:px-0">
          <span className={cn(groupLabel, 'mr-0.5 shrink-0')}>{t('usersPage.colRoles')}</span>
          {chips.map((r) => {
            const on = filters.roles.includes(r);
            const Icon = roleIcon(r);
            return (
              <button key={r} type="button" aria-pressed={on} onClick={() => toggleRole(r)} className={cn(chip, on ? chipMany : chipOff)}>
                <Icon className="h-3 w-3" aria-hidden />
                {roleLabel(r)}
                <span className="tabular-nums text-muted-foreground">{counts[r] ?? 0}</span>
                {on && <Check className="h-3 w-3" aria-hidden />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** `text` with the stretches the search matched marked (Cyrillic or Latin). */
export function HighlightMatch({ text, query }: { text: string | null | undefined; query: string }) {
  const parts = useMemo(() => highlightParts(text, query), [text, query]);
  if (!query.trim()) return <>{text}</>;
  return (
    <>
      {parts.map((p, i) => (p.hit
        ? <mark key={i} className="rounded-sm bg-amber-200/70 text-inherit dark:bg-amber-500/30">{p.text}</mark>
        : <span key={i}>{p.text}</span>))}
    </>
  );
}
