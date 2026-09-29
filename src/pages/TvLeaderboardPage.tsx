// Full-screen, always-on wall-board for the office TV. No login or app chrome:
// the access token rides in the URL (?key=...) and is validated server-side.
//
// v2 (owner, 28–29.09.2026): ONE board, one row per agent, the day split over
// the six departments — "how much she made that day, in which department, from
// her own orders". Every row: rank (non-managers with a total), name, team
// badge, one chip per department she sold in ("Aff. out 3 · 9.000 ден"), the
// collabBox bookings still waiting for a parcel ("+5 чекаат пратка"), the total,
// the day's work and conversion, and the time on the CRM. Managers are listed
// after everyone else, never ranked. Filters: all / a department / a team
// (?dept= and ?team= pin them per TV; an old ?mode= URL opens its team).
// Data: GET /api/leaderboard?v=2 (leaderboard_day_v2, migration 20260942001200).
// Today updates live (~1s) via the Supabase Realtime broadcast `tv-leaderboard`,
// with a 20 s polling fallback; a day switcher reviews previous days.
// Every screen (owner, 29.09.2026): from 1024 px wide (lg) it is the wall board —
// vh sizes, one grid row per person, the page never scrolls and pages itself.
// Below that (phones, tablets) the same facts become a scrolling list of cards
// (TvBoardCard), a two-line header, KPI tiles two / three per row and filter rows
// that scroll sideways — nothing is cut or squeezed.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ChevronLeft, ChevronRight, Trophy, Maximize2, Minimize2 } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import i18n, { SUPPORTED_LANGUAGES } from '@/i18n';
import { formatDate } from '@/i18n/dates';
import { formatDenari } from '@/lib/currency';
import {
  apiGetLeaderboardV2, deptKey, initialFilter, splitManagers, type BoardFilter, type BoardV2,
} from '@/lib/leaderboardV2';
import { Confetti, StatCard } from '@/components/tvboard/TvBoardParts';
import { TvBoardFilters } from '@/components/tvboard/TvBoardFilters';
import { TV_GRID, teamLabel } from '@/components/tvboard/tvBoardHelpers';
import { TvBoardRow } from '@/components/tvboard/TvBoardRow';
import { TvBoardCard } from '@/components/tvboard/TvBoardCard';
import { TvWebLive } from '@/components/tvboard/TvWebLive';

// The vendor-prefixed fullscreen API (Safari / older TV browsers) and the wake lock.
type FsDocument = Document & { webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => Promise<void> | void };
type FsElement = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };
type WakeLockSentinelLike = { release?: () => Promise<void> | void };
type WakeLockNavigator = Navigator & { wakeLock?: { request: (type: 'screen') => Promise<WakeLockSentinelLike> } };

const POLL_MS = 20_000;
const REFETCH_DEBOUNCE_MS = 1_000;
const CELEBRATE_MS = 4_500;
const SCROLL_EVERY_MS = 9_000;

const addDays = (ymd: string, delta: number) => {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + delta)).toISOString().slice(0, 10);
};

/** Below Tailwind's `lg` (1024 px): the card layout. Kept in step with the `lg:` classes. */
const COMPACT_QUERY = '(max-width: 1023px)';
function useCompactBoard() {
  const read = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia(COMPACT_QUERY).matches;
  const [compact, setCompact] = useState(read);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia(COMPACT_QUERY);
    const onChange = () => setCompact(mql.matches);
    onChange();
    mql.addEventListener?.('change', onChange);
    return () => mql.removeEventListener?.('change', onChange);
  }, []);
  return compact;
}

