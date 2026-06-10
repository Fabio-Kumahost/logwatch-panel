#!/usr/bin/env bash
# LogWatch Agent installer — supports most Linux distributions.
# Served by the panel at: <PANEL>/agent/install.sh
#
# Usage:
#   curl -sSL <PANEL>/agent/install.sh | sudo bash -s -- --panel <PANEL> --token <TOKEN>
#
# Options:
#   --panel URL      Panel base URL (required)
#   --token TOKEN    Per-server agent token (required)
#   --interval N     Send interval in seconds (default 5)
#   --insecure       Skip TLS verification (self-signed panels; not recommended)
#   --run-as-root    Run the agent as root (reads ALL logs incl. /var/log/secure)
#   --uninstall      Remove the agent
set -euo pipefail

PANEL_URL="__PANEL_URL_DEFAULT__"
TOKEN=""
INTERVAL="5"
INSECURE="false"
RUN_AS_ROOT="false"
DO_UNINSTALL="false"

AGENT_USER="logwatch"
BIN_PATH="/usr/local/bin/logwatch-agent"
CONF_DIR="/etc/logwatch-agent"
CONF_FILE="${CONF_DIR}/config.json"
STATE_DIR="/var/lib/logwatch-agent"
VERSION="1.1.0"

log()  { printf '\033[0;36m[logwatch]\033[0m %s\n' "$*"; }
ok()   { printf '\033[0;32m[ ok ]\033[0m %s\n' "$*"; }
warn() { printf '\033[0;33m[warn]\033[0m %s\n' "$*"; }
err()  { printf '\033[0;31m[fail]\033[0m %s\n' "$*" >&2; }
die()  { err "$*"; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --panel) PANEL_URL="${2:-}"; shift 2;;
    --token) TOKEN="${2:-}"; shift 2;;
    --interval) INTERVAL="${2:-5}"; shift 2;;
    --insecure) INSECURE="true"; shift;;
    --run-as-root) RUN_AS_ROOT="true"; shift;;
    --uninstall) DO_UNINSTALL="true"; shift;;
    *) warn "ignoring unknown option: $1"; shift;;
  esac
done

[ "$(id -u)" -eq 0 ] || die "must run as root (use sudo)."

# ---------------------------------------------------------------------------
# OS / arch detection
# ---------------------------------------------------------------------------
detect_os() {
  OS_ID="unknown"; OS_VER="unknown"
  if [ -r /etc/os-release ]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    OS_ID="${ID:-unknown}"
    OS_VER="${VERSION_ID:-unknown}"
  fi
  case "$(uname -m)" in
    x86_64|amd64) ARCH="amd64";;
    aarch64|arm64) ARCH="arm64";;
    armv7l|armv6l) ARCH="armv7";;
    i386|i686) ARCH="386";;
    *) die "unsupported architecture: $(uname -m)";;
  esac
  if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
    INIT="systemd"
  elif command -v rc-update >/dev/null 2>&1; then
    INIT="openrc"
  else
    INIT="none"
  fi
  log "detected: ${OS_ID} ${OS_VER} (${ARCH}), init: ${INIT}"
}

pkg_install() {
  # Best-effort install of curl + ca-certificates. The agent itself is a static
  # binary with no runtime dependencies, so this is only for the installer.
  command -v curl >/dev/null 2>&1 && command -v update-ca-certificates >/dev/null 2>&1 && return 0
  if command -v apt-get >/dev/null 2>&1; then apt-get update -qq && apt-get install -y -qq curl ca-certificates || true
  elif command -v dnf >/dev/null 2>&1; then dnf install -y -q curl ca-certificates || true
  elif command -v yum >/dev/null 2>&1; then yum install -y -q curl ca-certificates || true
  elif command -v zypper >/dev/null 2>&1; then zypper -q install -y curl ca-certificates || true
  elif command -v pacman >/dev/null 2>&1; then pacman -Sy --noconfirm curl ca-certificates || true
  elif command -v apk >/dev/null 2>&1; then apk add --no-cache curl ca-certificates || true
  fi
}

