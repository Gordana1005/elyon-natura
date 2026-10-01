import { useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import {
  Activity, PhoneCall, HardDrive, MemoryStick, Mic, AlertTriangle, ShieldAlert,
  CheckCircle2, XCircle, Server, Clock, Timer, Gauge, RefreshCw, Loader2,
} from 'lucide-react';
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';
import { AppLayout } from '@/layouts/AppLayout';
import { useAuth } from '@/contexts/AuthContext';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Progress } from '@/components/ui/progress';
import { KpiCard } from '@/components/insights/KpiCard';
import { CHART_COLORS, fmtDuration } from '@/lib/design-utils';
import { formatDayDmy } from '@/i18n/dates';
import {
  apiGetVoipHealth, apiGetVoipHealthHistory, apiGetRecordingCoverage, apiGetVoipMinutes,
} from '@/lib/api';
import { formatSkopje } from '@/lib/skopjeTime';

type Range = '24h' | '7d' | '30d';

// Fallback only — the live cap comes from the PBX (`pbx.lines.max`, read from the
// enforced dialplan global OUTMAXCHANS_1). Used until the first health pull lands.
// 10, not the 25 A1 sold us: their Admission Control still admits only 10
// (proven 2026-07-28). Showing a capacity the carrier won't honour is worse than
// showing none.
const MAX_LINES_FALLBACK = 10;

