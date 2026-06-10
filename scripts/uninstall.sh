#!/usr/bin/env bash
# Remove the LogWatch Panel from this host.
#   sudo bash /opt/logwatch-panel/scripts/uninstall.sh [--purge]
# --purge also deletes the database and config.
set -euo pipefail

INSTALL_DIR="/opt/logwatch-panel"
CONF_DIR="/etc/logwatch-panel"
PANEL_USER="logwatch-panel"
PURGE="false"
[ "${1:-}" = "--purge" ] && PURGE="true"

log() { printf '\033[0;36m[logwatch]\033[0m %s\n' "$*"; }
ok()  { printf '\033[0;32m[ ok ]\033[0m %s\n' "$*"; }
die() { printf '\033[0;31m[fail]\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "must run as root."

log "stopping service..."
systemctl stop logwatch-panel 2>/dev/null || true
systemctl disable logwatch-panel 2>/dev/null || true
rm -f /etc/systemd/system/logwatch-panel.service
systemctl daemon-reload 2>/dev/null || true

log "removing nginx config..."
rm -f /etc/nginx/sites-enabled/logwatch-panel.conf /etc/nginx/sites-available/logwatch-panel.conf /etc/nginx/conf.d/logwatch-panel.conf 2>/dev/null || true
systemctl reload nginx 2>/dev/null || true

if [ "$PURGE" = "true" ]; then
  log "purging install dir and config (including database)..."
  rm -rf "$INSTALL_DIR" "$CONF_DIR"
  id "$PANEL_USER" >/dev/null 2>&1 && userdel "$PANEL_USER" 2>/dev/null || true
else
  log "removing application files (keeping ${CONF_DIR} and database; use --purge to delete them)..."
  rm -rf "${INSTALL_DIR}/panel/node_modules"
fi

ok "LogWatch Panel removed."
