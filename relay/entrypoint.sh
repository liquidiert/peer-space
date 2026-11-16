#!/bin/sh
# Starts iroh-relay. Access is locked when IROH_RELAY_HTTP_BEARER_TOKEN is set (the app
# checks each endpoint through IROH_RELAY_ACCESS_URL). Otherwise the relay is open.
set -eu

OPEN_CONFIG=/etc/iroh-relay/relay.toml
LOCKED_TEMPLATE=/etc/iroh-relay/relay-locked.toml.in
LOCKED_CONFIG=/tmp/relay.toml

if [ -n "${IROH_RELAY_HTTP_BEARER_TOKEN:-}" ]; then
  url="${IROH_RELAY_ACCESS_URL:-http://peerspace:3000/internal/relay-access}"
  case "$url" in
    http://*|https://*) ;;
    *)
      echo "entrypoint: IROH_RELAY_ACCESS_URL must start with http:// or https://" >&2
      exit 1
      ;;
  esac
  # The URL goes into a TOML string and a sed replacement, so reject characters that would break either.
  if printf '%s' "$url" | grep -q '[][[:space:]"\|&]'; then
    echo "entrypoint: IROH_RELAY_ACCESS_URL contains characters that are not allowed (quotes, backslash, |, &, brackets or whitespace)" >&2
    exit 1
  fi
  sed "s|@ACCESS_URL@|$url|" "$LOCKED_TEMPLATE" > "$LOCKED_CONFIG"
  echo "entrypoint: relay access is LOCKED (only signed-in users). Access checks go to $url"
  cfg="$LOCKED_CONFIG"
else
  echo "entrypoint: relay access is OPEN. Set RELAY_ACCESS_TOKEN to lock it."
  cfg="$OPEN_CONFIG"
fi

# iroh-relay silently falls back to its defaults (open access, port 80) when the config
# file is missing, so fail here instead.
if [ ! -f "$cfg" ]; then
  echo "entrypoint: config file $cfg not found" >&2
  exit 1
fi

exec iroh-relay --config-path "$cfg" "$@"
