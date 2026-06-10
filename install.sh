#!/usr/bin/env bash
# LogWatch Panel installer.
#
#   bash <(curl -sSL https://raw.githubusercontent.com/Fabio-Kumahost/logwatch-panel/main/install.sh)
#
# PRIVATE repository? Pass a GitHub read token so the installer can clone:
#   curl -fsSL -H "Authorization: token <GH_TOKEN>" \
#     https://raw.githubusercontent.com/Fabio-Kumahost/logwatch-panel/main/install.sh \
#     | sudo LW_GH_TOKEN=<GH_TOKEN> bash
#
# Non-interactive overrides (env vars):
#   LW_NONINTERACTIVE=1  LW_DOMAIN=panel.example.com  LW_SSL_EMAIL=me@x.com
#   LW_ADMIN_USER=admin  LW_ADMIN_PASS=secret  LW_PORT=8088  LW_GH_TOKEN=<token>
set -euo pipefail

REPO="https://github.com/Fabio-Kumahost/logwatch-panel.git"
BRANCH="main"
INSTALL_DIR="/opt/logwatch-panel"
CONF_DIR="/etc/logwatch-panel"
CONF_FILE="${CONF_DIR}/config.env"
PANEL_USER="logwatch-panel"
NODE_MAJOR="20"
PORT="${LW_PORT:-8088}"

log()  { printf '\033[0;36m[logwatch]\033[0m %s\n' "$*"; }
ok()   { printf '\033[0;32m[ ok ]\033[0m %s\n' "$*"; }
warn() { printf '\033[0;33m[warn]\033[0m %s\n' "$*"; }
die()  { printf '\033[0;31m[fail]\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "must run as root (use sudo)."

# ---------------------------------------------------------------------------
detect_os() {
  if [ -r /etc/os-release ]; then . /etc/os-release; OS_ID="${ID:-}"; OS_LIKE="${ID_LIKE:-}"; else die "cannot detect OS (no /etc/os-release)"; fi
  if command -v apt-get >/dev/null 2>&1; then PM="apt";
  elif command -v dnf >/dev/null 2>&1; then PM="dnf";
  elif command -v yum >/dev/null 2>&1; then PM="yum";
  elif command -v zypper >/dev/null 2>&1; then PM="zypper";
  elif command -v pacman >/dev/null 2>&1; then PM="pacman";
  elif command -v apk >/dev/null 2>&1; then PM="apk";
  else die "no supported package manager found"; fi
  log "detected ${PRETTY_NAME:-$OS_ID} (package manager: ${PM})"
}

install_base() {
  log "installing base packages (git, curl, nginx, build tools)..."
  case "$PM" in
    apt)
      export DEBIAN_FRONTEND=noninteractive
      apt-get update -qq
      apt-get install -y -qq ca-certificates curl git nginx python3 g++ make >/dev/null ;;
    dnf|yum)
      $PM install -y -q ca-certificates curl git nginx python3 gcc-c++ make >/dev/null || true ;;
    zypper)
      zypper -q install -y ca-certificates curl git nginx python3 gcc-c++ make >/dev/null || true ;;
    pacman)
      pacman -Sy --noconfirm ca-certificates curl git nginx python base-devel >/dev/null || true ;;
    apk)
      apk add --no-cache ca-certificates curl git nginx python3 g++ make >/dev/null || true ;;
  esac
}

install_node() {
  if command -v node >/dev/null 2>&1 && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 18 ] 2>/dev/null; then
    ok "node $(node -v) already installed"; return
  fi
  log "installing Node.js ${NODE_MAJOR}.x..."
  case "$PM" in
    apt)
      curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null 2>&1
      apt-get install -y -qq nodejs >/dev/null ;;
    dnf|yum)
      curl -fsSL "https://rpm.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null 2>&1
      $PM install -y -q nodejs >/dev/null ;;
    zypper) zypper -q install -y nodejs20 npm20 >/dev/null 2>&1 || zypper -q install -y nodejs npm >/dev/null ;;
    pacman) pacman -Sy --noconfirm nodejs npm >/dev/null ;;
    apk)    apk add --no-cache nodejs npm >/dev/null ;;
  esac
  command -v node >/dev/null 2>&1 || die "Node.js installation failed"
  ok "node $(node -v) installed"
}

