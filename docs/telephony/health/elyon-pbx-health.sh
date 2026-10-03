#!/usr/bin/env bash
# elyon-pbx-health.sh — push a PBX health snapshot to the CRM.
# Deploy to /usr/local/bin/elyon-pbx-health.sh (chmod 750, owner root). Run by
# /etc/cron.d/elyon-pbx-health every few minutes. This is what gives the CRM
# trend history + lets it alert even when nobody has the dashboard open.
#
# The CRM webhook verifies an HMAC-SHA256 of the raw body using WEBHOOK_SECRET
# (the same secret as the Supabase function secret WEBHOOK_SECRET / the
# missed-call scripts). Store it at /etc/asterisk/elyon-webhook.secret (chmod 600).
set -uo pipefail

CRM_URL="https://oufoazmnbwugtfldkwsn.supabase.co/functions/v1/api/webhook/pbx-health"
WEBHOOK_SECRET="$(cat /etc/asterisk/elyon-webhook.secret)"

# Collect via the CLI mode of the health collector (no signature needed locally).
BODY="$(php /var/www/html/elyon-health.php)"
[ -z "$BODY" ] && exit 0

SIG="$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$WEBHOOK_SECRET" | awk '{print $NF}')"

curl -sS -m 15 -X POST "$CRM_URL" \
  -H 'content-type: application/json' \
  -H "x-webhook-signature: $SIG" \
  --data "$BODY" >/dev/null 2>&1 || true
exit 0
