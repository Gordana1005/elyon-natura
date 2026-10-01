import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Boxes, CheckCircle2, Loader2, Plus, Search, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { useToast } from '@/hooks/use-toast';
import { apiErrorText } from '@/i18n/apiErrors';
import { formatDenari } from '@/lib/currency';
import { cn } from '@/lib/utils';
import type { ProductRecipe, StockArticleRow } from '@/lib/stockV2Types';
import {
  draftBody, draftChanged, draftCost, draftFrom, hasProposal, parseQty, RECIPE_ROLES, validateDraft, type DraftLine, type RecipeRole,
} from './recipe';
import { apiProductRecipe, apiProductRecipeApprove, apiProductRecipeSet, apiStockArticlesSearch } from './recipeApi';

/** A unit cost: whole денари from 100 up, two decimals below (packaging, small components). */
const unitDen = (v: number | null | undefined) => {
  if (v == null) return '—';
  if (Math.abs(v) >= 100) return formatDenari(v);
  return `${v.toFixed(2).replace('.', ',')} ден`;
};

const STATUS_TONE: Record<string, string> = {
  approved: 'border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300',
  proposed: 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-300',
  none: 'border-dashed border-border bg-muted/40 text-muted-foreground',
};

/**
 * Рецепт (owners, Stock v2 — owner 01.10.2026): which Sigma articles a product is made of and what it
 * costs. A single product = its own article × 1; a bundle = its components; a gift packed with it =
 * role "подарок" (a real cost). Each line shows its Sigma CalcBuyPrice; the product's cost = Σ qty ×
 * unit cost (complete only when every article has a cost). Save as a proposal, save and approve, or
 * approve a waiting proposal as it is — only an APPROVED recipe moves stock and cost. The routes
 * (products/:id/articles, products/articles, products/articles/approve) are audited server-side.
 * A sheet from the right, full width on a phone; lines are cards (no table, no sideways scroll).
 */
