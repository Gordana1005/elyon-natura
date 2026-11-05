/**
 * PBX / Asterisk WebRTC connection settings.
 *
 * NOTE: Per-agent SIP credentials (extension + secret) are NO LONGER stored here.
 * They are fetched securely at login from GET /api/voip/credentials and injected
 * into the engine via RealVoipEngine.configure(). This file only holds the
 * non-secret connection defaults + the real/mock master switch.
 */

export const PBX_CONFIG = {
  // WebSocket connection defaults (the backend returns the authoritative ws_url;
  // these are only fallbacks if it's missing).
  // The Macedonian PBX (Makedonski Telekom VPS, FreePBX 17) — see the memory
  // "Telephony / SIP trunk — Telekom VPS" and docs/telephony/RUNBOOK.md.
  wsHost: 'pbx.naturall.mk',
  wsPortSecure: '443',
  wsNamespace: 'ws',
  wsUrl: 'wss://pbx.naturall.mk/ws',
  /** SIP domain of the agents' extensions (the PBX host). */
  sipDomain: 'pbx.naturall.mk',

  /** Fallback caller ID if the backend doesn't supply one (it normally does):
   *  the main published line 02 512 8888 on the Telekom trunk. */
  defaultCallerId: '+38925128888',

  /** Master switch for real vs mock engine. */
  useRealVoip: import.meta.env.VITE_USE_REAL_VOIP === 'true',
} as const;

export type PbxConfig = typeof PBX_CONFIG;
