#!/usr/bin/env bash
# elyon-recording.sh — post a recording's identity (Asterisk uniqueid + relative
# file path + start/end epochs) to the CRM on hangup. This is the PERMANENT,
# deterministic anchor for recording↔call linkage: the CRM keys call_recordings
# on the uniqueid and stamps recording_file onto the matching call_logs row, so
# the link can never drift (no fuzzy re-derivation, no swaps between two calls to
# the same number, no misses on long calls).
#
# Invoked from the Asterisk hangup handler alongside elyon-call-quality.sh — see
# extensions_custom_hangup_hook.conf. Same trust model as the other hooks:
#   chown root:asterisk /usr/local/bin/elyon-recording.sh && chmod 750 …
# (owner rwx, group r-x, others none — keeps the webhook-secret path unreadable).
#
# Args (from the dialplan): uniqueid ext dialed mixmon_path start_epoch
set -uo pipefail

UID_="${1:-}"; EXT="${2:-}"; DIALED="${3:-}"; MIX="${4:-}"; START="${5:-0}"
[ -z "$UID_" ] && exit 0
[ -z "$MIX" ] && exit 0   # no MixMonitor file on this channel → nothing to link

END="$(date +%s)"
# elyon-rec.php / the CRM address files RELATIVE to the monitor dir
# (YYYY/MM/DD/...wav). Strip the base so recording_file matches the play/download
# path regex on the CRM side.
MONBASE="/var/spool/asterisk/monitor/"
FILE="${MIX#"$MONBASE"}"
case "$FILE" in
  /*|"$MIX") exit 0 ;;   # prefix didn't strip → file isn't under the monitor dir
esac
# Some MixMonitor setups omit the extension on the variable; the file on disk is
# always .wav. Normalise.
case "$FILE" in *.wav) : ;; *) FILE="${FILE}.wav" ;; esac

SIZE=0; [ -f "$MIX" ] && SIZE="$(stat -c%s "$MIX" 2>/dev/null || echo 0)"
[ "${START:-0}" -gt 0 ] 2>/dev/null || START=0

CRM_URL="https://oufoazmnbwugtfldkwsn.supabase.co/functions/v1/api/webhook/recording"
WEBHOOK_SECRET="$(cat /etc/asterisk/elyon-webhook.secret)"

BODY="{\"uniqueid\":\"$UID_\",\"ext\":\"$EXT\",\"dialed\":\"$DIALED\",\"file\":\"$FILE\",\"start_epoch\":$START,\"end_epoch\":$END,\"size\":$SIZE}"
SIG="$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$WEBHOOK_SECRET" | awk '{print $NF}')"
curl -sS -m 10 -X POST "$CRM_URL" \
  -H 'content-type: application/json' \
  -H "x-webhook-signature: $SIG" \
  --data "$BODY" >/dev/null 2>&1 || true
exit 0
