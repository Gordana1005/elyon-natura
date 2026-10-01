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
import { apiGetBrandLineProposal, apiSetBrandLine } from '@/lib/api';
import { cn } from '@/lib/utils';
import {
  LINE_NAMES, PROFILE_FILLS, PROFILE_NAMES, PROPOSAL_FILTERS, applyLineChanges, autoAcceptPlan, canAccept, isFewParcels,
  matchesProposalFilter, matchesQuery, mexProfileForLine, proposalCounts,
  type BrandLine, type BrandLineProposal as Proposal, type ProposalConfidence, type ProposalFilter,
  type ProposalRow, type SetBrandLineResult,
} from '@/lib/products/brandLines';
import { useMinWidth } from '@/lib/products/useMinWidth';
import { LineBadge, LineChip } from './LineChip';
import { chip, chipOff, chipOne } from './ProductFilters';

// Always a word beside the colour (the badge text), never colour alone.
const CONFIDENCE_TONES: Record<ProposalConfidence, string> = {
  anchor: 'border-sky-500/40 bg-sky-500/10 text-sky-800 dark:text-sky-300',
  high: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-800 dark:text-emerald-300',
  low: 'border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-300',
  conflict: 'border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-400',
  hint: 'border-violet-500/40 bg-violet-500/10 text-violet-800 dark:text-violet-300',
  none: 'border-border bg-muted text-muted-foreground',
};

/**
 * Производи → Предлог: the brand-line suggestion from the MEX parcels (GET
 * /api/products/brand-line-proposal, SQL product_brand_line_proposal). Top to
 * bottom: the rule and the window · the tiles · the toolbar (search, the
 * filter chips, "accept all ≥ 90 %") · one row per product (a table from xl,
 * cards below) with the parcels per account, the suggestion with its
 * confidence and reason, the current line (a chip that picks any line) and
 * "Прифати". Every write goes through POST /api/products/brand-line (audited);
 * `onChanged` hands each answer to the page so its catalogue follows.
 */
