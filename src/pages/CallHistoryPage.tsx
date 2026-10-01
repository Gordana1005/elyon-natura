import { useState, useEffect, useCallback, Fragment } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '@/i18n';
import { useQuery } from '@tanstack/react-query';
import { Search, Filter, ChevronLeft, ChevronRight, FileText, ShoppingCart, Clock, ChevronDown, ChevronUp, Play, Download, Loader2, Mic, CheckCheck } from 'lucide-react';
import { SmartPagination } from '@/components/SmartPagination';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';
import { format } from 'date-fns';
import { formatSkopje } from '@/lib/skopjeTime';
import { useAuth } from '@/contexts/AuthContext';
import { usePermissions } from '@/contexts/PermissionsContext';
import { STATUS_COLORS as ORDER_STATUS_COLORS, statusLabel } from '@/types';
import { apiGetCallHistory, apiGetAgents, apiGetRecordingAudioUrl } from '@/lib/api';
import { useListenedMark } from '@/hooks/useListenedMark';
import { AppLayout } from '@/layouts/AppLayout';
import { cn } from '@/lib/utils';
import { formatMoney } from '@/lib/currency';
import { EmptyState } from '@/components/EmptyState';
import { MobileCard, MobileCardHeader, MobileCardField, MobileCardActions } from '@/components/ui/mobile-card';
import { useIsMobile } from '@/hooks/use-mobile';
import { predictionListLabel } from '@/lib/predictionListLabel';

// The Result filter offers EVERY value the Result column can display, so "what
// you filter == what you see". These are the canonical result tokens computed by
// the call_logs_with_result DB view (and mirrored by resultMeta() below) — the
// server filters on the exact same token. Order: order-resolution states first,
// then call-only outcomes.
const RESULT_FILTERS: string[] = [
  'confirmed', 'paid', 'shipped', 'delivered', 'returned',
  'cancelled', 'trash', 'no_answer', 'call_again', 'answered',
];

// Where the row came from (order/lead context, a brand-new "Direct" topbar dial,
// or a recording with no saved call log).
// Labels via i18n: callHist.source* / ordersPage.sourceLead
const sourceLabel = (s: string): string => ({
  order: i18n.t('callHist.sourceOrder'),
  prediction_lead: i18n.t('ordersPage.sourceLead'),
  standalone: i18n.t('callHist.sourceDirect'),
  recording: i18n.t('callHist.sourceRecording'),
}[s] || i18n.t('callHist.sourceOrder'));

// Order statuses from the canonical palette; lead-status keys added on top.
const STATUS_COLORS: Record<string, string> = {
  ...ORDER_STATUS_COLORS,
  not_contacted: 'bg-gray-400 text-white border-gray-400',
  no_answer: 'bg-amber-500 text-white border-amber-500',
  interested: 'bg-sky-500 text-white border-sky-500',
  not_interested: 'bg-rose-500 text-white border-rose-500',
};

// Order statuses that represent a real resolution — once an order reaches one of
// these, that IS what the call turned into, so we show the order status itself
// (a follow-up call to a Shipped order reads "Shipped" and is never flipped).
const RESOLVED_STATUSES = new Set(['confirmed', 'cancelled', 'trashed', 'shipped', 'delivered', 'paid', 'returned']);

