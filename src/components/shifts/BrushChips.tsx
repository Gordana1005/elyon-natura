import { useTranslation } from 'react-i18next';
import { Check, Eraser } from 'lucide-react';
import { cn } from '@/lib/utils';
import { CHIP } from '@/components/assigner/parts';
import { NEUTRAL_TONE, type Brush } from './model';

/**
 * The brushes as chips: every template, the custom windows in use (a month roll's
 * 07:00–21:00 …) and the "Слободен" eraser. Used as the grid's paint brush (md+) and in the
 * phone's pick sheet. Each chip says its hours, so colour is never the only channel.
 */
export function BrushChips({ brushes, tones, selected, onSelect, className }: {
  brushes: Brush[];
  tones: ReadonlyMap<string, string>;
  selected: string | null;
  onSelect: (key: string) => void;
  className?: string;
}) {
  const { t } = useTranslation();
  const all: Brush[] = [...brushes, { key: 'off', kind: 'off' }];
  return (
    <div role="group" aria-label={t('shiftsPage.grid.brushes')} className={cn('flex flex-wrap items-center gap-1.5', className)}>
      {all.map((b) => {
        const on = selected === b.key;
        const tone = b.kind === 'off' ? 'border-dashed bg-card text-foreground' : tones.get(b.key) ?? NEUTRAL_TONE;
        return (
          <button key={b.key} type="button" aria-pressed={on} onClick={() => onSelect(b.key)}
            data-brush={b.key}
            className={cn(CHIP, 'border', tone, on && 'ring-2 ring-foreground ring-offset-1 ring-offset-background')}>
            {b.kind === 'off' ? (
              <><Eraser className="h-3.5 w-3.5 shrink-0" aria-hidden />{t('shiftsPage.grid.off')}</>
            ) : (
              <>
                {b.name && <span className="max-w-[10rem] truncate">{b.name}</span>}
                <span className="tabular-nums opacity-80">{b.start}–{b.end}</span>
              </>
            )}
            {on && <Check className="h-3 w-3 shrink-0" aria-hidden />}
          </button>
        );
      })}
    </div>
  );
}