export function BrandLineProposal({ onChanged, f }: {
  onChanged: (result: SetBrandLineResult) => void;
  f: InsightsFormat;
}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [data, setData] = useState<Proposal | null>(null);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [loadError, setLoadError] = useState('');
  const [filter, setFilter] = useState<ProposalFilter>('todo');
  const [query, setQuery] = useState('');
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set());
  const [confirmAll, setConfirmAll] = useState(false);
  const [acceptingAll, setAcceptingAll] = useState(false);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const load = useCallback(() => {
    setPhase('loading');
    apiGetBrandLineProposal()
      .then((d) => { if (alive.current) { setData(d); setPhase('ready'); } })
      .catch((err: unknown) => { if (alive.current) { setLoadError(apiErrorText(err)); setPhase('error'); } });
  }, []);
  useEffect(() => { load(); }, [load]);

  const rows = useMemo(() => data?.rows ?? [], [data]);
  const counts = useMemo(() => proposalCounts(rows), [rows]);
  const shown = useMemo(
    () => rows.filter((r) => matchesProposalFilter(r, filter) && matchesQuery(r, query)),
    [rows, filter, query],
  );
  const plan = useMemo(() => autoAcceptPlan(rows), [rows]);
  const planTotal = plan.reduce((s, c) => s + c.ids.length, 0);
  const planByLine = useMemo(() => {
    const m = new Map<BrandLine, number>();
    for (const c of plan) m.set(c.line, (m.get(c.line) ?? 0) + c.ids.length);
    return [...m.entries()];
  }, [plan]);
  const fewInPlan = useMemo(
    () => rows.filter((r) => r.auto && r.brand_line === null && r.confidence === 'high' && isFewParcels(r)).length,
    [rows],
  );

  const applyResult = (res: SetBrandLineResult) => {
    setData((d) => (d ? { ...d, rows: applyLineChanges(d.rows, res) } : d));
    onChanged(res);
  };

  const save = async (ids: string[], line: BrandLine | null) => {
    setBusyIds((s) => new Set([...s, ...ids]));
    try {
      const res = await apiSetBrandLine(ids, line);
      applyResult(res);
      toast({
        title: t('products.line.savedTitle'),
        description: t('products.line.saved', {
          line: line ? LINE_NAMES[line] : t('products.line.none'), updated: f.int(res.updated), unchanged: f.int(res.unchanged),
        }),
      });
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
        const res = await apiSetBrandLine(c.ids, c.line);
        updated += res.updated;
        applyResult(res);
      }
      toast({ title: t('products.line.savedTitle'), description: t('products.proposal.acceptedAll', { updated: f.int(updated) }) });
    } catch (err: unknown) {
      toast({ title: t('common.error'), description: apiErrorText(err), variant: 'destructive' });
    } finally {
      setAcceptingAll(false);
      setConfirmAll(false);
    }
  };

  const days = data?.days ?? 180;
  const s = data?.summary;

  return (
    <div className="min-w-0 space-y-4">
      <section className="rounded-xl border bg-card p-3 shadow-sm sm:p-4" aria-labelledby="bl-proposal-title">
        <h2 id="bl-proposal-title" className="text-base font-semibold leading-snug">{t('products.proposal.title')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t('products.proposal.rule')}</p>
        <p className="mt-1 text-xs text-muted-foreground">{t('products.proposal.window', { days: f.int(days) })}</p>
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
          <section aria-labelledby="bl-kpi-title">
            <h3 id="bl-kpi-title" className="sr-only">{t('products.proposal.kpiTitle')}</h3>
            <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4 2xl:grid-cols-8">
              <Tile label={t('products.proposal.kpi.auto')} value={f.int(counts.auto)} sub={t('products.proposal.kpi.autoSub')} strong />
              <Tile label={t('products.proposal.kpi.sure')} value={f.int(s.sure)} sub={t('products.proposal.kpi.ofProducts', { n: f.int(s.products) })} />
              <Tile label={t('products.proposal.kpi.mixed')} value={f.int(s.mixed)} sub={t('products.proposal.kpi.mixedSub')} />
              <Tile label={t('products.proposal.kpi.none')} value={f.int(s.none)} sub={t('products.proposal.kpi.noneSub', { days: f.int(days) })} />
              <Tile label={t('products.proposal.kpi.anchors')} value={f.int(s.anchors)} sub={t('products.proposal.kpi.anchorsSub')} />
              <Tile label={t('products.proposal.kpi.conflicts')} value={f.int(s.conflicts)} sub={t('products.proposal.kpi.conflictsSub')} warn={s.conflicts > 0} />
              <Tile label={t('products.proposal.kpi.hints')} value={f.int(s.hints.ad_astra + s.hints.dr_becker)}
                sub={`Ad Astra ${f.int(s.hints.ad_astra)} · Dr.Becker ${f.int(s.hints.dr_becker)}`} />
              <Tile label={t('products.proposal.kpi.decided')} value={f.int(counts.decided)} sub={t('products.proposal.kpi.ofProducts', { n: f.int(rows.length) })} />
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
              <span className="text-xs tabular-nums text-muted-foreground" aria-live="polite" data-testid="proposal-shown">
                {t('products.shown', { shown: f.int(shown.length), total: f.int(rows.length) })}
              </span>
              <Button size="sm" className="ml-auto h-9 w-full sm:w-auto" disabled={planTotal === 0 || acceptingAll}
                onClick={() => setConfirmAll(true)}>
                {acceptingAll ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden /> : <CheckCheck className="mr-1.5 h-4 w-4" aria-hidden />}
                {t('products.proposal.acceptAll', { n: f.int(planTotal) })}
              </Button>
            </div>
            <div role="group" aria-label={t('products.proposal.filterLabel')} className="flex flex-wrap items-center gap-1.5">
              {PROPOSAL_FILTERS.map((k) => (
                <button key={k} type="button" aria-pressed={filter === k} onClick={() => setFilter(k)}
                  className={cn(chip, filter === k ? chipOne : chipOff)}>
                  {t(`products.proposal.filter.${k}`)}
                  <span className="tabular-nums opacity-70">{f.int(counts[k])}</span>
                </button>
              ))}
            </div>
          </div>

          {shown.length === 0 ? (
            <EmptyState icon={<Check className="h-5 w-5" />} title={t('products.proposal.empty')} size="sm" />
          ) : (
            <ProposalList rows={shown} days={days} busyIds={busyIds} onSave={save} f={f} />
          )}
        </>
      )}

      <AlertDialog open={confirmAll} onOpenChange={(o) => { if (!acceptingAll) setConfirmAll(o); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('products.proposal.acceptAllTitle', { n: f.int(planTotal) })}</AlertDialogTitle>
            <AlertDialogDescription>{t('products.proposal.acceptAllBody')}</AlertDialogDescription>
          </AlertDialogHeader>
          <ul className="space-y-1 text-sm" data-testid="accept-all-plan">
            {planByLine.map(([line, n]) => (
              <li key={line} className="flex items-center justify-between gap-2">
                <LineBadge line={line} size="md" />
                <span className="text-xs text-muted-foreground">{PROFILE_NAMES[mexProfileForLine(line)!]}</span>
                <span className="ml-auto font-semibold tabular-nums">{f.int(n)}</span>
              </li>
            ))}
          </ul>
          {fewInPlan > 0 && (
            <p className="text-xs text-amber-800 dark:text-amber-300">{t('products.proposal.acceptAllFew', { n: f.int(fewInPlan) })}</p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={acceptingAll}>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction disabled={acceptingAll} onClick={(e) => { e.preventDefault(); void acceptAll(); }}>
              {acceptingAll && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden />}
              {t('products.proposal.acceptAllConfirm')}
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
  rows: ProposalRow[];
  days: number;
  busyIds: ReadonlySet<string>;
  onSave: (ids: string[], line: BrandLine | null) => void;
  f: InsightsFormat;
}

function ProposalList(p: ListProps) {
  const { t } = useTranslation();
  // One layout mounted (Производи 2.0): the table from xl, the cards below.
  const wide = useMinWidth(1280);
  const th = 'whitespace-nowrap px-2 py-2 text-left font-medium';
  return (
    <>
      {wide && <div className="relative max-h-[70vh] overflow-auto rounded-xl border bg-card shadow-sm">
        <table className="w-full text-[13px]">
          <caption className="sr-only">{t('products.proposal.title')}</caption>
          <thead className="sticky top-0 z-20 bg-card text-[11px] text-muted-foreground shadow-[0_1px_0_hsl(var(--border))]">
            <tr>
              <th scope="col" className={cn(th, 'sticky left-0 z-30 bg-card pl-3')}>{t('ordersPage.colProduct')}</th>
              <th scope="col" className={th}>{t('products.proposal.parcels')}</th>
              <th scope="col" className={th}>{t('products.proposal.suggested')}</th>
              <th scope="col" className={th}>{t('products.proposal.current')}</th>
              <th scope="col" className="px-2 py-2 pr-3 text-right font-medium"><span className="sr-only">{t('common.actions')}</span></th>
            </tr>
          </thead>
          <tbody>
            {p.rows.map((r) => (
              <tr key={r.id} className="border-t align-top hover:bg-muted/30">
                <th scope="row" className="sticky left-0 z-10 max-w-[280px] bg-card py-2 pl-3 pr-2 text-left font-normal">
                  <ProductName r={r} />
                </th>
                <td className="px-2 py-2"><Parcels r={r} f={p.f} /></td>
                <td className="max-w-[340px] px-2 py-2"><Suggestion r={r} days={p.days} f={p.f} /></td>
                <td className="px-2 py-2">
                  <LineChip line={r.brand_line} name={r.name} editable busy={p.busyIds.has(r.id)} onPick={(l) => p.onSave([r.id], l)} />
                </td>
                <td className="px-2 py-2 pr-3 text-right"><AcceptButton r={r} busy={p.busyIds.has(r.id)} onSave={p.onSave} compact /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>}
      {!wide && <ul className="grid min-w-0 gap-3 md:grid-cols-2" aria-label={t('products.proposal.title')}>
        {p.rows.map((r) => (
          <li key={r.id} className="min-w-0 space-y-3 rounded-xl border bg-card p-3 shadow-sm">
            <ProductName r={r} />
            <Parcels r={r} f={p.f} />
            <Suggestion r={r} days={p.days} f={p.f} />
            <div className="flex flex-wrap items-center gap-2 border-t pt-2">
              <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{t('products.proposal.current')}</span>
              <LineChip line={r.brand_line} name={r.name} editable busy={p.busyIds.has(r.id)} onPick={(l) => p.onSave([r.id], l)} size="md" />
              <span className="ml-auto"><AcceptButton r={r} busy={p.busyIds.has(r.id)} onSave={p.onSave} /></span>
            </div>
          </li>
        ))}
      </ul>}
    </>
  );
}

function ProductName({ r }: { r: ProposalRow }) {
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

/** BIO NATURAL n · NATURA n (words and numbers) with a two-part bar in the accounts' fills. */
function Parcels({ r, f }: { r: ProposalRow; f: InsightsFormat }) {
  const { t } = useTranslation();
  if (r.parcels === 0) return <span className="text-xs text-muted-foreground">{t('products.proposal.noParcels')}</span>;
  const bio = (r.bio_natural / r.parcels) * 100;
  return (
    <div className="min-w-0 sm:max-w-xs xl:min-w-[170px]">
      <div className="flex flex-wrap justify-between gap-x-3 text-[11px] tabular-nums">
        <span className="inline-flex items-center gap-1">
          <span aria-hidden className={cn('h-2 w-2 rounded-full', PROFILE_FILLS.bio_natural)} />
          <span className="text-muted-foreground">{PROFILE_NAMES.bio_natural}</span> <b>{f.int(r.bio_natural)}</b>
        </span>
        <span className="inline-flex items-center gap-1">
          <span aria-hidden className={cn('h-2 w-2 rounded-full', PROFILE_FILLS.natura)} />
          <span className="text-muted-foreground">{PROFILE_NAMES.natura}</span> <b>{f.int(r.natura)}</b>
        </span>
      </div>
      {/* 2 px surface gap between the parts, so the split reads without colour */}
      <div className="mt-1 flex h-1.5 gap-0.5 overflow-hidden rounded-full" aria-hidden>
        {r.bio_natural > 0 && <div className={cn('rounded-full', PROFILE_FILLS.bio_natural)} style={{ width: `${bio}%` }} />}
        {r.natura > 0 && <div className={cn('rounded-full', PROFILE_FILLS.natura)} style={{ width: `${100 - bio}%` }} />}
      </div>
    </div>
  );
}

function Suggestion({ r, days, f }: { r: ProposalRow; days: number; f: InsightsFormat }) {
  const { t } = useTranslation();
  return (
    <div className="min-w-0 space-y-1">
      <div className="flex flex-wrap items-center gap-1.5">
        {r.suggested ? <LineBadge line={r.suggested} /> : <span className="text-xs text-muted-foreground">{t('products.proposal.noSuggestion')}</span>}
        <span className={cn('inline-flex h-5 items-center whitespace-nowrap rounded-full border px-1.5 text-[10px] font-semibold uppercase tracking-wide', CONFIDENCE_TONES[r.confidence])}>
          {t(`products.proposal.confidence.${r.confidence}`)}
        </span>
        {r.conflict && r.confidence !== 'conflict' && (
          <span className={cn('inline-flex h-5 items-center whitespace-nowrap rounded-full border px-1.5 text-[10px] font-semibold uppercase tracking-wide', CONFIDENCE_TONES.conflict)}>
            {t('products.proposal.confidence.conflict')}
          </span>
        )}
      </div>
      <p className="break-words text-[11px] leading-snug text-muted-foreground">
        {reasonText(r, days, f)}
        {r.confidence === 'high' && isFewParcels(r) && (
          <span className="text-amber-800 dark:text-amber-300"> · {t('products.proposal.fewParcels', { n: f.int(r.parcels) })}</span>
        )}
      </p>
    </div>
  );
}

function reasonText(r: ProposalRow, days: number, f: InsightsFormat): string {
  const { t } = f;
  const majorityCount = Math.max(r.bio_natural, r.natura);
  switch (r.reason) {
    case 'hint_name':
      return t('products.proposal.reason.hint_name', { line: r.hint ? LINE_NAMES[r.hint] : '' });
    case 'anchor_conflict': {
      const nameProfile = mexProfileForLine(r.suggested) ?? 'bio_natural';
      const other = nameProfile === 'bio_natural' ? 'natura' : 'bio_natural';
      const n = other === 'natura' ? r.natura : r.bio_natural;
      return t('products.proposal.reason.anchor_conflict', { pct: f.share(n, r.parcels), profile: PROFILE_NAMES[other] });
    }
    case 'anchor_name':
      return t('products.proposal.reason.anchor_name');
    case 'parcels_sure':
    case 'parcels_mixed':
      return t(`products.proposal.reason.${r.reason}`, {
        pct: f.share(majorityCount, r.parcels), profile: r.majority ? PROFILE_NAMES[r.majority] : '',
      });
    case 'parcels_tie':
      return t('products.proposal.reason.parcels_tie');
    default:
      return t('products.proposal.reason.no_parcels', { days: f.int(days) });
  }
}

function AcceptButton({ r, busy, onSave, compact }: {
  r: ProposalRow; busy: boolean; onSave: (ids: string[], line: BrandLine | null) => void; compact?: boolean;
}) {
  const { t } = useTranslation();
  if (r.suggested && r.brand_line === r.suggested) {
    return (
      <span className="inline-flex h-9 items-center gap-1 whitespace-nowrap text-xs font-medium text-emerald-700 dark:text-emerald-400 lg:h-8">
        <Check className="h-3.5 w-3.5" aria-hidden />{t('products.proposal.accepted')}
      </span>
    );
  }
  if (!canAccept(r)) return null;
  return (
    <Button variant="outline" size="sm" className={cn('whitespace-nowrap', compact ? 'h-8' : 'h-9')} disabled={busy}
      onClick={() => onSave([r.id], r.suggested)}
      aria-label={t('products.proposal.acceptFor', { line: LINE_NAMES[r.suggested], name: r.name })}>
      {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden /> : <Check className="mr-1.5 h-4 w-4" aria-hidden />}
      {t('products.proposal.accept')}
    </Button>
  );
}
