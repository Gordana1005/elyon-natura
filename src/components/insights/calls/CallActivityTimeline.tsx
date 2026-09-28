import { useCallback, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Loader2, Maximize2, ZoomIn, ZoomOut } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { apiErrorText } from '@/i18n/apiErrors';
import { apiGetInsightsWorkDay, type WorkDayPerson } from '@/lib/insightsApi/work';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { ClockCaption } from '../shared/ClockCaption';
import { LoadError } from '../shared/LoadError';
import { addDays, formatDmy, skopjeToday } from '../shared/period';
import type { InsightsFormat } from '../shared/useInsightsFormat';
import { OUTCOME_TONE } from './workPalette';
import { DAY_PARAM, minToHm, minutesInto, pickDay, type WorkOutcomeKey } from './workModel';

/** Horizontal zoom in pixels per hour; null = fit the card. */
const ZOOM = [60, 90, 150, 240, 380] as const;
const LABEL_PX = 184;

const DECISION_TONE: Record<string, string> = {
  sale: OUTCOME_TONE.sale, callback: OUTCOME_TONE.callback, cancel: OUTCOME_TONE.cancel, trash: OUTCOME_TONE.trash,
};
const BREAK_BG = 'repeating-linear-gradient(45deg, rgb(14 165 233 / 0.75) 0 4px, rgb(14 165 233 / 0.4) 4px 8px)';

interface Mark { min: number; end?: number; text: string }

/**
 * The swimlane — one Skopje day of the period, one row per person who left a
 * trace that day (a decision, a call log, presence, a break or a login; never
 * "everyone on the rota"). Upper lane: decisions as ticks coloured by outcome.
 * Lower lane: no-answer clicks (ticks) and timed calls (segments) — both
 * agent-reported while VOIP is off. Behind them: the CRM-open span (from
 * 28.09.2026) and breaks. Hover or focus a row for a readout.
 */