fetch_source() {
  # For a PRIVATE repository, export LW_GH_TOKEN with a GitHub token that has
  # read access; it is injected into the clone URL and never written to disk.
  local clone_url="$REPO"
  if [ -n "${LW_GH_TOKEN:-}" ]; then
    clone_url="https://x-access-token:${LW_GH_TOKEN}@github.com/Fabio-Kumahost/logwatch-panel.git"
  fi
  if [ -d "${INSTALL_DIR}/.git" ]; then
    log "updating existing checkout..."
    git -C "$INSTALL_DIR" fetch --depth 1 origin "$BRANCH" >/dev/null 2>&1
    git -C "$INSTALL_DIR" reset --hard "origin/${BRANCH}" >/dev/null 2>&1
  else
    log "cloning repository..."
    rm -rf "$INSTALL_DIR"
    git clone --depth 1 --branch "$BRANCH" "$clone_url" "$INSTALL_DIR" >/dev/null 2>&1 \
      || die "git clone failed. Private repo? set LW_GH_TOKEN=<github token>. Also check the branch '$BRANCH' exists."
    # Make sure the stored remote has no embedded token.
    git -C "$INSTALL_DIR" remote set-url origin "$REPO" >/dev/null 2>&1 || true
  fi
  log "installing panel dependencies (this can take a minute)..."
  ( cd "${INSTALL_DIR}/panel" && npm install --omit=dev --no-audit --no-fund >/dev/null 2>&1 ) \
    || die "npm install failed"
  ok "source ready at ${INSTALL_DIR}"
}

create_user() {
  id "$PANEL_USER" >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin "$PANEL_USER" 2>/dev/null \
    || useradd --system --no-create-home --shell /sbin/nologin "$PANEL_USER" 2>/dev/null || true
  mkdir -p "${INSTALL_DIR}/panel/data"
  chown -R "$PANEL_USER":"$PANEL_USER" "$INSTALL_DIR"
}

ask() { # ask VAR "prompt" "default"
  local __var="$1" __prompt="$2" __def="${3:-}" __ans=""
  if [ "${LW_NONINTERACTIVE:-0}" = "1" ]; then printf -v "$__var" '%s' "$__def"; return; fi
  read -r -p "$__prompt" __ans </dev/tty || true
  printf -v "$__var" '%s' "${__ans:-$__def}"
}

configure() {
  mkdir -p "$CONF_DIR"
  local domain admin_user admin_pass jwt public_url
  domain="${LW_DOMAIN:-}"
  [ -z "$domain" ] && ask domain "Domain for the panel (blank = use server IP over HTTP): " ""
  admin_user="${LW_ADMIN_USER:-}"
  [ -z "$admin_user" ] && ask admin_user "Admin username [admin]: " "admin"
  admin_pass="${LW_ADMIN_PASS:-}"
  if [ -z "$admin_pass" ]; then
    if [ "${LW_NONINTERACTIVE:-0}" = "1" ]; then admin_pass="$(openssl rand -base64 18 2>/dev/null | tr -d '/+=' | cut -c1-20)";
    else ask admin_pass "Admin password (blank = auto-generate): " ""; fi
    [ -z "$admin_pass" ] && admin_pass="$(openssl rand -base64 18 2>/dev/null | tr -d '/+=' | cut -c1-20)"
  fi
  jwt="$(openssl rand -hex 48 2>/dev/null || head -c 48 /dev/urandom | xxd -p | tr -d '\n')"

  local server_ip; server_ip="$(curl -fsSL https://api.ipify.org 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}')"
  if [ -n "$domain" ]; then public_url="http://${domain}"; else public_url="http://${server_ip}"; fi

  cat > "$CONF_FILE" <<EOF
NODE_ENV=production
HOST=127.0.0.1
PORT=${PORT}
PUBLIC_URL=${public_url}
JWT_SECRET=${jwt}
DB_PATH=${INSTALL_DIR}/panel/data/logwatch.db
AGENT_BIN_DIR=../agent-bin
RETENTION_DAYS=14
TRUST_PROXY=true
EOF
  chmod 600 "$CONF_FILE"

  log "initializing database and admin account..."
  ( cd "${INSTALL_DIR}/panel" && \
    ADMIN_USER="$admin_user" ADMIN_PASS="$admin_pass" LOGWATCH_CONFIG="$CONF_FILE" \
    node src/db/migrate.js --seed-admin >/dev/null ) || die "database init failed"
  chown -R "$PANEL_USER":"$PANEL_USER" "${INSTALL_DIR}/panel/data"

  # Export for the summary.
  CFG_DOMAIN="$domain"; CFG_ADMIN_USER="$admin_user"; CFG_ADMIN_PASS="$admin_pass"
  CFG_PUBLIC_URL="$public_url"; CFG_SERVER_IP="$server_ip"
}

