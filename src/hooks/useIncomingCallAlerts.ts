/**
 * Everything that makes an inbound Teleshop call NOTICED while it rings (05.11.2026): the ringtone (WebAudio,
 * primed on the first pointer-down / key after login because of Chrome's autoplay policy), the blinking tab
 * title and a system notification when the tab is hidden. Permission for notifications — and a one-off
 * microphone warm-up so the first "Прими" has no prompt — is asked only of people who receive these calls
 * (their inbound ring mode is not 'off'), after a user gesture.
 */
import { useEffect, useRef, useState } from 'react';
import i18n from '@/i18n';
import { apiGetInboundRingMe } from '@/lib/api';
import { PBX_CONFIG } from '@/lib/voip/pbxConfig';
import { createRinger, type Ringer } from '@/lib/voip/ringtone';
import { startTitleBlink, stopTitleBlink } from '@/lib/voip/titleBlink';
import { closeIncomingNotification, ensureNotificationPermission, showIncomingNotification } from '@/lib/voip/incomingNotification';
import { prettyMkPhone } from '@/lib/voip/inboundIdentity';
import type { IncomingCallInfo } from '@/lib/voip/RealVoipEngine';

export function useIncomingCallAlerts(incoming: IncomingCallInfo | null, userId: string | null | undefined): { ringtoneBlocked: boolean } {
  const ringerRef = useRef<Ringer | null>(null);
  const [blocked, setBlocked] = useState(false);
  const [receives, setReceives] = useState(false);

  // Does this login receive TV calls at all? (always / manual) — decides whether we ask for anything.
  useEffect(() => {
    if (!PBX_CONFIG.useRealVoip || !userId) { setReceives(false); return; }
    let cancelled = false;
    apiGetInboundRingMe()
      .then((r) => { if (!cancelled) setReceives(r.mode !== 'off'); })
      .catch(() => { if (!cancelled) setReceives(false); });
    return () => { cancelled = true; };
  }, [userId]);

  // The first gesture after login: prime the audio context; for receivers also the notification permission
  // and a microphone warm-up (tracks stopped at once — it only settles the browser prompt).
  useEffect(() => {
    if (typeof window === 'undefined' || !PBX_CONFIG.useRealVoip || !userId) return;
    const prime = () => {
      (ringerRef.current ??= createRinger()).prime();
      if (receives) {
        void ensureNotificationPermission();
        try {
          navigator.mediaDevices?.getUserMedia({ audio: true })
            .then((s) => s.getTracks().forEach((t) => t.stop()))
            .catch(() => { /* refused — the answer path reports it */ });
        } catch { /* no media devices */ }
      }
      window.removeEventListener('pointerdown', prime);
      window.removeEventListener('keydown', prime);
    };
    window.addEventListener('pointerdown', prime);
    window.addEventListener('keydown', prime);
    return () => {
      window.removeEventListener('pointerdown', prime);
      window.removeEventListener('keydown', prime);
    };
  }, [userId, receives]);

  // Ring while an inbound call is pending; everything stops the moment it is answered, declined or gone.
  useEffect(() => {
    if (!incoming) {
      ringerRef.current?.stop();
      stopTitleBlink();
      closeIncomingNotification();
      setBlocked(false);
      return;
    }
    const ringer = (ringerRef.current ??= createRinger());
    setBlocked(!ringer.start());
    const did = incoming.did_pretty ?? incoming.did_label ?? '';
    const title = i18n.t('incomingCall.notifTitle', { did });
    startTitleBlink(title);
    showIncomingNotification(title, i18n.t('incomingCall.notifBody', { phone: prettyMkPhone(incoming.phone) }));
    // the audio context may get its gesture a moment later — then the sound starts and the hint goes
    const recheck = window.setInterval(() => { if (ringer.start()) { setBlocked(false); window.clearInterval(recheck); } }, 1000);
    return () => {
      window.clearInterval(recheck);
      ringer.stop();
      stopTitleBlink();
      closeIncomingNotification();
    };
  }, [incoming]);

  return { ringtoneBlocked: blocked };
}
