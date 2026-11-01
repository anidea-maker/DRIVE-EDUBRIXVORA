#!/bin/sh
# Normalizes API_UPSTREAM, then hands over to the official nginx entrypoint
# (which renders /etc/nginx/templates/*.template with envsubst and starts nginx).
#
# Accepts API_UPSTREAM with or without a scheme, because every platform's env
# var UI encourages pasting a bare hostname:
#
#   backend:4000                      -> http://backend:4000
#   https://api.example.com           -> unchanged
#   (empty)                           -> http://backend:4000 (docker compose)
set -e

case "${API_UPSTREAM:-}" in
  *://*) ;;
  "") API_UPSTREAM="http://backend:4000" ;;
  *":443") API_UPSTREAM="https://${API_UPSTREAM}" ;;
  *) API_UPSTREAM="http://${API_UPSTREAM}" ;;
esac

# The nginx template has no trailing slash handling of its own.
API_UPSTREAM="${API_UPSTREAM%/}"
export API_UPSTREAM

echo "[entrypoint] PORT=${PORT:-80} API_UPSTREAM=${API_UPSTREAM}"

exec /docker-entrypoint.sh "$@"
