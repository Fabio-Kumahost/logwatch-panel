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

# The checkout is owned by the service user but we run as root — tell git
# this repo is trusted so it doesn't refuse with "dubious ownership".
git config --global --add safe.directory "$INSTALL_DIR" 2>/dev/null || true

log "fetching latest ${BRANCH}..."
git -C "$INSTALL_DIR" fetch --depth 1 origin "$BRANCH" >/dev/null
git -C "$INSTALL_DIR" reset --hard "origin/${BRANCH}" >/dev/null

log "updating dependencies..."
( cd "${INSTALL_DIR}/panel" && npm install --omit=dev --no-audit --no-fund >/dev/null 2>&1 ) || die "npm install failed"

# Install/refresh the one-click updater so future updates can be triggered
# straight from the panel UI (Settings -> Software update -> Update now).
if [ -f "${INSTALL_DIR}/deploy/systemd/logwatch-panel-updater.path" ]; then
  install -m644 "${INSTALL_DIR}/deploy/systemd/logwatch-panel-updater.service" /etc/systemd/system/ 2>/dev/null || true
  install -m644 "${INSTALL_DIR}/deploy/systemd/logwatch-panel-updater.path" /etc/systemd/system/ 2>/dev/null || true
  rm -f "${INSTALL_DIR}/panel/data/update-requested" 2>/dev/null || true
  systemctl daemon-reload 2>/dev/null || true
  systemctl enable --now logwatch-panel-updater.path >/dev/null 2>&1 || true
  log "one-click updater installed (panel can now self-update from the UI)."
fi

# Schema is idempotent and applied on boot; run migrate explicitly too.
( cd "${INSTALL_DIR}/panel" && LOGWATCH_CONFIG=/etc/logwatch-panel/config.env node src/db/migrate.js >/dev/null ) || true

chown -R "$PANEL_USER":"$PANEL_USER" "$INSTALL_DIR"
systemctl restart logwatch-panel
sleep 2
systemctl is-active --quiet logwatch-panel && ok "panel updated and restarted" || die "panel failed to start — check journalctl -u logwatch-panel"
