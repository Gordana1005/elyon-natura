// Settings → Integrations health (owners only, 2026-09-28). "One screen showing
// for every data feed whether it works … When the AlterCPA feed was dead for 24
// days nobody noticed; this would have shown it red on day one." (Mile)
// Data: GET /api/integrations/health → public.integrations_health() (migration
// 20260939000200). Headline statuses use the Overview freshness thresholds, so
// this page and the Overview's strip agree. Every status is an icon AND a word.
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity, AlertTriangle, CheckCircle2, CircleSlash, Clock, Download, ExternalLink, Loader2, RefreshCw, XCircle,
  type LucideIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useToast } from '@/hooks/use-toast';
import { apiErrorText } from '@/i18n/apiErrors';
import i18n from '@/i18n';
import { cn } from '@/lib/utils';
import { formatMoney } from '@/lib/currency';
import { noParcelDaysOr } from '@/lib/noParcelRule';
import { ordersHref } from '@/components/insights/overview/model';
import {
  apiGetIntegrationsHealth, apiGetNoParcelPreview, apiGetNoParcelReport, apiSetNoParcelMode,
  type HealthCronJob, type HealthDay, type HealthFeed, type HealthJob, type HealthNoParcel, type HealthStatus,
} from '@/lib/api';
import { agoText, errorIsCurrent, issueCount, noParcelReportCsv, skopjeDateTime } from './integrationsHealthModel';

const STATUS: Record<HealthStatus, { icon: LucideIcon; tone: string; border: string; key: string }> = {
  ok: { icon: CheckCircle2, tone: 'text-emerald-700 dark:text-emerald-400', border: '', key: 'ok' },
  stale: { icon: Clock, tone: 'text-amber-700 dark:text-amber-400', border: 'border-amber-300 dark:border-amber-900', key: 'stale' },
  failing: { icon: XCircle, tone: 'text-red-700 dark:text-red-400', border: 'border-red-300 dark:border-red-900', key: 'failing' },
  'n/a': { icon: CircleSlash, tone: 'text-muted-foreground', border: '', key: 'na' },
};

function useErrorText() {
  const { t } = useTranslation();
  return (err: unknown) => {
    const code = err instanceof Error ? err.message : '';
    return code && i18n.exists(`settings.integrations.err.${code}`) ? t(`settings.integrations.err.${code}`) : apiErrorText(err);
  };
}

/** A ticking clock so "N min ago" never goes stale between refetches. */
function useNow(ms = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

export function IntegrationsHealthTab() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const errorText = useErrorText();
  const now = useNow();
  const q = useQuery({
    queryKey: ['integrations-health'],
    queryFn: apiGetIntegrationsHealth,
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
  });
  const h = q.data;
  const issues = useMemo(() => issueCount(h), [h]);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Activity className="h-4 w-4 text-primary" /> {t('settings.integrations.title')}
          </h2>
          <p className="text-sm text-muted-foreground max-w-3xl">{t('settings.integrations.desc')}</p>
        </div>
        <div className="flex items-center gap-3">
          {h && (
            issues === 0 ? (
              <span className={cn('inline-flex items-center gap-1.5 text-sm font-medium', STATUS.ok.tone)}>
                <CheckCircle2 className="h-4 w-4" aria-hidden /> {t('settings.integrations.allOk')}
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-2.5 py-1 text-sm font-semibold text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
                <AlertTriangle className="h-4 w-4" aria-hidden /> {t('settings.integrations.issues', { count: issues })}
              </span>
            )
          )}
          {h && <span className="text-xs tabular-nums text-muted-foreground">{t('settings.integrations.updated', { time: skopjeDateTime(h.generated_at) })}</span>}
          <Button
            variant="outline" size="sm" className="h-9"
            onClick={() => qc.invalidateQueries({ queryKey: ['integrations-health'] })}
            aria-label={t('settings.integrations.refresh')}
          >
            <RefreshCw className={cn('h-4 w-4', q.isFetching && 'animate-spin')} />
          </Button>
        </div>
      </div>

      {q.isLoading ? (
        <div className="flex items-center justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-primary" /></div>
      ) : q.isError && !h ? (
        <div className="flex items-center gap-2 rounded-xl border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
          <AlertTriangle className="h-4 w-4 shrink-0" /> {errorText(q.error)}
        </div>
      ) : h ? (
        <>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {h.feeds.map((f) => <FeedCard key={f.key} feed={f} now={now} />)}
            {h.no_parcel && <NoParcelCard np={h.no_parcel} now={now} />}
          </div>
          <CronTable jobs={h.cron ?? []} now={now} />
        </>
      ) : null}
    </div>
  );
}

