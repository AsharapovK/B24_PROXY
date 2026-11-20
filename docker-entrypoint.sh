#!/bin/sh
set -eu
if [ -r /run/secrets/b24_webhook_url ]; then
  B24_WEBHOOK_URL=$(cat /run/secrets/b24_webhook_url)
  export B24_WEBHOOK_URL
fi
exec node index.js
