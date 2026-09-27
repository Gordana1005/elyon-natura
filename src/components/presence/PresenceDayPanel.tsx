import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { apiGetPresenceDay, type PresenceDayRow, type PresenceDayStatus } from '@/lib/api';
import { apiErrorText } from '@/i18n/apiErrors';
import { formatDate } from '@/i18n/dates';
import { shiftDay, skopjeDay, skopjeHm, splitMinutes } from '@/lib/presence/state';
import { cn } from '@/lib/utils';

const STATUS_ORDER: PresenceDayStatus[] = ['online', 'offline', 'no_heartbeat', 'absent', 'upcoming'];

// Dot colour per live state (online rows) or per day status (everyone else).
const DOT: Record<string, string> = {
  active: 'bg-emerald-500',
  idle: 'bg-amber-500',
  break: 'bg-sky-500',
  offline: 'bg-muted-foreground/40',
  no_heartbeat: 'bg-slate-400',
  absent: 'bg-rose-500',
  upcoming: 'bg-muted-foreground/25',
};

/**
 * Owners' "Who is working" view for one Europe/Skopje day: minutes online /
 * active / idle / on break per person, plus the people who logged in without
 * any activity data and the ones who were scheduled but never came.
 * Data: GET /presence/day (business owners only — migration 20260935000200).
 */
