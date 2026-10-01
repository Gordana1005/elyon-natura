import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { formatSkopje } from '@/lib/skopjeTime';
import { CheckCheck, ChevronDown, ChevronUp, Loader2, Lock, PhoneCall, Play } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { usePermissions } from '@/contexts/PermissionsContext';
import { apiGetOrderCalls, apiGetRecordingAudioUrl, type OrderCall } from '@/lib/api';
import { useListenedMark } from '@/hooks/useListenedMark';

// Recordings are purged from the PBX after ~30 days; an answered call older
// than that with no recording link is "expired", not "never recorded".
const RETENTION_DAYS = 30;
function recordingExpired(c: OrderCall): boolean {
  if (c.recording_file || c.recording_locked) return false;
  const answered = !!c.connected_at || (c.talk_seconds ?? 0) > 0;
  if (!answered) return false;
  return (Date.now() - new Date(c.created_at).getTime()) / (24 * 3600 * 1000) > RETENTION_DAYS;
}

function formatDuration(sec?: number | null): string {
  if (!sec || sec <= 0) return '—';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

// Inline "Calls" panel for an expanded order row: every call to the customer's
// number (any order/lead/standalone context), latest first, with in-place
// recording playback. Mounted only while the row is expanded, so the orders
// list itself never pays for it; React Query caches per orderId so collapsing
// and re-expanding a row doesn't refetch.
export function OrderCallsPanel({ orderId }: { orderId: string }) {
  const { t, i18n } = useTranslation();
  const { canSeePrivacy } = usePermissions();
  const canDownload = canSeePrivacy('can_hear_recordings');
  const [showAll, setShowAll] = useState(false);
  const [audioUrls, setAudioUrls] = useState<Record<string, string>>({});
  const [loadingAudio, setLoadingAudio] = useState<Record<string, boolean>>({});
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [locallyListened, setLocallyListened] = useState<Set<string>>(new Set());
  const onMarked = useCallback((id: string) => {
    setLocallyListened((prev) => new Set(prev).add(id));
  }, []);
  const trackListen = useListenedMark(canDownload, onMarked);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['order-calls', orderId],
    queryFn: () => apiGetOrderCalls(orderId),
    staleTime: 5 * 60 * 1000,
  });

  // Signed URLs live ~5 minutes, so the cache stays component-local.
  const playCall = async (call: OrderCall) => {
    const file = call.recording_file!;
    setPlayingId(call.id);
    if (audioUrls[file]) return;
    setLoadingAudio((p) => ({ ...p, [file]: true }));
    try {
      const { url } = await apiGetRecordingAudioUrl(file);
      setAudioUrls((p) => ({ ...p, [file]: url }));
    } catch {
      setPlayingId((cur) => (cur === call.id ? null : cur));
    } finally {
      setLoadingAudio((p) => ({ ...p, [file]: false }));
    }
  };

  const outcomeLabel = (o: string | null) =>
    o ? (i18n.exists(`outcome.${o}`) ? t(`outcome.${o}`) : o.replace(/_/g, ' ')) : '—';

  const calls = data?.calls || [];

  const renderCall = (call: OrderCall) => {
    const listened = !!call.listened_at || locallyListened.has(call.id);
    return (
      <div key={call.id} className="py-1.5 border-b border-border/50 last:border-0">
        <div className="flex items-center gap-2 flex-wrap text-xs">
          <span className="font-mono text-muted-foreground whitespace-nowrap">
            {formatSkopje(call.created_at, 'dd/MM/yy HH:mm')}
          </span>
          <span className="font-medium">{call.agent_name || '—'}</span>
          <span className="text-muted-foreground">{outcomeLabel(call.outcome)}</span>
          <span className="font-mono tabular-nums text-muted-foreground">
            {formatDuration(call.talk_seconds ?? call.total_seconds)}
          </span>
          {call.is_this_order && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-primary/10 text-primary font-medium whitespace-nowrap">
              {t('orderCalls.thisOrder')}
            </span>
          )}
          {listened && (
            <span
              title={call.listened_by_name
                ? t('orderCalls.listenedBy', { name: call.listened_by_name, date: call.listened_at ? formatSkopje(call.listened_at, 'dd/MM/yy HH:mm') : '' })
                : t('orderCalls.listened')}
              className="inline-flex items-center text-emerald-600"
            >
              <CheckCheck className="h-3.5 w-3.5" />
            </span>
          )}
          <span className="ml-auto">
            {call.recording_file ? (
              playingId !== call.id && (
                <Button variant="outline" size="sm" className="h-6 gap-1 px-2 text-xs" onClick={() => void playCall(call)}>
                  <Play className="h-3 w-3" /> {t('orderCalls.play')}
                </Button>
              )
            ) : call.recording_locked ? (
              <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground" title={t('orderCalls.restricted')}>
                <Lock className="h-3 w-3" /> {t('orderCalls.restricted')}
              </span>
            ) : recordingExpired(call) ? (
              <span className="text-[11px] italic text-muted-foreground" title={t('callHist.recordingExpiredHint')}>
                {t('callHist.recordingExpired')}
              </span>
            ) : null}
          </span>
        </div>
        {playingId === call.id && call.recording_file && (
          loadingAudio[call.recording_file] ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground mt-1.5">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> {t('callHist.loadingAudio')}
            </div>
          ) : audioUrls[call.recording_file] ? (
            <audio
              controls
              autoPlay
              src={audioUrls[call.recording_file]}
              className="w-full h-9 mt-1.5"
              controlsList={canDownload ? undefined : 'nodownload'}
              onContextMenu={canDownload ? undefined : (e) => e.preventDefault()}
              onTimeUpdate={trackListen(call.id, !!call.listened_at || locallyListened.has(call.id))}
            />
          ) : null
        )}
      </div>
    );
  };

  return (
    <div>
      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5 flex items-center gap-1">
        <PhoneCall className="h-3 w-3" /> {t('orderCalls.title')}
      </div>
      {isLoading ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> {t('orderCalls.loading')}
        </div>
      ) : isError ? (
        <div className="text-xs text-muted-foreground">{t('orderCalls.loadFailed')}</div>
      ) : calls.length === 0 ? (
        <div className="text-xs text-muted-foreground">{t('orderCalls.noCalls')}</div>
      ) : (
        <div>
          {renderCall(calls[0])}
          {showAll && calls.slice(1).map(renderCall)}
          {calls.length > 1 && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 mt-1 px-2 text-xs text-muted-foreground"
              onClick={() => setShowAll((v) => !v)}
            >
              {showAll
                ? <><ChevronUp className="h-3 w-3 mr-1" /> {t('orderCalls.showLess')}</>
                : <><ChevronDown className="h-3 w-3 mr-1" /> {t('orderCalls.viewMore', { count: calls.length - 1 })}</>}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
