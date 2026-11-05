import { Phone, PhoneOff, Loader2, X, Mic, MicOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { useVoip, formatDuration } from '@/contexts/VoipContext';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { PBX_CONFIG } from '@/lib/voip/pbxConfig';

// The default outbound caller-ID shown when the call object hasn't a specific one.
const AGENT_DID_PLACEHOLDER = PBX_CONFIG.defaultCallerId;

/**
 * Live-call indicator that lives INSIDE the sidebar (rendered by AppSidebar,
 * between the brand header and the nav). While a call is active it occupies a
 * slot and pushes the nav items down so Calls / Call Again / etc. stay visible
 * and clickable — it never overlays them. Self-hides when idle.
 *
 * It is display + minimal call control only (End / Cancel). All outcomes
 * (confirm / cancel / trash / no-answer) are recorded via the "Choose Answer"
 * button on the Calls page — clicking this card jumps there.
 */
export function SidebarCallIndicator({ collapsed }: { collapsed: boolean }) {
  const { t } = useTranslation();
  const { state, call, cancelCall, hangup, isMuted, toggleMute } = useVoip();
  const navigate = useNavigate();

  if (state === 'idle' || !call) return null;

  const isDialing = state === 'dialing';
  const isWrapping = state === 'wrapping';
  const goCalls = () => navigate('/calls');
  const stop = (e: React.MouseEvent) => e.stopPropagation();

  // ── Collapsed sidebar: compact icon + timer, click → Calls ──
  if (collapsed) {
    return (
      <button
        onClick={goCalls}
        title={t('sidebarCall.activeCallTitle')}
        className={cn(
          // relative z-[60] keeps the live-call card above any open modal/overlay
          // (all of which sit at z-50) so End/Mute stay clickable mid-call.
          'relative z-[60] mx-2 mt-2 mb-1 flex shrink-0 flex-col items-center gap-0.5 rounded-xl border bg-card px-1 py-2 shadow-sm',
          isWrapping ? 'border-destructive/40' : 'border-[hsl(var(--success))]/40',
        )}
      >
        <Phone className={cn('h-4 w-4', isWrapping ? 'text-destructive' : 'text-[hsl(var(--success))] animate-pulse')} />
        <span className="text-[10px] font-bold tabular-nums text-card-foreground">
          {isDialing ? '···' : formatDuration(call.duration_sec)}
        </span>
      </button>
    );
  }

  // ── Expanded sidebar: compact card ──
  return (
    <div
      onClick={goCalls}
      role="button"
      className={cn(
        // relative z-[60] keeps the live-call card above any open modal/overlay
        // (all of which sit at z-50) so End/Mute stay clickable mid-call.
        'relative z-[60] mx-3 mt-3 mb-1 shrink-0 cursor-pointer overflow-hidden rounded-xl border bg-card shadow-sm',
        isWrapping ? 'border-destructive/40' : 'border-[hsl(var(--success))]/40',
        'animate-in fade-in-0 slide-in-from-top-2 duration-200',
      )}
    >
      <div className="px-3 py-2">
        <div className="flex items-center justify-between">
          <span className={cn(
            'inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider',
            isWrapping ? 'text-destructive' : 'text-[hsl(var(--success))]',
          )}>
            <span className={cn('h-2 w-2 rounded-full', isWrapping ? 'bg-destructive' : 'bg-[hsl(var(--success))] animate-pulse')} />
            {isWrapping ? t('sidebarCall.callEnded') : isDialing ? t('sidebarCall.dialing') : t('sidebarCall.liveCall')}
          </span>
          <span className={cn('text-sm font-bold tabular-nums', isWrapping ? 'text-destructive' : 'text-card-foreground')}>
            {isDialing
              ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              : formatDuration(call.duration_sec)}
          </span>
        </div>
        <div className="mt-1 flex items-center gap-1.5">
          <Phone className="h-3.5 w-3.5 shrink-0 text-[hsl(var(--success))]" />
          <span className="truncate font-mono text-[13px] font-semibold tabular-nums text-card-foreground">{call.phone}</span>
        </div>
        <div className="truncate text-[10px] text-muted-foreground">
          {t('sidebarCall.callAs')} <span className="font-mono">{call.caller_id || AGENT_DID_PLACEHOLDER}</span>
        </div>
      </div>

      {!isWrapping && (
        <div className="border-t px-2 py-1.5">
          {/* Mute is available from the moment the call starts (dialing), beside
              either Cancel (still ringing) or End (connected). */}
          <div className="flex items-center gap-1.5">
            <Button
              size="sm"
              variant={isMuted ? 'destructive' : 'outline'}
              onClick={(e) => { stop(e); toggleMute(); }}
              title={isMuted ? t('sidebarCall.unmuteMic') : t('sidebarCall.muteMic')}
              className="h-7 flex-1 justify-center gap-1.5 text-xs"
            >
              {isMuted ? <><MicOff className="h-3.5 w-3.5" /> {t('sidebarCall.unmute')}</> : <><Mic className="h-3.5 w-3.5" /> {t('sidebarCall.mute')}</>}
            </Button>
            {isDialing ? (
              <Button size="sm" variant="destructive" onClick={(e) => { stop(e); cancelCall(); }} className="h-7 flex-1 justify-center gap-1.5 text-xs">
                <X className="h-3.5 w-3.5" /> {t('common.cancel')}
              </Button>
            ) : (
              <Button size="sm" variant="destructive" onClick={(e) => { stop(e); hangup(); }} className="h-7 flex-1 justify-center gap-1.5 text-xs">
                <PhoneOff className="h-3.5 w-3.5" /> {t('sidebarCall.end')}
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
