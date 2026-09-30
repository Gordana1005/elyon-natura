import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Loader2, Split, UserPlus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useToast } from '@/hooks/use-toast';
import { apiErrorText } from '@/i18n/apiErrors';
import { cn } from '@/lib/utils';
import {
  apiAssignerDistribute, type AssignerBoardAgent, type CallAgainSource, type DistributeBody,
  type DistributeKind, type DistributeOrder, type DistributeResult, type DistributeSplit,
} from '@/lib/assignerApi';
import { planDistribution } from '@/lib/assigner/plan';
import { agentLoad, presenceOf } from '@/lib/assigner/board';
import type { InsightsFormat } from '@/components/insights/shared/useInsightsFormat';
import { AgentPickerPopover } from './AgentPickerPopover';
import type { AgentChip } from './AgentPickerChips';
import { ChipGroup, LABEL, PresenceMark } from './parts';
import { invalidateAssigner } from './assignerQueries';

type CountMode = 20 | 50 | 100 | 200 | 'all' | 'custom';
const PRESETS: CountMode[] = [20, 50, 100, 200, 'all', 'custom'];
/** The api rate-limits previews (120/min): never faster than this. */
export const PREVIEW_DEBOUNCE_MS = 450;
/** A distribution this big asks twice (the Trash List alone holds ~13.000). */
export const BIG_DISTRIBUTION = 300;

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(id);
  }, [value, ms]);
  return v;
}

export interface DistributeBarProps {
  kind: DistributeKind;
  listId?: string;
  /** What is being shared, for the confirm dialog ("21–57 дена · …", "Пендинзи"). */
  whatLabel: string;
  departments: string[];
  /** The local pool estimate (unassigned, in the chosen departments); null = unknown. */
  pool: number | null;
  /** The estimate when "include already assigned" is on; null = unknown (the dry run tells). */
  poolWithAssigned?: number | null;
  agents: AssignerBoardAgent[];
  targets: string[];
  onTargetsChange: (ids: string[]) => void;
  source?: CallAgainSource;
  /** Controlled order (Pendings / Call-agains share it with their table). */
  order?: DistributeOrder;
  onOrderChange?: (o: DistributeOrder) => void;
  defaultOrder?: DistributeOrder;
  /** Lists only. */
  allowRandom?: boolean;
  /** Call-agains: warn when a chosen agent is offline. */
  warnOffline?: boolean;
  onDone?: (res: DistributeResult) => void;
  f: InsightsFormat;
  className?: string;
}

/**
 * ONE distribution control for Lists, Pendings and Call-agains: a count
 * (20 / 50 / 100 / 200 / Сите / друго) that goes to ONE agent or is shared
 * across several (100 over 3 = 34 · 33 · 33) — or "per agent" — newest or
 * oldest first (random for lists), optionally moving already-assigned rows.
 *
 * The preview is instant (planDistribution, the server's rule) and then
 * confirmed by the server's dry run (debounced). The real call selects on the
 * server (FOR UPDATE SKIP LOCKED), so the preview can never promise rows that
 * someone else just took.
 */