install_service() {
  install -m644 "${INSTALL_DIR}/deploy/systemd/logwatch-panel.service" /etc/systemd/system/logwatch-panel.service
  systemctl daemon-reload
  systemctl enable logwatch-panel >/dev/null 2>&1 || true
  systemctl restart logwatch-panel
  sleep 2
  systemctl is-active --quiet logwatch-panel && ok "panel service running" || die "panel service failed — check: journalctl -u logwatch-panel"
}

setup_nginx() {
  command -v nginx >/dev/null 2>&1 || { warn "nginx not installed; skipping reverse proxy"; return; }
  local server_name="${CFG_DOMAIN:-_}"
  local conf="/etc/nginx/sites-available/logwatch-panel.conf"
  [ -d /etc/nginx/sites-available ] || conf="/etc/nginx/conf.d/logwatch-panel.conf"
  sed -e "s/__DOMAIN__/${server_name}/g" -e "s/__PORT__/${PORT}/g" \
    "${INSTALL_DIR}/deploy/nginx/logwatch-panel.conf.template" > "$conf"
  if [ -d /etc/nginx/sites-enabled ]; then
    ln -sf "$conf" /etc/nginx/sites-enabled/logwatch-panel.conf
    rm -f /etc/nginx/sites-enabled/default 2>/dev/null || true
  fi
  nginx -t >/dev/null 2>&1 && systemctl restart nginx 2>/dev/null && systemctl enable nginx >/dev/null 2>&1 \
    && ok "nginx reverse proxy configured" || warn "nginx config test failed; review ${conf}"
}

setup_ssl() {
  [ -n "${CFG_DOMAIN:-}" ] || { log "no domain set — skipping SSL (you can run certbot later)"; return; }
  local want="${LW_SSL:-}"
  [ -z "$want" ] && ask want "Obtain a free Let's Encrypt certificate for ${CFG_DOMAIN}? [y/N]: " "n"
  case "$want" in y|Y|yes) ;; *) return;; esac
  local email="${LW_SSL_EMAIL:-}"; [ -z "$email" ] && ask email "Email for Let's Encrypt: " ""
  log "installing certbot..."
  case "$PM" in
    apt) apt-get install -y -qq certbot python3-certbot-nginx >/dev/null ;;
    dnf|yum) $PM install -y -q certbot python3-certbot-nginx >/dev/null || true ;;
    *) warn "automatic certbot install not supported on ${PM}; install manually"; return;;
  esac
  if certbot --nginx -d "$CFG_DOMAIN" --non-interactive --agree-tos -m "${email:-admin@${CFG_DOMAIN}}" --redirect >/dev/null 2>&1; then
    CFG_PUBLIC_URL="https://${CFG_DOMAIN}"
    sed -i "s#^PUBLIC_URL=.*#PUBLIC_URL=${CFG_PUBLIC_URL}#" "$CONF_FILE"
    systemctl restart logwatch-panel
    ok "SSL enabled — panel now at ${CFG_PUBLIC_URL}"
  else
    warn "certbot failed (DNS not pointing here yet?). Re-run later: certbot --nginx -d ${CFG_DOMAIN}"
  fi
}

summary() {
  echo
  echo "==================================================================="
  ok   "LogWatch Panel installed successfully!"
  echo "==================================================================="
  echo "  URL:       ${CFG_PUBLIC_URL}"
  echo "  Username:  ${CFG_ADMIN_USER}"
  echo "  Password:  ${CFG_ADMIN_PASS}"
  echo "-------------------------------------------------------------------"
  echo "  Config:    ${CONF_FILE}"
  echo "  Logs:      journalctl -u logwatch-panel -f"
  echo "  Restart:   systemctl restart logwatch-panel"
  echo
  echo "  Firewall: allow inbound 80/443 (HTTP/HTTPS), e.g.:"
  echo "     ufw allow 80,443/tcp        # Debian/Ubuntu"
  echo "     firewall-cmd --add-service={http,https} --permanent && firewall-cmd --reload"
  echo
  echo "  Add a server: open the panel, click 'Add server', and run the"
  echo "  generated one-liner on the target host. It looks like:"
  echo "     curl -sSL ${CFG_PUBLIC_URL}/agent/install.sh | sudo bash -s -- \\"
  echo "       --panel ${CFG_PUBLIC_URL} --token <SERVER_TOKEN>"
  echo "==================================================================="
}

main() {
  detect_os
  install_base
  install_node
  fetch_source
  create_user
  configure
  install_service
  setup_nginx
  setup_ssl
  summary
}

main
