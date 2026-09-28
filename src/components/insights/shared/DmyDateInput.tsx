import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CalendarDays } from 'lucide-react';
import type { Locale } from 'date-fns';
import { bg, enGB, mk, sq } from 'date-fns/locale';
import { Calendar } from '@/components/ui/calendar';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { formatDmy, isYmd, parseDmy } from './period';

const DATE_LOCALE: Record<string, Locale> = { mk, sq, bg, en: enGB };

/** A local-midnight Date for a YYYY-MM-DD (what the calendar grid shows). */
const toDate = (ymd: string | null | undefined): Date | undefined => {
  if (!ymd || !isYmd(ymd)) return undefined;
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(y, m - 1, d);
};
const fromDate = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/**
 * One day, written and read as dd.mm.yyyy. Not `<input type="date">`: the
 * browser renders that in ITS locale (mm/dd/yyyy on an English Windows), which
 * is how "01.09" turned into January 9th. The operator types a day
 * (28.09.2026, 28.9.26, 28/09/2026) or picks it from a Monday-first calendar.
 *
 * `value` / `onChange` are YYYY-MM-DD; onChange(null) while the text is not a day.
 */
export function DmyDateInput({
  value, onChange, label, min, max, invalid, className,
}: {
  value: string | null;
  onChange: (ymd: string | null) => void;
  label: string;
  min?: string;
  max?: string;
  /** Show the field as wrong (e.g. the pair is reversed / out of range). */
  invalid?: boolean;
  className?: string;
}) {
  const { t, i18n } = useTranslation();
  const id = useId();
  const [text, setText] = useState(formatDmy(value));
  const [open, setOpen] = useState(false);
  // Follow a value set from outside (a preset, the calendar), but never
  // rewrite what the operator is halfway through typing.
  useEffect(() => {
    if (parseDmy(text) !== value) setText(formatDmy(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const parsed = parseDmy(text);
  const outOfRange = !!parsed && ((min && parsed < min) || (max && parsed > max));
  const bad = invalid || (text.trim() !== '' && (!parsed || !!outOfRange));

  const type = (s: string) => {
    setText(s);
    const p = parseDmy(s);
    onChange(p && !(min && p < min) && !(max && p > max) ? p : null);
  };

  return (
    <div className={cn('flex flex-col gap-1 text-[11px] text-muted-foreground', className)}>
      <label htmlFor={id}>{label}</label>
      <div className="flex items-center">
        <Input
          id={id}
          value={text}
          onChange={(e) => type(e.target.value)}
          onBlur={() => { if (parsed) setText(formatDmy(parsed)); }}
          inputMode="numeric"
          autoComplete="off"
          placeholder={t('insights.common.period.placeholder')}
          aria-invalid={bad || undefined}
          className={cn(
            'h-8 w-[118px] rounded-r-none text-xs tabular-nums',
            bad && 'border-red-500 focus-visible:ring-red-500 dark:border-red-400',
          )}
        />
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label={t('insights.common.period.openCalendar', { label })}
              className="inline-flex h-8 w-8 items-center justify-center rounded-r-md border border-l-0 border-input bg-background text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <CalendarDays className="h-4 w-4" aria-hidden />
            </button>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-0" align="start">
            <Calendar
              mode="single"
              locale={DATE_LOCALE[i18n.language] ?? mk}
              weekStartsOn={1}
              selected={toDate(parsed ?? value)}
              defaultMonth={toDate(parsed ?? value ?? max)}
              fromDate={toDate(min)}
              toDate={toDate(max)}
              onSelect={(d) => {
                if (!d) return;
                const ymd = fromDate(d);
                setText(formatDmy(ymd));
                onChange(ymd);
                setOpen(false);
              }}
              initialFocus
            />
          </PopoverContent>
        </Popover>
      </div>
    </div>
  );
}
