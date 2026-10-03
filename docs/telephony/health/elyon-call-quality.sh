#!/usr/bin/env bash
# elyon-call-quality.sh — post per-call quality (hangup cause + RTP stats) to the
# CRM. Invoked by the Asterisk hangup handler (see extensions_custom_hangup_hook.conf).
#
# Asterisk runs System() as the `asterisk` user, so this MUST be:
#   chown root:asterisk /usr/local/bin/elyon-call-quality.sh && chmod 750 …
# (same trap as elyon-missed-call.sh — owner rwx, group r-x, others none, so the
# embedded webhook secret path stays unreadable to others).
#
# Args (from the dialplan): uniqueid ext dialed hangupcause rxcount txcount rxploss rxjitter rtt
set -uo pipefail

UID_="${1:-}"; EXT="${2:-}"; DIALED="${3:-}"; HC="${4:-0}"
RX="${5:-0}"; TX="${6:-0}"; RXPLOSS="${7:-0}"; RXJIT="${8:-}"; RTT="${9:-}"
[ -z "$UID_" ] && exit 0

CRM_URL="https://oufoazmnbwugtfldkwsn.supabase.co/functions/v1/api/webhook/call-quality"
WEBHOOK_SECRET="$(cat /etc/asterisk/elyon-webhook.secret)"

# Packet-loss % = lost / (received + lost).
LOSS="null"
TOTAL=$(( ${RX:-0} + ${RXPLOSS:-0} ))
if [ "$TOTAL" -gt 0 ] 2>/dev/null; then
  LOSS="$(awk "BEGIN{printf \"%.2f\", ${RXPLOSS:-0}/$TOTAL*100}")"
fi
# rtpqos jitter is reported in seconds on most builds — convert to ms. Verify the
# unit on YOUR box once (asterisk -rx 'pjsip show channelstats') and adjust if needed.
JIT="null"
if [ -n "${RXJIT:-}" ]; then JIT="$(awk "BEGIN{printf \"%.1f\", ${RXJIT}*1000}")"; fi
RTTMS="null"
if [ -n "${RTT:-}" ]; then RTTMS="$(awk "BEGIN{printf \"%.1f\", ${RTT}*1000}")"; fi

BODY="{\"uniqueid\":\"$UID_\",\"extension\":\"$EXT\",\"direction\":\"outbound\",\"dialed\":\"$DIALED\",\"hangup_cause\":${HC:-0},\"rxcount\":${RX:-0},\"txcount\":${TX:-0},\"packet_loss_pct\":$LOSS,\"jitter_ms\":$JIT,\"rtt_ms\":$RTTMS,\"occurred_at\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}"

SIG="$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$WEBHOOK_SECRET" | awk '{print $NF}')"
curl -sS -m 10 -X POST "$CRM_URL" \
  -H 'content-type: application/json' \
  -H "x-webhook-signature: $SIG" \
  --data "$BODY" >/dev/null 2>&1 || true
exit 0
