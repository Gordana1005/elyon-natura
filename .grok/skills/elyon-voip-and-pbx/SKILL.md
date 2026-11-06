---
name: elyon-voip-and-pbx
description: Use for any work involving the telephony stack, SIP trunk, Asterisk, FreePBX, WebRTC/WSS softphone, call recordings, PBX configuration, or the A1 integration. This is the long-term critical infrastructure for real calls. Especially important when changing the A1 SIP trunk, extensions, or the frontend VoIP layer.
---

# Elyon VOIP & PBX Skill — The Real Call Path (LIVE in production)

This skill is the authoritative reference for the entire telephony infrastructure.

> **STATUS: LIVE (production, since ~June 2026).** Browser-based WebRTC calls run over the A1
> "Business Voice" SIP trunk to real Bulgarian DIDs, with call recording. The frontend softphone is
> `src/lib/voip/RealVoipEngine.ts` (sip.js) — **not** a mock. Two-way calls work; per-agent
> extensions + per-agent caller-ID; recordings (Asterisk MixMonitor) are browsable; there is a
> missed-call inbox and a superadmin VOIP Health dashboard at `/voip-health`. `call_logs` carries
> real `connection_state` / `talk_seconds`. `src/lib/mockCalls.ts` is **dead** (no importers).
> Trust the running code and `/voip-health` over any older "awaiting/mock" wording. The A1-onboarding
> roadmap below is kept only as **History**.

## Current Production Infrastructure (as of May 2026)

### VPS Server (Sofia)
- **Provider**: AlphaVPS — €6.99/month
- **Location**: Sofia, Bulgaria (AS203380 – DA International Group)
- **Public IPv4**: `104.152.48.222`
- **IPv6**: `2a01:8740:1:946::56c7`
- **Hostname**: `pbx.elyoncall.com`
- **OS**: AlmaLinux 8.10 (Cerulean Leopard)
- **Specs**: 2 vCPU / 8 GB RAM / 60 GB SSD / 5.86 TB bandwidth

### Installed Software
- **Asterisk**: 20.19.0 LTS (built from source with PJSIP, Opus codec, DTLS-SRTP, `res_http_websocket`)
- **FreePBX**: 16.0.45
- **Apache + mod_ssl**: Serving the FreePBX UI over HTTPS
- **PHP**: 7.4.33 (Remi) – pinned (FreePBX 16 does not support PHP 8)
- **MariaDB**: 10.3.39 (local only)
- **php-fpm**: Running as `asterisk:asterisk`

### Key Services & Ports
| Service              | Port(s)              | Notes |
|----------------------|----------------------|-------|
| SSH                  | 22/tcp               | Key-only (password auth disabled) |
| Apache (HTTPS)       | 443/tcp              | FreePBX UI (80 redirects to 443 + HSTS 6 months) |
| Asterisk PJSIP       | 5060/udp+tcp, 5061/tcp | SIP signalling |
| Asterisk WSS         | 8089/tcp             | **Critical**: `wss://pbx.elyoncall.com:8089/ws` – real Let's Encrypt cert |
| RTP Media            | 10000–20000/udp      | Audio streams |
| php-fpm              | Unix socket          | Must run as asterisk user |

All core services auto-start: `httpd`, `mariadb`, `fail2ban`, `php-fpm`, `freepbx`.

### Access Methods
- **SSH** (primary): `ssh -i $env:USERPROFILE\.ssh\elyon_vps root@104.152.48.222`
  - Private key location on Mile's machine: `C:\Users\Mile\.ssh\elyon_vps`
  - If key is lost: Use AlphaVPS noVNC console (credentials in password manager) to add new key to `/root/.ssh/authorized_keys`
- **FreePBX Web UI**: https://pbx.elyoncall.com (admin user created on first visit)
- **AlphaVPS Panel**: For reboots, console access, OS rebuilds (alphavps.com → Services → "elyon")

