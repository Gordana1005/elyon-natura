import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, CheckCheck, Loader2, Search, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { EmptyState } from '@/components/EmptyState';
import { LoadError } from '@/components/insights/shared/LoadError';
import type { InsightsFormat } from '@/components/insights/shared/useInsightsFormat';
import { useToast } from '@/hooks/use-toast';
import { apiErrorText } from '@/i18n/apiErrors';
import { apiGetKindProposal, apiSetProductKind } from '@/lib/api';
import { cn } from '@/lib/utils';
import { normalizeForSearch } from '@/lib/transliterate';
import { useMinWidth } from '@/lib/products/useMinWidth';
import {
  KIND_PROPOSAL_FILTERS, PRODUCT_KINDS, applyKindChanges, autoKindPlan, canAcceptKind, kindProposalCounts,
  matchesKindProposalFilter, type KindProposal as Proposal, type KindProposalFilter, type KindProposalRow,
  type ProductKind, type SetKindResult,
} from '@/lib/products/kinds';
import { KindBadge, KindChip, useKindLabel } from './KindChip';
import { chip, chipOff, chipOne } from './ProductFilters';

const CONFIDENCE_TONES = {
  high: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-800 dark:text-emerald-300',
  low: 'border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-300',
} as const;

/**
 * Производи → Предлог → Вид: the kind suggestion (GET /api/products/kind-proposal,
 * SQL product_kind_proposal): the rule · the tiles · the toolbar (search, filter
 * chips, "accept all sure") · one row per product (a table from xl, cards below)
 * with the suggestion, its confidence and reason, the current kind (a chip that
 * picks any kind) and "Прифати". Every write goes through POST /api/products/kind
 * (audited); `onChanged` hands each answer to the page so its catalogue follows.
 */
