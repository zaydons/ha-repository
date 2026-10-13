#!/bin/sh
# Runs as root: prepare /data, seed sample config (never overwrite), then
# drop to the node user (uid 1000) for the server. Design §7.5.
set -eu

CONFIG_DIR="${HL_CONFIG_DIR:-/config}"
DATA_DIR="${HL_DATA_DIR:-/data}"
SAMPLE_DIR=/app/sample

log() { printf '%s %s [entrypoint] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$2"; }

# We run as root here, and chown/chmod/cp follow symlinks. Anything in /data
# is writable by the node user, so a symlink there could point root at any
# file in the container. Never act through a symlink: the app-owned entries
# in /data are removed and recreated, the user's files in /config are skipped.
for p in "$DATA_DIR" "$CONFIG_DIR"; do
  if [ -L "$p" ]; then
    log ERROR "$p is a symlink; refusing to start"
    exit 1
  fi
done
for p in "$DATA_DIR/icon-cache" "$DATA_DIR/last-good.json"; do
  if [ -L "$p" ]; then
    log WARN "Removed symlink $p (the app recreates it)"
    rm -f "$p"
  fi
done

mkdir -p "$DATA_DIR/icon-cache" "$CONFIG_DIR"
chown -h node:node "$DATA_DIR" "$DATA_DIR/icon-cache"
chmod 700 "$DATA_DIR/icon-cache"
if [ -f "$DATA_DIR/last-good.json" ] && [ ! -L "$DATA_DIR/last-good.json" ]; then
  chown -h node:node "$DATA_DIR/last-good.json"
  chmod 600 "$DATA_DIR/last-good.json"
fi

for f in services.yaml settings.yaml; do
  if [ -L "$CONFIG_DIR/$f" ] && [ ! -e "$CONFIG_DIR/$f" ]; then
    log WARN "$f is a broken symlink; not creating a sample over it"
  elif [ ! -e "$CONFIG_DIR/$f" ]; then
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

# The Supervisor writes /data/options.json readable by root only, so the node
# user can't read it. Copy it (it holds only theme/log_level) into a directory
# only root can write, readable by the node group, and tell the app where it
# is. /data is node-owned, so refuse a symlink there; no node process is
# running yet, so nothing can swap the file between the check and the copy.
OPTIONS_SRC="$DATA_DIR/options.json"
OPTIONS_DIR=/run/homelab
OPTIONS_MAX_BYTES=65536
if [ -L "$OPTIONS_SRC" ]; then
  log WARN "options.json is a symlink; ignoring it and using default app options"
elif [ -f "$OPTIONS_SRC" ]; then
  size=$(wc -c < "$OPTIONS_SRC")
  if [ "$size" -gt "$OPTIONS_MAX_BYTES" ]; then
    log WARN "options.json is larger than $OPTIONS_MAX_BYTES bytes; using default app options"
  else
    rm -rf "$OPTIONS_DIR"
    mkdir -m 750 "$OPTIONS_DIR"
    chown root:node "$OPTIONS_DIR"
    cp "$OPTIONS_SRC" "$OPTIONS_DIR/options.json"
    chown root:node "$OPTIONS_DIR/options.json"
    chmod 640 "$OPTIONS_DIR/options.json"
    export HL_OPTIONS_FILE="$OPTIONS_DIR/options.json"
  fi
fi

exec su-exec node:node node /app/src/server.ts
