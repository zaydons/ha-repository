#!/bin/sh
# Runs as root: prepare /data, seed sample config (never overwrite), then
# drop to the node user (uid 1000) for the server. Design §7.5.
set -eu

CONFIG_DIR="${HL_CONFIG_DIR:-/config}"
DATA_DIR="${HL_DATA_DIR:-/data}"
SAMPLE_DIR=/app/sample

log() { printf '%s %s [entrypoint] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$2"; }

mkdir -p "$DATA_DIR/icon-cache" "$CONFIG_DIR"
chown node:node "$DATA_DIR" "$DATA_DIR/icon-cache"
chmod 700 "$DATA_DIR/icon-cache"
if [ -f "$DATA_DIR/last-good.json" ]; then
  chown node:node "$DATA_DIR/last-good.json"
  chmod 600 "$DATA_DIR/last-good.json"
fi

for f in services.yaml settings.yaml; do
  if [ ! -e "$CONFIG_DIR/$f" ]; then
    cp "$SAMPLE_DIR/$f" "$CONFIG_DIR/$f"
    chmod 644 "$CONFIG_DIR/$f"
    log INFO "Created sample $f in the app's config folder"
  fi
done

for f in services.yaml settings.yaml secrets.yaml; do
  if [ -e "$CONFIG_DIR/$f" ] && ! su-exec node:node test -r "$CONFIG_DIR/$f"; then
    log ERROR "$f exists but the app (uid 1000) can't read it. Make it readable, e.g. chmod 644."
  fi
done

exec su-exec node:node node /app/src/server.ts
