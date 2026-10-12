#!/bin/sh
# Home Assistant add-on entrypoint for Homepage. Computes the Host allow-list
# and client-network guard settings from /data/options.json, then hands over
# to the upstream Homepage entrypoint.
set -eu

LIB=/usr/local/lib/addon

PORT="${PORT:-3000}"
export PORT

if ! HOMEPAGE_ALLOWED_HOSTS="$(node "$LIB/addon-options.cjs" hosts)"; then
  echo "ERROR: could not compute allowed hosts; check the allowed_hosts option" >&2
  exit 1
fi
case "$HOMEPAGE_ALLOWED_HOSTS" in
  "" | *"*"*)
    echo "ERROR: refusing to start with an empty or wildcard host allow-list" >&2
    exit 1
    ;;
esac

if ! HOMEPAGE_ALLOWED_NETWORKS="$(node "$LIB/addon-options.cjs" networks)"; then
  echo "ERROR: could not read allowed networks; check the allowed_networks option" >&2
  exit 1
fi
export HOMEPAGE_ALLOWED_HOSTS HOMEPAGE_ALLOWED_NETWORKS

echo "Allowed hosts: $HOMEPAGE_ALLOWED_HOSTS"
if [ -n "$HOMEPAGE_ALLOWED_NETWORKS" ]; then
  echo "Allowed client networks: $HOMEPAGE_ALLOWED_NETWORKS (plus loopback)"
  case ",$HOMEPAGE_ALLOWED_NETWORKS," in
    *"/0,"*)
      echo "WARNING: client network guard effectively disabled (an allowed_networks entry is /0, which matches every address)"
      ;;
  esac
  NODE_OPTIONS="--require $LIB/lan-guard.cjs${NODE_OPTIONS:+ $NODE_OPTIONS}"
  export NODE_OPTIONS
else
  echo "WARNING: client network guard disabled (allowed_networks is empty)"
fi

exec /usr/local/bin/docker-entrypoint.sh "$@"