export function RecipeDrawer({ product, open, onOpenChange, onChanged }: {
  product: { id: string; name: string } | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** After a save / approve: the recipe as the server now holds it. */
  onChanged?: (productId: string, recipe: ProductRecipe) => void;
}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  const [recipe, setRecipe] = useState<ProductRecipe | null>(null);
  const [draft, setDraft] = useState<DraftLine[]>([]);
  const [qtyText, setQtyText] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<'propose' | 'approve' | 'approveAsIs' | null>(null);
  const [tried, setTried] = useState(false);
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<StockArticleRow[]>([]);
  const [searching, setSearching] = useState(false);
  const searchAbort = useRef<AbortController | null>(null);

  const reset = useCallback((r: ProductRecipe | null) => {
    setRecipe(r);
    const d = draftFrom(r);
    setDraft(d);
    setQtyText(Object.fromEntries(d.map((l) => [l.code, String(l.qty)])));
    setTried(false);
  }, []);

  const load = useCallback((id: string, signal?: AbortSignal) => {
    setPhase('loading');
    apiProductRecipe(id, signal)
      .then((r) => { reset(r); setPhase('ready'); })
      .catch((err: unknown) => {
        if (signal?.aborted) return;
        setError(err instanceof Error && /^HTTP 404$|not found/i.test(err.message) ? t('productsRecipe.drawer.notDeployed') : apiErrorText(err));
        setPhase('error');
      });
  }, [reset, t]);

  useEffect(() => {
    if (!open || !product) return;
    const ac = new AbortController();
    setQ('');
    setHits([]);
    load(product.id, ac.signal);
    return () => ac.abort();
  }, [open, product, load]);

  // the article search (debounced; 2+ characters)
  useEffect(() => {
    const term = q.trim();
    searchAbort.current?.abort();
    if (term.length < 2) { setHits([]); setSearching(false); return; }
    const ac = new AbortController();
    searchAbort.current = ac;
    setSearching(true);
    const h = setTimeout(() => {
      apiStockArticlesSearch(term, ac.signal)
        .then((rows) => { if (!ac.signal.aborted) setHits((rows ?? []).slice(0, 8)); })
        .catch(() => { if (!ac.signal.aborted) setHits([]); })
        .finally(() => { if (!ac.signal.aborted) setSearching(false); });
    }, 250);
    return () => { clearTimeout(h); ac.abort(); };
  }, [q]);

  const base = useMemo(() => draftFrom(recipe), [recipe]);
  const changed = draftChanged(base, draft);
  const cost = draftCost(draft);
  const invalid = validateDraft(draft);
  const status: 'approved' | 'proposed' | 'none' = !recipe ? 'none'
    : recipe.lines.some((l) => l.status === 'approved') ? 'approved' : hasProposal(recipe) ? 'proposed' : 'none';

  const setLine = (code: string, patch: Partial<DraftLine>) =>
    setDraft((d) => d.map((l) => (l.code === code ? { ...l, ...patch } : l)));
  const removeLine = (code: string) => setDraft((d) => d.filter((l) => l.code !== code));
  const addArticle = (a: StockArticleRow) => {
    setDraft((d) => (d.some((l) => l.code === a.code) ? d
      : [...d, { code: a.code, name: a.name, qty: 1, role: d.length ? 'component' : 'main', cost_mkd: a.cost_mkd ?? null }]));
    setQtyText((m) => ({ ...m, [a.code]: m[a.code] ?? '1' }));
    setQ('');
    setHits([]);
  };

  const save = async (approve: boolean) => {
    if (!product) return;
    setTried(true);
    if (invalid) return;
    setBusy(approve ? 'approve' : 'propose');
    try {
      // the route answers with the writer's result, not the recipe: read the recipe back
      await apiProductRecipeSet(draftBody(product.id, draft, approve));
      const r = await apiProductRecipe(product.id);
      reset(r);
      onChanged?.(product.id, r);
      toast({ title: approve ? t('productsRecipe.drawer.approvedTitle') : t('productsRecipe.drawer.savedTitle') });
    } catch (err: unknown) {
      toast({ title: t('common.error'), description: apiErrorText(err), variant: 'destructive' });
    } finally { setBusy(null); }
  };

  const approveAsIs = async () => {
    if (!product) return;
    setBusy('approveAsIs');
    try {
      await apiProductRecipeApprove([product.id]);
      const r = await apiProductRecipe(product.id);
      reset(r);
      onChanged?.(product.id, r);
      toast({ title: t('productsRecipe.drawer.approvedTitle') });
    } catch (err: unknown) {
      toast({ title: t('common.error'), description: apiErrorText(err), variant: 'destructive' });
    } finally { setBusy(null); }
  };

  const fact = 'text-[11px] font-medium uppercase tracking-wide text-muted-foreground';

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-lg" data-testid="recipe-drawer">
        <SheetHeader className="space-y-1 border-b p-4 pr-12 text-left">
          <SheetTitle className="break-words text-base">{t('productsRecipe.drawer.title', { name: product?.name ?? '' })}</SheetTitle>
          <SheetDescription className="text-xs">{t('productsRecipe.drawer.subtitle')}</SheetDescription>
        </SheetHeader>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
          {phase === 'loading' ? (
            <div className="space-y-2" aria-busy="true">
              <Skeleton className="h-16 rounded-xl" />
              <Skeleton className="h-16 rounded-xl" />
            </div>
          ) : phase === 'error' ? (
            <div role="alert" className="space-y-2 rounded-xl border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
              <p>{error}</p>
              {product && <Button size="sm" variant="outline" onClick={() => load(product.id)}>{t('common.retry')}</Button>}
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <span className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium', STATUS_TONE[status])}>
                  {status === 'approved' && <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />}
                  {t(`productsRecipe.status.${status}`)}
                </span>
                {recipe?.exempt && <span className="text-xs text-muted-foreground">{t('productsRecipe.drawer.exempt')}</span>}
              </div>

              {draft.length === 0 ? (
                <p className="rounded-xl border border-dashed p-4 text-center text-sm text-muted-foreground">{t('productsRecipe.drawer.empty')}</p>
              ) : (
                <ul className="space-y-2" aria-label={t('productsRecipe.drawer.lines')}>
                  {draft.map((l) => {
                    const lineCost = l.cost_mkd == null ? null : l.cost_mkd * l.qty;
                    const qtyBad = tried && !(l.qty > 0 && l.qty <= 100);
                    return (
                      <li key={l.code} data-recipe-line className="min-w-0 space-y-2 rounded-xl border bg-card p-3 shadow-sm">
                        <div className="flex min-w-0 items-start gap-2">
                          <div className="min-w-0 flex-1">
                            <p className="break-words text-sm font-medium leading-snug">{l.name}</p>
                            <p className="text-xs tabular-nums text-muted-foreground">{l.code}</p>
                          </div>
                          <Button variant="ghost" size="icon" className="h-9 w-9 shrink-0" onClick={() => removeLine(l.code)}
                            aria-label={t('productsRecipe.drawer.remove', { name: l.name })} title={t('productsRecipe.drawer.remove', { name: l.name })}>
                            <Trash2 className="h-4 w-4 text-muted-foreground" aria-hidden />
                          </Button>
                        </div>
                        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                          <label className="min-w-0 space-y-0.5">
                            <span className={fact}>{t('productsRecipe.drawer.qty')}</span>
                            <input inputMode="decimal" value={qtyText[l.code] ?? String(l.qty)}
                              onChange={(e) => { const v = e.target.value; setQtyText((m) => ({ ...m, [l.code]: v })); setLine(l.code, { qty: parseQty(v) }); }}
                              aria-invalid={qtyBad}
                              className={cn('h-9 w-full rounded-md border bg-background px-2 text-base tabular-nums md:text-sm', qtyBad && 'border-red-500')} />
                          </label>
                          <label className="min-w-0 space-y-0.5">
                            <span className={fact}>{t('productsRecipe.drawer.role')}</span>
                            <select value={l.role} onChange={(e) => setLine(l.code, { role: e.target.value as RecipeRole })}
                              className="h-9 w-full rounded-md border bg-background px-1.5 text-sm">
                              {RECIPE_ROLES.map((r) => <option key={r} value={r}>{t(`productsRecipe.role.${r}`)}</option>)}
                            </select>
                          </label>
                          <div className="min-w-0 space-y-0.5">
                            <span className={fact}>{t('productsRecipe.drawer.unitCost')}</span>
                            <p className={cn('h-9 truncate py-2 text-sm tabular-nums', l.cost_mkd == null && 'italic text-amber-800 dark:text-amber-300')}>
                              {l.cost_mkd == null ? t('productsRecipe.drawer.noCost') : unitDen(l.cost_mkd)}
                            </p>
                          </div>
                          <div className="min-w-0 space-y-0.5">
                            <span className={fact}>{t('productsRecipe.drawer.lineCost')}</span>
                            <p className="h-9 truncate py-2 text-sm font-medium tabular-nums">{lineCost == null ? '—' : unitDen(lineCost)}</p>
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}

              <div className="space-y-2">
                <label className="relative block">
                  <span className="sr-only">{t('productsRecipe.drawer.search')}</span>
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
                  <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('productsRecipe.drawer.search')}
                    autoComplete="off" spellCheck={false}
                    className="h-10 w-full rounded-lg border bg-background pl-8 pr-8 text-base focus:outline-none focus:ring-2 focus:ring-ring md:text-sm" />
                  {searching && <Loader2 className="absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground" aria-hidden />}
                </label>
                {hits.length > 0 && (
                  <ul className="space-y-1" aria-label={t('productsRecipe.drawer.results')}>
                    {hits.map((a) => (
                      <li key={a.code}>
                        <button type="button" onClick={() => addArticle(a)} disabled={draft.some((l) => l.code === a.code)}
                          className="flex min-h-10 w-full min-w-0 items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left text-sm transition-colors hover:bg-muted disabled:opacity-50">
                          <Plus className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate">{a.name}</span>
                            <span className="block text-xs tabular-nums text-muted-foreground">{a.code} · {a.unit}</span>
                          </span>
                          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{a.cost_mkd == null ? '—' : unitDen(a.cost_mkd)}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {q.trim().length >= 2 && !searching && hits.length === 0 && (
                  <p className="text-xs text-muted-foreground">{t('productsRecipe.drawer.noResults')}</p>
                )}
              </div>
            </>
          )}
        </div>

        {phase === 'ready' && (
          <div className="space-y-3 border-t bg-card p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="flex items-center gap-1.5 text-sm text-muted-foreground"><Boxes className="h-4 w-4" aria-hidden />{t('productsRecipe.drawer.total')}</span>
              <span className={cn('text-lg font-semibold tabular-nums', !cost.complete && 'text-amber-800 dark:text-amber-300')} data-testid="recipe-total">
                {recipe?.exempt ? formatDenari(0) : cost.total == null ? '—' : unitDen(cost.total)}
              </span>
            </div>
            {!recipe?.exempt && draft.length > 0 && !cost.complete && (
              <p className="text-xs text-amber-800 dark:text-amber-300">{t('productsRecipe.drawer.incomplete')}</p>
            )}
            {tried && invalid && <p role="alert" className="text-xs text-red-700 dark:text-red-400">{t(`productsRecipe.drawer.err.${invalid}`)}</p>}
            <div className="flex flex-wrap justify-end gap-2">
              {!changed && hasProposal(recipe) && (
                <Button variant="outline" className="h-10" onClick={() => { void approveAsIs(); }} disabled={!!busy}>
                  {busy === 'approveAsIs' && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden />}
                  {t('productsRecipe.drawer.approve')}
                </Button>
              )}
              <Button variant="outline" className="h-10" onClick={() => { void save(false); }} disabled={!!busy || !changed}>
                {busy === 'propose' && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden />}
                {t('productsRecipe.drawer.propose')}
              </Button>
              <Button className="h-10" onClick={() => { void save(true); }} disabled={!!busy || (!changed && status === 'approved')}>
                {busy === 'approve' && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden />}
                {t('productsRecipe.drawer.saveApprove')}
              </Button>
            </div>
            <p className="text-[11px] leading-snug text-muted-foreground">{t('productsRecipe.drawer.note')}</p>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
