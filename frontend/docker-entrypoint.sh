#!/bin/sh
# Normalizes API_UPSTREAM, detects the "proxying to myself" mistake, then hands
# over to the official nginx entrypoint (which renders
# /etc/nginx/templates/*.template with envsubst and starts nginx).
#
# Accepts API_UPSTREAM with or without a scheme, because platform env-var UIs
# encourage pasting a bare hostname:
#
#   backend:4000                      -> http://backend:4000
#   https://api.example.com           -> unchanged
#   (empty)                           -> http://backend:4000 (docker compose)
set -e

case "${API_UPSTREAM:-}" in
  *://*) ;;
  "") API_UPSTREAM="http://backend:4000" ;;
  *)
    # No scheme given. Public hostnames get https (Render/Railway/Fly serve TLS
    # and redirect plain http, which would break proxying), while bare service
    # names like "backend:4000" stay on http.
    upstream_host=$(printf '%s' "$API_UPSTREAM" | sed -e 's|/.*$||' -e 's|:[0-9]*$||')
    upstream_port=$(printf '%s' "$API_UPSTREAM" | sed -n 's|^[^:]*:\([0-9]*\)$|\1|p')
    case "$upstream_host" in
      *.*) [ "${upstream_port:-443}" = "443" ] && API_UPSTREAM="https://${API_UPSTREAM}" || API_UPSTREAM="http://${API_UPSTREAM}" ;;
      *)   API_UPSTREAM="http://${API_UPSTREAM}" ;;
    esac
    ;;
esac

# The nginx template has no trailing slash handling of its own.
API_UPSTREAM="${API_UPSTREAM%/}"

# Host part only, for the self-reference check below.
API_HOST=$(printf '%s' "$API_UPSTREAM" | sed -e 's|^[a-zA-Z][a-zA-Z0-9+.-]*://||' -e 's|/.*$||' -e 's|:[0-9]*$||')

# Public hostname of this very container, as seen by browsers. Render exports
# RENDER_EXTERNAL_HOSTNAME; RENDER_EXTERNAL_URL is accepted as well.
SELF_HOST="${RENDER_EXTERNAL_HOSTNAME:-}"
if [ -z "$SELF_HOST" ] && [ -n "${RENDER_EXTERNAL_URL:-}" ]; then
  SELF_HOST=$(printf '%s' "$RENDER_EXTERNAL_URL" | sed -e 's|^[a-zA-Z][a-zA-Z0-9+.-]*://||' -e 's|/.*$||' -e 's|:[0-9]*$||')
fi

API_HINT=""
if [ -n "$SELF_HOST" ] && [ "$API_HOST" = "$SELF_HOST" ]; then
  # Pointing /api at this same container makes every API call loop back into the
  # static file handler -> "405 Not Allowed" and no way to register or log in.
  echo "[entrypoint] ERROR: API_UPSTREAM=$API_UPSTREAM points at this service itself ($SELF_HOST)."
  echo "[entrypoint]        Set API_UPSTREAM to the BACKEND service URL (Render -> your backend -> its .onrender.com URL)."
  echo "[entrypoint]        /api requests will answer 502 until that is fixed."
  API_UPSTREAM="http://api-upstream-not-configured.invalid:9"
  API_HINT="API_UPSTREAM currently points at this same service (self-reference). "
fi

# 127.0.0.11 is Docker's embedded DNS and does not exist on Render/Railway/Fly,
# where it fails with "recv() failed (111: Connection refused) ... resolver".
case "${RESOLVER:-}" in
  "") RESOLVER="8.8.8.8 1.1.1.1" ;;
esac

export API_UPSTREAM API_HINT RESOLVER
echo "[entrypoint] PORT=${PORT:-80} API_UPSTREAM=${API_UPSTREAM} RESOLVER=${RESOLVER}"

exec /docker-entrypoint.sh "$@"
