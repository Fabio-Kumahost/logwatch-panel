#!/usr/bin/env bash
# Update an existing LogWatch Panel installation in place.
#   sudo bash /opt/logwatch-panel/scripts/update.sh
set -euo pipefail

INSTALL_DIR="/opt/logwatch-panel"
PANEL_USER="logwatch-panel"
BRANCH="${LW_BRANCH:-main}"

log() { printf '\033[0;36m[logwatch]\033[0m %s\n' "$*"; }
ok()  { printf '\033[0;32m[ ok ]\033[0m %s\n' "$*"; }
die() { printf '\033[0;31m[fail]\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "must run as root."
[ -d "${INSTALL_DIR}/.git" ] || die "no git checkout at ${INSTALL_DIR}; was the panel installed from the installer?"

log "fetching latest ${BRANCH}..."
git -C "$INSTALL_DIR" fetch --depth 1 origin "$BRANCH" >/dev/null
git -C "$INSTALL_DIR" reset --hard "origin/${BRANCH}" >/dev/null

log "updating dependencies..."
( cd "${INSTALL_DIR}/panel" && npm install --omit=dev --no-audit --no-fund >/dev/null 2>&1 ) || die "npm install failed"

# Schema is idempotent and applied on boot; run migrate explicitly too.
( cd "${INSTALL_DIR}/panel" && LOGWATCH_CONFIG=/etc/logwatch-panel/config.env node src/db/migrate.js >/dev/null ) || true

chown -R "$PANEL_USER":"$PANEL_USER" "$INSTALL_DIR"
systemctl restart logwatch-panel
sleep 2
systemctl is-active --quiet logwatch-panel && ok "panel updated and restarted" || die "panel failed to start — check journalctl -u logwatch-panel"