export default function CallActivityTimeline({ from, to, team, f }: { from: string; to: string; team: string; f: InsightsFormat }) {
  const { t } = f;
  const { user } = useAuth();
  const [sp, setSp] = useSearchParams();
  const day = pickDay(sp.get(DAY_PARAM), from, to);
  const setDay = useCallback((d: string) => setSp((prev) => {
    const n = new URLSearchParams(prev);
    n.set(DAY_PARAM, d);
    return n;
  }, { replace: true }), [setSp]);
  const today = skopjeToday();
  const isToday = day === today;
  const [zoom, setZoom] = useState<number | null>(null);

  const q = useQuery({
    queryKey: ['insights-work-day', user?.id, day],
    queryFn: ({ signal }) => apiGetInsightsWorkDay(day, signal),
    staleTime: 60_000,
    refetchInterval: isToday ? 60_000 : false,
    placeholderData: keepPreviousData,
    retry: 0,
  });
  const data = q.data;
  const people = useMemo(
    () => (data?.people ?? []).filter((p) => !team || p.team_key === team),
    [data, team],
  );
  const nowMin = isToday ? minutesInto(day, new Date().toISOString()) : null;

  // Axis: 08:00–20:00, stretched to cover every mark of the day.
  const [lo, hi] = useMemo(() => {
    let a = 8 * 60, b = 20 * 60;
    const see = (iso: string | null | undefined) => {
      if (!iso) return;
      const m = minutesInto(day, iso);
      if (m == null) return;
      a = Math.min(a, m); b = Math.max(b, m);
    };
    for (const p of people) {
      p.decisions.forEach((x) => see(x.at));
      p.calls.forEach((x) => { see(x.at); see(x.e); });
      p.breaks.forEach((x) => { see(x.s); see(x.e); });
      p.logins.forEach(see);
      see(p.presence?.first_seen); see(p.presence?.last_seen);
    }
    if (nowMin != null) b = Math.max(b, nowMin);
    return [Math.max(0, Math.floor(a / 60) * 60), Math.min(1440, Math.ceil(b / 60) * 60)];
  }, [people, day, nowMin]);
  const span = Math.max(60, hi - lo);
  const hours: number[] = [];
  for (let h = lo / 60; h <= hi / 60; h++) hours.push(h);
  const pct = (m: number) => ((Math.max(lo, Math.min(hi, m)) - lo) / span) * 100;
  const trackPx = zoom == null ? null : Math.round((span / 60) * zoom);

  const canPrev = day > from;
  const canNext = day < to;
  const zoomIdx = zoom == null ? -1 : ZOOM.indexOf(zoom as (typeof ZOOM)[number]);

  return (
    <section id="wk-day" aria-labelledby="wk-day-title" className="scroll-mt-20 space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h3 id="wk-day-title" className="text-base font-semibold">{t('insights.calls.day.title')}</h3>
          <p className="text-xs text-muted-foreground">{t('insights.calls.day.subtitle')}</p>
          <ClockCaption clock={['decided', 'call']} />
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Button variant="outline" size="icon" className="h-8 w-8" disabled={!canPrev} onClick={() => setDay(addDays(day, -1))} aria-label={t('insights.calls.day.prev')}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="min-w-[96px] text-center text-sm font-medium tabular-nums">{formatDmy(day)}</span>
          <Button variant="outline" size="icon" className="h-8 w-8" disabled={!canNext} onClick={() => setDay(addDays(day, 1))} aria-label={t('insights.calls.day.next')}>
            <ChevronRight className="h-4 w-4" />
          </Button>
          {isToday && <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300">{t('insights.calls.day.live')}</span>}
          {q.isFetching && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-label={t('insights.common.period.loading')} />}
        </div>
      </div>

      <div className="rounded-xl border bg-card p-3 shadow-sm sm:p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <Legend f={f} />
          <div className="flex items-center gap-1">
            <Button variant={zoom == null ? 'secondary' : 'outline'} size="sm" className="h-8 gap-1.5 px-2.5 text-xs" onClick={() => setZoom(null)}>
              <Maximize2 className="h-3.5 w-3.5" aria-hidden />{t('insights.calls.day.fit')}
            </Button>
            <Button variant="outline" size="icon" className="h-8 w-8" aria-label={t('insights.calls.day.zoomOut')}
              disabled={zoom == null || zoomIdx <= 0} onClick={() => setZoom(ZOOM[Math.max(0, zoomIdx - 1)])}>
              <ZoomOut className="h-4 w-4" />
            </Button>
            <Button variant="outline" size="icon" className="h-8 w-8" aria-label={t('insights.calls.day.zoomIn')}
              disabled={zoomIdx === ZOOM.length - 1} onClick={() => setZoom(ZOOM[Math.min(ZOOM.length - 1, zoomIdx + 1)])}>
              <ZoomIn className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {!data ? (
          q.isError ? <LoadError text={apiErrorText(q.error)} onRetry={() => { void q.refetch(); }} /> : (
            <div className="space-y-2" aria-hidden>{Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-10" />)}</div>
          )
        ) : people.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">{t('insights.calls.day.empty')}</p>
        ) : (
          <div className={cn('overflow-x-auto rounded-lg border border-border/60 transition-opacity', q.isPlaceholderData && 'opacity-60')}>
            <div className={zoom == null ? 'min-w-[680px]' : ''} style={trackPx == null ? undefined : { width: LABEL_PX + trackPx }}>
              <div className="flex items-end border-b border-border/60 bg-muted/30 py-1.5">
                <div className="shrink-0" style={{ width: LABEL_PX }} />
                <div className="relative h-4 flex-1">
                  {hours.map((h) => (
                    <span key={h} className="absolute -translate-x-1/2 text-[10px] font-medium tabular-nums text-muted-foreground" style={{ left: `${pct(h * 60)}%` }}>
                      {String(h % 24).padStart(2, '0')}
                    </span>
                  ))}
                </div>
              </div>
              <ul className="divide-y divide-border/40">
                {people.map((p) => (
                  <Row key={p.person_id} p={p} day={day} hours={hours} pct={pct} lo={lo} span={span} nowMin={nowMin} f={f} />
                ))}
              </ul>
            </div>
          </div>
        )}
        {data && data.unattributed.decisions + data.unattributed.calls > 0 && (
          <p className="mt-2 text-[11px] text-muted-foreground">
            {t('insights.calls.day.unattributed', { decisions: f.int(data.unattributed.decisions), calls: f.int(data.unattributed.calls) })}
          </p>
        )}
      </div>
    </section>
  );
}

function Legend({ f }: { f: InsightsFormat }) {
  const { t } = f;
  const ticks: WorkOutcomeKey[] = ['sale', 'callback', 'cancel', 'trash'];
  return (
    <ul className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
      {ticks.map((k) => (
        <li key={k} className="inline-flex items-center gap-1"><span className={cn('h-3 w-[3px] rounded-sm', OUTCOME_TONE[k])} aria-hidden />{t(`insights.calls.outcome.${k}`)}</li>
      ))}
      <li className="inline-flex items-center gap-1"><span className={cn('h-2 w-[3px] rounded-sm', OUTCOME_TONE.no_answer)} aria-hidden />{t('insights.calls.outcome.no_answer')}</li>
      <li className="inline-flex items-center gap-1"><span className="h-2 w-3 rounded-sm bg-slate-600 dark:bg-slate-300" aria-hidden />{t('insights.calls.day.timedCall')}</li>
      <li className="inline-flex items-center gap-1"><span className="h-3 w-4 rounded-sm bg-muted-foreground/20" aria-hidden />{t('insights.calls.day.presence')}</li>
      <li className="inline-flex items-center gap-1"><span className="h-3 w-4 rounded-sm" style={{ background: BREAK_BG }} aria-hidden />{t('insights.calls.day.break')}</li>
      <li className="inline-flex items-center gap-1"><span className="h-2 w-2 rotate-45 bg-foreground/70" aria-hidden />{t('insights.calls.day.login')}</li>
    </ul>
  );
}

function Row({ p, day, hours, pct, lo, span, nowMin, f }: {
  p: WorkDayPerson; day: string; hours: number[]; pct: (m: number) => number; lo: number; span: number; nowMin: number | null; f: InsightsFormat;
}) {
  const { t } = f;
  const track = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<{ x: number; text: string } | null>(null);
  const at = (iso: string | null | undefined) => (iso ? minutesInto(day, iso) : null);

  // Everything the readout can name, by minute.
  const marks = useMemo(() => {
    const out: Mark[] = [];
    for (const d of p.decisions) {
      const m = at(d.at);
      if (m != null) out.push({ min: m, text: `${minToHm(m)} · ${t(`insights.calls.outcome.${d.o}`, { defaultValue: d.o })} (${d.via === 'altercpa' ? 'AlterCPA' : 'CRM'})` });
    }
    for (const c of p.calls) {
      const m = at(c.at);
      if (m == null) continue;
      if (c.timed) {
        const e = at(c.e) ?? m + c.sec / 60;
        out.push({ min: m, end: e, text: `${minToHm(m)}–${minToHm(e)} · ${t('insights.calls.day.timedCallTip', { time: f.minutes(c.sec / 60) })}` });
      } else {
        out.push({ min: m, text: `${minToHm(m)} · ${t(c.o === 'no_answer' ? 'insights.calls.outcome.no_answer' : 'insights.calls.day.callLog')}` });
      }
    }
    for (const b of p.breaks) {
      const s = at(b.s);
      if (s == null) continue;
      const e = at(b.e) ?? nowMin ?? s;
      out.push({ min: s, end: e, text: `${minToHm(s)}–${b.e ? minToHm(e) : '…'} · ${t('insights.calls.day.break')}` });
    }
    for (const l of p.logins) {
      const m = at(l);
      if (m != null) out.push({ min: m, text: `${minToHm(m)} · ${t('insights.calls.day.login')}` });
    }
    return out.sort((a, b) => a.min - b.min);
  }, [p, day, nowMin, t, f]); // eslint-disable-line react-hooks/exhaustive-deps

  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const box = track.current?.getBoundingClientRect();
    if (!box || !marks.length) return;
    const x = e.clientX - box.left;
    const perPx = span / box.width;
    const min = lo + x * perPx;
    const tol = 6 * perPx;
    let best: Mark | null = null;
    let bestD = Infinity;
    for (const m of marks) {
      const d = m.end != null && min >= m.min && min <= m.end ? 0 : Math.abs(m.min - min);
      if (d < bestD) { bestD = d; best = m; }
    }
    if (best && bestD <= tol) setTip({ x, text: best.text });
    else if (p.presence?.first_seen && p.presence.last_seen) {
      const a = at(p.presence.first_seen), b = at(p.presence.last_seen);
      if (a != null && b != null && min >= a && min <= b) setTip({ x, text: t('insights.calls.day.presenceTip', { from: minToHm(a), to: minToHm(b), online: f.minutes(p.presence.online_min), active: f.minutes(p.presence.active_min) }) });
      else setTip(null);
    } else setTip(null);
  };

  const tot = p.totals;
  const summary = t('insights.calls.day.rowSummary', {
    worked: f.int(tot.worked), sale: f.int(tot.sale), na: f.int(tot.no_answer),
  });
  const first = at(tot.first_at), last = at(tot.last_at);
  const pres = p.presence;
  const pa = at(pres?.first_seen), pb = at(pres?.last_seen);
  const aria = [p.name, summary, first != null && last != null ? `${minToHm(first)}–${minToHm(last)}` : '',
    pres ? t('insights.calls.day.presenceTip', { from: minToHm(pa), to: minToHm(pb), online: f.minutes(pres.online_min), active: f.minutes(pres.active_min) }) : '']
    .filter(Boolean).join(' · ');

  return (
    <li className="flex items-center py-1.5" aria-label={aria}>
      <div className="shrink-0 pl-3 pr-3" style={{ width: LABEL_PX }}>
        <div className="truncate text-sm font-semibold" title={p.name}>{p.name}</div>
        <div className="truncate text-[11px] tabular-nums text-muted-foreground">
          {first != null && last != null && `${minToHm(first)}–${minToHm(last)} · `}
          {summary}
        </div>
      </div>
      <div
        ref={track}
        tabIndex={0}
        onPointerMove={onMove}
        onPointerLeave={() => setTip(null)}
        onFocus={() => setTip({ x: 8, text: aria })}
        onBlur={() => setTip(null)}
        className="relative h-11 flex-1 rounded-md bg-muted/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {/* CRM open (presence, from 28.09.2026) */}
        {pa != null && pb != null && pb > pa && (
          <div className="absolute inset-y-0 rounded-sm bg-muted-foreground/15" style={{ left: `${pct(pa)}%`, width: `${pct(pb) - pct(pa)}%` }} />
        )}
        {hours.map((h) => <div key={h} className="absolute inset-y-0 w-px bg-border/50" style={{ left: `${pct(h * 60)}%` }} />)}
        {/* breaks */}
        {p.breaks.map((b, i) => {
          const s = at(b.s);
          if (s == null) return null;
          const e = at(b.e) ?? nowMin ?? s;
          return <div key={`b${i}`} className="absolute inset-y-1 rounded-[3px]" style={{ left: `${pct(s)}%`, width: `max(4px, ${pct(e) - pct(s)}%)`, background: BREAK_BG }} />;
        })}
        {/* logins */}
        {p.logins.map((l, i) => {
          const m = at(l);
          return m == null ? null : <span key={`l${i}`} className="absolute top-0 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rotate-45 bg-foreground/70" style={{ left: `${pct(m)}%` }} />;
        })}
        {/* upper lane: decisions */}
        {p.decisions.map((d, i) => {
          const m = at(d.at);
          return m == null ? null : (
            <span key={`d${i}`} className={cn('absolute top-1.5 h-[45%] w-[2px] -translate-x-1/2 rounded-sm', DECISION_TONE[d.o] ?? 'bg-foreground')} style={{ left: `${pct(m)}%` }} />
          );
        })}
        {/* lower lane: call logs (agent-reported) */}
        {p.calls.map((c, i) => {
          const m = at(c.at);
          if (m == null) return null;
          if (c.timed) {
            const e = at(c.e) ?? m + c.sec / 60;
            return <span key={`c${i}`} className="absolute bottom-1.5 h-2 rounded-sm bg-slate-600 dark:bg-slate-300" style={{ left: `${pct(m)}%`, width: `max(3px, ${pct(e) - pct(m)}%)` }} />;
          }
          return <span key={`c${i}`} className={cn('absolute bottom-1.5 h-[30%] w-[2px] -translate-x-1/2 rounded-sm', c.o === 'no_answer' ? OUTCOME_TONE.no_answer : 'bg-slate-500')} style={{ left: `${pct(m)}%` }} />;
        })}
        {nowMin != null && <div className="absolute inset-y-0 w-0.5 bg-primary/80" style={{ left: `${pct(nowMin)}%` }} />}
        {tip && (
          <div role="presentation" className="pointer-events-none absolute bottom-full z-20 mb-1 max-w-[80vw] -translate-x-1/2 whitespace-nowrap rounded-md border bg-popover px-2 py-1 text-xs tabular-nums text-popover-foreground shadow-md"
            style={{ left: Math.max(60, tip.x) }}>
            {tip.text}
          </div>
        )}
      </div>
    </li>
  );
}