export function PresenceDayPanel() {
  const { t } = useTranslation();
  const today = skopjeDay();
  const [day, setDay] = useState(today);
  const [scope, setScope] = useState<'agents' | 'all'>('agents');
  const isToday = day === today;

  const { data, isLoading, isFetching, error } = useQuery({
    queryKey: ['presence-day', day],
    queryFn: () => apiGetPresenceDay(day),
    refetchInterval: isToday ? 60_000 : false,
  });

  const rows = useMemo(
    () => (data?.rows ?? []).filter((r) => scope === 'all' || r.is_agent),
    [data, scope],
  );
  const counts = useMemo(() => {
    const c: Record<PresenceDayStatus, number> = { online: 0, offline: 0, no_heartbeat: 0, absent: 0, upcoming: 0 };
    for (const r of rows) c[r.status] += 1;
    return c;
  }, [rows]);

  const chipLabel: Record<PresenceDayStatus, string> = {
    online: t('presence.chip.online'),
    offline: t('presence.chip.offline'),
    no_heartbeat: t('presence.chip.noHeartbeat'),
    absent: t('presence.chip.absent'),
    upcoming: t('presence.chip.upcoming'),
  };

  const dur = (min: number) => {
    const { h, m } = splitMinutes(min);
    return h > 0 ? t('presence.hm', { h, m }) : t('presence.m', { m });
  };

  const statusLabel = (r: PresenceDayRow): string => {
    if (r.status === 'online') {
      if (r.live_state === 'idle') return t('presence.status.idle', { minutes: r.idle_streak_minutes });
      if (r.live_state === 'break') return t('presence.status.break');
      return t('presence.status.active');
    }
    if (r.status === 'offline') return t('presence.status.offline');
    if (r.status === 'no_heartbeat') return t('presence.status.noHeartbeat');
    if (r.status === 'absent') return t('presence.status.absent');
    return t('presence.status.upcoming');
  };

  const dotFor = (r: PresenceDayRow) =>
    r.status === 'online' ? DOT[r.live_state ?? 'active'] : DOT[r.status];

  const whenLabel = (r: PresenceDayRow): string => {
    if (r.first_seen_at) {
      return `${skopjeHm(r.first_seen_at)}–${r.status === 'online' ? '…' : skopjeHm(r.last_seen_at)}`;
    }
    if (r.logins.length) return t('presence.loginAt', { time: skopjeHm(r.logins[0].at) });
    if (r.shifts.length) {
      return t('presence.shiftAt', { from: r.shifts[0].start, to: r.shifts[r.shifts.length - 1].end });
    }
    return '—';
  };

  const errorText = error
    ? ((error as Error).message === 'owners_only'
      ? t('presence.ownersOnly')
      : `${t('presence.loadFailed')} — ${apiErrorText(error)}`)
    : null;

  return (
    <div className="mt-4 space-y-3">
      {/* Day + scope controls */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1">
          <Button variant="outline" size="icon" className="h-8 w-8" aria-label={t('presence.prevDay')}
            onClick={() => setDay((d) => shiftDay(d, -1))}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="min-w-[10rem] text-center text-sm font-medium capitalize">
            {formatDate(new Date(`${day}T12:00:00`), 'EEEE, d MMMM yyyy')}
          </span>
          <Button variant="outline" size="icon" className="h-8 w-8" aria-label={t('presence.nextDay')}
            disabled={isToday} onClick={() => setDay((d) => (d >= today ? d : shiftDay(d, 1)))}>
            <ChevronRight className="h-4 w-4" />
          </Button>
          {!isToday && (
            <Button variant="ghost" size="sm" className="h-8" onClick={() => setDay(today)}>
              {t('presence.today')}
            </Button>
          )}
        </div>
        <div className="ml-auto flex items-center gap-1 rounded-lg border p-0.5">
          {(['agents', 'all'] as const).map((s) => (
            <button key={s} type="button" onClick={() => setScope(s)}
              className={cn('rounded-md px-2.5 py-1 text-xs transition-colors',
                scope === s ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted')}>
              {s === 'agents' ? t('presence.agentsOnly') : t('presence.allStaff')}
            </button>
          ))}
        </div>
        {isFetching && !isLoading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
      </div>

      {/* Status counts for the rows in view */}
      {!isLoading && !errorText && (
        <div className="flex flex-wrap gap-1.5">
          {STATUS_ORDER.filter((s) => counts[s] > 0).map((s) => (
            <span key={s} className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs">
              <span className={cn('h-2 w-2 rounded-full', DOT[s === 'online' ? 'active' : s])} />
              {chipLabel[s]}
              <span className="font-semibold tabular-nums">{counts[s]}</span>
            </span>
          ))}
        </div>
      )}

      {isLoading ? (
        <div className="flex items-center justify-center py-12 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      ) : errorText ? (
        <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">{errorText}</p>
      ) : rows.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted-foreground">{t('presence.empty')}</p>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="bg-muted/50 text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left font-medium">{t('presence.colPerson')}</th>
                <th className="px-3 py-2 text-left font-medium">{t('presence.colStatus')}</th>
                <th className="px-3 py-2 text-right font-medium">{t('presence.colOnline')}</th>
                <th className="px-3 py-2 text-right font-medium">{t('presence.colActive')}</th>
                <th className="px-3 py-2 text-right font-medium">{t('presence.colIdle')}</th>
                <th className="px-3 py-2 text-right font-medium">{t('presence.colBreak')}</th>
                <th className="px-3 py-2 text-left font-medium">{t('presence.colFromTo')}</th>
                <th className="px-3 py-2 text-right font-medium">{t('presence.colAlerts')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const seen = !!r.first_seen_at;
                return (
                  <tr key={r.user_id} className="border-t">
                    <td className="px-3 py-2 font-medium">{r.full_name}</td>
                    <td className="px-3 py-2">
                      <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                        <span className={cn('h-2 w-2 shrink-0 rounded-full', dotFor(r))} />
                        {statusLabel(r)}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{seen ? dur(r.online_minutes) : '—'}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-emerald-700 dark:text-emerald-400">
                      {seen ? dur(r.active_minutes) : '—'}
                    </td>
                    <td className={cn('px-3 py-2 text-right tabular-nums',
                      r.idle_minutes > 0 ? 'text-amber-700 dark:text-amber-400' : 'text-muted-foreground')}>
                      {seen ? dur(r.idle_minutes) : '—'}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                      {seen ? dur(r.break_minutes) : '—'}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 tabular-nums text-muted-foreground">{whenLabel(r)}</td>
                    <td className={cn('px-3 py-2 text-right tabular-nums',
                      r.idle_alerts > 0 ? 'font-semibold text-amber-700 dark:text-amber-400' : 'text-muted-foreground')}>
                      {r.idle_alerts > 0 ? r.idle_alerts : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {data && (
        <p className="text-xs text-muted-foreground">
          {data.idle_alert_minutes > 0
            ? t('presence.alertRule', { minutes: data.idle_alert_minutes })
            : t('presence.alertsOff')}
        </p>
      )}
    </div>
  );
}
