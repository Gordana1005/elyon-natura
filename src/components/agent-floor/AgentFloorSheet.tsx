import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { ArrowUpRight } from 'lucide-react';
import type { AgentFloorRow } from '@/lib/api';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { formatDenari } from '@/lib/currency';
import { fmtDuration } from '@/lib/design-utils';
import { skopjeHm } from '@/lib/presence/state';
import { cn } from '@/lib/utils';
import { StatusPill, TeamBadge } from './AgentFloorCard';

function Row({ children, className }: { children: React.ReactNode; className?: string }) {
  return <li className={cn('flex items-center justify-between gap-3 py-2 text-[13px]', className)}>{children}</li>;
}

function Empty({ text }: { text: string }) {
  return <p className="py-8 text-center text-xs text-muted-foreground">{text}</p>;
}

function SummaryCell({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="min-w-0 rounded-lg border bg-card p-2.5">
      <p className="truncate text-[11px] text-muted-foreground">{label}</p>
      <p className="truncate text-sm font-semibold tabular-nums">{value}</p>
      {sub && <p className="truncate text-[11px] tabular-nums text-muted-foreground">{sub}</p>}
    </div>
  );
}

/** One agent's day in a side sheet: summary, calls, breaks, sales by department (+ a link to the orders). */
export function AgentFloorSheet({ agent, date, onClose }: { agent: AgentFloorRow | null; date: string; onClose: () => void }) {
  const { t } = useTranslation();
  const a = agent;
  const hasMoney = typeof a?.sales.value_mkd === 'number';
  const deptEntries = a ? Object.entries(a.sales.departments).filter(([, v]) => v.sales > 0 || (v.value_mkd ?? 0) > 0) : [];

  return (
    <Sheet open={!!a} onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-lg">
        {a && (
          <>
            <SheetHeader className="space-y-1.5 text-left">
              <SheetTitle className="flex flex-wrap items-center gap-2">
                {a.full_name}
                {a.live && <StatusPill live={a.live} />}
              </SheetTitle>
              <SheetDescription className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                <TeamBadge team={a.team} />
                <span>
                  {a.shift_windows.length > 0
                    ? a.shift_windows.map((w) => t('agentFloor.shift', { from: w.start, to: w.end })).join(', ')
                    : t('agentFloor.noShift')}
                </span>
                <span>{a.first_seen ? t('agentFloor.login', { time: skopjeHm(a.first_seen) }) : t('agentFloor.notLoggedIn')}</span>
                {a.login?.last_logout && <span>{t('agentFloor.sheet.logout', { time: skopjeHm(a.login.last_logout) })}</span>}
                {a.login && <span>{t('agentFloor.sheet.logins')}: {a.login.logins}</span>}
              </SheetDescription>
            </SheetHeader>

            {/* Day summary */}
            <h4 className="mt-5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('agentFloor.sheet.summary')}</h4>
            <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
              <SummaryCell
                label={t('agentFloor.online')}
                value={fmtDuration((a.presence?.online_minutes ?? 0) * 60)}
                sub={a.presence
                  ? `${t('agentFloor.presActive')} ${fmtDuration(a.presence.active_minutes * 60)}`
                  : t('agentFloor.noPresence')}
              />
              <SummaryCell
                label={t('agentFloor.presIdle')}
                value={fmtDuration((a.presence?.idle_minutes ?? 0) * 60)}
                sub={`${t('agentFloor.presBreak')} ${fmtDuration((a.presence?.break_minutes ?? 0) * 60)}`}
              />
              <SummaryCell
                label={t('agentFloor.calls')}
                value={String(a.totals.calls)}
                sub={a.totals.calls ? t('agentFloor.answeredRate', { rate: Math.round(a.totals.answer_rate * 100) }) : undefined}
              />
              <SummaryCell
                label={t('agentFloor.talk')}
                value={fmtDuration(a.totals.talk_seconds)}
                sub={a.totals.answered ? t('agentFloor.avgTalk', { avg: fmtDuration(a.totals.talk_seconds / a.totals.answered) }) : undefined}
              />
              <SummaryCell
                label={t('agentFloor.sales')}
                value={String(a.sales.sales)}
                sub={t('agentFloor.workedCount', { count: a.sales.worked })}
              />
              <SummaryCell
                label={t('agentFloor.value')}
                value={hasMoney ? formatDenari(a.sales.value_mkd) : '—'}
                sub={hasMoney && a.sales.scoped ? t('agentFloor.scopedHint') : t('agentFloor.returnedCount', { count: a.sales.returned })}
              />
            </div>
            <p className="mt-2 text-[11px] text-muted-foreground">{t('agentFloor.salesHint')}</p>

            <Tabs defaultValue="calls" className="mt-5">
              <TabsList className="grid w-full grid-cols-3">
                <TabsTrigger value="calls">{t('agentFloor.calls')} ({a.calls.length})</TabsTrigger>
                <TabsTrigger value="breaks">{t('agentFloor.sheet.breaks')} ({a.breaks.length})</TabsTrigger>
                <TabsTrigger value="sales">{t('agentFloor.sales')} ({a.sales.sales})</TabsTrigger>
              </TabsList>

              <TabsContent value="calls">
                {a.calls.length === 0 ? <Empty text={t('agentFloor.sheet.noCalls')} /> : (
                  <ul className="divide-y">
                    {[...a.calls].reverse().map((c) => {
                      const answered = c.connection_state === 'answered' || (c.connection_state == null && (c.talk_seconds ?? 0) > 0);
                      return (
                        <Row key={c.id}>
                          <span className="min-w-0">
                            <span className="block truncate font-medium tabular-nums">{c.customer_phone || '—'}</span>
                            <span className="block truncate text-[11px] text-muted-foreground">
                              {skopjeHm(c.started_at)} · {c.outcome ? t('outcome.' + c.outcome, { defaultValue: c.outcome }) : '—'}
                            </span>
                          </span>
                          <span className={cn('shrink-0 text-right text-xs tabular-nums', answered ? 'text-emerald-700 dark:text-emerald-300' : 'text-rose-600 dark:text-rose-300')}>
                            {answered
                              ? t('agentFloor.sheet.ringTalk', { ring: `${c.ring_seconds ?? 0}s`, talk: fmtDuration(c.talk_seconds ?? 0) })
                              : t('agentFloor.sheet.rangNoAnswer', { ring: `${c.ring_seconds ?? 0}s` })}
                          </span>
                        </Row>
                      );
                    })}
                  </ul>
                )}
              </TabsContent>

              <TabsContent value="breaks">
                {a.breaks.length === 0 ? <Empty text={t('agentFloor.sheet.noBreaks')} /> : (
                  <ul className="divide-y">
                    {a.breaks.map((b, i) => {
                      const end = b.end ? new Date(b.end).getTime() : Date.now();
                      const sec = Math.max(0, (end - new Date(b.start).getTime()) / 1000);
                      return (
                        <Row key={i}>
                          <span className="tabular-nums">
                            {skopjeHm(b.start)} – {b.end ? skopjeHm(b.end) : t('agentFloor.sheet.ongoing')}
                          </span>
                          <span className="font-semibold tabular-nums">{fmtDuration(sec)}</span>
                        </Row>
                      );
                    })}
                  </ul>
                )}
              </TabsContent>

              <TabsContent value="sales" className="space-y-4">
                {deptEntries.length === 0 ? <Empty text={t('agentFloor.sheet.noSales')} /> : (
                  <ul className="divide-y">
                    {deptEntries.map(([key, v]) => (
                      <Row key={key}>
                        <span className="min-w-0 truncate font-medium">{t(`agentFloor.dept.${key}`, { defaultValue: key })}</span>
                        <span className="shrink-0 text-right">
                          <span className="block font-semibold tabular-nums">{v.sales}</span>
                          {typeof v.value_mkd === 'number' && <span className="block text-[10px] tabular-nums text-muted-foreground">{formatDenari(v.value_mkd)}</span>}
                        </span>
                      </Row>
                    ))}
                  </ul>
                )}
                <Link
                  to={`/orders?seller=${encodeURIComponent(a.user_id)}&range=custom&from=${date}&to=${date}`}
                  className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                >
                  {t('agentFloor.sheet.openOrders')} <ArrowUpRight className="h-3 w-3" aria-hidden />
                </Link>
              </TabsContent>
            </Tabs>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
