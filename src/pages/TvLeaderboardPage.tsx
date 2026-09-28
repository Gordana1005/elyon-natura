// Full-screen, always-on wall-board for the office TV. No login or app chrome:
// the access token rides in the URL (?key=...) and is validated server-side.
// Since 2026-09-28 it shows EVERY person on the board's team, every day —
// online / idle / on break / offline, with or without sales — plus guests who
// sold this board's source from another team and anyone added in Settings.
// Each row carries the time spent on the CRM that day (online / active / idle /
// break, first–last activity); people who decide in AlterCPA's own panel have
// no CRM presence, so their row shows their last decision instead.
// Today updates live (~1s) via a Supabase Realtime broadcast, with a 20s polling
// fallback. A day switcher lets you review previous days.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ChevronLeft, ChevronRight, Trophy, Maximize2, Minimize2, BellRing } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import i18n, { SUPPORTED_LANGUAGES } from '@/i18n';
import { formatDate } from '@/i18n/dates';
import {
  apiGetLeaderboard,
  type LeaderboardResponse, type LeaderboardRow, type LeaderboardMode, type LeaderboardPresenceState,
} from '@/lib/api';
import { formatMoney } from '@/lib/currency';

const POLL_MS = 20_000;
const REFETCH_DEBOUNCE_MS = 1_000;
const CELEBRATE_MS = 4_500;
const SCROLL_EVERY_MS = 9_000;

const addDays = (ymd: string, delta: number) => {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + delta)).toISOString().slice(0, 10);
};

// Module-level, so it reaches for the i18n singleton directly. The page itself
// subscribes via useTranslation(), so a language switch re-renders and re-calls it.
function dayLabel(day: string, offset: number) {
  if (offset === 0) return i18n.t('tvBoard.today');
  if (offset === 1) return i18n.t('tvBoard.yesterday');
  const [y, m, d] = day.split('-').map(Number);
  // Local midnight (not UTC) so the weekday never slips a day on a TV west of UTC.
  return formatDate(new Date(y, m - 1, d), 'EEE d MMM');
}

function initials(name: string) {
  return name.split(/[.\s_]+/).filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase()).join('') || '–';
}

// Clock times of the data are Skopje wall-clock, whatever the TV's own zone.
const hhmm = (iso: string | null | undefined) => (iso
  ? new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Skopje' })
  : '');

function fmtDur(min: number) {
  const m = Math.max(0, Math.round(min || 0));
  if (m < 60) return i18n.t('tvBoard.durM', { m });
  return i18n.t('tvBoard.durHM', { h: Math.floor(m / 60), m: String(m % 60).padStart(2, '0') });
}

const soldAny = (a: LeaderboardRow) => (a.sales ?? 0) > 0 || a.confirmed_count > 0;

// Tasteful confetti (thin brand-colored strips, no emoji).
function Confetti() {
  const bits = useMemo(() => Array.from({ length: 36 }, (_, i) => ({
    id: i, left: Math.random() * 100, delay: Math.random() * 0.8, dur: 2.6 + Math.random() * 1.8,
    color: ['#34d399', '#818cf8', '#fbbf24', '#f9fafb', '#22d3ee'][i % 5], rot: Math.random() * 360,
  })), []);
  return (
    <div className="pointer-events-none fixed inset-0 z-50 overflow-hidden">
      {bits.map((b) => (
        <span key={b.id} className="absolute -top-10 block"
          style={{ left: `${b.left}%`, width: '7px', height: '16px', background: b.color, borderRadius: '2px',
            transform: `rotate(${b.rot}deg)`, animation: `tv-fall ${b.dur}s cubic-bezier(.3,.1,.5,1) ${b.delay}s 1` }} />
      ))}
    </div>
  );
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] px-[1.4vw] py-[1.2vh]">
      <div className="text-[1.4vh] font-medium uppercase tracking-[0.12em] text-slate-400">{label}</div>
      <div className="mt-[0.4vh] text-[3.4vh] font-bold leading-none tabular-nums text-slate-50">{value}</div>
      {sub && <div className="mt-[0.5vh] truncate text-[1.35vh] text-slate-400">{sub}</div>}
    </div>
  );
}