// The single "Result" — what the call turned into. Merges the old Outcome +
// Status columns into one honest answer:
//   • recording with no log        → Untracked
//   • the call wasn't answered      → No Answer (wins over any order status)
//   • the order reached a result    → that order status (Confirmed/Shipped/…)
//   • otherwise                     → the call outcome, consolidated
//       (not_interested→Cancelled, wrong_number→Trash, interested/answered→Answered)
function getResult(log: any): { label: string; className: string } {
  const outcome: string | null = log.outcome;
  const status: string | null = log.order_status;
  const NEUTRAL = 'bg-slate-200 text-slate-700 border-slate-300';
  const MUTED = 'bg-muted text-muted-foreground border-border';

  if (log.source === 'recording') return { label: i18n.t('callHist.untracked'), className: MUTED };
  if (outcome === 'no_answer') return { label: i18n.t('outcome.no_answer'), className: STATUS_COLORS.no_answer };
  if (status && RESOLVED_STATUSES.has(status)) {
    return { label: statusLabel(status), className: STATUS_COLORS[status] || MUTED };
  }
  switch (outcome) {
    case 'confirmed': return { label: i18n.t('outcome.confirmed'), className: STATUS_COLORS.confirmed };
    case 'cancelled':
    case 'not_interested': return { label: i18n.t('outcome.cancelled'), className: STATUS_COLORS.cancelled };
    case 'trash':
    case 'wrong_number': return { label: i18n.t('outcome.trash'), className: STATUS_COLORS.trashed };
    case 'call_again': return { label: i18n.t('outcome.call_again'), className: STATUS_COLORS.call_again };
    case 'answered':
    case 'interested': return { label: i18n.t('outcome.answered'), className: NEUTRAL };
    default: return { label: '—', className: MUTED };
  }
}

// Render a canonical `result` token (from the server / call_logs_with_result
// view) to a label + colour. This is the single source of truth shared with the
// filter dropdown — every token here is a filterable value. Kept in lock-step
// with the view's CASE and with getResult above (the legacy fallback).
function resultMeta(result: string): { label: string; className: string } {
  const NEUTRAL = 'bg-slate-200 text-slate-700 border-slate-300';
  const MUTED = 'bg-muted text-muted-foreground border-border';
  switch (result) {
    case 'untracked': return { label: i18n.t('callHist.untracked'), className: MUTED };
    case 'no_answer': return { label: i18n.t('outcome.no_answer'), className: STATUS_COLORS.no_answer };
    case 'confirmed': return { label: statusLabel('confirmed'), className: STATUS_COLORS.confirmed };
    case 'cancelled': return { label: statusLabel('cancelled'), className: STATUS_COLORS.cancelled };
    case 'trash': return { label: i18n.t('outcome.trash'), className: STATUS_COLORS.trashed };
    case 'shipped': return { label: statusLabel('shipped'), className: STATUS_COLORS.shipped };
    case 'delivered': return { label: statusLabel('delivered'), className: STATUS_COLORS.delivered };
    case 'paid': return { label: statusLabel('paid'), className: STATUS_COLORS.paid };
    case 'returned': return { label: statusLabel('returned'), className: STATUS_COLORS.returned };
    case 'call_again': return { label: i18n.t('outcome.call_again'), className: STATUS_COLORS.call_again };
    case 'answered': return { label: i18n.t('outcome.answered'), className: NEUTRAL };
    default: return { label: '—', className: MUTED };
  }
}
const resultLabel = (v: string): string => resultMeta(v).label;

// Prefer the server's canonical result; fall back to the legacy client merge for
// any row that predates it (e.g. a stale cache).
const rowResult = (log: any): { label: string; className: string } =>
  log.result ? resultMeta(log.result) : getResult(log);

// Recordings are purged from the PBX after ~30 days (no permanent archival).
const RETENTION_DAYS = 30;
// An answered call older than retention with no recording link: the audio is
// gone, not "never recorded" — say so honestly.
function recordingExpired(log: any): boolean {
  if (log.recording_file || log.source === 'recording') return false;
  const answered = !!log.connected_at || (log.talk_seconds ?? 0) > 0;
  if (!answered) return false;
  const ageDays = (Date.now() - new Date(log.created_at).getTime()) / (24 * 3600 * 1000);
  return ageDays > RETENTION_DAYS;
}