// ── pieces ─────────────────────────────────────────────────────────────────
function StatusChip({ status, small }: { status: HealthStatus; small?: boolean }) {
  const { t } = useTranslation();
  const s = STATUS[status] ?? STATUS['n/a'];
  const Icon = s.icon;
  return (
    <span className={cn('inline-flex items-center gap-1 font-medium', small ? 'text-xs' : 'text-sm', s.tone)}>
      <Icon className={small ? 'h-3.5 w-3.5' : 'h-4 w-4'} aria-hidden /> {t(`settings.integrations.status.${s.key}`)}
    </span>
  );
}

function When({ iso, now }: { iso: string | null | undefined; now: number }) {
  const { t } = useTranslation();
  if (!iso) return <span className="text-muted-foreground">{t('settings.integrations.never')}</span>;
  return (
    <span className="tabular-nums">
      {skopjeDateTime(iso)} <span className="text-muted-foreground">({agoText(t, iso, now)})</span>
    </span>
  );
}

function ErrorBlock({ error, at, lastOk, now }: { error: string | null; at: string | null; lastOk: string | null; now: number }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  if (!error) return null;
  const current = errorIsCurrent(at, lastOk);
  const long = error.length > 140;
  return (
    <div className={cn('rounded-lg border px-3 py-2 text-xs', current ? 'border-red-300 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300' : 'bg-muted/40 text-muted-foreground')}>
      <div className="mb-0.5 flex flex-wrap items-center gap-x-2 font-medium">
        {t('settings.integrations.lastError')}
        {at && <span className="font-normal tabular-nums">{skopjeDateTime(at, true)} ({agoText(t, at, now)})</span>}
        {!current && <span className="font-normal">· {t('settings.integrations.errorOld')}</span>}
      </div>
      <p className="whitespace-pre-wrap break-words font-mono">{open || !long ? error : `${error.slice(0, 140)}…`}</p>
      {long && (
        <button type="button" onClick={() => setOpen((o) => !o)} className="mt-1 underline underline-offset-2">
          {open ? t('settings.integrations.showLess') : t('settings.integrations.showMore')}
        </button>
      )}
    </div>
  );
}