const DOT: Record<LeaderboardPresenceState, string> = {
  online: 'bg-emerald-400 shadow-[0_0_0.8vh_rgba(52,211,153,0.8)]',
  idle: 'bg-amber-400',
  break: 'bg-sky-400',
  offline: 'bg-slate-600',
  'n/a': 'border-2 border-slate-500 bg-transparent',
};

function PresenceDot({ state }: { state: LeaderboardPresenceState | undefined }) {
  const { t } = useTranslation();
  if (!state) return null;
  const label = {
    online: t('tvBoard.stateOnline'), idle: t('tvBoard.stateIdle'), break: t('tvBoard.stateBreak'),
    offline: t('tvBoard.stateOffline'), 'n/a': t('tvBoard.stateNa'),
  }[state];
  return (
    <span title={label} aria-label={label}
      className={`inline-block shrink-0 rounded-full ${DOT[state]} ${state === 'idle' ? 'animate-pulse' : ''}`}
      style={{ width: '1.5vh', height: '1.5vh' }} />
  );
}

const rankAccent: Record<number, string> = {
  1: 'bg-amber-300/15 text-amber-300 ring-amber-300/30',
  2: 'bg-slate-300/15 text-slate-200 ring-slate-300/30',
  3: 'bg-orange-400/15 text-orange-300 ring-orange-400/30',
};

