import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/EmptyState';
import { Clock, ZoomIn, ZoomOut, Maximize2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { CHART_COLORS } from '@/lib/design-utils';
import type { AgentActivityResponse, AgentActivityRow, AgentActivityCall } from '@/lib/api';

const TZ = 'Europe/Skopje';

// Horizontal zoom expressed as pixels-per-hour. Higher = more spread out, so
// short (few-second) calls and tight clusters become readable. The view scrolls
// horizontally when wider than the container.
const ZOOM_LEVELS = [90, 150, 240, 380, 600, 960];
const DEFAULT_ZOOM_IDX = 2; // 240 px/hour ≈ 3× the fit-to-width density
const LABEL_PX = 184;       // left rail (name + totals) width

// ── Band colours ──
// Idle and break are the two full-height bands, so they must never read alike.
// `--muted` is 95% lightness in light mode (i.e. white on a white card), so idle
// uses muted-FOREGROUND at low alpha instead — a real gray in both themes.
const IDLE_FILL = 'hsl(var(--muted-foreground) / 0.22)';
// Break is purple, striped purple-on-purple (no transparent gaps) so the band
// stays unmistakably purple whatever sits underneath it.
const BREAK_PURPLE = '271 81% 56%';
const breakStripes = (strong: number, soft: number, px: number) =>
  `repeating-linear-gradient(45deg, hsl(${BREAK_PURPLE} / ${strong}) 0 ${px}px, hsl(${BREAK_PURPLE} / ${soft}) ${px}px ${px * 2}px)`;
const BREAK_TRACK = breakStripes(0.85, 0.45, 5);
const BREAK_SWATCH = breakStripes(0.95, 0.5, 3);

/** Minutes to ADD to UTC to get Skopje local time at `at` (+60 / +120, DST-aware). */
function skopjeOffsetMinutes(at: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(at);
  const m: Record<string, string> = {};
  for (const p of parts) m[p.type] = p.value;
  const hh = m.hour === '24' ? '00' : m.hour;
  const asUTC = Date.UTC(+m.year, +m.month - 1, +m.day, +hh, +m.minute, +m.second);
  return Math.round((asUTC - at.getTime()) / 60000);
}

function fmtDur(totalSec: number): string {
  const s = Math.max(0, Math.round(totalSec));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${sec}s`;
  return `${sec}s`;
}

function minutesToHHMMSS(min: number): string {
  const totalSec = Math.round(min * 60);
  const m = ((Math.floor(totalSec / 60) % 1440) + 1440) % 1440;
  const ss = ((totalSec % 60) + 60) % 60;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

interface AgentTimelineProps {
  data: AgentActivityResponse;
  isToday: boolean;
}

export function AgentTimeline({ data, isToday }: AgentTimelineProps) {
  const { t } = useTranslation();
  const { agents, date } = data;
  const [zoomIdx, setZoomIdx] = useState(DEFAULT_ZOOM_IDX);
  const [fit, setFit] = useState(false);

  // Skopje-midnight epoch for the selected day — lets us map any instant to
  // minutes-of-day (handles a call that spills past midnight, and "now").
  const [yy, mm, dd] = date.split('-').map(Number);
  const off = skopjeOffsetMinutes(new Date(Date.UTC(yy, mm - 1, dd, 12, 0, 0)));
  const midnightMs = Date.UTC(yy, mm - 1, dd, 0, 0, 0) - off * 60000;
  const minutesOfDay = (iso: string) => (new Date(iso).getTime() - midnightMs) / 60000;
  const hhmmToMin = (s: string) => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
  const nowMin = isToday ? minutesOfDay(new Date().toISOString()) : null;

  // ── Axis window: default 08:00–21:00, expanded to cover all activity ──
  let lo = 8 * 60, hi = 21 * 60;
  const consider = (a: number, b: number) => { if (isFinite(a)) lo = Math.min(lo, a); if (isFinite(b)) hi = Math.max(hi, b); };
  for (const ag of agents) {
    for (const w of ag.shift_windows) consider(hhmmToMin(w.start), hhmmToMin(w.end));
    for (const b of ag.breaks) consider(minutesOfDay(b.start), b.end ? minutesOfDay(b.end) : (nowMin ?? minutesOfDay(b.start)));
    for (const c of ag.calls) {
      if (!c.started_at) continue;
      const s = minutesOfDay(c.started_at);
      const e = c.ended_at ? minutesOfDay(c.ended_at) : (nowMin ?? s);
      consider(s, e);
    }
  }
  if (nowMin != null) hi = Math.max(hi, nowMin);
  lo = Math.max(0, Math.floor(lo / 60) * 60);
  hi = Math.min(1440, Math.ceil(hi / 60) * 60);
  if (hi <= lo) hi = lo + 60;
  const span = hi - lo;

  const clamp = (min: number) => Math.max(lo, Math.min(hi, min));
  const leftPct = (min: number) => ((clamp(min) - lo) / span) * 100;
  const widthPct = (a: number, b: number) => Math.max(0, ((clamp(b) - clamp(a)) / span) * 100);

  const hours: number[] = [];
  for (let h = Math.ceil(lo / 60); h <= Math.floor(hi / 60); h++) hours.push(h);
  // Minor (30-min) ticks — only render when there's room so they don't crowd.
  const pxPerHour = ZOOM_LEVELS[zoomIdx];
  const showHalfHours = fit ? false : pxPerHour >= 150;
  const halfHours: number[] = [];
  if (showHalfHours) for (let h = Math.ceil(lo / 60); h < Math.floor(hi / 60); h++) halfHours.push(h * 60 + 30);

  if (agents.length === 0) {
    return (
      <EmptyState
        icon={<Clock className="h-6 w-6" />}
        title={t('activity.noActivity')}
        description={t('activity.noActivityDesc')}
      />
    );
  }

  const green = CHART_COLORS.success;
  const amber = CHART_COLORS.warning;
  const red = CHART_COLORS.destructive;

  // Inner width: explicit (zoom) so it scrolls, or fit-to-container.
  const trackPx = fit ? null : Math.round((span / 60) * pxPerHour);
  const innerStyle = fit ? undefined : { width: LABEL_PX + (trackPx ?? 0) };
  const innerClass = fit ? 'min-w-[680px]' : '';

  const canZoomOut = !fit && zoomIdx > 0;
  const canZoomIn = !fit && zoomIdx < ZOOM_LEVELS.length - 1;

  return (
    <div className="space-y-3">
      {/* Legend + zoom controls */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
          <LegendSwatch color={green} label={t('activity.onCall')} />
          <LegendSwatch color={amber} label={t('activity.connecting')} />
          <LegendSwatch color={red} label={t('activity.noAnswer')} />
          <span className="inline-flex items-center gap-1.5">
            <span className="h-3 w-3 rounded-sm border border-border/60" style={{ background: IDLE_FILL }} />
            {t('activity.idleOnShift')}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-3 w-3 rounded-sm" style={{ background: BREAK_SWATCH }} />
            {t('activity.onBreak')}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant={fit ? 'secondary' : 'outline'} size="sm" className="h-8 gap-1.5 px-2.5 text-xs"
            onClick={() => setFit((f) => !f)}
            title={t('activity.fitTitle')}
          >
            <Maximize2 className="h-3.5 w-3.5" /> {t('activity.fit')}
          </Button>
          <Button
            variant="outline" size="icon" className="h-8 w-8"
            onClick={() => { setFit(false); setZoomIdx((i) => Math.max(0, i - 1)); }}
            disabled={!fit && !canZoomOut} aria-label={t('activity.zoomOut')}
          >
            <ZoomOut className="h-4 w-4" />
          </Button>
          <Button
            variant="outline" size="icon" className="h-8 w-8"
            onClick={() => { setFit(false); setZoomIdx((i) => Math.min(ZOOM_LEVELS.length - 1, i + (fit ? 0 : 1))); }}
            disabled={!fit && !canZoomIn} aria-label={t('activity.zoomIn')}
          >
            <ZoomIn className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="overflow-x-auto rounded-lg border border-border/50">
        <div className={innerClass} style={innerStyle}>
          {/* Hour axis header */}
          <div className="flex items-end border-b border-border/50 bg-muted/20 py-1.5">
            <div className="shrink-0" style={{ width: LABEL_PX }} />
            <div className="relative h-5 flex-1">
              {hours.map((h) => (
                <div key={h} className="absolute -translate-x-1/2 text-[11px] font-medium tabular-nums text-muted-foreground" style={{ left: `${leftPct(h * 60)}%` }}>
                  {String(h).padStart(2, '0')}:00
                </div>
              ))}
            </div>
          </div>

          {/* Agent rows */}
          <div className="divide-y divide-border/40">
            {agents.map((ag) => (
              <AgentRow
                key={ag.user_id}
                agent={ag}
                hours={hours}
                halfHours={halfHours}
                leftPct={leftPct}
                widthPct={widthPct}
                minutesOfDay={minutesOfDay}
                hhmmToMin={hhmmToMin}
                nowMin={nowMin}
                green={green}
                amber={amber}
                red={red}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function LegendSwatch({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="h-3 w-3 rounded-sm" style={{ background: color }} />
      {label}
    </span>
  );
}

interface AgentRowProps {
  agent: AgentActivityRow;
  hours: number[];
  halfHours: number[];
  leftPct: (m: number) => number;
  widthPct: (a: number, b: number) => number;
  minutesOfDay: (iso: string) => number;
  hhmmToMin: (s: string) => number;
  nowMin: number | null;
  green: string; amber: string; red: string;
}

function AgentRow({ agent, hours, halfHours, leftPct, widthPct, minutesOfDay, hhmmToMin, nowMin, green, amber, red }: AgentRowProps) {
  const t = agent.totals;
  return (
    <div className="flex items-center py-1.5">
      {/* Left rail: name + totals */}
      <div className="shrink-0 pl-3 pr-3" style={{ width: LABEL_PX }}>
        <div className="truncate text-sm font-semibold text-foreground">{agent.full_name}</div>
        <div className="truncate text-xs text-muted-foreground">
          {fmtDur(t.talk_seconds)} talk · {t.calls} {t.calls === 1 ? 'call' : 'calls'}
          {t.calls > 0 && ` · ${Math.round(t.answer_rate * 100)}%`}
        </div>
      </div>

      {/* Track */}
      <div className="relative h-12 flex-1 overflow-hidden rounded-md bg-muted/20">
        {/* Shift band(s) */}
        {agent.shift_windows.map((w, i) => {
          const s = hhmmToMin(w.start), e = hhmmToMin(w.end);
          return (
            <div
              key={`sh-${i}`}
              className="absolute inset-y-0 border-x border-border/40"
              style={{ left: `${leftPct(s)}%`, width: `${widthPct(s, e)}%`, background: IDLE_FILL }}
            />
          );
        })}

        {/* Half-hour minor gridlines */}
        {halfHours.map((m) => (
          <div key={`mg-${m}`} className="absolute inset-y-0 w-px bg-border/25" style={{ left: `${leftPct(m)}%` }} />
        ))}
        {/* Hour gridlines */}
        {hours.map((h) => (
          <div key={`g-${h}`} className="absolute inset-y-0 w-px bg-border/50" style={{ left: `${leftPct(h * 60)}%` }} />
        ))}

        {/* Breaks */}
        {agent.breaks.map((b, i) => (
          <BreakSegment
            key={`br-${i}`}
            brk={b}
            leftPct={leftPct}
            widthPct={widthPct}
            minutesOfDay={minutesOfDay}
            nowMin={nowMin}
          />
        ))}

        {/* Calls */}
        {agent.calls.map((c) => (
          <CallSegment
            key={c.id}
            call={c}
            leftPct={leftPct}
            widthPct={widthPct}
            minutesOfDay={minutesOfDay}
            nowMin={nowMin}
            green={green}
            amber={amber}
            red={red}
          />
        ))}

        {/* Live "now" marker */}
        {nowMin != null && (
          <div className="absolute inset-y-0 w-0.5 bg-primary/80" style={{ left: `${leftPct(nowMin)}%` }} />
        )}
      </div>
    </div>
  );
}

interface BreakSegmentProps {
  brk: { start: string; end: string | null };
  leftPct: (m: number) => number;
  widthPct: (a: number, b: number) => number;
  minutesOfDay: (iso: string) => number;
  nowMin: number | null;
}

/**
 * A pause band. Deliberately the same height/inset/rounding as a call segment
 * so the row reads as one strip of blocks, and hoverable like one so the
 * operator can read when the break ran and how long it lasted.
 */
function BreakSegment({ brk, leftPct, widthPct, minutesOfDay, nowMin }: BreakSegmentProps) {
  const { t } = useTranslation();
  const s = minutesOfDay(brk.start);
  const live = !brk.end && nowMin != null;
  const e = brk.end ? minutesOfDay(brk.end) : (nowMin ?? s);
  if (e <= s) return null;

  return (
    <Tooltip delayDuration={60}>
      <TooltipTrigger asChild>
        <div
          className="absolute inset-y-1.5 cursor-default rounded-[3px] hover:z-10 hover:ring-2 hover:ring-foreground/25"
          style={{
            left: `${leftPct(s)}%`,
            width: `${widthPct(s, e)}%`,
            minWidth: '4px',
            background: BREAK_TRACK,
          }}
        />
      </TooltipTrigger>
      <TooltipContent side="top" className="text-xs">
        <div className="font-semibold">{t('activity.onBreak')}</div>
        <div className="mt-0.5 font-mono text-muted-foreground">
          {minutesToHHMMSS(s)} → {live ? '…' : minutesToHHMMSS(e)}
        </div>
        <div className="mt-0.5">
          {fmtDur((e - s) * 60)}{live ? ` · ${t('activity.live')}` : ''}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

interface CallSegmentProps {
  call: AgentActivityCall;
  leftPct: (m: number) => number;
  widthPct: (a: number, b: number) => number;
  minutesOfDay: (iso: string) => number;
  nowMin: number | null;
  green: string; amber: string; red: string;
}

function CallSegment({ call, leftPct, widthPct, minutesOfDay, nowMin, green, amber, red }: CallSegmentProps) {
  const { t } = useTranslation();
  if (!call.started_at) return null;
  const sMin = minutesOfDay(call.started_at);
  const cMin = call.connected_at ? minutesOfDay(call.connected_at) : null;
  const live = !call.ended_at && nowMin != null;
  const eMin = call.ended_at ? minutesOfDay(call.ended_at) : (live ? nowMin! : (cMin ?? sMin));
  const dur = Math.max(eMin - sMin, 0.0001);
  const connectFrac = cMin != null ? Math.max(0, Math.min(1, (cMin - sMin) / dur)) : 0;

  const answered = cMin != null;
  const startLabel = minutesToHHMMSS(sMin);

  return (
    <Tooltip delayDuration={60}>
      <TooltipTrigger asChild>
        <div
          className="absolute inset-y-1.5 cursor-default rounded-[3px] ring-0 hover:z-10 hover:ring-2 hover:ring-foreground/25"
          style={{ left: `${leftPct(sMin)}%`, width: `${widthPct(sMin, eMin)}%`, minWidth: '4px' }}
        >
          {answered ? (
            <>
              {connectFrac > 0 && (
                <div className="absolute inset-y-0 left-0 rounded-l-[3px]" style={{ width: `${connectFrac * 100}%`, background: amber }} />
              )}
              <div className="absolute inset-y-0 right-0 rounded-r-[3px]" style={{ left: `${connectFrac * 100}%`, background: green, boxShadow: live ? `0 0 0 1px ${green}` : undefined }} />
            </>
          ) : (
            <div className="absolute inset-0 rounded-[3px]" style={{ background: red }} />
          )}
        </div>
      </TooltipTrigger>
      <TooltipContent side="top" className="text-xs">
        <div className="font-mono font-semibold">{call.customer_phone || '—'}</div>
        <div className="mt-0.5 text-muted-foreground">
          {startLabel} · {call.outcome ? t('outcome.' + call.outcome, { defaultValue: call.outcome }) : '—'}
        </div>
        <div className="mt-0.5">
          {answered
            ? <>{t('activity.callRingTalk', { ring: fmtDur(call.ring_seconds || 0), talk: fmtDur(call.talk_seconds || 0) })}{live ? ` · ${t('activity.live')}` : ''}</>
            : <>{t('activity.callRangNoAnswer', { ring: fmtDur(call.ring_seconds || Math.max(0, (eMin - sMin) * 60)) })}</>}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
