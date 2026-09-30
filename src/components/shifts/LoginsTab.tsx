import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Ban, CheckCircle2, ChevronLeft, ChevronRight, Clock, LogOut, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { MobileCard, MobileCardField, MobileCardHeader } from '@/components/ui/mobile-card';
import { EmptyState } from '@/components/EmptyState';
import { LoadError } from '@/components/insights/shared/LoadError';
import { DmyDateInput } from '@/components/insights/shared/DmyDateInput';
import { formatDmy } from '@/components/insights/shared/period';
import { useInsightsFormat } from '@/components/insights/shared/useInsightsFormat';
import { Chip, LABEL } from '@/components/assigner/parts';
import { apiGetAgents } from '@/lib/api';
import {
  ACTIVITY_STATUSES, apiGetShiftLoginActivity, monthBounds, skopjeNow, type ActivityRow, type ActivityStatus,
} from '@/lib/shiftsApi';
import { duration } from './format';

const LIMIT = 50;

export const STATUS_UI: Record<ActivityStatus, { icon: LucideIcon; tone: string }> = {
  on_time: { icon: CheckCircle2, tone: 'border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-200' },
  late: { icon: Clock, tone: 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200' },
  early: { icon: LogOut, tone: 'border-sky-300 bg-sky-50 text-sky-900 dark:border-sky-500/40 dark:bg-sky-500/10 dark:text-sky-200' },
  blocked: { icon: Ban, tone: 'border-red-300 bg-red-50 text-red-800 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-200' },
};

/** A status as the server sends it (a code) → an icon + a translated word. */
export function StatusBadge({ status }: { status: ActivityStatus }) {
  const { t } = useTranslation();
  const ui = STATUS_UI[status];
  const Icon = ui.icon;
  return (
    <span data-status={status} className={cn('inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-medium', ui.tone)}>
      <Icon className="h-3 w-3 shrink-0" aria-hidden /> {t(`shiftsPage.logins.status.${status}`)}
    </span>
  );
}

/**
 * Најави: every login (and every refused one) in the period, newest first, 50 a page, Skopje
 * times, the status as a code the page translates (on_time | late | early | blocked). A table
 * from md, cards below; the per-agent summary under it.
 */
export function LoginsTab() {
  const { t } = useTranslation();
  const f = useInsightsFormat();
  const today = skopjeNow().date;
  const [from, setFrom] = useState<string | null>(monthBounds(today).from);
  const [to, setTo] = useState<string | null>(today);
  const [agent, setAgent] = useState('all');
  const [status, setStatus] = useState<ActivityStatus | 'all'>('all');
  const [page, setPage] = useState(0);
  useEffect(() => setPage(0), [from, to, agent, status]);
  const valid = !!from && !!to && from <= to;

  const q = useQuery({
    queryKey: ['shifts', 'activity', from, to, agent, status, page],
    queryFn: () => apiGetShiftLoginActivity({
      from: from!, to: to!, agent_id: agent === 'all' ? null : agent, status: status === 'all' ? null : status,
      limit: LIMIT, offset: page * LIMIT,
    }),
    enabled: valid,
    placeholderData: keepPreviousData,
  });
  const agents = useQuery<{ user_id: string; full_name: string }[]>({ queryKey: ['agents'], queryFn: apiGetAgents, staleTime: 5 * 60_000 });
  const agentOptions = useMemo(
    () => [...(agents.data ?? [])].sort((a, b) => (a.full_name ?? '').localeCompare(b.full_name ?? '')),
    [agents.data],
  );

  const data = q.data;
  const total = data?.total ?? 0;
  const first = total === 0 ? 0 : page * LIMIT + 1;
  const last = Math.min(total, (page + 1) * LIMIT);

  const reason = (r: ActivityRow) =>
    r.reason_code ? t(`shiftsPage.logins.reason.${r.reason_code}`, { detail: r.reason_detail ?? '' }) : null;
  const shiftText = (r: ActivityRow) => (r.shift_start && r.shift_end ? `${r.shift_start}–${r.shift_end}` : '—');
  const logoutText = (r: ActivityRow) =>
    r.kind === 'blocked' ? '—' : r.logout_local ?? t('shiftsPage.logins.active');

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-3 rounded-xl border bg-card/80 p-2 shadow-sm">
        <DmyDateInput label={t('shiftsPage.logins.from')} value={from} onChange={setFrom} max={to ?? undefined} />
        <DmyDateInput label={t('shiftsPage.logins.to')} value={to} onChange={setTo} min={from ?? undefined} />
        <label className="flex min-w-0 flex-col gap-1 text-[11px] text-muted-foreground">
          <span>{t('shiftsPage.logins.agent')}</span>
          <Select value={agent} onValueChange={setAgent}>
            <SelectTrigger className="h-8 w-[min(16rem,calc(100vw-4rem))] text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('shiftsPage.logins.allAgents')}</SelectItem>
              {agentOptions.map((a) => <SelectItem key={a.user_id} value={a.user_id}>{a.full_name}</SelectItem>)}
            </SelectContent>
          </Select>
        </label>
        <div role="group" aria-label={t('shiftsPage.logins.col.status')} className="flex w-full flex-wrap items-center gap-1.5">
          <Chip on={status === 'all'} onClick={() => setStatus('all')}>{t('shiftsPage.logins.allStatuses')}</Chip>
          {ACTIVITY_STATUSES.map((s) => (
            <Chip key={s} on={status === s} onClick={() => setStatus(s)}>
              {t(`shiftsPage.logins.status.${s}`)}
              {data && <span className="tabular-nums text-muted-foreground">{f.int(data.counts[s])}</span>}
            </Chip>
          ))}
        </div>
      </div>
      <p className="text-[11px] text-muted-foreground">{t('shiftsPage.logins.note')}</p>

      {q.isError && !data ? (
        <LoadError text={t('shiftsPage.logins.loadFailed')} onRetry={() => q.refetch()} />
      ) : !data ? (
        <div className="space-y-2" aria-hidden>{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} variant="tableRow" className="h-10" />)}</div>
      ) : data.rows.length === 0 ? (
        <EmptyState title={t('shiftsPage.logins.none')} size="sm" className="rounded-xl shadow-sm" />
      ) : (
        <>
          <div className="hidden overflow-x-auto rounded-xl border bg-card shadow-sm lg:block">
            <table className="w-full text-sm" data-testid="logins-table">
              <thead className="border-b text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">{t('shiftsPage.logins.col.user')}</th>
                  <th className="px-3 py-2 font-medium">{t('shiftsPage.logins.col.date')}</th>
                  <th className="px-3 py-2 font-medium">{t('shiftsPage.logins.col.shift')}</th>
                  <th className="px-3 py-2 font-medium">{t('shiftsPage.logins.col.login')}</th>
                  <th className="px-3 py-2 font-medium">{t('shiftsPage.logins.col.logout')}</th>
                  <th className="px-3 py-2 font-medium">{t('shiftsPage.logins.col.duration')}</th>
                  <th className="px-3 py-2 font-medium">{t('shiftsPage.logins.col.status')}</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {data.rows.map((r) => (
                  <tr key={`${r.kind}-${r.id}`} className="align-top">
                    <td className="px-3 py-2 font-medium">{r.user_name}</td>
                    <td className="px-3 py-2 tabular-nums">{formatDmy(r.date)}</td>
                    <td className="px-3 py-2 tabular-nums">{shiftText(r)}</td>
                    <td className="px-3 py-2 tabular-nums">{r.login_local ?? '—'}</td>
                    <td className="px-3 py-2 tabular-nums text-muted-foreground">{logoutText(r)}</td>
                    <td className="px-3 py-2 tabular-nums">{r.minutes != null ? duration(t, r.minutes) : '—'}</td>
                    <td className="px-3 py-2">
                      <StatusBadge status={r.status} />
                      {reason(r) && <span className="mt-0.5 block text-[11px] text-muted-foreground">{reason(r)}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2 lg:hidden">
            {data.rows.map((r) => (
              <MobileCard key={`${r.kind}-${r.id}`}>
                <MobileCardHeader title={r.user_name} subtitle={`${formatDmy(r.date)} · ${r.login_local ?? '—'}`} badge={<StatusBadge status={r.status} />} />
                <MobileCardField label={t('shiftsPage.logins.col.shift')} value={shiftText(r)} />
                {r.kind === 'login' && <MobileCardField label={t('shiftsPage.logins.col.logout')} value={logoutText(r)} />}
                {r.minutes != null && <MobileCardField label={t('shiftsPage.logins.col.duration')} value={duration(t, r.minutes)} />}
                {reason(r) && <p className="text-xs text-muted-foreground">{reason(r)}</p>}
              </MobileCard>
            ))}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <span className="tabular-nums">{t('shiftsPage.logins.page', { from: f.int(first), to: f.int(last), total: f.int(total) })}</span>
            <div className="flex gap-1">
              <Button type="button" variant="outline" size="icon" className="h-9 w-9" aria-label={t('shiftsPage.logins.prev')}
                disabled={page === 0 || q.isFetching} onClick={() => setPage((p) => Math.max(0, p - 1))}>
                <ChevronLeft className="h-4 w-4" aria-hidden />
              </Button>
              <Button type="button" variant="outline" size="icon" className="h-9 w-9" aria-label={t('shiftsPage.logins.next')}
                disabled={last >= total || q.isFetching} onClick={() => setPage((p) => p + 1)}>
                <ChevronRight className="h-4 w-4" aria-hidden />
              </Button>
            </div>
          </div>
        </>
      )}

      {data && data.summary.length > 0 && (
        <section aria-labelledby="logins-summary" className="space-y-2">
          <h3 id="logins-summary" className={LABEL}>{t('shiftsPage.logins.summaryTitle')}</h3>
          <div className="hidden overflow-x-auto rounded-xl border bg-card shadow-sm md:block">
            <table className="w-full text-sm">
              <thead className="border-b text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">{t('shiftsPage.logins.col.user')}</th>
                  {(['logins', 'days', 'late', 'early', 'blocked'] as const).map((k) => (
                    <th key={k} className="px-3 py-2 text-right font-medium">{t(`shiftsPage.logins.sumCols.${k}`)}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y">
                {data.summary.map((s) => (
                  <tr key={s.user_id}>
                    <td className="px-3 py-2 font-medium">{s.user_name}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{f.int(s.logins)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{f.int(s.days)}</td>
                    <td className={cn('px-3 py-2 text-right tabular-nums', s.late > 0 && 'text-amber-700 dark:text-amber-400')}>{f.int(s.late)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{f.int(s.early)}</td>
                    <td className={cn('px-3 py-2 text-right tabular-nums', s.blocked > 0 && 'text-red-700 dark:text-red-400')}>{f.int(s.blocked)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 md:hidden">
            {data.summary.map((s) => (
              <MobileCard key={s.user_id}>
                <MobileCardHeader title={s.user_name} />
                <MobileCardField label={t('shiftsPage.logins.sumCols.logins')} value={f.int(s.logins)} />
                <MobileCardField label={t('shiftsPage.logins.sumCols.late')} value={f.int(s.late)} />
                <MobileCardField label={t('shiftsPage.logins.sumCols.blocked')} value={f.int(s.blocked)} />
              </MobileCard>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