// Human duration mm:ss from the stored telemetry (talk time preferred, else
// the whole-call total). Returns '—' when there's no usable telemetry.
function formatDuration(sec?: number | null): string {
  if (!sec || sec <= 0) return '—';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export default function CallHistoryPage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const { canSeePrivacy } = usePermissions();
  // canHear: may play recordings (hear-all roles OR own-scoped agents — the list
  // is already scoped to the agent's own calls server-side, and the audio
  // endpoint re-verifies ownership). canDownload: only hear-all roles
  // (admin/manager/inbound_agent); own-scoped agents are listen-only in the CRM.
  const canHear = canSeePrivacy('can_hear_recordings') || canSeePrivacy('can_hear_own_recordings');
  const canDownload = canSeePrivacy('can_hear_recordings');
  const isAdmin = user?.isAdmin || user?.isManager;
  const isMobile = useIsMobile();

  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [agentFilter, setAgentFilter] = useState('all');
  const [resultFilter, setResultFilter] = useState('all');
  const [sourceFilter, setSourceFilter] = useState('all');
  const [dateFrom, setDateFrom] = useState<Date | undefined>();
  const [dateTo, setDateTo] = useState<Date | undefined>();
  const [page, setPage] = useState(1);
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
  const [audioUrls, setAudioUrls] = useState<Record<string, string>>({});
  const [loadingAudio, setLoadingAudio] = useState<Record<string, boolean>>({});
  const limit = 25;

  // Team-wide "reviewed" mark: >=10s of real playback by a hear-all role sets
  // it (server-side, first listener wins). locallyListened makes the ✓✓ appear
  // immediately without a refetch.
  const [locallyListened, setLocallyListened] = useState<Set<string>>(new Set());
  const onMarked = useCallback((id: string) => {
    setLocallyListened((prev) => new Set(prev).add(id));
  }, []);
  const trackListen = useListenedMark(canDownload, onMarked);
  const isListened = (log: any) => !!log.listened_at || locallyListened.has(log.id);
  const listenedTitle = (log: any) =>
    log.listened_by_name
      ? t('orderCalls.listenedBy', { name: log.listened_by_name, date: log.listened_at ? formatSkopje(log.listened_at, 'dd/MM/yy HH:mm') : '' })
      : t('orderCalls.listened');

  // Recordings stream on demand from the PBX via a short-lived signed URL.
  const loadAudio = async (file: string): Promise<string | null> => {
    if (audioUrls[file]) return audioUrls[file];
    setLoadingAudio((p) => ({ ...p, [file]: true }));
    try {
      const { url } = await apiGetRecordingAudioUrl(file);
      setAudioUrls((p) => ({ ...p, [file]: url }));
      return url;
    } catch {
      return null;
    } finally {
      setLoadingAudio((p) => ({ ...p, [file]: false }));
    }
  };

  const playRecording = (id: string, file: string) => {
    setExpandedRows((prev) => { const next = new Set(prev); next.add(id); return next; });
    void loadAudio(file);
  };

  const downloadRecording = async (file: string) => {
    const url = await loadAudio(file);
    if (!url) return;
    const a = document.createElement('a');
    a.href = url; a.download = file.split('/').pop() || 'recording.wav';
    document.body.appendChild(a); a.click(); a.remove();
  };

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 400);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => { setPage(1); }, [debouncedSearch, agentFilter, resultFilter, sourceFilter, dateFrom, dateTo]);

  const { data: agentsData } = useQuery({
    queryKey: ['agents'],
    queryFn: apiGetAgents,
    enabled: !!isAdmin,
  });

  const { data, isLoading } = useQuery({
    queryKey: ['call-history', debouncedSearch, agentFilter, resultFilter, sourceFilter, dateFrom, dateTo, page],
    queryFn: () => apiGetCallHistory({
      search: debouncedSearch || undefined,
      agent_id: agentFilter !== 'all' ? agentFilter : undefined,
      result: resultFilter !== 'all' ? resultFilter : undefined,
      source: sourceFilter !== 'all' ? sourceFilter : undefined,
      // The picked calendar days, as Skopje days (the api turns them into that day's 00:00
      // and its last instant). An ISO of the pick was the browser's midnight, and `to` cut
      // off the whole picked day.
      from: dateFrom ? format(dateFrom, 'yyyy-MM-dd') : undefined,
      to: dateTo ? format(dateTo, 'yyyy-MM-dd') : undefined,
      page,
      limit,
    }),
  });

  // Roles without recording access (e.g. investor managers) still see the call
  // list but no playback — strip the recording link so every Play/Download/audio
  // control below simply disappears.
  const logs = (data?.logs || []).map((l: any) => (canHear ? l : { ...l, recording_file: null }));
  const total = data?.total || 0;
  const totalPages = Math.ceil(total / limit);

  const toggleRow = (id: string) => {
    setExpandedRows(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  return (
    <AppLayout title={t('nav.callHistory')}>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-foreground">{t('nav.callHistory')}</h1>
            <p className="text-sm text-muted-foreground">{total} call records · recordings play inline</p>
          </div>
        </div>

        {/* Filters */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[200px] max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder={t('callHist.searchPlaceholder')}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9"
            />
          </div>

          {isAdmin && (
            <Select value={agentFilter} onValueChange={setAgentFilter}>
              <SelectTrigger className="w-[180px]"><SelectValue placeholder={t('search.colAgent')} /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('dashboard.allAgents')}</SelectItem>
                {(agentsData || []).map((a: any) => (
                  <SelectItem key={a.user_id} value={a.user_id}>{a.full_name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}

          <Select value={resultFilter} onValueChange={setResultFilter}>
            <SelectTrigger className="w-[160px]"><SelectValue placeholder={t('callHist.colResult')} /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('callHist.allResults')}</SelectItem>
              {RESULT_FILTERS.map((o) => (
                <SelectItem key={o} value={o}>{resultLabel(o)}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={sourceFilter} onValueChange={setSourceFilter}>
            <SelectTrigger className="w-[160px]"><SelectValue placeholder={t('ordersPage.colSource')} /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('callHist.allSources')}</SelectItem>
              <SelectItem value="order">{t('callHist.standardOrder')}</SelectItem>
              <SelectItem value="prediction_lead">{t('callHist.predictionLead')}</SelectItem>
            </SelectContent>
          </Select>

          <Popover>
            <PopoverTrigger asChild>
              <Button variant="outline" size="sm" className="gap-1.5">
                <Filter className="h-3.5 w-3.5" />
                {dateFrom ? format(dateFrom, 'MMM d') : 'From'}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0" align="start">
              <Calendar mode="single" selected={dateFrom} onSelect={setDateFrom} />
            </PopoverContent>
          </Popover>

          <Popover>
            <PopoverTrigger asChild>
              <Button variant="outline" size="sm" className="gap-1.5">
                <Filter className="h-3.5 w-3.5" />
                {dateTo ? format(dateTo, 'MMM d') : 'To'}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0" align="start">
              <Calendar mode="single" selected={dateTo} onSelect={setDateTo} />
            </PopoverContent>
          </Popover>

          {(dateFrom || dateTo || agentFilter !== 'all' || resultFilter !== 'all' || sourceFilter !== 'all') && (
            <Button variant="ghost" size="sm" onClick={() => {
              setDateFrom(undefined);
              setDateTo(undefined);
              setAgentFilter('all');
              setResultFilter('all');
              setSourceFilter('all');
            }}>{t('common.clear')}</Button>
          )}
        </div>

        {/* Table — desktop (only mounted on desktop so its autoplay audio can't keep playing under the mobile card) */}
        {!isMobile && (
        <div className="rounded-lg border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[30px]"></TableHead>
                <TableHead>{t('callHist.colDateTime')}</TableHead>
                <TableHead>{t('ordersPage.colCustomer')}</TableHead>
                <TableHead>{t('search.phone')}</TableHead>
                <TableHead>{t('search.colAgent')}</TableHead>
                <TableHead>{t('callHist.colResult')}</TableHead>
                <TableHead>{t('ordersPage.colSource')}</TableHead>
                <TableHead>{t('search.colProducts')}</TableHead>
                <TableHead className="text-right">{t('createOrder.total')}</TableHead>
                <TableHead className="text-right">{t('callHist.colDuration')}</TableHead>
                <TableHead className="text-right pr-4">{t('callHist.colRecording')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow><TableCell colSpan={11} className="text-center py-8 text-muted-foreground">{t('common.loading')}</TableCell></TableRow>
              ) : logs.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={11} className="p-0">
                    <EmptyState
                      icon={<Clock className="h-5 w-5" />}
                      title={t('callHist.noRecords')}
                      description={t('callHist.noRecordsDesc')}
                      size="sm"
                      className="border-0 bg-transparent hover:shadow-none"
                    />
                  </TableCell>
                </TableRow>
              ) : logs.map((log: any) => {
                const isExpanded = expandedRows.has(log.id);
                return (
                  <Fragment key={log.id}>
                  <TableRow className="group">
                    <TableCell className="px-2">
                      <button onClick={() => toggleRow(log.id)} className="p-0.5 rounded hover:bg-muted transition-colors">
                        {isExpanded ? <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />}
                      </button>
                    </TableCell>
                    <TableCell className="text-sm whitespace-nowrap">
                      {formatSkopje(log.created_at, 'dd/MM/yyyy')}<br />
                      <span className="text-xs text-muted-foreground">{formatSkopje(log.created_at, 'HH:mm')}</span>
                    </TableCell>
                    <TableCell>
                      <div>
                        <span className="font-medium text-sm">{log.customer_name || '—'}</span>
                        {log.customer_city && (
                          <span className="block text-[11px] text-muted-foreground">{log.customer_city}</span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="font-mono text-xs">{log.customer_phone || '—'}</TableCell>
                    <TableCell className="text-sm">{log.agent_name}</TableCell>
                    <TableCell>
                      {(() => {
                        const r = rowResult(log);
                        return (
                          <span className={cn('text-[11px] px-2 py-0.5 rounded-full font-medium whitespace-nowrap', r.className)}>
                            {r.label}
                          </span>
                        );
                      })()}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="text-xs">
                        {sourceLabel(log.source)}
                      </Badge>
                      {log.display_id && log.display_id !== '—' && (
                        <span className="block text-[10px] font-mono text-muted-foreground mt-0.5">{log.display_id}</span>
                      )}
                    </TableCell>
                    <TableCell className="max-w-[200px]">
                      <div className="text-xs whitespace-normal leading-relaxed">
                        {log.product_items?.length > 0 ? (
                          log.product_items.map((item: any, idx: number) => (
                            <span key={idx}>
                              {idx > 0 && <span className="text-muted-foreground">, </span>}
                              <span className="font-medium">{item.product_name}</span>
                              <span className="text-muted-foreground"> x{item.quantity}</span>
                            </span>
                          ))
                        ) : (
                          <span>{log.product_name || '—'}</span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs tabular-nums font-medium">
                      {log.total_price ? formatMoney(log.total_price) : <span className="text-muted-foreground">—</span>}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs tabular-nums">
                      {(() => {
                        const d = formatDuration(log.talk_seconds ?? log.total_seconds);
                        return d === '—'
                          ? <span className="text-muted-foreground">—</span>
                          : <span title={t('callHist.talkTime')}>{d}</span>;
                      })()}
                    </TableCell>
                    <TableCell className="text-right pr-4">
                      {log.recording_file ? (
                        <div className="inline-flex items-center gap-1.5">
                          {isListened(log) && (
                            <span title={listenedTitle(log)} className="inline-flex text-emerald-600">
                              <CheckCheck className="h-3.5 w-3.5" />
                            </span>
                          )}
                          <Button variant="outline" size="sm" onClick={() => playRecording(log.id, log.recording_file)} className="gap-1.5 h-7">
                            <Play className="h-3 w-3" /> Play
                          </Button>
                          {canDownload && (
                            <Button variant="ghost" size="sm" onClick={() => downloadRecording(log.recording_file)} className="h-7 px-2" title={t('callHist.download')}>
                              <Download className="h-3 w-3" />
                            </Button>
                          )}
                        </div>
                      ) : recordingExpired(log) ? (
                        <span className="text-muted-foreground text-[11px] italic" title={t('callHist.recordingExpiredHint')}>{t('callHist.recordingExpired')}</span>
                      ) : (
                        <span className="text-muted-foreground text-xs">—</span>
                      )}
                    </TableCell>
                  </TableRow>
                  {isExpanded && (
                    <TableRow className="hover:bg-transparent">
                      <TableCell colSpan={11} className="p-0">
                        <div className="border-t bg-muted/30 px-6 py-4 space-y-3">
              {log.recording_file && (
                <div>
                  <h4 className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5 flex items-center gap-1">
                    <Mic className="h-3 w-3" /> Recording
                  </h4>
                  {loadingAudio[log.recording_file] ? (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> {t('callHist.loadingAudio')}</div>
                  ) : audioUrls[log.recording_file] ? (
                    <audio controls autoPlay src={audioUrls[log.recording_file]} className="w-full max-w-2xl h-9" controlsList={canDownload ? undefined : 'nodownload'} onContextMenu={canDownload ? undefined : (e) => e.preventDefault()} onTimeUpdate={trackListen(log.id, isListened(log))} />
                  ) : (
                    <Button variant="outline" size="sm" onClick={() => loadAudio(log.recording_file)} className="gap-1.5 h-7"><Play className="h-3 w-3" /> Load recording</Button>
                  )}
                </div>
              )}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                <div>
                  <span className="text-[10px] uppercase tracking-wider text-muted-foreground block">{t('ordersPage.colCustomer')}</span>
                  <span className="font-medium">{log.customer_name || '—'}</span>
                </div>
                <div>
                  <span className="text-[10px] uppercase tracking-wider text-muted-foreground block">{t('search.phone')}</span>
                  <span className="font-mono text-xs">{log.customer_phone || '—'}</span>
                </div>
                <div>
                  <span className="text-[10px] uppercase tracking-wider text-muted-foreground block">{t('orderModal.city')}</span>
                  <span>{log.customer_city || '—'}</span>
                </div>
                <div>
                  <span className="text-[10px] uppercase tracking-wider text-muted-foreground block">{t('orderModal.address')}</span>
                  <span>{log.customer_address || '—'}</span>
                </div>
                <div>
                  <span className="text-[10px] uppercase tracking-wider text-muted-foreground block">{t('search.colAgent')}</span>
                  <span className="font-medium">{log.agent_name}</span>
                </div>
                <div>
                  <span className="text-[10px] uppercase tracking-wider text-muted-foreground block">{t('callHist.orderAgent')}</span>
                  <span>{log.order_agent || '—'}</span>
                </div>
                <div>
                  <span className="text-[10px] uppercase tracking-wider text-muted-foreground block">{t('ordersPage.colSource')}</span>
                  <span className="capitalize">{(log.order_source || log.source || '').replace(/_/g, ' ')}</span>
                  {log.list_name && <span className="block text-[11px] text-muted-foreground" title={log.list_name}>{predictionListLabel(log.list_name)}</span>}
                </div>
                <div>
                  <span className="text-[10px] uppercase tracking-wider text-muted-foreground block">{t('callHist.reference')}</span>
                  <span className="font-mono text-xs">{log.display_id}</span>
                </div>
                <div>
                  <span className="text-[10px] uppercase tracking-wider text-muted-foreground block">{t('callHist.talkTime')}</span>
                  <span className="font-mono text-xs">{formatDuration(log.talk_seconds)}</span>
                </div>
                <div>
                  <span className="text-[10px] uppercase tracking-wider text-muted-foreground block">{t('callHist.ringTime')}</span>
                  <span className="font-mono text-xs">{formatDuration(log.ring_seconds)}</span>
                </div>
                <div>
                  <span className="text-[10px] uppercase tracking-wider text-muted-foreground block">{t('createOrder.total')}</span>
                  <span className="font-mono text-xs">{formatDuration(log.total_seconds)}</span>
                </div>
                <div>
                  <span className="text-[10px] uppercase tracking-wider text-muted-foreground block">{t('callHist.ended')}</span>
                  <span className="text-xs">{log.ended_at ? formatSkopje(log.ended_at, 'dd/MM HH:mm') : '—'}</span>
                </div>
              </div>

              {/* Product Items Detail */}
              {log.product_items?.length > 0 && (
                <div>
                  <h4 className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5 flex items-center gap-1">
                    <ShoppingCart className="h-3 w-3" /> {t('callHist.productsCount', { n: log.product_items.length })}
                  </h4>
                  <div className="rounded-md border bg-card overflow-hidden">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b bg-muted/50">
                          <th className="text-left px-3 py-1.5 font-medium text-muted-foreground">{t('ordersPage.colProduct')}</th>
                          <th className="text-center px-3 py-1.5 font-medium text-muted-foreground">{t('ordersPage.colQty')}</th>
                          <th className="text-right px-3 py-1.5 font-medium text-muted-foreground">{t('insights.colUnitPrice')}</th>
                          <th className="text-right px-3 py-1.5 font-medium text-muted-foreground">{t('createOrder.total')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {log.product_items.map((item: any, idx: number) => (
                          <tr key={idx} className="border-b last:border-0">
                            <td className="px-3 py-1.5 font-medium">{item.product_name}</td>
                            <td className="px-3 py-1.5 text-center tabular-nums">{item.quantity}</td>
                            <td className="px-3 py-1.5 text-right tabular-nums font-mono">{formatMoney(item.price_per_unit)}</td>
                            <td className="px-3 py-1.5 text-right tabular-nums font-mono font-medium">{formatMoney(item.total_price)}</td>
                          </tr>
                        ))}
                        <tr className="bg-muted/30">
                          <td colSpan={3} className="px-3 py-1.5 text-right font-semibold">{t('createOrder.total')}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums font-mono font-bold text-primary">
                            {formatMoney(log.total_price || 0)}
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* Status History */}
              {log.status_history?.length > 0 && (
                <div>
                  <h4 className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5 flex items-center gap-1">
                    <Clock className="h-3 w-3" /> Status History
                  </h4>
                  <div className="space-y-1">
                    {log.status_history.map((h: any, idx: number) => (
                      <div key={idx} className="flex items-center gap-2 text-xs">
                        <span className="text-muted-foreground w-[100px] shrink-0">
                          {formatSkopje(h.changed_at, 'dd/MM/yy HH:mm')}
                        </span>
                        {h.from_status && (
                          <>
                            <span className={cn('px-1.5 py-0.5 rounded text-[10px] font-medium', STATUS_COLORS[h.from_status] || 'bg-muted')}>
                              {h.from_status}
                            </span>
                            <span className="text-muted-foreground">→</span>
                          </>
                        )}
                        <span className={cn('px-1.5 py-0.5 rounded text-[10px] font-medium', STATUS_COLORS[h.to_status] || 'bg-muted')}>
                          {h.to_status}
                        </span>
                        {h.changed_by_name && (
                          <span className="text-muted-foreground ml-auto">by {h.changed_by_name}</span>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Notes */}
              {log.notes && (
                <div>
                  <h4 className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1 flex items-center gap-1">
                    <FileText className="h-3 w-3" /> Notes
                  </h4>
                  <div className="rounded-md bg-card border p-2.5 text-sm whitespace-pre-wrap">{log.notes}</div>
                </div>
              )}
                        </div>
                      </TableCell>
                    </TableRow>
                  )}
                  </Fragment>
                );
              })}
            </TableBody>
          </Table>
        </div>
        )}

        {/* Cards — mobile */}
        {isMobile && (
        <div className="space-y-2">
          {isLoading ? (
            <div className="text-center py-8 text-sm text-muted-foreground">{t('common.loading')}</div>
          ) : logs.length === 0 ? (
            <EmptyState icon={<Clock className="h-5 w-5" />} title={t('callHist.noRecords')} description={t('callHist.noRecordsDesc')} size="sm" />
          ) : logs.map((log: any) => {
            const isExpanded = expandedRows.has(log.id);
            return (
              <MobileCard key={log.id}>
                <MobileCardHeader
                  title={log.customer_name || '—'}
                  subtitle={log.customer_phone || '—'}
                  badge={(() => {
                    const r = rowResult(log);
                    return <span className={cn('text-[10px] px-1.5 py-0.5 rounded-full font-medium whitespace-nowrap', r.className)}>{r.label}</span>;
                  })()}
                />
                <MobileCardField label={t('callHist.when')} value={formatSkopje(log.created_at, 'dd/MM/yyyy HH:mm')} />
                <MobileCardField label={t('search.colAgent')} value={log.agent_name} />
                <MobileCardField label={t('callHist.colDuration')} value={formatDuration(log.talk_seconds ?? log.total_seconds)} />
                <MobileCardField
                  label={t('ordersPage.colSource')}
                  value={<span>{sourceLabel(log.source)}{log.display_id && log.display_id !== '—' ? <span className="block text-[10px] font-mono text-muted-foreground">{log.display_id}</span> : null}</span>}
                />
                <MobileCardField
                  label={t('wh.colProducts')}
                  value={log.product_items?.length > 0
                    ? log.product_items.map((i: any) => `${i.product_name} x${i.quantity}`).join(', ')
                    : (log.product_name || '—')}
                />
                {log.total_price ? <MobileCardField label={t('createOrder.total')} value={formatMoney(log.total_price)} /> : null}
                {log.recording_file && (
                  <MobileCardActions>
                    {isListened(log) && (
                      <span title={listenedTitle(log)} className="inline-flex items-center text-emerald-600">
                        <CheckCheck className="h-4 w-4" />
                      </span>
                    )}
                    <Button variant="outline" size="sm" className="gap-1.5" onClick={() => playRecording(log.id, log.recording_file)}>
                      <Play className="h-3.5 w-3.5" /> Play
                    </Button>
                    {canDownload && (
                      <Button variant="outline" size="sm" className="gap-1.5" onClick={() => downloadRecording(log.recording_file)}>
                        <Download className="h-3.5 w-3.5" /> Save
                      </Button>
                    )}
                  </MobileCardActions>
                )}
                <Button variant="ghost" size="sm" className="w-full justify-center text-xs text-muted-foreground" onClick={() => toggleRow(log.id)}>
                  {isExpanded ? <ChevronUp className="h-3.5 w-3.5 mr-1" /> : <ChevronDown className="h-3.5 w-3.5 mr-1" />}
                  {isExpanded ? t('callHist.hideDetails') : t('callHist.details')}
                </Button>
                {isExpanded && (
                  <div className="border-t pt-2 space-y-2 text-sm">
                    {log.recording_file && (
                      loadingAudio[log.recording_file] ? (
                        <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> {t('callHist.loadingAudio')}</div>
                      ) : audioUrls[log.recording_file] ? (
                        <audio controls autoPlay src={audioUrls[log.recording_file]} className="w-full h-9" controlsList={canDownload ? undefined : 'nodownload'} onContextMenu={canDownload ? undefined : (e) => e.preventDefault()} onTimeUpdate={trackListen(log.id, isListened(log))} />
                      ) : (
                        <Button variant="outline" size="sm" onClick={() => loadAudio(log.recording_file)} className="gap-1.5"><Play className="h-3.5 w-3.5" /> {t('callHist.loadRecording')}</Button>
                      )
                    )}
                    {log.customer_city && <MobileCardField label={t('orderModal.city')} value={log.customer_city} />}
                    {log.customer_address && <MobileCardField label={t('orderModal.address')} value={log.customer_address} />}
                    {log.notes && (
                      <div>
                        <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">{t('orderModal.notes')}</div>
                        <div className="rounded-md bg-muted/40 border p-2 text-sm whitespace-pre-wrap">{log.notes}</div>
                      </div>
                    )}
                  </div>
                )}
              </MobileCard>
            );
          })}
        </div>
        )}

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              {t('ordersPage.pageOf', { page, totalPages, total })}
            </p>
            <SmartPagination page={page} totalPages={totalPages} onPageChange={setPage} />
          </div>
        )}
      </div>
    </AppLayout>
  );
}