# ---------------------------------------------------------------------------
# Uninstall
# ---------------------------------------------------------------------------
uninstall() {
  log "uninstalling agent..."
  if [ "$INIT" = "systemd" ]; then
    systemctl stop logwatch-agent 2>/dev/null || true
    systemctl disable logwatch-agent 2>/dev/null || true
    rm -f /etc/systemd/system/logwatch-agent.service
    systemctl daemon-reload 2>/dev/null || true
  elif [ "$INIT" = "openrc" ]; then
    rc-service logwatch-agent stop 2>/dev/null || true
    rc-update del logwatch-agent 2>/dev/null || true
    rm -f /etc/init.d/logwatch-agent
  fi
  rm -f "$BIN_PATH"
  rm -rf "$CONF_DIR" "$STATE_DIR"
  id "$AGENT_USER" >/dev/null 2>&1 && userdel "$AGENT_USER" 2>/dev/null || true
  ok "agent removed."
  exit 0
}

# ---------------------------------------------------------------------------
# Install
# ---------------------------------------------------------------------------
download_binary() {
  local url="${PANEL_URL%/}/agent/download/logwatch-agent-linux-${ARCH}"
  # Retries cover flaky connection establishment to the panel host.
  local curl_opts="-fSL --retry 10 --retry-delay 3 --retry-connrefused"
  [ "$INSECURE" = "true" ] && curl_opts="$curl_opts -k"
  log "downloading agent binary: ${url}"
  if curl $curl_opts -o "${BIN_PATH}.new" "$url"; then
    chmod 0755 "${BIN_PATH}.new"
    mv "${BIN_PATH}.new" "$BIN_PATH"
    ok "binary installed at ${BIN_PATH}"
    return 0
  fi
  warn "download failed — trying to build from source (requires Go)."
  build_from_source
}

build_from_source() {
  command -v go >/dev/null 2>&1 || die "binary download failed and Go is not installed to build from source."
  local src="${PANEL_URL%/}/agent/source.tar.gz"
  local tmp; tmp="$(mktemp -d)"
  curl -fSL${INSECURE:+k} -o "${tmp}/src.tar.gz" "$src" || die "could not fetch agent source from panel."
  tar -xzf "${tmp}/src.tar.gz" -C "$tmp"
  ( cd "${tmp}"/agent* && CGO_ENABLED=0 go build -o "$BIN_PATH" ./ ) || die "go build failed."
  chmod 0755 "$BIN_PATH"
  rm -rf "$tmp"
  ok "binary built from source."
}

create_user() {
  if [ "$RUN_AS_ROOT" = "true" ]; then
    RUNTIME_USER="root"; RUNTIME_GROUP="root"
    log "agent will run as root (full log access)."
    return
  fi
  RUNTIME_USER="$AGENT_USER"; RUNTIME_GROUP="$AGENT_USER"
  if ! id "$AGENT_USER" >/dev/null 2>&1; then
    useradd --system --no-create-home --shell /usr/sbin/nologin "$AGENT_USER" 2>/dev/null \
      || useradd --system --no-create-home --shell /sbin/nologin "$AGENT_USER" 2>/dev/null \
      || adduser -S -H -s /sbin/nologin "$AGENT_USER" 2>/dev/null || true
  fi
  # Grant read access to logs via standard groups where they exist.
  for grp in adm systemd-journal docker wheel; do
    getent group "$grp" >/dev/null 2>&1 && usermod -aG "$grp" "$AGENT_USER" 2>/dev/null \
      || addgroup "$AGENT_USER" "$grp" 2>/dev/null || true
  done
  log "created unprivileged user '${AGENT_USER}' (groups: adm, systemd-journal, docker)."
  warn "some root-only logs (e.g. /var/log/secure on RHEL) may be skipped. Re-run with --run-as-root for full access."
}