// Module-level, so it reaches for the i18n singleton directly. The page itself
// subscribes via useTranslation(), so a language switch re-renders and re-calls it.
function dayLabel(day: string, offset: number) {
  if (offset === 0) return i18n.t('tvBoard.today');
  if (offset === 1) return i18n.t('tvBoard.yesterday');
  const [y, m, d] = day.split('-').map(Number);
  // Local midnight (not UTC) so the weekday never slips a day on a TV west of UTC.
  return formatDate(new Date(y, m - 1, d), 'EEE d MMM');
}

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

  // The filter is seeded from the URL (so a TV can be pinned) and changeable on screen.
  const [filter, setFilter] = useState<BoardFilter>(() => initialFilter(params));
  const [data, setData] = useState<BoardV2 | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [offset, setOffset] = useState(0); // 0 = today, 1 = yesterday, ...
  const [now, setNow] = useState(() => new Date());
  const [celebrate, setCelebrate] = useState<{ agentId: string; at: number } | null>(null);
  const [isFs, setIsFs] = useState(false);
  const [cursorHidden, setCursorHidden] = useState(false);
  const compact = useCompactBoard();

  const toggleFullscreen = useCallback(() => {
    const el = document.documentElement as FsElement;
    const doc = document as FsDocument;
    if (!doc.fullscreenElement && !doc.webkitFullscreenElement) {
      (el.requestFullscreen || el.webkitRequestFullscreen)?.call(el);
    } else {
      (doc.exitFullscreen || doc.webkitExitFullscreen)?.call(doc);
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
      const res = await apiGetLeaderboardV2(key, { day: reqDay, ...filter });
      anchorRef.current = res.today;
      setData(res);
      setError(null);
    } catch (e) {
      setError((e instanceof Error && e.message) || i18n.t('tvBoard.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [key, filter]);

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

  // Load on key / filter / offset change.
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
    const onFs = () => setIsFs(!!(document.fullscreenElement || (document as FsDocument).webkitFullscreenElement));
    document.addEventListener('fullscreenchange', onFs);
    document.addEventListener('webkitfullscreenchange', onFs);
    return () => { document.removeEventListener('fullscreenchange', onFs); document.removeEventListener('webkitfullscreenchange', onFs); };
  }, []);

  // Hide the cursor after 3s idle (clean wall display); show it on mouse move so
  // the buttons stay clickable.
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
      .on('broadcast', { event: 'confirmed' }, ({ payload }: { payload?: { agent_id?: string } }) => { triggerCelebrate(payload?.agent_id); scheduleRefetch(); })
      .on('broadcast', { event: 'refresh' }, () => scheduleRefetch())
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [offset, scheduleRefetch, triggerCelebrate]);

  // Keep the TV awake.
  useEffect(() => {
    let lock: WakeLockSentinelLike | null = null;
    const req = async () => { try { lock = (await (navigator as WakeLockNavigator).wakeLock?.request('screen')) ?? null; } catch { /* ignore */ } };
    void req();
    const onVis = () => { if (document.visibilityState === 'visible') void req(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { document.removeEventListener('visibilitychange', onVis); try { lock?.release?.(); } catch { /* ignore */ } };
  }, []);

  // More people than fit: page through them every few seconds (a wall screen
  // has no one to scroll it). Programmatic scroll works under overflow:hidden.
  // A phone scrolls the page itself — no paging there.
  useEffect(() => {
    if (compact) return;
    const id = window.setInterval(() => {
      const el = scrollRef.current;
      if (!el) return;
      const max = el.scrollHeight - el.clientHeight;
      if (max <= 4) { if (el.scrollTop) el.scrollTop = 0; return; }
      const next = el.scrollTop >= max - 2 ? 0 : Math.min(max, el.scrollTop + el.clientHeight * 0.8);
      el.scrollTo({ top: next, behavior: 'smooth' });
    }, SCROLL_EVERY_MS);
    return () => window.clearInterval(id);
  }, [compact]);

  const isToday = offset === 0;
  const rows = useMemo(() => data?.rows ?? [], [data]);
  const { people, managers } = useMemo(() => splitManagers(rows), [rows]);
  const s = data?.summary ?? {};
  const money = data?.money !== false;
  const dept = data?.legacy ? data.filter.department : filter.department;
  const n = (k: string) => Number(s[k] ?? 0) || 0;
  // The web shop has no agents: with the Web filter the board shows the shop itself (TvWebLive).
  // An api without the web view (web_live absent) keeps the people view.
  const webView = dept === 'web' && data != null && data.web_live !== undefined;

  // Row height follows the head count so a normal day fits without paging.
  const rowVh = Math.max(3.6, Math.min(6.2, 58 / Math.max(1, rows.length + (managers.length ? 1 : 0))));
  const fontVh = Math.min(3, Math.max(1.75, rowVh * 0.5));

  const presenceTile = () => {
    if (!isToday) {
      return <StatCard label={t('tvBoard.wereOnline')} value={String(n('was_online'))} sub={t('tvBoard.peopleSub', { n: n('people') })} />;
    }
    const sub = [
      t('tvBoard.presenceSub', { idle: n('idle'), brk: n('on_break'), off: n('offline') }),
      n('no_login') > 0 ? t('leaderboard2.noLoginSub', { n: n('no_login') }) : '',
    ].filter(Boolean).join(' · ');
    return <StatCard label={t('tvBoard.onlineNow')} value={`${n('online_now')}/${n('people')}`} sub={sub} />;
  };

  const worked = n('worked');
  const convAll = worked > 0 ? (n('sale_decisions') / worked) * 100 : null;
  const label = data ? dayLabel(data.day, offset) : '';
  const viewLabel = [
    dept ? t(`leaderboard2.dept.${deptKey(dept)}`) : t('leaderboard2.allDepartments'),
    filter.team ? teamLabel(t, filter.team, data?.teams.find((x) => x.key === filter.team)?.name) : '',
  ].filter(Boolean).join(' · ');

  return (
    <div className={`relative flex min-h-[100dvh] w-full flex-col bg-gradient-to-b from-slate-950 to-slate-900 px-3 py-3 font-sans text-slate-100 sm:px-4 lg:h-screen lg:min-h-0 lg:w-screen lg:overflow-hidden lg:px-[2.2vw] lg:py-[2vh] ${cursorHidden ? 'cursor-none' : ''}`}>
      <style>{`@keyframes tv-fall{0%{transform:translateY(-12vh)}100%{transform:translateY(112vh)}}
        @keyframes tv-glow{0%,100%{background-color:rgba(52,211,153,0)}40%{background-color:rgba(52,211,153,0.16)}}`}</style>

      {celebrate && isToday && <Confetti />}

      {/* Header — phone: title + clock on top, the day switcher across the second row */}
      <header className="mb-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-2 lg:mb-[1.4vh] lg:flex-nowrap lg:gap-[1vw]">
        <div className="order-1 flex min-w-0 flex-1 items-center gap-2.5 lg:order-none lg:flex-initial lg:gap-[1.2vw]">
          <Trophy className="h-7 w-7 shrink-0 text-amber-300 lg:h-[4vh] lg:w-[4vh]" />
          <div className="min-w-0">
            <h1 className="text-xl font-bold leading-tight tracking-tight lg:truncate lg:text-[3vh] lg:leading-none">{t('leaderboard2.title')}</h1>
            <div className="mt-0.5 flex items-center gap-2 text-xs text-slate-400 lg:mt-[0.6vh] lg:truncate lg:text-[1.6vh]">
              {isToday && <span className="inline-block h-2 w-2 shrink-0 animate-pulse rounded-full bg-emerald-400" />}
              <span className="lg:truncate">
                {viewLabel} · {isToday ? t('tvBoard.live') : t('tvBoard.history')} ·{' '}
                {t('tvBoard.updated', { time: data ? new Date(data.generated_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '—' })}
              </span>
            </div>
          </div>
        </div>

        {/* Day switcher */}
        <div className="order-3 flex w-full items-center justify-between gap-2 lg:order-none lg:w-auto lg:shrink-0 lg:justify-center lg:gap-[0.8vw]">
          <button type="button" onClick={() => setOffset((o) => o + 1)} aria-label={t('leaderboard2.prevDay')}
            className="rounded-lg border border-white/10 bg-white/5 p-2 text-slate-200 transition hover:bg-white/10 lg:p-[1vh]">
            <ChevronLeft className="h-5 w-5 lg:h-[2.6vh] lg:w-[2.6vh]" />
          </button>
          <div className="flex-1 text-center lg:min-w-[12vw] lg:flex-none">
            <div className="text-base font-semibold leading-none lg:text-[2.6vh]">{label}</div>
            <div className="mt-1 text-xs text-slate-400 lg:mt-[0.5vh] lg:text-[1.5vh]">{data?.day || ''}</div>
          </div>
          <button type="button" onClick={() => setOffset((o) => Math.max(0, o - 1))} disabled={isToday} aria-label={t('leaderboard2.nextDay')}
            className="rounded-lg border border-white/10 bg-white/5 p-2 text-slate-200 transition hover:bg-white/10 disabled:opacity-30 lg:p-[1vh]">
            <ChevronRight className="h-5 w-5 lg:h-[2.6vh] lg:w-[2.6vh]" />
          </button>
        </div>

        <div className="order-2 flex shrink-0 items-center gap-2 lg:order-none lg:gap-[1vw]">
          <div className="text-2xl font-bold leading-none tabular-nums lg:text-[4.4vh]">{now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</div>
          <button type="button" onClick={toggleFullscreen} title={isFs ? t('tvBoard.exitFullscreen') : t('tvBoard.fullscreen')}
            className="rounded-lg border border-white/10 bg-white/5 p-2 text-slate-300 transition hover:bg-white/10 lg:p-[1vh]">
            {isFs ? <Minimize2 className="h-5 w-5 lg:h-[2.6vh] lg:w-[2.6vh]" /> : <Maximize2 className="h-5 w-5 lg:h-[2.6vh] lg:w-[2.6vh]" />}
          </button>
        </div>
      </header>

      {/* Filters */}
      <div className="mb-3 lg:mb-[1.4vh]">
        <TvBoardFilters filter={filter} teams={data?.teams ?? []} onChange={(f) => { setFilter(f); }} />
        {data?.legacy && <div className="mt-2 text-xs text-amber-300 lg:mt-[0.8vh] lg:text-[1.4vh]">{t('leaderboard2.legacyApi')}</div>}
      </div>

      {/* The web view: the shop's own day instead of the (empty) agent list */}
      {webView && !loading && !error && (
        <TvWebLive web={data?.web_live ?? null} money={money} isToday={isToday} now={now} />
      )}

      {/* KPI strip — phone 2 per row, small tablet 3, wall screen 5 */}
      {!webView && (
      <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:mb-[1.6vh] lg:grid-cols-5 lg:gap-[1vw]">
        {presenceTile()}
        <StatCard label={t('leaderboard2.kpiSales')} value={String(n('total_count'))}
          sub={t('leaderboard2.kpiSalesSub', { orders: n('sales'), booked: n('booked') })} />
        <StatCard label={t('leaderboard2.kpiValue')} value={money ? formatDenari(n('total_value_mkd')) : '—'}
          sub={n('cancelled_after_sale') > 0 ? t('leaderboard2.kpiCancelledSub', { n: n('cancelled_after_sale') }) : undefined} />
        <StatCard label={t('tvBoard.colWorked')} value={String(worked)}
          sub={convAll == null ? undefined : t('leaderboard2.kpiConvSub', { pct: convAll.toFixed(1) })} />
        <StatCard label={t('leaderboard2.kpiNoSeller')} className="col-span-2 sm:col-span-1"
          value={money && n('no_seller') > 0 ? `${n('no_seller')} · ${formatDenari(n('no_seller_value_mkd'))}` : String(n('no_seller'))}
          sub={n('booked_no_person') > 0 ? t('leaderboard2.kpiNoSellerBooked', { n: n('booked_no_person') }) : t('leaderboard2.kpiNoSellerSub')} />
      </div>
      )}

      {/* States */}
      {loading && <div className="mt-10 text-center text-base text-slate-400 lg:mt-[18vh] lg:text-[2.6vh]">{t('common.loading')}</div>}
      {!loading && error && (
        <div className="mt-10 text-center text-base text-rose-400 lg:mt-[18vh] lg:text-[2.6vh]">
          {error === 'Unauthorized' ? t('tvBoard.invalidKey') : error}
        </div>
      )}
      {!loading && !error && !webView && rows.length === 0 && (
        <div className="mt-10 text-center text-base text-slate-400 lg:mt-[18vh] lg:text-[2.6vh]">{t('leaderboard2.noPeople')}</div>
      )}

      {/* Phone / tablet: one card per person, the page scrolls */}
      {!loading && !error && !webView && rows.length > 0 && compact && (
        <div className="flex flex-col gap-2 pb-2">
          {people.map((r) => (
            <TvBoardCard key={r.person_id} row={r} department={dept} money={money} isToday={isToday} now={now}
              glow={!!r.user_id && isToday && celebrate?.agentId === r.user_id} />
          ))}
          {managers.length > 0 && (
            <>
              <div className="mt-2 px-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-400">
                {t('leaderboard2.managersHeading')}
              </div>
              {managers.map((r) => (
                <TvBoardCard key={r.person_id} row={r} department={dept} money={money} isToday={isToday} now={now}
                  glow={!!r.user_id && isToday && celebrate?.agentId === r.user_id} />
              ))}
            </>
          )}
        </div>
      )}

      {/* Wall screen: the table */}
      {!loading && !error && !webView && rows.length > 0 && !compact && (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-white/10 bg-white/[0.02]">
          <div className={`grid ${TV_GRID} shrink-0 items-center px-[1.6vw] py-[1.1vh] text-[1.4vh] font-semibold uppercase tracking-[0.1em] text-slate-400`}>
            <div>#</div>
            <div>{t('tvBoard.colAgent')}</div>
            <div>{t('leaderboard2.colDepartments')}</div>
            <div className="text-right">{t('leaderboard2.colTotal')}</div>
            <div className="text-center">{t('tvBoard.colWorked')}</div>
            <div>{t('tvBoard.colTime')}</div>
          </div>
          <div ref={scrollRef} className="min-h-0 flex-1 overflow-hidden">
            {people.map((r, idx) => (
              <TvBoardRow key={r.person_id} row={r} idx={idx} department={dept} money={money} rowVh={rowVh} fontVh={fontVh}
                isToday={isToday} now={now} glow={!!r.user_id && isToday && celebrate?.agentId === r.user_id} />
            ))}
            {managers.length > 0 && (
              <>
                <div className="border-t border-white/10 bg-white/[0.03] px-[1.6vw] py-[0.8vh] text-[1.4vh] font-semibold uppercase tracking-[0.12em] text-slate-400">
                  {t('leaderboard2.managersHeading')}
                </div>
                {managers.map((r, idx) => (
                  <TvBoardRow key={r.person_id} row={r} idx={idx} department={dept} money={money} rowVh={rowVh} fontVh={fontVh}
                    isToday={isToday} now={now} glow={!!r.user_id && isToday && celebrate?.agentId === r.user_id} />
                ))}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