export function DistributeBar({
  kind, listId, whatLabel, departments, pool, poolWithAssigned, agents, targets, onTargetsChange, source,
  order: orderProp, onOrderChange, defaultOrder = 'newest', allowRandom, warnOffline, onDone, f, className,
}: DistributeBarProps) {
  const { t } = f;
  const { toast } = useToast();
  const qc = useQueryClient();
  const [countMode, setCountMode] = useState<CountMode>(20);
  const [custom, setCustom] = useState('30');
  const [split, setSplit] = useState<DistributeSplit>('total');
  const [ownOrder, setOwnOrder] = useState<DistributeOrder>(defaultOrder);
  const [includeAssigned, setIncludeAssigned] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const order = orderProp ?? ownOrder;
  const setOrder = (o: DistributeOrder) => (onOrderChange ? onOrderChange(o) : setOwnOrder(o));

  const byId = useMemo(() => new Map(agents.map((a) => [a.user_id, a])), [agents]);
  const customN = Math.floor(Number(custom));
  const count: number | null = countMode === 'all' ? null : countMode === 'custom' ? (customN > 0 ? customN : 0) : countMode;
  const countValid = count === null || count > 0;

  const body: DistributeBody = useMemo(() => ({
    kind,
    ...(listId ? { list_id: listId } : {}),
    ...(departments.length ? { departments } : {}),
    order,
    count,
    split,
    agent_ids: targets,
    include_assigned: includeAssigned,
    dry_run: true,
    ...(kind === 'call_agains' ? { source: source ?? 'all' } : {}),
  }), [kind, listId, departments, order, count, split, targets, includeAssigned, source]);
  const bodyKey = JSON.stringify(body);
  const debouncedKey = useDebounced(bodyKey, PREVIEW_DEBOUNCE_MS);
  const settled = debouncedKey === bodyKey;

  const preview = useQuery({
    queryKey: ['assigner-distribute-preview', debouncedKey],
    queryFn: ({ signal }) => apiAssignerDistribute(JSON.parse(debouncedKey) as DistributeBody, signal),
    enabled: settled && targets.length > 0 && countValid,
    staleTime: 10_000,
    retry: false,
  });
  const server = settled && preview.data && !preview.isError ? preview.data : null;
  // A dry run the server REFUSED (random outside a list, a static list, an inactive agent,
  // a bad department …) comes back 400 {error}: say why and do not offer the real run.
  // An api that is not there yet (HTTP 404 / 5xx, a timeout) only costs the exact preview.
  const previewErr = settled && preview.isError ? preview.error : null;
  const refused = previewErr instanceof Error && !/^HTTP \d{3}$/.test(previewErr.message) && previewErr.name !== 'TimeoutError';

  const localPool = includeAssigned ? (poolWithAssigned ?? null) : pool;
  const local = localPool == null ? null : planDistribution(count, targets, split, localPool);
  const requested = count == null ? null : split === 'per_agent' ? count * targets.length : count;

  // What the preview shows: the server's answer when it is for THIS body, else the local plan.
  const shown = server
    ? {
      pool: server.pool,
      total: server.selected,
      short: requested != null && requested > server.pool,
      per: targets.map((id) => ({ id, count: server.per_agent.find((p) => p.agent_id === id)?.count ?? 0 })),
      exact: true,
    }
    : local
      ? { pool: localPool!, total: local.total, short: local.short, per: local.per.map((p) => ({ id: p.agent, count: p.count })), exact: false }
      : null;

  const nameOf = (id: string) =>
    byId.get(id)?.full_name || server?.per_agent.find((p) => p.agent_id === id)?.full_name || t('assigner.unknownAgent');
  const splitText = (per: { id: string; count: number }[]) =>
    per.map((p) => `${nameOf(p.id)} ${f.int(p.count)}`).join(' · ');

  const offline = warnOffline ? targets.filter((id) => byId.get(id) && presenceOf(byId.get(id)!) === 'offline') : [];

  const run = useMutation({
    mutationFn: () => apiAssignerDistribute({ ...body, dry_run: false }),
    onSuccess: (res) => {
      setConfirmOpen(false);
      const moved = res.assigned || res.selected;
      toast(moved > 0
        ? {
          title: t('assigner.dist.doneTitle', { n: f.int(moved) }),
          description: res.per_agent.filter((p) => p.count > 0)
            .map((p) => `${byId.get(p.agent_id)?.full_name || p.full_name || t('assigner.unknownAgent')} ${f.int(p.count)}`).join(' · ') || undefined,
        }
        : { title: t('assigner.dist.doneNone') });
      invalidateAssigner(qc);
      onDone?.(res);
    },
    onError: (err) => {
      setConfirmOpen(false);
      toast({ title: t('assigner.distributionFailed'), description: apiErrorText(err), variant: 'destructive' });
    },
  });

  const pickerAgents: AgentChip[] = useMemo(() => agents.map((a) => ({
    user_id: a.user_id, full_name: a.full_name, is_online: a.online || a.in_call, members_open: agentLoad(a),
  })), [agents]);

  const nothing = shown != null && shown.total === 0;
  const canRun = targets.length > 0 && countValid && !run.isPending && !refused
    && !(server && server.selected === 0) && !(shown == null && !server) && !nothing;
  const big = (shown?.total ?? 0) > BIG_DISTRIBUTION;

  const orderOptions: { value: DistributeOrder; label: string }[] = [
    { value: 'newest', label: t('assigner.dist.newest') },
    { value: 'oldest', label: t('assigner.dist.oldest') },
    ...(allowRandom ? [{ value: 'random' as const, label: t('assigner.dist.random') }] : []),
  ];

  return (
    <div className={cn('space-y-2.5 rounded-xl border bg-card/80 p-3 shadow-sm', className)}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="inline-flex items-center gap-1.5 text-sm font-semibold">
          <Split className="h-4 w-4 text-primary" aria-hidden />
          {t('assigner.dist.title')}
        </span>
        <ChipGroup<CountMode>
          label={t('assigner.dist.count')}
          value={countMode}
          onChange={setCountMode}
          options={PRESETS.map((p) => ({
            value: p,
            label: p === 'all' ? t('assigner.dist.all') : p === 'custom' ? t('assigner.dist.custom') : f.int(p),
          }))}
        />
        {countMode === 'custom' && (
          <Input type="number" inputMode="numeric" min={1} value={custom} onChange={(e) => setCustom(e.target.value)}
            aria-label={t('assigner.dist.customCount')} className="h-9 w-24 text-sm tabular-nums sm:h-8" />
        )}
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <ChipGroup<DistributeSplit>
          label={t('assigner.dist.split')}
          value={split}
          onChange={setSplit}
          options={[
            { value: 'total', label: t('assigner.dist.splitTotal') },
            { value: 'per_agent', label: t('assigner.dist.splitPerAgent') },
          ]}
        />
        <ChipGroup<DistributeOrder> label={t('assigner.dist.order')} value={order} onChange={setOrder} options={orderOptions} />
        <label className="inline-flex cursor-pointer items-center gap-2 text-xs">
          <Checkbox checked={includeAssigned} onCheckedChange={(v) => setIncludeAssigned(v === true)} />
          <span>{t('assigner.dist.includeAssigned')}</span>
        </label>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <span className={cn(LABEL, 'mr-0.5')}>{t('assigner.dist.targets')}</span>
        {targets.length === 0 && <span className="text-xs text-muted-foreground">{t('assigner.dist.pickAgents')}</span>}
        {targets.map((id) => {
          const a = byId.get(id);
          // The whole chip removes the agent: a 36 px target on a phone.
          return (
            <button key={id} type="button" onClick={() => onTargetsChange(targets.filter((x) => x !== id))}
              aria-label={t('assigner.dist.removeAgent', { name: nameOf(id) })}
              title={t('assigner.dist.removeAgent', { name: nameOf(id) })}
              className="inline-flex h-9 max-w-[14rem] items-center gap-1 rounded-full border border-foreground/60 bg-muted pl-2 pr-1.5 text-xs font-medium hover:bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:h-7">
              {a && <PresenceMark presence={presenceOf(a)} t={t} />}
              <span className="truncate">{nameOf(id)}</span>
              {a && <span className="tabular-nums text-muted-foreground">{f.int(agentLoad(a))}</span>}
              <X className="h-3 w-3 shrink-0" aria-hidden />
            </button>
          );
        })}
        <AgentPickerPopover agents={pickerAgents} selected={targets} onChange={onTargetsChange} className="h-9 min-w-0 text-xs sm:h-7"
          triggerLabel={t('assigner.dist.addAgents')} />
      </div>

      {offline.length > 0 && (
        <p role="alert" className="flex items-start gap-1.5 rounded-lg border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5 text-xs text-amber-900 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>{t('assigner.dist.offlineWarn', { names: offline.map(nameOf).join(', ') })}</span>
        </p>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-2.5">
        <p className="min-w-0 text-xs text-muted-foreground" aria-live="polite" data-testid="distribute-preview">
          {targets.length === 0 ? null : !countValid ? (
            t('assigner.dist.invalidCount')
          ) : shown == null ? (
            <span className="inline-flex items-center gap-1"><Loader2 className="h-3 w-3 animate-spin" aria-hidden />{t('assigner.dist.previewLoading')}</span>
          ) : (
            <>
              <span className="tabular-nums">{t('assigner.dist.available', { n: f.int(shown.pool) })}</span>
              {' · '}
              {shown.total === 0 ? (
                <span className="font-medium text-foreground">{t('assigner.dist.nothing')}</span>
              ) : (
                <span className="font-medium tabular-nums text-foreground">
                  {t('assigner.dist.preview', {
                    n: f.int(shown.total),
                    agents: t('assigner.dist.agentsN', { count: targets.length }),
                    split: splitText(shown.per),
                  })}
                </span>
              )}
              {shown.short && shown.total > 0 && (
                <span className="ml-1 inline-flex items-center gap-1 text-amber-700 dark:text-amber-400">
                  <AlertTriangle className="h-3 w-3" aria-hidden />{t('assigner.dist.short', { n: f.int(shown.pool) })}
                </span>
              )}
              {!shown.exact && <span className="ml-1 italic">({t('assigner.dist.estimate')})</span>}
              {refused && (
                <span className="mt-1 flex items-start gap-1 text-amber-800 dark:text-amber-300">
                  <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
                  {t('assigner.dist.refused', { reason: apiErrorText(previewErr) })}
                </span>
              )}
            </>
          )}
        </p>
        <Button type="button" size="sm" className="h-9 gap-1.5" disabled={!canRun} onClick={() => setConfirmOpen(true)}>
          {run.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <UserPlus className="h-3.5 w-3.5" aria-hidden />}
          {shown && shown.total > 0 ? t('assigner.dist.runN', { n: f.int(shown.total) }) : t('assigner.dist.run')}
        </Button>
      </div>

      <AlertDialog open={confirmOpen} onOpenChange={(o) => { if (!o && !run.isPending) setConfirmOpen(false); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('assigner.dist.confirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('assigner.dist.confirmBody', {
                n: f.int(shown?.total ?? 0),
                what: whatLabel,
                agents: t('assigner.dist.agentsN', { count: targets.length }),
                order: orderOptions.find((o) => o.value === order)?.label ?? '',
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {shown && (
            <ul className="max-h-56 space-y-1 overflow-y-auto rounded-lg border p-2 text-sm">
              {shown.per.map((p) => (
                <li key={p.id} className="flex items-center justify-between gap-3">
                  <span className="flex min-w-0 items-center gap-1.5">
                    {byId.get(p.id) && <PresenceMark presence={presenceOf(byId.get(p.id)!)} t={t} />}
                    <span className="truncate">{nameOf(p.id)}</span>
                  </span>
                  <span className="font-semibold tabular-nums">{f.int(p.count)}</span>
                </li>
              ))}
            </ul>
          )}
          {big && (
            <p className="flex items-start gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5 text-sm font-medium text-amber-900 dark:text-amber-200">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              {t('assigner.dist.bigWarn', { n: f.int(shown?.total ?? 0) })}
            </p>
          )}
          {includeAssigned && <p className="text-xs text-muted-foreground">{t('assigner.dist.confirmMoves')}</p>}
          {offline.length > 0 && (
            <p className="flex items-start gap-1.5 text-xs text-amber-800 dark:text-amber-300">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              {t('assigner.dist.offlineWarn', { names: offline.map(nameOf).join(', ') })}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={run.isPending}>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction disabled={run.isPending} onClick={(e) => { e.preventDefault(); run.mutate(); }}>
              {run.isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden />}
              {t('assigner.dist.confirmCta')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