function DayStrip({ days }: { days: HealthDay[] | null | undefined }) {
  const { t } = useTranslation();
  if (!days) {
    return <p className="text-xs text-muted-foreground">{t('settings.integrations.noRunsYet')}</p>;
  }
  const max = Math.max(1, ...days.map((d) => d.ok + d.failed));
  return (
    <div>
      <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{t('settings.integrations.days7')}</div>
      <div className="flex items-end gap-1" role="img" aria-label={days.map((d) => t('settings.integrations.dayTip', { day: d.d.slice(8, 10) + '.' + d.d.slice(5, 7), ok: d.ok, failed: d.failed })).join('; ')}>
        {days.map((d) => {
          const total = d.ok + d.failed;
          const hPx = total === 0 ? 2 : Math.max(4, Math.round((total / max) * 36));
          const failPx = total === 0 ? 0 : Math.max(d.failed > 0 ? 3 : 0, Math.round((d.failed / total) * hPx));
          const label = `${d.d.slice(8, 10)}.${d.d.slice(5, 7)}`;
          return (
            <div key={d.d} className="flex flex-1 flex-col items-center gap-0.5" title={t('settings.integrations.dayTip', { day: label, ok: d.ok, failed: d.failed })}>
              <div className="flex h-9 w-full items-end justify-center">
                <div className="flex w-full max-w-[22px] flex-col overflow-hidden rounded-sm" style={{ height: hPx }}>
                  {failPx > 0 && <div className="bg-red-500 dark:bg-red-400" style={{ height: failPx }} />}
                  <div className={cn('flex-1', total === 0 ? 'bg-muted' : 'bg-emerald-500 dark:bg-emerald-400')} />
                </div>
              </div>
              <span className="text-[10px] tabular-nums text-muted-foreground">{d.d.slice(8, 10)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function JobsList({ jobs, now }: { jobs: HealthJob[]; now: number }) {
  const { t } = useTranslation();
  if (!jobs.length) return null;
  const jobName = (j: string) => (i18n.exists(`settings.integrations.job.${j}`) ? t(`settings.integrations.job.${j}`) : j);
  return (
    <div>
      <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{t('settings.integrations.jobs')}</div>
      <ul className="divide-y rounded-lg border">
        {jobs.map((j) => (
          <li key={j.job} className="px-2.5 py-1.5 text-xs">
            <div className="flex flex-wrap items-center justify-between gap-x-2">
              <span>
                <span className="font-medium">{jobName(j.job)}</span>
                <span className="ml-1.5 text-muted-foreground">{t(`settings.integrations.expect.${j.expect}`)}</span>
              </span>
              <StatusChip status={j.status} small />
            </div>
            <div className="mt-0.5 flex flex-wrap gap-x-3 text-muted-foreground">
              <span>{t('settings.integrations.lastOk')}: {j.last_ok_at ? agoText(t, j.last_ok_at, now) : t('settings.integrations.never')}</span>
              <span>{t('settings.integrations.runs24')}: {t('settings.integrations.runs24Value', { runs: j.runs_24h, failed: j.failed_24h })}</span>
            </div>
            {j.status === 'failing' && j.last_error && (
              <p className="mt-0.5 break-words font-mono text-red-700 dark:text-red-400" title={j.last_error}>
                {j.last_error.length > 120 ? `${j.last_error.slice(0, 120)}…` : j.last_error}
              </p>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function FeedCard({ feed, now }: { feed: HealthFeed; now: number }) {
  const { t } = useTranslation();
  const s = STATUS[feed.status] ?? STATUS['n/a'];
  const isCb = feed.key === 'collabbox';
  const rowKeys = Object.keys(feed.rows ?? {});
  return (
    <section className={cn('space-y-3 rounded-xl border bg-card p-4 shadow-sm', s.border)} aria-label={t(`settings.integrations.feed.${feed.key}`)}>
      <header className="space-y-0.5">
        <div className="flex items-center justify-between gap-2">
          <h3 className="font-semibold">{t(`settings.integrations.feed.${feed.key}`)}</h3>
          <StatusChip status={feed.status} />
        </div>
        <p className="text-xs text-muted-foreground" title={feed.detail ?? undefined}>{t(`settings.integrations.feedDesc.${feed.key}`)}</p>
      </header>

      <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-1 text-sm">
        <dt className="text-muted-foreground">{isCb ? t('settings.integrations.newestDoc') : t('settings.integrations.lastOk')}</dt>
        <dd><When iso={feed.last_ok_at} now={now} /></dd>
        {!isCb && (
          <>
            <dt className="text-muted-foreground">{t('settings.integrations.runs24')}</dt>
            <dd className={cn('tabular-nums', feed.failed_24h > 0 && 'text-red-700 dark:text-red-400')}>
              {t('settings.integrations.runs24Value', { runs: feed.runs_24h, failed: feed.failed_24h })}
            </dd>
          </>
        )}
      </dl>
      {feed.key.startsWith('mex_') && feed.data_through && (
        <p className="text-xs text-muted-foreground">{t('settings.integrations.dataThrough', { time: skopjeDateTime(feed.data_through, true) })}</p>
      )}

      {rowKeys.length > 0 && (
        <div>
          {!isCb && <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{t('settings.integrations.rows24')}</div>}
          <dl className="grid grid-cols-[1fr,auto] gap-x-3 gap-y-0.5 text-sm">
            {rowKeys.map((k) => (
              <div key={k} className="contents">
                <dt className="text-muted-foreground">{t(`settings.integrations.rows.${k}`)}</dt>
                <dd className="text-right font-medium tabular-nums">{(feed.rows[k] ?? 0).toLocaleString('de-DE')}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}

      <ErrorBlock error={feed.last_error} at={feed.last_error_at} lastOk={feed.last_ok_at} now={now} />
      <DayStrip days={feed.days} />
      <JobsList jobs={feed.jobs ?? []} now={now} />
    </section>
  );
}

// ── the no-parcel rule (window from no_parcel_rule_days(), default 10) ───────────────────────────────────────────────
function NoParcelCard({ np, now }: { np: HealthNoParcel; now: number }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const errorText = useErrorText();
  const [pending, setPending] = useState<'apply' | 'report' | null>(null);
  const [switching, setSwitching] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const previewQ = useQuery({
    queryKey: ['no-parcel-preview', pending],
    queryFn: apiGetNoParcelPreview,
    enabled: pending === 'apply',
    staleTime: 0,
    gcTime: 0,
  });
  const s = STATUS[np.status] ?? STATUS['n/a'];
  const run = np.last_run;
  const nextTime = skopjeDateTime(np.next_run_at);
  const modeWord = (m: string) => (m === 'apply' ? t('settings.integrations.np.modeApply') : t('settings.integrations.np.modeReport'));
  // The rule's window from the payload (no_parcel_rule_days(), default 10) — never a hardcoded 7.
  const days = noParcelDaysOr(np.days_n);
  const ordersLink = ordersHref({ attention: 'approved_no_parcel_7d' }, t('overview.attention.kind.approved_no_parcel_7d', { days }))
    ?? '/orders?attention=approved_no_parcel_7d';

  const confirm = async () => {
    if (!pending) return;
    setSwitching(true);
    try {
      await apiSetNoParcelMode(pending);
      toast({ title: t('settings.integrations.np.switched', { mode: modeWord(pending), days }) });
      setPending(null);
      await qc.invalidateQueries({ queryKey: ['integrations-health'] });
    } catch (err) {
      toast({ title: t('common.error'), description: errorText(err), variant: 'destructive' });
    } finally {
      setSwitching(false);
    }
  };

  const download = async () => {
    if (!run) {
      toast({ title: t('settings.integrations.np.downloadEmpty') });
      return;
    }
    setDownloading(true);
    try {
      const r = await apiGetNoParcelReport(run.id);
      const blob = new Blob([noParcelReportCsv(r.rows ?? [])], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `no-parcel-rule-${run.run_day}-${run.mode}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      toast({ title: t('common.error'), description: errorText(err), variant: 'destructive' });
    } finally {
      setDownloading(false);
    }
  };

  const stat = (label: string, value: string | number, tone?: string) => (
    <div className="rounded-lg border px-2.5 py-1.5">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className={cn('text-base font-semibold tabular-nums', tone)}>{value}</div>
    </div>
  );
  const preview = previewQ.data;

  return (
    <section className={cn('space-y-3 rounded-xl border bg-card p-4 shadow-sm', s.border)} aria-label={t('settings.integrations.feed.no_parcel_rule', { days })}>
      <header className="space-y-0.5">
        <div className="flex items-center justify-between gap-2">
          <h3 className="font-semibold">{t('settings.integrations.feed.no_parcel_rule', { days })}</h3>
          <StatusChip status={np.status} />
        </div>
        <p className="text-xs text-muted-foreground">{t('settings.integrations.feedDesc.no_parcel_rule', { days, hour: np.hour })}</p>
      </header>

      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2">
        <div className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">{t('settings.integrations.np.mode')}</span>
          <Badge variant={np.mode === 'apply' ? 'destructive' : 'secondary'}>{modeWord(np.mode)}</Badge>
        </div>
        <label className="flex items-center gap-2 text-sm">
          {t('settings.integrations.np.switchLabel')}
          <Switch
            checked={np.mode === 'apply'}
            onCheckedChange={(v) => setPending(v ? 'apply' : 'report')}
            aria-label={t('settings.integrations.np.switchLabel')}
          />
        </label>
      </div>
      <p className="text-xs text-muted-foreground">
        {np.mode === 'apply' ? t('settings.integrations.np.hintApply', { days }) : t('settings.integrations.np.hintReport')}
      </p>

      <div className="text-sm">
        {run ? (
          <span>
            {t('settings.integrations.np.lastRun', { time: skopjeDateTime(run.ran_at, true) })}
            <span className="text-muted-foreground"> · {t(`settings.integrations.np.trigger.${run.trigger_kind}`)} · {modeWord(run.mode)} ({agoText(t, run.ran_at, now)})</span>
          </span>
        ) : (
          <span className="text-muted-foreground">{t('settings.integrations.np.noRun')}</span>
        )}
        {np.next_run_at && <div className="text-xs text-muted-foreground">{t('settings.integrations.np.nextRun', { time: nextTime })}</div>}
      </div>

      {run && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {stat(t('settings.integrations.np.matched'), run.candidates)}
          {stat(t('settings.integrations.np.wouldCancel'), run.to_cancel, run.to_cancel > 0 ? 'text-amber-700 dark:text-amber-400' : undefined)}
          {stat(t('settings.integrations.np.needsLinking'), run.needs_linking)}
          {stat(t('settings.integrations.np.cancelled'), run.cancelled, run.cancelled > 0 ? 'text-red-700 dark:text-red-400' : undefined)}
          {stat(t('settings.integrations.np.value'), formatMoney(run.mode === 'apply' && run.cancelled > 0 ? run.cancelled_value_eur : run.value_eur))}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <Button asChild variant="outline" size="sm" className="h-8">
          <Link to={ordersLink}>
            <ExternalLink className="h-3.5 w-3.5 mr-1" /> {t('settings.integrations.np.openOrders')}
          </Link>
        </Button>
        <Button variant="outline" size="sm" className="h-8" onClick={download} disabled={downloading || !run}>
          {downloading ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Download className="h-3.5 w-3.5 mr-1" />}
          {t('settings.integrations.np.download')}
        </Button>
      </div>

      <ErrorBlock error={np.last_error} at={np.cron_last_at} lastOk={np.last_ok_at} now={now} />
      <DayStrip days={np.days} />

      <AlertDialog open={!!pending} onOpenChange={(o) => { if (!o && !switching) setPending(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pending === 'apply' ? t('settings.integrations.np.confirmApplyTitle', { days }) : t('settings.integrations.np.confirmReportTitle', { days })}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="text-sm text-muted-foreground">
                {pending === 'report' && t('settings.integrations.np.confirmReportBody', { time: nextTime })}
                {pending === 'apply' && (
                  previewQ.isLoading || previewQ.isFetching ? (
                    <span className="flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" /> {t('settings.integrations.np.previewLoading')}</span>
                  ) : previewQ.isError || !preview ? (
                    <span className="text-destructive">{t('settings.integrations.np.previewFailed')}</span>
                  ) : (
                    <p>
                      {t('settings.integrations.np.confirmApplyBody', {
                        time: nextTime, count: preview.to_cancel, value: formatMoney(preview.value_eur), linking: preview.needs_linking,
                      })}
                    </p>
                  )
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={switching}>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => { e.preventDefault(); void confirm(); }}
              disabled={switching || (pending === 'apply' && (!preview || previewQ.isFetching))}
              className={pending === 'apply' ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90' : undefined}
            >
              {switching && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
              {pending === 'apply' ? t('settings.integrations.np.confirmApply') : t('settings.integrations.np.confirmReport')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

// ── pg_cron ────────────────────────────────────────────────────────────────
function CronTable({ jobs, now }: { jobs: HealthCronJob[]; now: number }) {
  const { t } = useTranslation();
  const [openErr, setOpenErr] = useState<number | null>(null);
  return (
    <section className="rounded-xl border bg-card shadow-sm">
      <header className="border-b px-4 py-3">
        <h3 className="text-sm font-semibold">{t('settings.integrations.cron.title')}</h3>
        <p className="text-xs text-muted-foreground">{t('settings.integrations.cron.desc')}</p>
      </header>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">{t('settings.integrations.cron.job')}</th>
              <th className="px-3 py-2 font-medium">{t('settings.integrations.cron.schedule')}</th>
              <th className="px-3 py-2 font-medium">{t('settings.integrations.cron.status')}</th>
              <th className="px-3 py-2 font-medium">{t('settings.integrations.cron.lastRun')}</th>
              <th className="px-3 py-2 font-medium text-right">{t('settings.integrations.cron.runs24')}</th>
              <th className="px-3 py-2 font-medium">{t('settings.integrations.cron.days')}</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {jobs.map((j) => (
              <tr key={j.jobid} className={cn(!j.active && 'opacity-60')}>
                <td className="px-3 py-2 align-top">
                  <span className="font-mono text-xs">{j.jobname}</span>
                  {!j.active && <Badge variant="secondary" className="ml-1.5 h-5 px-1.5 text-[10px]">{t('settings.integrations.cron.paused')}</Badge>}
                  {j.last_error && (
                    <div className="mt-0.5">
                      <button type="button" className="text-[11px] text-red-700 underline underline-offset-2 dark:text-red-400" onClick={() => setOpenErr(openErr === j.jobid ? null : j.jobid)}>
                        {t('settings.integrations.lastError')} · {skopjeDateTime(j.last_error_at)}
                      </button>
                      {openErr === j.jobid && <p className="mt-0.5 max-w-md whitespace-pre-wrap break-words font-mono text-[11px] text-red-700 dark:text-red-400">{j.last_error}</p>}
                    </div>
                  )}
                </td>
                <td className="px-3 py-2 align-top font-mono text-xs">{j.schedule}</td>
                <td className="px-3 py-2 align-top"><StatusChip status={j.status} small /></td>
                <td className="px-3 py-2 align-top text-xs">
                  {j.last_start ? <When iso={j.last_start} now={now} /> : <span className="text-muted-foreground">{t('settings.integrations.cron.noRuns')}</span>}
                </td>
                <td className={cn('px-3 py-2 align-top text-right text-xs tabular-nums', j.failed_24h > 0 && 'text-red-700 dark:text-red-400')}>
                  {t('settings.integrations.runs24Value', { runs: j.runs_24h, failed: j.failed_24h })}
                </td>
                <td className="px-3 py-2 align-top">
                  <MiniStrip days={j.days} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function MiniStrip({ days }: { days: HealthDay[] | null }) {
  const { t } = useTranslation();
  if (!days) return null;
  return (
    <div className="flex items-end gap-0.5">
      {days.map((d) => {
        const label = `${d.d.slice(8, 10)}.${d.d.slice(5, 7)}`;
        const tone = d.failed > 0 ? 'bg-red-500 dark:bg-red-400' : d.ok > 0 ? 'bg-emerald-500 dark:bg-emerald-400' : 'bg-muted';
        return (
          <span
            key={d.d}
            className={cn('inline-block h-3 w-2 rounded-[2px]', tone)}
            title={t('settings.integrations.dayTip', { day: label, ok: d.ok, failed: d.failed })}
          />
        );
      })}
    </div>
  );
}
