import { useEffect, useRef, useState } from 'react';
import { format, subDays, subMonths, subYears } from 'date-fns';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';

// Shared date-range control for the Dashboard and Management Insights.
// `from`/`to` are `YYYY-MM-DD`; both empty means "all time" (no bound).
export interface DateRange { from: string; to: string }

const iso = (d: Date) => format(d, 'yyyy-MM-dd');
const today = () => iso(new Date());

type PresetDef = { key: string; labelKey: string; range: () => DateRange };

const todayRange = (): DateRange => ({ from: today(), to: today() });
// Inclusive last-N-days (Today counts as day 1).
const lastDays = (n: number): DateRange => ({ from: iso(subDays(new Date(), n - 1)), to: today() });
const lastMonths = (n: number): DateRange => ({ from: iso(subMonths(new Date(), n)), to: today() });
const lastYears = (n: number): DateRange => ({ from: iso(subYears(new Date(), n)), to: today() });

// Always-visible quick buttons.
const QUICK: PresetDef[] = [
  { key: 'today', labelKey: 'dateRange.today', range: todayRange },
  { key: '7d', labelKey: 'dateRange.d7', range: () => lastDays(7) },
  { key: '1mo', labelKey: 'dateRange.mo1', range: () => lastMonths(1) },
];

// Longer ranges, tucked into the "More" dropdown.
const MORE: PresetDef[] = [
  { key: '3d', labelKey: 'dateRange.last3d', range: () => lastDays(3) },
  { key: '2w', labelKey: 'dateRange.last2w', range: () => lastDays(14) },
  { key: '2mo', labelKey: 'dateRange.last2mo', range: () => lastMonths(2) },
  { key: '3mo', labelKey: 'dateRange.last3mo', range: () => lastMonths(3) },
  { key: '6mo', labelKey: 'dateRange.last6mo', range: () => lastMonths(6) },
  { key: '12mo', labelKey: 'dateRange.last12mo', range: () => lastMonths(12) },
  { key: '2y', labelKey: 'dateRange.last2y', range: () => lastYears(2) },
  { key: '3y', labelKey: 'dateRange.last3y', range: () => lastYears(3) },
];

/** The default range every consumer should start on. */
export const defaultRange = (): DateRange => todayRange();

// `<input type="date">` fires onChange on EVERY keystroke, and every intermediate
// value is a valid date: typing "2025" into the year box emits 0002-…, 0020-…,
// 0202-… before 2025-…. Each one used to fire a full re-query, and the first three
// span two millennia — i.e. three accidental all-time aggregates racing the one the
// operator actually wanted. So: keep the typed value local, never propagate a year
// before 2000, and wait for typing to settle. Preset buttons still apply instantly.
const COMMIT_DELAY_MS = 400;
const plausible = (d: string) => !d || Number(d.slice(0, 4)) >= 2000;

export function DateRangePicker({ value, onChange, className, simple = false }: {
  value: DateRange;
  onChange: (r: DateRange) => void;
  className?: string;
  /** Compact set (Insights): Today, 1 month, and a from–to range only. */
  simple?: boolean;
}) {
  const { t } = useTranslation();

  // What the two date boxes show while the operator is still typing. Re-syncs
  // whenever the range changes from outside (a preset button, or a reset).
  const [draft, setDraft] = useState<DateRange>(value);
  useEffect(() => { setDraft(value); }, [value.from, value.to]);

  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(timer.current), []);

  const typeRange = (next: DateRange) => {
    setDraft(next);
    clearTimeout(timer.current);
    if (!plausible(next.from) || !plausible(next.to)) return;   // still mid-year
    // Clearing ONE box must not commit a half-open range — that silently means
    // "all time" with no visual hint. Keep it as a draft; a full range (or a
    // deliberate clear of BOTH boxes) still commits.
    if (!next.from !== !next.to) return;
    timer.current = setTimeout(() => onChange(next), COMMIT_DELAY_MS);
  };

  const isAllTime = !value.from && !value.to;
  const matches = (def: PresetDef) => {
    const r = def.range();
    return r.from === value.from && r.to === value.to;
  };
  const activeKey = isAllTime ? 'all' : ([...QUICK, ...MORE].find(matches)?.key ?? 'custom');
  const moreActive = MORE.some(m => m.key === activeKey);

  // simple → Today + 1 month + from/to (wraps to fit a phone). Full → the swipe
  // strip used on the Dashboard (rides inside a parent ScrollStrip on mobile).
  const quick = simple ? QUICK.filter(p => p.key !== '7d') : QUICK;

  return (
    <div className={cn(simple ? 'flex flex-wrap items-center gap-1.5' : 'flex items-center gap-1.5 shrink-0 md:flex-wrap', className)}>
      {quick.map(p => (
        <Button key={p.key} size="sm" variant={activeKey === p.key ? 'default' : 'outline'}
          className="h-8 text-xs shrink-0" onClick={() => onChange(p.range())}>
          {t(p.labelKey)}
        </Button>
      ))}

      {!simple && (
        <Select value={moreActive ? activeKey : ''}
          onValueChange={k => { const def = MORE.find(m => m.key === k); if (def) onChange(def.range()); }}>
          <SelectTrigger className={cn('h-8 w-[130px] text-xs shrink-0', moreActive && 'border-primary text-primary')}>
            <SelectValue placeholder={t('common.moreRanges')} />
          </SelectTrigger>
          <SelectContent>
            {MORE.map(m => <SelectItem key={m.key} value={m.key} className="text-xs">{t(m.labelKey)}</SelectItem>)}
          </SelectContent>
        </Select>
      )}

      <div className="flex items-center gap-1 shrink-0">
        <Input type="date" value={draft.from} max={draft.to || undefined}
          onChange={e => typeRange({ from: e.target.value, to: draft.to || e.target.value })}
          className="h-8 w-[140px] text-xs" />
        <span className="text-muted-foreground text-xs">–</span>
        <Input type="date" value={draft.to} min={draft.from || undefined}
          onChange={e => typeRange({ from: draft.from || e.target.value, to: e.target.value })}
          className="h-8 w-[140px] text-xs" />
      </div>

      {!simple && (
        <Button size="sm" variant={isAllTime ? 'default' : 'outline'}
          className="h-8 text-xs shrink-0" onClick={() => onChange({ from: '', to: '' })}>
          {t('dateRange.allTime')}
        </Button>
      )}
    </div>
  );
}
