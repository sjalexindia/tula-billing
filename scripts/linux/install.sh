#!/usr/bin/env bash
# Install Tula as a service on Linux (Debian/Ubuntu/Fedora...). Run from the unpacked Tula folder:
#   sudo ./scripts/linux/install.sh [--port 5000] [--preset building-materials]
# Layout: app in /opt/tula/app, data in /var/lib/tula (db, backups, logs), settings in /etc/tula/tula.env.
# Safe to run again. Needs Node.js 20+ (e.g. https://github.com/nodesource/distributions) and internet once.
set -euo pipefail

PORT=5000
PRESET=building-materials
APP_DIR=/opt/tula/app
DATA_DIR=/var/lib/tula
ENV_FILE=/etc/tula/tula.env
while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --preset) PRESET="$2"; shift 2 ;;
    *) echo "Unknown option $1"; exit 2 ;;
  esac
done

say() { printf '%s\n' "$*"; }
fail() { printf 'STOPPED: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fail "Run with sudo."
SRC="$(cd "$(dirname "$0")/../.." && pwd)"
[ -f "$SRC/apps/server/src/supervisor.ts" ] || fail "Run this from inside the Tula folder."

NODE="$(command -v node || true)"
[ -n "$NODE" ] || fail "Node.js is not installed. Install Node.js 20 or later, then run this again."
MAJOR="$("$NODE" -p 'process.versions.node.split(".")[0]')"
[ "$MAJOR" -ge 20 ] || fail "Node.js $("$NODE" --version) is too old; Tula needs 20 or later."
command -v rsync >/dev/null || fail "Please install rsync (apt install rsync)."

say "== Service user"
id tula >/dev/null 2>&1 || useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin tula
say "== App files -> $APP_DIR"
mkdir -p "$APP_DIR"
if [ "$SRC" != "$APP_DIR" ]; then
  rsync -a --delete --exclude node_modules --exclude .git --exclude data --exclude dist --exclude android \
    --exclude '*.db' --exclude '*.db-wal' --exclude '*.db-shm' --exclude tula.env --exclude '*.profile.json' "$SRC/" "$APP_DIR/"
fi
say "== Packages and web app (a few minutes)"
(cd "$APP_DIR" && npm ci --no-audit --no-fund && npm run build -w apps/web)
chown -R root:root "$APP_DIR"
chmod -R a+rX,go-w "$APP_DIR"

say "== Data -> $DATA_DIR"
mkdir -p "$DATA_DIR/backups" "$DATA_DIR/logs"
chown -R tula:tula "$DATA_DIR"
chmod 750 "$DATA_DIR"

say "== Settings -> $ENV_FILE"
mkdir -p "$(dirname "$ENV_FILE")"
if [ ! -f "$ENV_FILE" ]; then
  cat > "$ENV_FILE" <<CONF
# Tula settings for this computer. After changing: sudo systemctl restart tula
TULA_DB=$DATA_DIR/tula.db
TULA_PORT=$PORT
TULA_HOST=0.0.0.0
# Used only the very first time Tula starts:
TULA_PRESET=$PRESET
# TULA_PROFILE=$DATA_DIR/business.profile.json
# Cloud sync (later). Never share this file.
# TULA_SYNC_URL=
# TULA_SYNC_TOKEN=
CONF
else
  say "   keeping the existing file"
  PORT="$(sed -n 's/^TULA_PORT=//p' "$ENV_FILE" | tail -1)"; PORT="${PORT:-5000}"
fi
chown root:tula "$ENV_FILE"
chmod 640 "$ENV_FILE"

say "== Service"
sed "s#/usr/bin/env node#$NODE#" "$APP_DIR/scripts/linux/tula.service" > /etc/systemd/system/tula.service
systemctl daemon-reload
systemctl enable tula >/dev/null
systemctl restart tula

say "== Waiting for Tula"
for _ in $(seq 1 90); do
  if curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then break; fi
  sleep 2
done
(cd "$APP_DIR" && sudo -u tula "$NODE" --import tsx apps/server/src/cli/status.ts --env-file "$ENV_FILE") || true
if command -v ufw >/dev/null && ufw status | grep -q active; then
  say "Firewall: to let phones on the local network connect, run e.g.: sudo ufw allow from 192.168.0.0/16 to any port $PORT proto tcp"
fi
say "Done. First sign-in: Owner, PIN 1234. Logs: $DATA_DIR/logs, or: journalctl -u tula"