export default function TvLeaderboardPage() {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const key = params.get('key') || '';
  const langParam = params.get('lang') || '';

  // Public board — no login, so there is no profiles.language to read. ?lang=bg
  // pins the board's language per TV; without it the localStorage default wins.
  useEffect(() => {
    if (langParam && (SUPPORTED_LANGUAGES as string[]).includes(langParam) && i18n.language !== langParam) {
      void i18n.changeLanguage(langParam);
    }
  }, [langParam]);

  // Mode is seeded from ?mode= (so a TV can be pinned) but also togglable on screen.
  const [mode, setMode] = useState<LeaderboardMode>(params.get('mode') === 'pending' ? 'pending' : 'prediction');
  const [data, setData] = useState<LeaderboardResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [offset, setOffset] = useState(0); // 0 = today, 1 = yesterday, ...
  const [now, setNow] = useState(() => new Date());
  const [celebrate, setCelebrate] = useState<{ agentId: string; at: number } | null>(null);
  const [isFs, setIsFs] = useState(false);
  const [cursorHidden, setCursorHidden] = useState(false);

  const toggleFullscreen = useCallback(() => {
    const el = document.documentElement as any;
    if (!document.fullscreenElement && !(document as any).webkitFullscreenElement) {
      (el.requestFullscreen || el.webkitRequestFullscreen)?.call(el);
    } else {
      (document.exitFullscreen || (document as any).webkitExitFullscreen)?.call(document);
    }
  }, []);

  const anchorRef = useRef<string | null>(null); // server "today" once known
  const debounceRef = useRef<number | null>(null);
  const celebrateTimer = useRef<number | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async (ofs: number) => {
    if (!key) { setError(i18n.t('tvBoard.missingKey')); setLoading(false); return; }
    try {
      const reqDay = ofs > 0 && anchorRef.current ? addDays(anchorRef.current, -ofs) : undefined;
      const res = await apiGetLeaderboard(key, reqDay, mode);
      anchorRef.current = res.today;
      setData(res);
      setError(null);
    } catch (e: any) {
      setError(e?.message || i18n.t('tvBoard.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [key, mode]);

  const scheduleRefetch = useCallback(() => {
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => { void load(0); }, REFETCH_DEBOUNCE_MS);
  }, [load]);

  const triggerCelebrate = useCallback((agentId?: string) => {
    if (!agentId) return;
    setCelebrate({ agentId, at: Date.now() });
    if (celebrateTimer.current) window.clearTimeout(celebrateTimer.current);
    celebrateTimer.current = window.setTimeout(() => setCelebrate(null), CELEBRATE_MS);
  }, []);

  // Load on key/offset change.
  useEffect(() => { setLoading(true); void load(offset); }, [load, offset]);

  // Poll only the live (today) view.
  useEffect(() => {
    if (offset !== 0) return;
    const id = window.setInterval(() => { void load(0); }, POLL_MS);
    return () => window.clearInterval(id);
  }, [load, offset]);

  // Live clock (also ages "last decision N min ago").
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(id);
  }, []);

  // Track fullscreen state (button icon + browser F11/Esc).
  useEffect(() => {
    const onFs = () => setIsFs(!!(document.fullscreenElement || (document as any).webkitFullscreenElement));
    document.addEventListener('fullscreenchange', onFs);
    document.addEventListener('webkitfullscreenchange', onFs);
    return () => { document.removeEventListener('fullscreenchange', onFs); document.removeEventListener('webkitfullscreenchange', onFs); };
  }, []);

  // Hide the cursor after 3s idle (clean wall display); show it on mouse move so
  // the fullscreen button stays clickable.
  useEffect(() => {
    let tm: number | undefined;
    const onMove = () => { setCursorHidden(false); if (tm) window.clearTimeout(tm); tm = window.setTimeout(() => setCursorHidden(true), 3000); };
    onMove();
    window.addEventListener('mousemove', onMove);
    return () => { window.removeEventListener('mousemove', onMove); if (tm) window.clearTimeout(tm); };
  }, []);

  // Realtime broadcast — instant updates + celebration, today only.
  useEffect(() => {
    if (offset !== 0) return;
    const channel = supabase
      .channel('tv-leaderboard')
      .on('broadcast', { event: 'confirmed' }, ({ payload }: any) => { triggerCelebrate(payload?.agent_id); scheduleRefetch(); })
      .on('broadcast', { event: 'refresh' }, () => scheduleRefetch())
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [offset, scheduleRefetch, triggerCelebrate]);

  // Keep the TV awake.
  useEffect(() => {
    let lock: any = null;
    const req = async () => { try { lock = await (navigator as any).wakeLock?.request('screen'); } catch { /* ignore */ } };
    void req();
    const onVis = () => { if (document.visibilityState === 'visible') void req(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { document.removeEventListener('visibilitychange', onVis); try { lock?.release?.(); } catch { /* ignore */ } };
  }, []);

  const isPred = mode === 'prediction';
  const agents: LeaderboardRow[] = useMemo(() => data?.agents || [], [data]);
  const summary = data?.summary;
  const isToday = offset === 0;

  // More people than fit: page through them every few seconds (a wall screen
  // has no one to scroll it). Programmatic scroll works under overflow:hidden.
  useEffect(() => {
    const id = window.setInterval(() => {
      const el = scrollRef.current;
      if (!el) return;
      const max = el.scrollHeight - el.clientHeight;
      if (max <= 4) { if (el.scrollTop) el.scrollTop = 0; return; }
      const next = el.scrollTop >= max - 2 ? 0 : Math.min(max, el.scrollTop + el.clientHeight * 0.8);
      el.scrollTo({ top: next, behavior: 'smooth' });
    }, SCROLL_EVERY_MS);
    return () => window.clearInterval(id);
  }, []);

  const team = useMemo(() => {
    const confirmed = agents.reduce((s, a) => s + a.confirmed_count, 0);
    const revenue = agents.reduce((s, a) => s + (a.revenue || 0), 0);
    const price = agents.reduce((s, a) => s + a.avg_order_value * a.confirmed_count, 0);
    const calls = agents.reduce((s, a) => s + a.calls, 0);
    const bonus = agents.reduce((s, a) => s + a.bonus, 0);
    const worked = agents.reduce((s, a) => s + (a.worked ?? 0), 0);
    const decisions = agents.reduce((s, a) => s + (a.sale_decisions ?? 0), 0);
    // Conversion from the work ledger when the api provides it (AlterCPA
    // operators log no CRM calls, so calls-based "sold rate" reads 0 for them).
    const rate = worked > 0 ? (decisions / worked) * 100 : calls ? (confirmed / calls) * 100 : 0;
    return { people: agents.length, confirmed, revenue, avg: confirmed ? price / confirmed : 0, rate, bonus };
  }, [agents]);

  // Row height follows the head count so a normal day fits without paging.
  const topVh = isPred ? 58 : 64;
  const rowVh = Math.max(3.4, Math.min(6.2, topVh / Math.max(1, agents.length)));
  const fontVh = Math.min(3, Math.max(1.75, rowVh * 0.5));

  const presenceTile = () => {
    if (!summary) return <StatCard label={t('tvBoard.agentsOnline')} value={String(team.people)} />;
    if (!isToday) {
      return <StatCard label={t('tvBoard.wereOnline')} value={String(summary.was_online)}
        sub={t('tvBoard.peopleSub', { n: summary.people })} />;
    }
    const sub = [
      t('tvBoard.presenceSub', { idle: summary.idle, brk: summary.on_break, off: summary.offline }),
      summary.no_login > 0 ? t('tvBoard.noLoginSub', { n: summary.no_login }) : '',
    ].filter(Boolean).join(' · ');
    return <StatCard label={t('tvBoard.onlineNow')} value={`${summary.online_now}/${summary.people}`} sub={sub} />;
  };

  const lastDecisionText = (iso: string) => {
    const mins = Math.floor((now.getTime() - Date.parse(iso)) / 60000);
    if (isToday && mins >= 0 && mins < 60) return t('tvBoard.lastDecisionAgo', { n: mins });
    return t('tvBoard.lastDecisionAt', { time: hhmm(iso) });
  };

  const timeCell = (a: LeaderboardRow) => {
    const p = a.presence;
    if (p && p.online_min > 0) {
      return (
        <div className="min-w-0 leading-tight">
          <div className="font-semibold tabular-nums">{fmtDur(p.online_min)}</div>
          <div className="truncate text-[0.52em] text-slate-400 tabular-nums">
            {t('tvBoard.timeSplit', { a: fmtDur(p.active_min), i: fmtDur(p.idle_min), b: fmtDur(p.break_min) })}
            {p.idle_alerts > 0 && (
              <span className="ml-[0.4vw] inline-flex items-center gap-[0.2vw] text-amber-300" title={t('tvBoard.idleAlerts', { n: p.idle_alerts })}>
                <BellRing style={{ width: '1.3vh', height: '1.3vh' }} />{p.idle_alerts}
              </span>
            )}
          </div>
        </div>
      );
    }
    if (a.last_decision_at) return <div className="truncate text-[0.62em] text-slate-300">{lastDecisionText(a.last_decision_at)}</div>;
    if (p?.first_login) return <div className="truncate text-[0.62em] text-slate-400">{t('tvBoard.loggedInAt', { time: hhmm(p.first_login) })}</div>;
    return <div className="text-[0.62em] text-slate-500">{p?.state === 'n/a' ? t('tvBoard.noDecision') : '—'}</div>;
  };

  const shiftText = (a: LeaderboardRow) => {
    const p = a.presence;
    if (!p) return '—';
    const start = p.first_active || p.first_seen || p.first_login;
    const end = p.last_active || p.last_seen;
    if (start && end) return `${hhmm(start)}–${hhmm(end)}`;
    if (start) return `${hhmm(start)} →`;
    return '—';
  };

  const teamLabel = (a: LeaderboardRow) =>
    a.team_key ? t(`tvBoard.team.${a.team_key}`, { defaultValue: a.team_name || a.team_key }) : '';

  const label = data ? dayLabel(data.day, offset) : '';
  const pill = (active: boolean) =>
    `rounded-md px-[1vw] py-[0.6vh] text-[1.7vh] font-semibold transition ${active ? 'bg-indigo-500 text-white' : 'text-slate-300 hover:bg-white/10'}`;
  const gridCls = isPred
    ? 'grid-cols-[5%_29%_8%_13%_8%_17%_10%_10%]'
    : 'grid-cols-[5%_26%_8%_11%_9%_7%_15%_9%_10%]';

  return (
    <div className={`flex h-screen w-screen flex-col overflow-hidden bg-gradient-to-b from-slate-950 to-slate-900 px-[2.2vw] py-[2.2vh] font-sans text-slate-100 ${cursorHidden ? 'cursor-none' : ''}`}>
      <style>{`@keyframes tv-fall{0%{transform:translateY(-12vh)}100%{transform:translateY(112vh)}}
        @keyframes tv-glow{0%,100%{background-color:rgba(52,211,153,0)}40%{background-color:rgba(52,211,153,0.16)}}`}</style>

      {celebrate && isToday && <Confetti />}

      {/* Header */}
      <header className="mb-[2vh] flex items-center justify-between">
        <div className="flex items-center gap-[1.2vw]">
          <Trophy className="text-amber-300" style={{ width: '4vh', height: '4vh' }} />
          <div>
            <div className="text-[3vh] font-bold leading-none tracking-tight">{isPred ? t('tvBoard.titlePrediction') : t('tvBoard.titlePending')}</div>
            <div className="mt-[0.6vh] flex items-center gap-2 text-[1.6vh] text-slate-400">
              {isToday && <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-emerald-400" />}
              <span>
                {isToday ? t('tvBoard.live') : t('tvBoard.history')} ·{' '}
                {t('tvBoard.updated', { time: data ? new Date(data.generated_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '—' })}
              </span>
            </div>
          </div>
          <div className="ml-[0.6vw] flex rounded-lg border border-white/10 bg-white/5 p-[0.4vh]">
            <button onClick={() => setMode('prediction')} className={pill(isPred)}>{t('tvBoard.modePrediction')}</button>
            <button onClick={() => setMode('pending')} className={pill(!isPred)}>{t('tvBoard.modePending')}</button>
          </div>
        </div>

        {/* Day switcher */}
        <div className="flex items-center gap-[0.8vw]">
          <button onClick={() => setOffset((o) => o + 1)}
            className="rounded-lg border border-white/10 bg-white/5 p-[1vh] text-slate-200 transition hover:bg-white/10">
            <ChevronLeft style={{ width: '2.6vh', height: '2.6vh' }} />
          </button>
          <div className="min-w-[14vw] text-center">
            <div className="text-[2.6vh] font-semibold leading-none">{label}</div>
            <div className="mt-[0.5vh] text-[1.5vh] text-slate-400">{data?.day || ''}</div>
          </div>
          <button onClick={() => setOffset((o) => Math.max(0, o - 1))} disabled={isToday}
            className="rounded-lg border border-white/10 bg-white/5 p-[1vh] text-slate-200 transition hover:bg-white/10 disabled:opacity-30">
            <ChevronRight style={{ width: '2.6vh', height: '2.6vh' }} />
          </button>
        </div>

        <div className="flex items-center gap-[1vw]">
          <div className="text-[4.4vh] font-bold leading-none tabular-nums">{now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</div>
          <button onClick={toggleFullscreen} title={isFs ? t('tvBoard.exitFullscreen') : t('tvBoard.fullscreen')}
            className="rounded-lg border border-white/10 bg-white/5 p-[1vh] text-slate-300 transition hover:bg-white/10">
            {isFs ? <Minimize2 style={{ width: '2.6vh', height: '2.6vh' }} /> : <Maximize2 style={{ width: '2.6vh', height: '2.6vh' }} />}
          </button>
        </div>
      </header>

      {/* KPI strip */}
      <div className="mb-[2vh] grid grid-cols-5 gap-[1vw]">
        {presenceTile()}
        <StatCard label={t('tvBoard.sales')} value={String(team.confirmed)}
          sub={summary ? t('tvBoard.zeroSaleSub', { n: summary.zero_sale_people }) : undefined} />
        {isPred
          ? <StatCard label={t('tvBoard.revenue')} value={formatMoney(team.revenue)} />
          : <StatCard label={t('tvBoard.conversion')} value={`${team.rate.toFixed(1)}%`} />}
        <StatCard label={t('tvBoard.avgOrder')} value={formatMoney(team.avg)} />
        <StatCard label={t('tvBoard.bonusPool')} value={formatMoney(team.bonus)} />
      </div>

      {/* Team daily target (prediction only) — the shared goal of the team */}
      {isPred && !loading && !error && data && (
        <div className="mb-[2vh] rounded-xl border border-emerald-400/20 bg-emerald-400/[0.06] px-[1.6vw] py-[1.2vh]">
          <div className="mb-[0.8vh] flex items-end justify-between">
            <span className="text-[1.6vh] font-semibold uppercase tracking-[0.12em] text-emerald-300">
              {t('tvBoard.teamTarget')}
              {summary && data.team_target_bonus > 0 && (
                <span className="ml-[1vw] normal-case tracking-normal text-slate-300">{t('tvBoard.targetEarners', { n: summary.team_target_earners })}</span>
              )}
            </span>
            <span className="text-[2.6vh] font-bold tabular-nums">
              {formatMoney(data.team_revenue)} <span className="text-[1.9vh] text-slate-400">/ {formatMoney(data.target)}</span>
              <span className="ml-[1vw] text-emerald-300">{data.team_target_pct.toFixed(0)}%</span>
            </span>
          </div>
          <div className="h-[1.8vh] w-full overflow-hidden rounded-full bg-white/10">
            <div className="h-full rounded-full bg-gradient-to-r from-emerald-400 to-emerald-300 transition-all duration-700" style={{ width: `${Math.min(100, data.team_target_pct)}%` }} />
          </div>
        </div>
      )}

      {/* States */}
      {loading && <div className="mt-[18vh] text-center text-[2.6vh] text-slate-400">{t('common.loading')}</div>}
      {!loading && error && (
        <div className="mt-[18vh] text-center text-[2.6vh] text-rose-400">
          {error === 'Unauthorized' ? t('tvBoard.invalidKey') : error}
        </div>
      )}
      {!loading && !error && agents.length === 0 && (
        <div className="mt-[18vh] text-center text-[2.6vh] text-slate-400">{t('tvBoard.noAgents')}</div>
      )}

      {/* Table */}
      {!loading && !error && agents.length > 0 && (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-white/10 bg-white/[0.02]">
          <div className={`grid ${gridCls} shrink-0 items-center px-[1.6vw] py-[1.2vh] text-[1.4vh] font-semibold uppercase tracking-[0.1em] text-slate-400`}>
            <div>#</div><div>{t('tvBoard.colAgent')}</div>
            <div className="text-center">{isPred ? t('tvBoard.sales') : t('tvBoard.colConfirmed')}</div>
            <div className="text-center">{isPred ? t('tvBoard.revenue') : t('tvBoard.avgOrder')}</div>
            {!isPred && <div className="text-center">{t('tvBoard.conversion')}</div>}
            <div className="text-center">{t('tvBoard.colWorked')}</div>
            <div>{t('tvBoard.colTime')}</div>
            <div className="text-center">{t('tvBoard.colShift')}</div>
            <div className="text-right">{t('tvBoard.colBonus')}</div>
          </div>
          <div ref={scrollRef} className="min-h-0 flex-1 overflow-hidden">
            {agents.map((a, idx) => {
              const rowKey = a.key || a.person_id || a.user_id || a.full_name;
              const live = !!a.user_id && celebrate?.agentId === a.user_id && isToday;
              const sold = soldAny(a);
              const quiet = !sold && !(a.worked ?? 0) && (!a.presence || a.presence.state === 'offline' || a.presence.state === 'n/a');
              const p = a.presence;
              const conv = a.conversion_pct ?? (a.calls > 0 ? a.sold_rate : null);
              return (
                <div key={rowKey}
                  className={`grid ${gridCls} items-center border-t border-white/5 px-[1.6vw] ${idx % 2 ? 'bg-white/[0.015]' : ''} ${sold ? '' : quiet ? 'opacity-40' : 'opacity-60'}`}
                  style={{ height: `${rowVh}vh`, fontSize: `${fontVh}vh`, ...(live ? { animation: 'tv-glow 1.4s ease-in-out 2' } : {}) }}>
                  {/* Rank — only people who sold get a number */}
                  <div>
                    {sold ? (
                      <span className={`inline-flex items-center justify-center rounded-full font-bold ring-1 ${rankAccent[a.rank] || 'bg-white/5 text-slate-300 ring-white/10'}`}
                        style={{ width: `${rowVh * 0.7}vh`, height: `${rowVh * 0.7}vh`, fontSize: `${fontVh * 0.72}vh` }}>{a.rank}</span>
                    ) : <span className="text-slate-600">–</span>}
                  </div>
                  {/* Person: presence dot, name, badges */}
                  <div className="flex min-w-0 items-center gap-[0.7vw]">
                    <span className="relative inline-flex shrink-0 items-center justify-center rounded-full bg-indigo-500/20 font-bold text-indigo-200"
                      style={{ width: `${rowVh * 0.72}vh`, height: `${rowVh * 0.72}vh`, fontSize: `${fontVh * 0.62}vh` }}>
                      {initials(a.full_name)}
                      <span className="absolute -bottom-[0.2vh] -right-[0.2vh]"><PresenceDot state={p?.state} /></span>
                    </span>
                    <span className="truncate font-semibold">{a.full_name}</span>
                    {a.is_super && <span className="shrink-0 rounded bg-white/10 px-[0.5vw] py-[0.2vh] text-[1.2vh] font-medium uppercase tracking-wide text-slate-400">{t('tvBoard.adminBadge')}</span>}
                    {a.is_guest && <span className="shrink-0 rounded bg-indigo-400/15 px-[0.5vw] py-[0.2vh] text-[1.2vh] font-medium uppercase tracking-wide text-indigo-200">{t('tvBoard.guestBadge')}{teamLabel(a) ? ` · ${teamLabel(a)}` : ''}</span>}
                    {!a.is_guest && a.is_extra && <span className="shrink-0 rounded bg-white/10 px-[0.5vw] py-[0.2vh] text-[1.2vh] font-medium uppercase tracking-wide text-slate-300">{t('tvBoard.extraBadge')}</span>}
                    {isToday && p?.state === 'idle' && (p.idle_streak_min ?? 0) > 0 && (
                      <span className="shrink-0 rounded bg-amber-400/15 px-[0.5vw] py-[0.2vh] text-[1.2vh] font-semibold text-amber-300">{t('tvBoard.idleFor', { n: p.idle_streak_min })}</span>
                    )}
                    {isToday && p?.state === 'break' && (
                      <span className="shrink-0 rounded bg-sky-400/15 px-[0.5vw] py-[0.2vh] text-[1.2vh] font-semibold text-sky-300">{t('tvBoard.stateBreak')}</span>
                    )}
                  </div>
                  {/* Sales / Confirmed (net) — returns shown beside it on past days */}
                  <div className="text-center font-bold tabular-nums">
                    {a.confirmed_count}
                    {(a.returned ?? 0) + (a.lost ?? 0) > 0 && (
                      <span className="ml-[0.3vw] text-[0.5em] font-medium text-rose-300" title={t('tvBoard.reversedHint')}>−{(a.returned ?? 0) + (a.lost ?? 0)}</span>
                    )}
                  </div>
                  {/* Revenue (prediction) / Avg order (pending) */}
                  <div className="text-center font-semibold tabular-nums">{formatMoney(isPred ? a.revenue : a.avg_order_value)}</div>
                  {/* Conversion (pending only) */}
                  {!isPred && <div className="text-center font-semibold tabular-nums">{conv == null ? '—' : `${conv.toFixed(1)}%`}</div>}
                  {/* Worked */}
                  <div className="text-center tabular-nums text-slate-200">{a.worked ?? '—'}</div>
                  {/* Time on the CRM / last decision */}
                  {timeCell(a)}
                  {/* First – last activity */}
                  <div className="text-center text-[0.62em] tabular-nums text-slate-300">{shiftText(a)}</div>
                  {/* Bonus */}
                  <div className="text-right">
                    <span className={`inline-block rounded-lg px-[0.8vw] py-[0.3vh] font-bold tabular-nums ${a.bonus > 0 ? 'bg-emerald-400/15 text-emerald-300' : a.bonus < 0 ? 'bg-rose-500/15 text-rose-300' : 'bg-white/5 text-slate-400'}`}
                      style={{ fontSize: `${fontVh * 0.85}vh` }}>
                      {a.bonus > 0 ? formatMoney(a.bonus) : a.bonus < 0 ? `−${formatMoney(Math.abs(a.bonus))}` : formatMoney(0)}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