### TLS / Certificates
- Let's Encrypt certificate for `pbx.elyoncall.com`, auto-renewed via certbot.
- Renewal hook: `/etc/letsencrypt/renewal-hooks/deploy/asterisk-certs.sh`
  - Copies renewed cert to `/etc/asterisk/certs/asterisk.pem` (used by Asterisk for WSS)
  - Reloads Apache + Asterisk PJSIP
- Initial expiry was ~2026-08-07 (auto-renews ~30 days before)

### Hardening (Current State)
- SSH key-only (password authentication disabled)
- fail2ban protecting SSH
- firewalld with minimal open ports
- SELinux set to **Permissive** (not Disabled) – FreePBX has many fights with Enforcing mode
- Automatic security updates enabled

## A1 SIP Trunk (LIVE)

We went live on **Path II** — our own FreePBX/Asterisk PBX in Sofia registering A1's **Business
Voice** SIP trunk. The browser softphone connects to the PBX over WSS; the PBX carries the SIP/RTP
leg to A1; A1 terminates to BG mobile/PSTN. The Sofia BG IP makes A1 see the traffic as domestic.

The WebRTC transport is in place at `/etc/asterisk/pjsip.transports_custom.conf`:
```
[wss-transport]
type=transport
protocol=wss
bind=0.0.0.0
```

**Operational rules (still apply):**
- Configure trunk/extension changes in **FreePBX GUI → Connectivity → Trunks / Extensions**, not by
  hand-editing FreePBX-managed files.
- `*_custom.conf` files (e.g. `pjsip.transports_custom.conf`) are the only safe place for manual
  Asterisk overrides — FreePBX overwrites the rest.
- See `project_voip_working_config` for the exact 7 fixes that made browser→A1→PSTN work, and
  `project_voip_calldrops_proxytimeout_2026-06-10` for the Apache `ProxyTimeout` fix on `/ws`.

### History (A1 onboarding — completed)
Contract for A1 "Business Voice" signed 2026-05-20; provisioning completed and the trunk went live in
production. Pre-staged template files (`/root/A1-TRUNK-TEMPLATE.txt`,
`/root/WEBRTC-EXTENSION-TEMPLATE.txt`) were used during go-live. Zadarma was evaluated as a fallback
carrier but A1 is the production carrier. (Kept for reference only.)

## Architecture (Browser → Real Calls)

```
[Agent in Skopje – Chrome]
        │  WebRTC (WSS over TLS)
        ▼
[Sofia VPS – Asterisk 20 + FreePBX]
        │  SIP/RTP (via A1 trunk, BG IP origin)
        ▼
[A1 SIP Trunk / Cloud PBX]
        │  PSTN
        ▼
[Bulgarian customer mobile DID]
```

The Sofia BG IP origin is crucial for A1 to treat the traffic as domestic.

## Frontend Integration Point

- **Live engine**: `src/lib/voip/RealVoipEngine.ts` (sip.js) behind `VoipContext` (`src/contexts/VoipContext.tsx`). Config in `src/lib/voip/pbxConfig.ts`.
- Every call is logged via `apiLogCall` with a real `connection_state` and `talk_seconds`/`total_seconds` (`VoipContext.tsx` ~306-324).
- `src/lib/mockCalls.ts` is **dead** (no importers in `src/`); ignore older "mock swap pending" notes.
- **Rule**: `VoipContext`'s consumer surface (`startCall`, `hangup`, `endCall`, `confirmCall`, `state`, `call`, `lastFinished`) is the stable contract — keep changes to the engine behind it focused.

## Things NOT to Break (High Priority)

- `/etc/asterisk/pjsip.transports_custom.conf` — FreePBX will overwrite non-custom files. WebRTC dies if this is lost.
- Apache user/group must be `asterisk` (FreePBX requirement).
- PHP must stay on 7.4 (Remi) – do not reset modules.
- SELinux must stay Permissive (or test thoroughly before changing).
- fail2ban must remain enabled (SSH is under constant brute-force).
- php-fpm pool must run as `asterisk:asterisk`.
- Do not touch `/etc/httpd/conf.d/pbx-elyoncall.conf` without testing.

