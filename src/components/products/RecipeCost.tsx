import { useTranslation } from 'react-i18next';
import { ChefHat } from 'lucide-react';
import { formatDenari } from '@/lib/currency';
import { cn } from '@/lib/utils';
import { recipeStatusOf, sigmaCostMkd, type RecipeFields } from './recipe';

const TONE: Record<string, string> = {
  approved: 'text-emerald-700 dark:text-emerald-400',
  exempt: 'text-muted-foreground',
  proposed: 'text-amber-800 dark:text-amber-300',
  none: 'text-amber-800 dark:text-amber-300',
};

/**
 * "Набавна (Сигма)" of one product (owners only): its Sigma purchase cost in денари and, when the
 * catalogue says so, its recipe status — the whole cell opens the recipe drawer. "—" = no cost yet
 * (no approved recipe or an article without a Sigma price), never a made-up 0.
 */
export function RecipeCost({ r, onOpen, align = 'right' }: {
  r: RecipeFields & { name: string };
  onOpen: () => void;
  align?: 'right' | 'left';
}) {
  const { t } = useTranslation();
  const cost = sigmaCostMkd(r);
  const status = recipeStatusOf(r);
  return (
    <button type="button" onClick={onOpen} data-testid="recipe-cost"
      aria-label={t('productsRecipe.open', { name: r.name })} title={t('productsRecipe.open', { name: r.name })}
      className={cn('group inline-flex min-h-9 min-w-0 flex-col justify-center rounded-md px-1.5 py-0.5 transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        align === 'right' ? 'items-end text-right' : 'items-start text-left')}>
      <span className={cn('tabular-nums', cost == null ? 'text-muted-foreground' : 'text-foreground')}>
        {cost == null ? '—' : formatDenari(cost)}
      </span>
      <span className={cn('inline-flex items-center gap-1 text-[10px] font-medium leading-tight', status ? TONE[status] : 'text-muted-foreground')}>
        <ChefHat className="h-3 w-3" aria-hidden />
        {status ? t(`productsRecipe.status.${status}`) : t('productsRecipe.recipe')}
      </span>
    </button>
  );
}