function bytesH(n?: number | null): string {
  if (!n || n <= 0) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${u[i]}`;
}

function StatusDot({ ok, label }: { ok: boolean | null | undefined; label: string }) {
  const color = ok === true ? 'bg-emerald-500' : ok === false ? 'bg-destructive' : 'bg-muted-foreground';
  return (
    <span className="inline-flex items-center gap-1.5 text-sm font-medium">
      <span className={`h-2.5 w-2.5 rounded-full ${color}`} />
      {label}
    </span>
  );
}

function pctTone(pct: number): string {
  if (pct >= 92) return 'bg-destructive/10 text-destructive';
  if (pct >= 85) return 'bg-amber-100 text-amber-700';
  return 'bg-emerald-100 text-emerald-700';
}

export default function VoipHealthPage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [tab, setTab] = useState('overview');
  const [range, setRange] = useState<Range>('7d');
  const isAdmin = !!user?.isAdmin;

  const health = useQuery({
    queryKey: ['voip-health'],
    queryFn: apiGetVoipHealth,
    refetchInterval: 20000,
    enabled: isAdmin,
  });
  const history = useQuery({
    queryKey: ['voip-health-history', range],
    queryFn: () => apiGetVoipHealthHistory(range === '24h' ? '24h' : range),
    enabled: isAdmin && (tab === 'server' || tab === 'lines'),
  });
  const coverage = useQuery({
    queryKey: ['voip-coverage', range],
    queryFn: () => apiGetRecordingCoverage(range),
    enabled: isAdmin && tab === 'recordings',
  });
  const minutes = useQuery({
    queryKey: ['voip-minutes', range],
    queryFn: () => apiGetVoipMinutes(range, 'day'),
    enabled: isAdmin && tab === 'minutes',
  });
  const minutesByAgent = useQuery({
    queryKey: ['voip-minutes-agent', range],
    queryFn: () => apiGetVoipMinutes(range, 'agent'),
    enabled: isAdmin && tab === 'minutes',
  });

  // Superadmin only (after hooks so hook order stays stable).
  if (user && !user.isAdmin) return <Navigate to="/" replace />;

  const h = health.data;
  const pbx = h?.pbx;
  const pbxOk = pbx?.ok !== false;
  const incidents = h?.incidents || [];
  const critical = incidents.filter((i) => i.level === 'critical');
  const maxLines = pbx?.lines?.max ?? MAX_LINES_FALLBACK;
  const cycle = minutes.data?.cycle;

  const rangeBtns: Range[] = ['24h', '7d', '30d'];
  const headerActions = (
    <div className="flex items-center gap-1.5">
      {health.isFetching && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
      <Button variant="outline" size="sm" onClick={() => health.refetch()}>
        <RefreshCw className="h-3.5 w-3.5 mr-1.5" /> {t('voipHealth.refresh')}
      </Button>
    </div>
  );

  return (
    <AppLayout title={t('voipHealth.title')} headerActions={headerActions}>
      <div className="space-y-4">
        {/* Connectivity banner for the page itself */}
        {!pbxOk && (
          <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-2.5 text-sm text-destructive">
            <ShieldAlert className="h-4 w-4 shrink-0" />
            {t('voipHealth.pbxUnreachable')}
          </div>
        )}

        {health.isLoading ? (
          <div className="flex h-64 items-center justify-center">
            <Loader2 className="h-7 w-7 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <Tabs value={tab} onValueChange={setTab}>
            <TabsList>
              <TabsTrigger value="overview">{t('voipHealth.tabs.overview')}</TabsTrigger>
              <TabsTrigger value="lines">{t('voipHealth.tabs.linesTrunk')}</TabsTrigger>
              <TabsTrigger value="recordings">{t('voipHealth.tabs.recordings')}</TabsTrigger>
              <TabsTrigger value="quality">{t('voipHealth.tabs.callQuality')}</TabsTrigger>
              <TabsTrigger value="server">{t('voipHealth.tabs.server')}</TabsTrigger>
              <TabsTrigger value="minutes">{t('voipHealth.tabs.minutes')}</TabsTrigger>
            </TabsList>

            {/* ── OVERVIEW ── */}
            <TabsContent value="overview" className="space-y-4">
              <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
                <KpiCard
                  icon={PhoneCall} label={t('voipHealth.cards.activeLines')}
                  value={`${pbx?.lines?.active ?? '—'} / ${maxLines}`}
                  sub={t('voipHealth.cards.linesSub')}
                  tone={(pbx?.lines?.active ?? 0) >= maxLines ? 'bg-amber-100 text-amber-700' : 'bg-emerald-100 text-emerald-700'}
                />
                <KpiCard
                  icon={Activity} label={t('voipHealth.cards.trunk')}
                  value={pbx?.trunk?.reachable === true ? t('voipHealth.status.reachable') : pbx?.trunk ? t('voipHealth.status.unreachable') : '—'}
                  sub={pbx?.trunk?.rtt_ms != null ? `${pbx.trunk.rtt_ms} ms` : undefined}
                  tone={pbx?.trunk?.reachable === false ? 'bg-destructive/10 text-destructive' : 'bg-emerald-100 text-emerald-700'}
                />
                <KpiCard
                  icon={HardDrive} label={t('voipHealth.cards.disk')}
                  value={pbx?.disk?.pct != null ? `${pbx.disk.pct}%` : '—'}
                  sub={pbx?.disk ? `${bytesH(pbx.disk.free)} ${t('voipHealth.free')}` : undefined}
                  tone={pbx?.disk?.pct != null ? pctTone(pbx.disk.pct) : undefined}
                />
                <KpiCard
                  icon={MemoryStick} label={t('voipHealth.cards.memory')}
                  value={pbx?.mem?.pct != null ? `${pbx.mem.pct}%` : '—'}
                  tone={pbx?.mem?.pct != null ? pctTone(pbx.mem.pct) : undefined}
                />
                <KpiCard
                  icon={Mic} label={t('voipHealth.cards.recordingsToday')}
                  value={`${pbx?.recordings_today?.count ?? h?.today.answered_recorded ?? '—'}`}
                  sub={`${h?.today.recording_coverage_pct ?? 0}% ${t('voipHealth.recordings.coverage')}`}
                  tone={(h?.today.recording_coverage_pct ?? 100) < 80 ? 'bg-amber-100 text-amber-700' : 'bg-emerald-100 text-emerald-700'}
                />
                <KpiCard
                  icon={AlertTriangle} label={t('voipHealth.cards.openIncidents')}
                  value={`${incidents.length}`}
                  tone={critical.length ? 'bg-destructive/10 text-destructive' : incidents.length ? 'bg-amber-100 text-amber-700' : 'bg-emerald-100 text-emerald-700'}
                />
              </div>

              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                <KpiCard icon={PhoneCall} label={t('voipHealth.cards.callsToday')} value={`${h?.today.calls ?? 0}`} tone="bg-sky-100 text-sky-700" />
                <KpiCard icon={CheckCircle2} label={t('voipHealth.cards.answered')} value={`${h?.today.answered ?? 0}`} tone="bg-emerald-100 text-emerald-700" />
                <KpiCard icon={Timer} label={t('voipHealth.cards.outboundMinutes')} value={`${h?.today.outbound_minutes ?? 0}`} tone="bg-violet-100 text-violet-700" />
                <KpiCard icon={XCircle} label={t('voipHealth.cards.oneWayAudio')} value={`${h?.today.one_way_audio ?? 0}`} tone={(h?.today.one_way_audio ?? 0) > 0 ? 'bg-amber-100 text-amber-700' : 'bg-muted text-muted-foreground'} />
              </div>

              {/* Incidents */}
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">{t('voipHealth.incidentsTitle')}</CardTitle>
                </CardHeader>
                <CardContent>
                  {incidents.length === 0 ? (
                    <p className="flex items-center gap-2 text-sm text-muted-foreground">
                      <CheckCircle2 className="h-4 w-4 text-emerald-600" /> {t('voipHealth.noIncidents')}
                    </p>
                  ) : (
                    <ul className="space-y-2">
                      {incidents.map((i, idx) => (
                        <li key={idx} className="flex items-center gap-2 text-sm">
                          <Badge variant={i.level === 'critical' ? 'destructive' : 'secondary'}>
                            {t(`voipHealth.level.${i.level}`)}
                          </Badge>
                          <span>{i.message}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {h?.snapshot_age_seconds != null && (
                    <p className="mt-3 text-xs text-muted-foreground">
                      {t('voipHealth.lastSnapshot', { ago: fmtDuration(h.snapshot_age_seconds) })}
                    </p>
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            {/* ── LINES & TRUNK ── */}
            <TabsContent value="lines" className="space-y-4">
              <div className="grid gap-4 lg:grid-cols-2">
                <Card>
                  <CardHeader className="pb-3"><CardTitle className="text-base">{t('voipHealth.lines.title')}</CardTitle></CardHeader>
                  <CardContent className="space-y-3">
                    <div className="flex items-baseline gap-2">
                      <span className="text-3xl font-bold tabular-nums">{pbx?.lines?.active ?? 0}</span>
                      <span className="text-muted-foreground">/ {maxLines} {t('voipHealth.lines.linesLabel')}</span>
                    </div>
                    <Progress value={((pbx?.lines?.active ?? 0) / maxLines) * 100} />
                    {pbx?.lines?.channels?.length ? (
                      <div className="divide-y rounded-md border text-sm">
                        {pbx.lines.channels.map((c, i) => (
                          <div key={i} className="flex items-center justify-between px-3 py-2">
                            <span className="font-medium">{c.ext || '—'}</span>
                            <span className="text-muted-foreground tabular-nums">{c.dialed || '—'}</span>
                            <span className="tabular-nums">{fmtDuration(c.duration)}</span>
                            <Badge variant="outline">{c.state}</Badge>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-sm text-muted-foreground">{t('voipHealth.lines.noActive')}</p>
                    )}
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader className="pb-3"><CardTitle className="text-base">{t('voipHealth.trunk.title')}</CardTitle></CardHeader>
                  <CardContent className="space-y-3">
                    <StatusDot ok={pbx?.trunk?.reachable} label={pbx?.trunk?.name || 'a1-bulgaria'} />
                    <div className="text-sm text-muted-foreground">
                      {pbx?.trunk?.rtt_ms != null ? `${t('voipHealth.trunk.rtt')}: ${pbx.trunk.rtt_ms} ms` : '—'}
                    </div>
                    <div className="pt-2">
                      <p className="mb-2 text-xs font-semibold uppercase text-muted-foreground">{t('voipHealth.extensions.title')}</p>
                      <div className="flex flex-wrap gap-1.5">
                        {(pbx?.extensions || []).map((e) => (
                          <Badge key={e.ext} variant={e.registered ? 'default' : 'outline'}>
                            {e.ext} {e.registered ? '●' : '○'}
                          </Badge>
                        ))}
                        {!pbx?.extensions?.length && <span className="text-sm text-muted-foreground">—</span>}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </div>

              {/* Line usage trend (peaks toward the cap = need more lines) */}
              <Card>
                <CardHeader className="pb-3"><CardTitle className="text-base">{t('voipHealth.lines.usageTrend')}</CardTitle></CardHeader>
                <CardContent>
                  {history.data?.snapshots?.length ? (
                    <ResponsiveContainer width="100%" height={220}>
                      <AreaChart data={history.data.snapshots}>
                        <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                        <XAxis dataKey="captured_at" tickFormatter={(v) => formatSkopje(v, 'HH:mm')} fontSize={11} />
                        <YAxis allowDecimals={false} domain={[0, maxLines]} fontSize={11} />
                        <Tooltip labelFormatter={(v) => formatSkopje(v as string, 'dd.MM.yyyy HH:mm')} />
                        <Area type="monotone" dataKey="active_lines" stroke={CHART_COLORS.primary} fill={CHART_COLORS.primary} fillOpacity={0.2} />
                      </AreaChart>
                    </ResponsiveContainer>
                  ) : (
                    <p className="text-sm text-muted-foreground">{t('voipHealth.noTrend')}</p>
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            {/* ── RECORDINGS ── */}
            <TabsContent value="recordings" className="space-y-4">
              <RangeBar range={range} setRange={setRange} rangeBtns={rangeBtns} t={t} />
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                <KpiCard icon={Mic} label={t('voipHealth.recordings.coverage')} value={`${coverage.data?.coverage_pct ?? '—'}%`} tone={(coverage.data?.coverage_pct ?? 100) < 80 ? 'bg-amber-100 text-amber-700' : 'bg-emerald-100 text-emerald-700'} />
                <KpiCard icon={CheckCircle2} label={t('voipHealth.recordings.recorded')} value={`${coverage.data?.recorded ?? '—'}`} tone="bg-emerald-100 text-emerald-700" />
                <KpiCard icon={XCircle} label={t('voipHealth.recordings.unrecorded')} value={`${coverage.data?.unrecorded ?? '—'}`} tone={(coverage.data?.unrecorded ?? 0) > 0 ? 'bg-amber-100 text-amber-700' : 'bg-muted text-muted-foreground'} />
                <KpiCard icon={HardDrive} label={t('voipHealth.recordings.diskUsage')} value={bytesH(pbx?.disk?.rec_bytes)} tone="bg-sky-100 text-sky-700" />
              </div>
              <Card>
                <CardHeader className="pb-3"><CardTitle className="text-base">{t('voipHealth.recordings.gapList')}</CardTitle></CardHeader>
                <CardContent>
                  {coverage.isLoading ? (
                    <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                  ) : coverage.data?.gaps?.length ? (
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead className="text-left text-xs uppercase text-muted-foreground">
                          <tr>
                            <th className="py-2 pr-3">{t('voipHealth.recordings.when')}</th>
                            <th className="py-2 pr-3">{t('voipHealth.recordings.agent')}</th>
                            <th className="py-2 pr-3">{t('voipHealth.recordings.phone')}</th>
                            <th className="py-2 pr-3">{t('voipHealth.recordings.outcome')}</th>
                            <th className="py-2">{t('voipHealth.recordings.reason')}</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y">
                          {coverage.data.gaps.map((g) => (
                            <tr key={g.id}>
                              <td className="py-2 pr-3 tabular-nums">{g.call_at ? formatSkopje(g.call_at, 'dd.MM.yyyy HH:mm') : '—'}</td>
                              <td className="py-2 pr-3">{g.agent_name || '—'}</td>
                              <td className="py-2 pr-3 tabular-nums">{g.customer_phone || '—'}</td>
                              <td className="py-2 pr-3">{g.outcome || '—'}</td>
                              <td className="py-2"><Badge variant="outline">{t(`voipHealth.recordings.reasonCode.${g.reason}`)}</Badge></td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <p className="flex items-center gap-2 text-sm text-muted-foreground">
                      <CheckCircle2 className="h-4 w-4 text-emerald-600" /> {t('voipHealth.recordings.noGaps')}
                    </p>
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            {/* ── CALL QUALITY ── */}
            <TabsContent value="quality" className="space-y-4">
              <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
                <KpiCard icon={XCircle} label={t('voipHealth.quality.oneWayToday')} value={`${h?.today.one_way_audio ?? 0}`} tone={(h?.today.one_way_audio ?? 0) > 0 ? 'bg-amber-100 text-amber-700' : 'bg-emerald-100 text-emerald-700'} />
                <KpiCard icon={Gauge} label={t('voipHealth.cards.answered')} value={`${h?.today.answered ?? 0}`} tone="bg-sky-100 text-sky-700" />
                <KpiCard icon={PhoneCall} label={t('voipHealth.cards.noAnswer')} value={`${h?.today.no_answer ?? 0}`} tone="bg-muted text-muted-foreground" />
              </div>
              <Card>
                <CardContent className="pt-6 text-sm text-muted-foreground">
                  {t('voipHealth.quality.explainer')}
                </CardContent>
              </Card>
            </TabsContent>

            {/* ── SERVER ── */}
            <TabsContent value="server" className="space-y-4">
              <RangeBar range={range} setRange={setRange} rangeBtns={rangeBtns} t={t} />
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                <KpiCard icon={Server} label={t('voipHealth.server.asterisk')} value={pbx?.asterisk?.running ? t('voipHealth.status.running') : t('voipHealth.status.stopped')} tone={pbx?.asterisk?.running ? 'bg-emerald-100 text-emerald-700' : 'bg-destructive/10 text-destructive'} />
                <KpiCard icon={Clock} label={t('voipHealth.server.uptime')} value={pbx?.asterisk?.uptime_seconds != null ? fmtDuration(pbx.asterisk.uptime_seconds) : '—'} tone="bg-sky-100 text-sky-700" />
                <KpiCard icon={Gauge} label={t('voipHealth.server.load')} value={pbx?.load?.['1'] != null ? `${pbx.load['1']}` : '—'} tone="bg-violet-100 text-violet-700" />
                <KpiCard icon={ShieldAlert} label={t('voipHealth.server.bannedIps')} value={`${pbx?.attacks?.banned_count ?? 0}`} tone={(pbx?.attacks?.banned_count ?? 0) >= 10 ? 'bg-amber-100 text-amber-700' : 'bg-muted text-muted-foreground'} />
              </div>

              <div className="grid gap-4 lg:grid-cols-2">
                <Card>
                  <CardHeader className="pb-3"><CardTitle className="text-base">{t('voipHealth.server.resourceTrend')}</CardTitle></CardHeader>
                  <CardContent>
                    {history.data?.snapshots?.length ? (
                      <ResponsiveContainer width="100%" height={220}>
                        <AreaChart data={history.data.snapshots}>
                          <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                          <XAxis dataKey="captured_at" tickFormatter={(v) => formatSkopje(v, 'HH:mm')} fontSize={11} />
                          <YAxis domain={[0, 100]} fontSize={11} />
                          <Tooltip labelFormatter={(v) => formatSkopje(v as string, 'dd.MM.yyyy HH:mm')} />
                          <Area type="monotone" dataKey="disk_pct" name={t('voipHealth.cards.disk')} stroke={CHART_COLORS.warning} fill={CHART_COLORS.warning} fillOpacity={0.15} />
                          <Area type="monotone" dataKey="mem_pct" name={t('voipHealth.cards.memory')} stroke={CHART_COLORS.tertiary} fill={CHART_COLORS.tertiary} fillOpacity={0.15} />
                        </AreaChart>
                      </ResponsiveContainer>
                    ) : (
                      <p className="text-sm text-muted-foreground">{t('voipHealth.noTrend')}</p>
                    )}
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader className="pb-3"><CardTitle className="text-base">{t('voipHealth.server.errors')}</CardTitle></CardHeader>
                  <CardContent>
                    {pbx?.errors?.length ? (
                      <ul className="max-h-64 space-y-1 overflow-y-auto font-mono text-xs">
                        {pbx.errors.map((e, i) => (
                          <li key={i} className="border-b border-border/50 pb-1">
                            <span className="text-muted-foreground">[{e.src}]</span> {e.line}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-sm text-muted-foreground">{t('voipHealth.server.noErrors')}</p>
                    )}
                    {pbx?.attacks?.banned_ips?.length ? (
                      <div className="mt-4">
                        <p className="mb-1.5 text-xs font-semibold uppercase text-muted-foreground">{t('voipHealth.server.bannedIps')}</p>
                        <div className="flex flex-wrap gap-1.5">
                          {pbx.attacks.banned_ips.map((ip) => <Badge key={ip} variant="outline" className="font-mono">{ip}</Badge>)}
                        </div>
                      </div>
                    ) : null}
                  </CardContent>
                </Card>
              </div>
            </TabsContent>

            {/* ── MINUTES ── */}
            <TabsContent value="minutes" className="space-y-4">
              <RangeBar range={range} setRange={setRange} rangeBtns={rangeBtns} t={t} />
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                <KpiCard icon={Timer} label={t('voipHealth.minutes.total')} value={`${minutes.data?.total_minutes ?? '—'}`} tone="bg-violet-100 text-violet-700" />
                <KpiCard icon={PhoneCall} label={t('voipHealth.minutes.talk')} value={`${minutes.data?.talk_minutes ?? '—'}`} tone="bg-emerald-100 text-emerald-700" />
                <KpiCard
                  icon={Gauge} label={t('voipHealth.minutes.usedOfBundle')}
                  value={cycle ? `${cycle.used_minutes.toLocaleString()} / ${cycle.included_minutes.toLocaleString()}` : '—'}
                  sub={cycle ? t('voipHealth.minutes.pctUsed', { pct: cycle.pct_used }) : undefined}
                  tone={cycle?.status === 'critical' ? 'bg-destructive/10 text-destructive'
                    : cycle?.status === 'warn' ? 'bg-amber-100 text-amber-700' : 'bg-emerald-100 text-emerald-700'}
                />
                <KpiCard icon={Activity} label={t('voipHealth.minutes.lineCap')} value={`${maxLines}`} sub={t('voipHealth.minutes.a1Cap')} tone="bg-sky-100 text-sky-700" />
              </div>

              {/* Bundle consumption for the CURRENT billing cycle. Independent of
                  the range selector above, which only drives the charts. */}
              {cycle && (
                <Card>
                  <CardHeader className="pb-3">
                    <CardTitle className="text-base">{t('voipHealth.minutes.bundleTitle')}</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <div className="flex items-baseline gap-2">
                        <span className="text-3xl font-bold tabular-nums">{cycle.used_minutes.toLocaleString()}</span>
                        <span className="text-muted-foreground">
                          / {cycle.included_minutes.toLocaleString()} {t('voipHealth.minutes.minShort')}
                        </span>
                      </div>
                      <span className="text-sm text-muted-foreground">
                        {t('voipHealth.minutes.cycleRange', {
                          start: formatDayDmy(cycle.start),
                          end: formatDayDmy(cycle.end),
                        })}
                        {' · '}
                        {t('voipHealth.minutes.daysRemaining', { days: cycle.days_remaining })}
                      </span>
                    </div>
                    <Progress value={Math.min(100, cycle.pct_used)} />
                    <div className="grid gap-3 sm:grid-cols-3">
                      <div>
                        <p className="text-xs text-muted-foreground">{t('voipHealth.minutes.projected')}</p>
                        <p className={`text-lg font-semibold tabular-nums ${cycle.projected_pct >= 100 ? 'text-destructive' : ''}`}>
                          {cycle.projected_minutes.toLocaleString()} ({cycle.projected_pct}%)
                        </p>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">{t('voipHealth.minutes.metricLabel')}</p>
                        <p className="text-lg font-semibold">
                          {cycle.metric === 'talk' ? t('voipHealth.minutes.metricTalk') : t('voipHealth.minutes.metricTotal')}
                        </p>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">{t('voipHealth.minutes.totalWithRing')}</p>
                        <p className="text-lg font-semibold tabular-nums">{cycle.used_total_minutes.toLocaleString()}</p>
                      </div>
                    </div>
                    {cycle.projected_over_by > 0 && (
                      <p className="flex items-center gap-2 text-sm text-destructive">
                        <AlertTriangle className="h-4 w-4 shrink-0" />
                        {t('voipHealth.minutes.projectedOver', { minutes: cycle.projected_over_by.toLocaleString() })}
                      </p>
                    )}
                    <p className="text-xs text-muted-foreground">{t('voipHealth.minutes.notBilling')}</p>
                  </CardContent>
                </Card>
              )}

              <div className="grid gap-4 lg:grid-cols-2">
                <Card>
                  <CardHeader className="pb-3"><CardTitle className="text-base">{t('voipHealth.minutes.byDay')}</CardTitle></CardHeader>
                  <CardContent>
                    {minutes.data?.series?.length ? (
                      <ResponsiveContainer width="100%" height={220}>
                        <BarChart data={minutes.data.series}>
                          <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                          <XAxis dataKey="key" fontSize={11} />
                          <YAxis fontSize={11} />
                          <Tooltip />
                          <Bar dataKey="minutes" fill={CHART_COLORS.primary} radius={[4, 4, 0, 0]} />
                        </BarChart>
                      </ResponsiveContainer>
                    ) : <p className="text-sm text-muted-foreground">{t('voipHealth.noTrend')}</p>}
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader className="pb-3"><CardTitle className="text-base">{t('voipHealth.minutes.byAgent')}</CardTitle></CardHeader>
                  <CardContent>
                    {minutesByAgent.data?.series?.length ? (
                      <div className="space-y-2">
                        {minutesByAgent.data.series.slice(0, 12).map((s) => (
                          <div key={s.key} className="flex items-center justify-between text-sm">
                            <span className="truncate">{s.key}</span>
                            <span className="font-medium tabular-nums">{s.minutes} {t('voipHealth.minutes.minShort')}</span>
                          </div>
                        ))}
                      </div>
                    ) : <p className="text-sm text-muted-foreground">{t('voipHealth.noTrend')}</p>}
                  </CardContent>
                </Card>
              </div>

              {/* What to ask A1 */}
              <Card>
                <CardHeader className="pb-3"><CardTitle className="text-base">{t('voipHealth.minutes.askA1Title')}</CardTitle></CardHeader>
                <CardContent>
                  <p className="mb-2 text-sm text-muted-foreground">{t('voipHealth.minutes.askA1Body')}</p>
                  <ul className="list-disc space-y-1 pl-5 text-sm">
                    <li>{t('voipHealth.minutes.askA1Portal')}</li>
                    <li>{t('voipHealth.minutes.askA1Cdr')}</li>
                    <li>{t('voipHealth.minutes.askA1Api')}</li>
                    <li>{t('voipHealth.minutes.askA1Bundle')}</li>
                  </ul>
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        )}
      </div>
    </AppLayout>
  );
}

function RangeBar({ range, setRange, rangeBtns, t }: { range: Range; setRange: (r: Range) => void; rangeBtns: Range[]; t: (k: string) => string }) {
  return (
    <div className="flex gap-1.5">
      {rangeBtns.map((r) => (
        <Button key={r} variant={range === r ? 'default' : 'outline'} size="sm" onClick={() => setRange(r)}>
          {t(`voipHealth.range.${r}`)}
        </Button>
      ))}
    </div>
  );
}
