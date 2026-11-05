import { useTranslation } from 'react-i18next';
import { Clock3, LogIn, PhoneCall } from 'lucide-react';
import type { AgentFloorRow, AgentLiveStatus } from '@/lib/api';
import { formatDenari } from '@/lib/currency';
import { fmtDuration } from '@/lib/design-utils';
import { skopjeHm } from '@/lib/presence/state';
import { cn } from '@/lib/utils';
import { isLate, minutesSince, presenceSplit } from './floor';

/** Pill + dot colours per live status. Tailwind classes so dark mode follows the theme. */
export const STATUS_STYLE: Record<AgentLiveStatus, { pill: string; dot: string }> = {
  in_call: { pill: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300', dot: 'bg-emerald-500' },
  online:  { pill: 'bg-sky-100 text-sky-800 dark:bg-sky-500/15 dark:text-sky-300', dot: 'bg-sky-500' },
  idle:    { pill: 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300', dot: 'bg-amber-500' },
  break:   { pill: 'bg-violet-100 text-violet-800 dark:bg-violet-500/15 dark:text-violet-300', dot: 'bg-violet-500' },
  offline: { pill: 'bg-muted text-muted-foreground', dot: 'bg-muted-foreground/40' },
};

const initials = (name: string) =>
  name.split(/\s+/).filter(Boolean).map((p) => p[0]).join('').toUpperCase().slice(0, 2) || '?';

export function StatusPill({ live, className }: { live: NonNullable<AgentFloorRow['live']>; className?: string }) {
  const { t } = useTranslation();
  const mins = live.status !== 'offline' ? minutesSince(live.since) : 0;
  return (
    <span className={cn('inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium', STATUS_STYLE[live.status].pill, className)}>
      <span className={cn('h-1.5 w-1.5 rounded-full', STATUS_STYLE[live.status].dot, live.status === 'in_call' && 'animate-pulse')} aria-hidden />
      {t(`agentFloor.status.${live.status}`)}
      {mins > 0 && <span className="font-normal opacity-80">· {t('agentFloor.since', { duration: fmtDuration(mins * 60) })}</span>}
    </span>
  );
}

/** The team badge: the business line + lane (Affiliate / Teleshop · in / out / social), Менаџмент shown as such. */
export function TeamBadge({ team, className }: { team: AgentFloorRow['team']; className?: string }) {
  const { t } = useTranslation();
  if (!team?.name && !team?.key) return null;
  const lane = team.lane ? t(`agentFloor.lane.${team.lane}`, { defaultValue: team.lane }) : null;
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-px text-[11px] font-medium text-muted-foreground', className)}>
      {team.name || team.key}
      {lane && <span className="opacity-70">· {lane}</span>}
    </span>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="min-w-0">
      <p className="truncate text-[11px] text-muted-foreground">{label}</p>
      <p className="truncate text-sm font-semibold tabular-nums">{value}</p>
      {sub && <p className="truncate text-[11px] tabular-nums text-muted-foreground">{sub}</p>}
    </div>
  );
}

export function AgentFloorCard({ agent, onOpen }: { agent: AgentFloorRow; onOpen: () => void }) {
  const { t } = useTranslation();
  const { totals, presence, sales, live } = agent;
  const split = presenceSplit(presence);
  const shift = agent.shift_windows[0];
  const offline = !live || live.status === 'offline';
  const hasMoney = typeof sales.value_mkd === 'number';

  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        'flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-4 text-left shadow-sm transition-all duration-200',
        'hover:-translate-y-[1px] hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        live?.status === 'offline' && 'opacity-80',
      )}
    >
      {/* Header: avatar, name, status */}
      <div className="flex items-start gap-3">
        <div className="relative shrink-0">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary">
            {initials(agent.full_name)}
          </div>
          {live && (
            <span className={cn('absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-card', STATUS_STYLE[live.status].dot)} aria-hidden />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
            <p className="truncate text-sm font-semibold">{agent.full_name}</p>
            {live && <StatusPill live={live} />}
          </div>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
            <TeamBadge team={agent.team} />
            <span className="inline-flex items-center gap-1">
              <Clock3 className="h-3 w-3" aria-hidden />
              {shift ? t('agentFloor.shift', { from: shift.start, to: shift.end }) : t('agentFloor.noShift')}
            </span>
            <span className="inline-flex items-center gap-1">
              <LogIn className="h-3 w-3" aria-hidden />
              {agent.first_seen ? t('agentFloor.login', { time: skopjeHm(agent.first_seen) }) : t('agentFloor.notLoggedIn')}
            </span>
            {isLate(agent) && (
              <span className="rounded bg-rose-100 px-1.5 py-px font-medium text-rose-700 dark:bg-rose-500/15 dark:text-rose-300">
                {t('agentFloor.late', { min: agent.late_minutes })}
              </span>
            )}
            {offline && agent.last_seen && (
              <span>{t('agentFloor.lastSeen', { time: skopjeHm(agent.last_seen) })}</span>
            )}
          </p>
        </div>
      </div>

      {/* Time on the CRM: active / idle / break */}
      <div>
        <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
          <span className="truncate">
            {presence
              ? t('agentFloor.onlineTime', { time: fmtDuration(presence.online_minutes * 60) })
              : t('agentFloor.noPresence')}
          </span>
          {presence && presence.online_minutes > 0 && (
            <span className="shrink-0 tabular-nums">
              {fmtDuration(presence.active_minutes * 60)} · {fmtDuration(presence.idle_minutes * 60)} · {fmtDuration(presence.break_minutes * 60)}
            </span>
          )}
        </div>
        <div className="mt-1 flex h-1.5 overflow-hidden rounded-full bg-muted" role="img"
          aria-label={`${t('agentFloor.presActive')} ${Math.round(split.active)}% · ${t('agentFloor.presIdle')} ${Math.round(split.idle)}% · ${t('agentFloor.presBreak')} ${Math.round(split.brk)}%`}>
          <div className="bg-emerald-500" style={{ width: `${split.active}%` }} />
          <div className="bg-amber-400" style={{ width: `${split.idle}%` }} />
          <div className="bg-violet-400" style={{ width: `${split.brk}%` }} />
        </div>
      </div>

      {/* Calls */}
      <div className="grid grid-cols-3 gap-2 border-t pt-3">
        <Stat
          label={t('agentFloor.calls')}
          value={String(totals.calls)}
          sub={totals.calls ? t('agentFloor.answeredRate', { rate: Math.round(totals.answer_rate * 100) }) : undefined}
        />
        <Stat
          label={t('agentFloor.talk')}
          value={fmtDuration(totals.talk_seconds)}
          sub={totals.answered ? t('agentFloor.avgTalk', { avg: fmtDuration(totals.talk_seconds / totals.answered) }) : undefined}
        />
        <Stat label={t('agentFloor.lastCall')} value={totals.last_call ? skopjeHm(totals.last_call) : '—'} />
      </div>

      {/* The day's sales (the cohort board); value only for a money viewer */}
      <div className="grid grid-cols-3 gap-2 rounded-lg bg-muted/40 p-2.5">
        <Stat
          label={t('agentFloor.sales')}
          value={String(sales.sales)}
          sub={sales.worked ? t('agentFloor.workedCount', { count: sales.worked }) : undefined}
        />
        <Stat
          label={t('agentFloor.value')}
          value={hasMoney ? formatDenari(sales.value_mkd) : '—'}
          sub={hasMoney && sales.scoped ? t('agentFloor.scopedHint') : undefined}
        />
        <Stat
          label={t('agentFloor.returned')}
          value={String(sales.returned)}
          sub={sales.cancelled ? t('agentFloor.cancelledCount', { count: sales.cancelled }) : undefined}
        />
      </div>

      {live?.status === 'in_call' && (
        <p className="flex items-center gap-1.5 truncate text-[11px] font-medium text-emerald-700 dark:text-emerald-300">
          <PhoneCall className="h-3 w-3" aria-hidden />
          {t('agentFloor.inCallNow')}
        </p>
      )}
    </button>
  );
}