## Recommended Commands (SSH as root)

```bash
# FreePBX
fwconsole restart
fwconsole reload
asterisk -rvvv                    # Interactive Asterisk CLI

# Status checks
systemctl status httpd php-fpm mariadb fail2ban freepbx
asterisk -rx "pjsip show endpoints"
asterisk -rx "pjsip show registrations"
asterisk -rx "http show status"

# Logs
tail -f /var/log/asterisk/full
tail -f /var/log/httpd/pbx_error.log
```

## Health & Observability (added 2026-06-18)

A superadmin **VOIP Health** page (`/voip-health`) + app-wide alert banner now surface the live
state of the phone system: server (disk/memory/load), **lines in use vs the A1 trunk's channel
cap** (live from the PBX — never hardcode it), A1
trunk reachability, recording coverage (answered calls with no recording + why), call-quality
(one-way audio — the "agent couldn't hear the client" symptom), fail2ban bans, recent errors, and
outbound minutes. It is fed by three PBX-side pieces: a signed live collector
(`/var/www/html/elyon-health.php`), a 3-min cron push (`elyon-pbx-health.sh` →
`/api/webhook/pbx-health` → `pbx_health_snapshots`), and an Asterisk hangup hook
(`elyon-call-quality.sh` → `/api/webhook/call-quality` → `call_quality`).

**Before touching telephony, read [`docs/telephony/MONITORING.md`](../../../docs/telephony/MONITORING.md)**
(deploy steps, the narrow read-only sudoers grant, thresholds, and the A1-minutes request checklist).
Artifacts live in [`docs/telephony/health/`](../../../docs/telephony/health/). The collector is
read-only and HMAC-signed (same trust boundary as `elyon-rec.php`); never widen the sudoers entry
beyond the fixed read-only commands listed there.

This skill must be consulted before any change to the VPS, Asterisk, FreePBX, or the frontend VoIP layer. The infrastructure is deliberately hardened and pre-staged. Do not improvise.
## Macedonia — inbound Teleshop calls ring the CRM (06.11.2026)

The MK PBX (FreePBX 17 on pbx.naturall.mk, Telekom trunk `telekom-mk`) sends the TV numbers 02 512 8888 and
02 620 2515 (and the test number 02 311 8813) to queue 700 "Teleshop In": `[elyon-tv-in]` in extensions_custom.conf
(caller-ID name TV8888 / TV2515, 07:00-20:59 Europe/Skopje, `Queue(700,r,,,60,,,elyon-in-answer^s^1)`), everything
else and every failure to `[elyon-missed-call]` (greeting + voicemail into Пропуштени повици). The queue
(queues_custom.conf) is ringall, 60 s, `ringinuse=no`, joinempty strict; its members are DYNAMIC and come from the CRM
every 30 s (`elyon-queue-sync.sh` -> `GET /api/voip/inbound-members`, HMAC `inbound|<exp>` with the recordings key):
`inbound_ring_settings` per login, mode always | manual | off, set in Settings -> Teams "Прима ТВ повици" or by the
person's own ВКЛ/ИСКЛ button on /calls (manual only; off by itself at 21:05). Never add queue members by hand.
The browser engine (sip.js `delegate.onInvite`) rings the `IncomingCallPanel` on every page; a ring that ends without
an answer goes `incoming -> idle` and logs NOTHING; an answered call is `call_logs.direction = 'inbound'`, recorded as
`in-<HHMMSS>-<ext>-<caller>-to-<did>-<uniqueid>.wav` on the agent leg (`[elyon-in-answer]`, hook `elyon-cq`).
`device_state_busy_at=1` on the agent lines makes a line In Use while on a call, so the queue skips it.
Telekom must route the numbers inbound (the forwards to mobiles are removed at the cut-over); test on 02 311 8813 first.
Memory: project_inbound_teleshop_queue_2026_11_06.md. Rollback: /root/pbx-setup/backup-inbound-<stamp>/.