write_config() {
  mkdir -p "$CONF_DIR" "$STATE_DIR/buffer"
  local hostname; hostname="$(hostname -f 2>/dev/null || hostname)"
  cat > "$CONF_FILE" <<EOF
{
  "panel_url": "${PANEL_URL%/}",
  "token": "${TOKEN}",
  "hostname": "${hostname}",
  "os": "${OS_ID}",
  "os_version": "${OS_VER}",
  "interval_seconds": ${INTERVAL},
  "batch_size": 500,
  "buffer_dir": "${STATE_DIR}/buffer",
  "insecure_tls": ${INSECURE},
  "journal": true,
  "docker": true,
  "auto_update": true,
  "backfill_lines": 300,
  "files": [],
  "exclude": []
}
EOF
  # The agent must own its binary so auto-update can replace it (no privilege
  # gain: the binary already runs as this same user).
  chown "$RUNTIME_USER":"$RUNTIME_GROUP" "$BIN_PATH" 2>/dev/null || true
  chown -R "$RUNTIME_USER":"$RUNTIME_GROUP" "$STATE_DIR" 2>/dev/null || true
  # The agent runs as $RUNTIME_USER, so it must own (and be able to read) its
  # config, which holds the token. Keep it readable only by that user.
  chown "$RUNTIME_USER":"$RUNTIME_GROUP" "$CONF_DIR" "$CONF_FILE" 2>/dev/null || true
  chmod 0750 "$CONF_DIR"
  chmod 0600 "$CONF_FILE"
  ok "config written to ${CONF_FILE}"
}

install_systemd() {
  cat > /etc/systemd/system/logwatch-agent.service <<EOF
[Unit]
Description=LogWatch Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${RUNTIME_USER}
Group=${RUNTIME_GROUP}
ExecStart=${BIN_PATH} --config ${CONF_FILE}
Restart=always
RestartSec=5
# Hardening: the agent only needs to read logs and reach the network.
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=${STATE_DIR}
# /usr/local/bin so the agent can self-update its own binary.
ReadWritePaths=/usr/local/bin
ReadOnlyPaths=/var/log
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictSUIDSGID=true
RestrictRealtime=true
LockPersonality=true
MemoryMax=128M
CPUQuota=20%

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable logwatch-agent >/dev/null 2>&1 || true
  systemctl restart logwatch-agent
  ok "systemd service installed and started."
}

install_openrc() {
  cat > /etc/init.d/logwatch-agent <<EOF
#!/sbin/openrc-run
name="logwatch-agent"
command="${BIN_PATH}"
command_args="--config ${CONF_FILE}"
command_background=true
pidfile="/run/logwatch-agent.pid"
command_user="${RUNTIME_USER}"
output_log="/var/log/logwatch-agent.log"
error_log="/var/log/logwatch-agent.log"
depend() { need net; }
EOF
  chmod +x /etc/init.d/logwatch-agent
  rc-update add logwatch-agent default >/dev/null 2>&1 || true
  rc-service logwatch-agent restart
  ok "OpenRC service installed and started."
}

test_connection() {
  local curl_opts="-fsS --retry 5 --retry-delay 2 --retry-connrefused"
  [ "$INSECURE" = "true" ] && curl_opts="$curl_opts -k"
  log "testing panel connectivity..."
  if curl $curl_opts "${PANEL_URL%/}/api/v1/health" >/dev/null 2>&1; then
    ok "panel reachable at ${PANEL_URL}"
  else
    warn "could not reach ${PANEL_URL}/api/v1/health — check firewall/DNS. Agent will buffer and retry."
  fi
}

main() {
  detect_os
  [ "$DO_UNINSTALL" = "true" ] && uninstall
  [ -n "$PANEL_URL" ] && [ "$PANEL_URL" != "__PANEL_URL_DEFAULT__" ] || die "--panel is required."
  [ -n "$TOKEN" ] || die "--token is required."

  pkg_install
  download_binary
  create_user
  write_config

  case "$INIT" in
    systemd) install_systemd;;
    openrc)  install_openrc;;
    *) die "no supported init system (systemd/openrc) found. Start ${BIN_PATH} --config ${CONF_FILE} manually.";;
  esac

  test_connection
  echo
  ok "LogWatch Agent ${VERSION} installed on ${OS_ID} ${OS_VER}."
  log "View logs:    journalctl -u logwatch-agent -f   (or /var/log/logwatch-agent.log on OpenRC)"
  log "Config:       ${CONF_FILE}"
  log "Uninstall:    curl -sSL ${PANEL_URL%/}/agent/install.sh | sudo bash -s -- --uninstall"
}

main