export function KindProposal({ onChanged, f }: { onChanged: (result: SetKindResult) => void; f: InsightsFormat }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const label = useKindLabel();
  const [data, setData] = useState<Proposal | null>(null);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [loadError, setLoadError] = useState('');
  const [filter, setFilter] = useState<KindProposalFilter>('todo');
  const [query, setQuery] = useState('');
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set());
  const [confirmAll, setConfirmAll] = useState(false);
  const [acceptingAll, setAcceptingAll] = useState(false);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const load = useCallback(() => {
    setPhase('loading');
    apiGetKindProposal()
      .then((d) => { if (alive.current) { setData(d); setPhase('ready'); } })
      .catch((err: unknown) => { if (alive.current) { setLoadError(apiErrorText(err)); setPhase('error'); } });
  }, []);
  useEffect(() => { load(); }, [load]);

  const rows = useMemo(() => data?.rows ?? [], [data]);
  const keys = useMemo(() => new Map(rows.map((r) => [r.id, normalizeForSearch(`${r.name} ${r.sku ?? ''}`)])), [rows]);
  const counts = useMemo(() => kindProposalCounts(rows), [rows]);
  const words = normalizeForSearch(query.trim()).split(/\s+/).filter(Boolean);
  const shown = rows.filter((r) => matchesKindProposalFilter(r, filter) && words.every((w) => keys.get(r.id)?.includes(w)));
  const plan = useMemo(() => autoKindPlan(rows), [rows]);
  const planTotal = plan.reduce((s, c) => s + c.ids.length, 0);
  const planByKind = useMemo(() => {
    const m = new Map<ProductKind, number>();
    for (const c of plan) m.set(c.kind, (m.get(c.kind) ?? 0) + c.ids.length);
    return [...m.entries()];
  }, [plan]);

  const applyResult = (res: SetKindResult) => {
    setData((d) => (d ? { ...d, rows: applyKindChanges(d.rows, res) } : d));
    onChanged(res);
  };

  const save = async (ids: string[], kind: ProductKind | null) => {
    setBusyIds((s) => new Set([...s, ...ids]));
    try {
      const res = await apiSetProductKind(ids, kind);
      applyResult(res);
      toast({ title: t('products.kind.savedTitle'), description: t('products.kind.saved', { kind: label(kind), updated: f.int(res.updated), unchanged: f.int(res.unchanged) }) });
    } catch (err: unknown) {
      toast({ title: t('common.error'), description: apiErrorText(err), variant: 'destructive' });
    } finally {
      setBusyIds((s) => { const n = new Set(s); ids.forEach((id) => n.delete(id)); return n; });
    }
  };

  const acceptAll = async () => {
    setAcceptingAll(true);
    let updated = 0;
    try {
      for (const c of plan) {
        const res = await apiSetProductKind(c.ids, c.kind);
        updated += res.updated;
        applyResult(res);
      }
      toast({ title: t('products.kind.savedTitle'), description: t('products.kindProposal.acceptedAll', { updated: f.int(updated) }) });
    } catch (err: unknown) {
      toast({ title: t('common.error'), description: apiErrorText(err), variant: 'destructive' });
    } finally {
      setAcceptingAll(false);
      setConfirmAll(false);
    }
  };

  const s = data?.summary;
  return (
    <div className="min-w-0 space-y-4">
      <section className="rounded-xl border bg-card p-3 shadow-sm sm:p-4" aria-labelledby="kind-proposal-title">
        <h2 id="kind-proposal-title" className="text-base font-semibold leading-snug">{t('products.kindProposal.title')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t('products.kindProposal.rule')}</p>
      </section>

      {phase === 'error' ? (
        <LoadError text={loadError} onRetry={load} />
      ) : phase === 'loading' || !s ? (
        <div className="space-y-3" aria-busy="true">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-20 rounded-xl" />)}
          </div>
          <Skeleton className="h-64 rounded-xl" />
        </div>
      ) : (
        <>
          <section aria-labelledby="kind-kpi-title">
            <h3 id="kind-kpi-title" className="sr-only">{t('products.kindProposal.kpiTitle')}</h3>
            <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4 2xl:grid-cols-8">
              <Tile label={t('products.kindProposal.kpi.auto')} value={f.int(counts.auto)} sub={t('products.kindProposal.kpi.autoSub')} strong />
              {PRODUCT_KINDS.map((k) => (
                <Tile key={k} label={t(`products.kindFilter.${k}`)} value={f.int(s.suggested[k])}
                  sub={t('products.kindProposal.kpi.ofProducts', { n: f.int(s.products) })} />
              ))}
              <Tile label={t('products.kindProposal.kpi.low')} value={f.int(counts.low)} sub={t('products.kindProposal.kpi.lowSub')} />
              <Tile label={t('products.kindProposal.kpi.decided')} value={f.int(counts.decided)} sub={t('products.kindProposal.kpi.ofProducts', { n: f.int(rows.length) })} />
              <Tile label={t('products.kindProposal.kpi.differs')} value={f.int(counts.differs)} warn={counts.differs > 0} />
            </ul>
          </section>

          <div role="search" aria-label={t('products.searchPlaceholder')} className="space-y-2 rounded-xl border bg-card/80 p-3 shadow-sm">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <div className="relative min-w-0 basis-full sm:basis-auto sm:flex-1 lg:max-w-md">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
                <input type="search" value={query} onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Escape' && query) { e.preventDefault(); setQuery(''); } }}
                  placeholder={t('products.searchShort')} aria-label={t('products.searchPlaceholder')}
                  autoComplete="off" spellCheck={false} enterKeyHint="search"
                  className={cn('h-9 w-full rounded-lg border bg-background pl-8 text-base focus:outline-none focus:ring-2 focus:ring-ring md:text-sm [&::-webkit-search-cancel-button]:hidden', query ? 'pr-9' : 'pr-3')} />
                {query && (
                  <button type="button" onClick={() => setQuery('')} aria-label={t('products.clearSearch')}
                    className="absolute right-0 top-0 flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    <X className="h-3.5 w-3.5" aria-hidden />
                  </button>
                )}
              </div>
              <span className="text-xs tabular-nums text-muted-foreground" aria-live="polite" data-testid="kind-proposal-shown">
                {t('products.shown', { shown: f.int(shown.length), total: f.int(rows.length) })}
              </span>
              <Button size="sm" className="ml-auto h-9 w-full sm:w-auto" disabled={planTotal === 0 || acceptingAll} onClick={() => setConfirmAll(true)}>
                {acceptingAll ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden /> : <CheckCheck className="mr-1.5 h-4 w-4" aria-hidden />}
                {t('products.kindProposal.acceptAll', { n: f.int(planTotal) })}
              </Button>
            </div>
            <div role="group" aria-label={t('products.kindProposal.filterLabel')} className="flex flex-wrap items-center gap-1.5">
              {KIND_PROPOSAL_FILTERS.map((k) => (
                <button key={k} type="button" aria-pressed={filter === k} onClick={() => setFilter(k)} className={cn(chip, filter === k ? chipOne : chipOff)}>
                  {t(`products.kindProposal.filter.${k}`)}
                  <span className="tabular-nums opacity-70">{f.int(counts[k])}</span>
                </button>
              ))}
            </div>
          </div>

          {shown.length === 0 ? (
            <EmptyState icon={<Check className="h-5 w-5" />} title={t('products.kindProposal.empty')} size="sm" />
          ) : (
            <ProposalList rows={shown.slice(0, 200)} busyIds={busyIds} onSave={save} f={f} />
          )}
          {shown.length > 200 && (
            <p className="text-center text-xs text-muted-foreground">{t('products.shownPage', { shown: f.int(200), total: f.int(shown.length) })}</p>
          )}
        </>
      )}

      <AlertDialog open={confirmAll} onOpenChange={(o) => { if (!acceptingAll) setConfirmAll(o); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('products.kindProposal.acceptAllTitle', { n: f.int(planTotal) })}</AlertDialogTitle>
            <AlertDialogDescription>{t('products.kindProposal.acceptAllBody')}</AlertDialogDescription>
          </AlertDialogHeader>
          <ul className="space-y-1 text-sm" data-testid="accept-all-kinds">
            {planByKind.map(([kind, n]) => (
              <li key={kind} className="flex items-center justify-between gap-2">
                <KindBadge kind={kind} size="md" />
                <span className="ml-auto font-semibold tabular-nums">{f.int(n)}</span>
              </li>
            ))}
          </ul>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={acceptingAll}>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction disabled={acceptingAll} onClick={(e) => { e.preventDefault(); void acceptAll(); }}>
              {acceptingAll && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden />}
              {t('products.kindProposal.acceptAllConfirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function Tile({ label, value, sub, strong, warn }: { label: string; value: string; sub?: string; strong?: boolean; warn?: boolean }) {
  return (
    <li className={cn('flex min-w-0 flex-col gap-0.5 rounded-xl border bg-card p-3 shadow-sm', strong && 'border-foreground/40')}>
      <span className="break-words text-[11px] font-medium leading-tight text-muted-foreground">{label}</span>
      <span className={cn('text-2xl font-semibold leading-tight tabular-nums', warn ? 'text-destructive' : 'text-card-foreground')}>{value}</span>
      {sub && <span className="break-words text-[11px] leading-snug text-muted-foreground">{sub}</span>}
    </li>
  );
}

interface ListProps {
  rows: KindProposalRow[];
  busyIds: ReadonlySet<string>;
  onSave: (ids: string[], kind: ProductKind | null) => void;
  f: InsightsFormat;
}

function ProposalList(p: ListProps) {
  const { t } = useTranslation();
  const wide = useMinWidth(1280);
  const th = 'whitespace-nowrap px-2 py-2 text-left font-medium';
  if (!wide) return <ProposalCards {...p} />;
  return (
    <>
      <div className="relative max-h-[70vh] overflow-auto rounded-xl border bg-card shadow-sm">
        <table className="w-full text-[13px]">
          <caption className="sr-only">{t('products.kindProposal.title')}</caption>
          <thead className="sticky top-0 z-20 bg-card text-[11px] text-muted-foreground shadow-[0_1px_0_hsl(var(--border))]">
            <tr>
              <th scope="col" className={cn(th, 'sticky left-0 z-30 bg-card pl-3')}>{t('ordersPage.colProduct')}</th>
              <th scope="col" className={th}>{t('products.kindProposal.suggested')}</th>
              <th scope="col" className={th}>{t('products.kindProposal.current')}</th>
              <th scope="col" className="px-2 py-2 pr-3 text-right font-medium"><span className="sr-only">{t('common.actions')}</span></th>
            </tr>
          </thead>
          <tbody>
            {p.rows.map((r) => (
              <tr key={r.id} className="border-t align-top hover:bg-muted/30">
                <th scope="row" className="sticky left-0 z-10 max-w-[320px] bg-card py-2 pl-3 pr-2 text-left font-normal"><ProductName r={r} /></th>
                <td className="max-w-[380px] px-2 py-2"><Suggestion r={r} f={p.f} /></td>
                <td className="px-2 py-2">
                  <KindChip kind={r.kind} name={r.name} editable busy={p.busyIds.has(r.id)} onPick={(k) => p.onSave([r.id], k)} />
                </td>
                <td className="px-2 py-2 pr-3 text-right"><AcceptButton r={r} busy={p.busyIds.has(r.id)} onSave={p.onSave} compact /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function ProposalCards(p: ListProps) {
  const { t } = useTranslation();
  return (
    <>
      <ul className="grid min-w-0 gap-3 md:grid-cols-2" aria-label={t('products.kindProposal.title')}>
        {p.rows.map((r) => (
          <li key={r.id} className="min-w-0 space-y-3 rounded-xl border bg-card p-3 shadow-sm">
            <ProductName r={r} />
            <Suggestion r={r} f={p.f} />
            <div className="flex flex-wrap items-center gap-2 border-t pt-2">
              <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{t('products.kindProposal.current')}</span>
              <KindChip kind={r.kind} name={r.name} editable busy={p.busyIds.has(r.id)} onPick={(k) => p.onSave([r.id], k)} size="md" />
              <span className="ml-auto"><AcceptButton r={r} busy={p.busyIds.has(r.id)} onSave={p.onSave} /></span>
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}

function ProductName({ r }: { r: KindProposalRow }) {
  const { t } = useTranslation();
  return (
    <span className="block min-w-0">
      <span className="block break-words font-medium leading-snug text-card-foreground xl:truncate" title={r.name}>{r.name}</span>
      <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
        {r.sku && <span className="truncate">{r.sku}</span>}
        {!r.is_active && <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">{t('products.disabled')}</Badge>}
      </span>
    </span>
  );
}

function Suggestion({ r, f }: { r: KindProposalRow; f: InsightsFormat }) {
  const { t } = useTranslation();
  const reason = r.reason === 'free_in_orders'
    ? t('products.kindProposal.reason.free_in_orders', { pct: f.share(r.free_lines, r.lines), lines: f.int(r.lines) })
    : t(`products.kindProposal.reason.${r.reason}`, { hit: r.hit ?? '' });
  return (
    <div className="min-w-0 space-y-1">
      <div className="flex flex-wrap items-center gap-1.5">
        <KindBadge kind={r.suggested} />
        <span className={cn('inline-flex h-5 items-center whitespace-nowrap rounded-full border px-1.5 text-[10px] font-semibold uppercase tracking-wide', CONFIDENCE_TONES[r.confidence])}>
          {t(`products.kindProposal.confidence.${r.confidence}`)}
        </span>
      </div>
      <p className="break-words text-[11px] leading-snug text-muted-foreground">{reason}</p>
    </div>
  );
}

function AcceptButton({ r, busy, onSave, compact }: {
  r: KindProposalRow; busy: boolean; onSave: (ids: string[], kind: ProductKind | null) => void; compact?: boolean;
}) {
  const { t } = useTranslation();
  const label = useKindLabel();
  if (r.suggested && r.kind === r.suggested) {
    return (
      <span className="inline-flex h-9 items-center gap-1 whitespace-nowrap text-xs font-medium text-emerald-700 dark:text-emerald-400 lg:h-8">
        <Check className="h-3.5 w-3.5" aria-hidden />{t('products.kindProposal.accepted')}
      </span>
    );
  }
  if (!canAcceptKind(r)) return null;
  return (
    <Button variant="outline" size="sm" className={cn('whitespace-nowrap', compact ? 'h-8' : 'h-9')} disabled={busy}
      onClick={() => onSave([r.id], r.suggested)}
      aria-label={t('products.kindProposal.acceptFor', { kind: label(r.suggested), name: r.name })}>
      {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden /> : <Check className="mr-1.5 h-4 w-4" aria-hidden />}
      {t('products.kindProposal.accept')}
    </Button>
  );
}
