// Built-in knowledge base: maps common log error patterns to a short
// explanation and concrete fix steps. Used by the log detail view.
const KB = [
  {
    re: /Failed password|Invalid user|authentication failure.*sshd|Connection closed by authenticating user/i,
    title: 'SSH login attempts / possible brute force',
    why: 'Someone (often automated bots) is guessing SSH credentials.',
    steps: [
      'Install fail2ban to auto-ban offenders: apt install fail2ban (works out of the box for sshd)',
      'Disable password auth, use keys: set "PasswordAuthentication no" in /etc/ssh/sshd_config, then: systemctl restart sshd',
      'Disable direct root login: "PermitRootLogin prohibit-password"',
      'Optionally move SSH to a non-standard port or restrict with a firewall (ufw allow from <your-ip> to any port 22)',
    ],
  },
  {
    re: /No space left on device|disk full|filesystem.*full/i,
    title: 'Disk full',
    why: 'A filesystem ran out of space — services will start failing to write.',
    steps: [
      'Find the full filesystem: df -h',
      'Find the biggest directories: du -xh --max-depth=2 / 2>/dev/null | sort -rh | head -20',
      'Shrink the journal: journalctl --vacuum-size=200M',
      'Clean package caches: apt clean  (or dnf clean all)',
      'Docker leftovers: docker system prune -a (CAUTION: removes unused images)',
    ],
  },
  {
    re: /Out of memory|oom-kill|Killed process|Cannot allocate memory/i,
    title: 'Out of memory (OOM)',
    why: 'The kernel killed a process because RAM (and swap) were exhausted.',
    steps: [
      'See what was killed and when: dmesg -T | grep -i oom',
      'Check current usage: free -h && ps aux --sort=-%mem | head',
      'Add swap as a quick mitigation: fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile',
      'Cap the offending service in its systemd unit: MemoryMax=…',
      'Long term: more RAM or tune the application (e.g. DB buffer sizes)',
    ],
  },
  {
    re: /connect\(\) failed.*Connection refused|connection refused.*upstream|ECONNREFUSED/i,
    title: 'Upstream/backend connection refused',
    why: 'A service tried to reach another (e.g. nginx → app) but nothing listens on that port.',
    steps: [
      'Is the backend running? systemctl status <service>',
      'Is it listening on the expected port? ss -tlnp | grep <port>',
      'Check the backend logs: journalctl -u <service> -n 50',
      'Verify the upstream address/port in the proxy config matches reality',
    ],
  },
  {
    re: /segfault|core[- ]dumped|signal 11|SIGSEGV/i,
    title: 'Process crashed (segmentation fault)',
    why: 'A program accessed invalid memory — usually a bug or corrupted install.',
    steps: [
      'Check which binary and how often: journalctl -k | grep -i segfault',
      'Reinstall/update the affected package',
      'If it is your own app: inspect core dumps (coredumpctl list / coredumpctl gdb)',
      'Repeated random segfaults across programs can mean bad RAM: run memtester',
    ],
  },
  {
    re: /Main process exited|Failed with result|start request repeated too quickly|failed to start/i,
    title: 'systemd service failed',
    why: 'A service exited unexpectedly or could not start.',
    steps: [
      'Full error: journalctl -u <service> -n 50 --no-pager',
      'Status + last start attempt: systemctl status <service>',
      'After fixing the cause: systemctl restart <service>',
      'If it crash-loops, stop the loop while debugging: systemctl stop <service>',
    ],
  },
  {
    re: /permission denied|EACCES|operation not permitted/i,
    title: 'Permission denied',
    why: 'A process lacks rights on a file, directory or port (<1024 needs root/capability).',
    steps: [
      'Check owner/permissions of the path in the message: ls -l <path>',
      'Fix ownership for the service user: chown <user>:<group> <path>',
      'For ports <1024 grant a capability instead of root: setcap cap_net_bind_service=+ep <binary>',
      'systemd sandboxing can also block paths — check ProtectSystem/ReadWritePaths in the unit',
    ],
  },
  {
    re: /address already in use|EADDRINUSE|bind.*failed/i,
    title: 'Port already in use',
    why: 'Two processes try to bind the same port.',
    steps: [
      'Who holds the port? ss -tlnp | grep <port>',
      'Stop the duplicate (systemctl stop …) or change the port in one config',
      'A zombie instance can be killed by PID: kill <pid>',
    ],
  },
  {
    re: /certificate (has )?expired|certificate verify failed|TLS handshake error|SSL_ERROR/i,
    title: 'TLS/certificate problem',
    why: 'An expired or invalid certificate breaks HTTPS connections.',
    steps: [
      'Check expiry: openssl s_client -connect <host>:443 2>/dev/null | openssl x509 -noout -dates',
      'Renew Let’s Encrypt: certbot renew (then reload nginx)',
      'If port 80 is blocked, renew via TLS-ALPN: certbot renew --preferred-challenges tls-alpn-01',
      'Verify system time is correct — clock drift breaks TLS: timedatectl',
    ],
  },
  {
    re: /Temporary failure in name resolution|could not resolve|DNS.*(fail|error)|NXDOMAIN/i,
    title: 'DNS resolution failure',
    why: 'The host cannot resolve domain names.',
    steps: [
      'Quick test: dig +short example.com  (or: getent hosts example.com)',
      'Check /etc/resolv.conf points to a working resolver',
      'systemd-resolved status: resolvectl status; restart: systemctl restart systemd-resolved',
      'Fallback: set nameserver 1.1.1.1 in /etc/resolv.conf to confirm it is DNS',
    ],
  },
  {
    re: /FATAL:\s+password authentication failed|Access denied for user|auth failed/i,
    title: 'Database/application authentication failed',
    why: 'Wrong credentials or auth rules between an app and its database.',
    steps: [
      'Verify the credentials in the application config match the DB user',
      'PostgreSQL: check pg_hba.conf rules and reload (systemctl reload postgresql)',
      'MySQL/MariaDB: check user@host grants: SELECT user,host FROM mysql.user;',
      'Reset the password if unsure (ALTER USER … WITH PASSWORD …)',
    ],
  },
  {
    re: /I\/O error|read-only file system|EXT4-fs error|XFS.*error|blk_update_request/i,
    title: 'Disk/filesystem errors',
    why: 'The kernel reports storage problems — possibly a failing disk.',
    steps: [
      'Check kernel messages: dmesg -T | grep -iE "error|fail" | tail',
      'SMART health: smartctl -H /dev/sdX (apt install smartmontools)',
      'A filesystem remounted read-only needs fsck from a rescue environment',
      'BACK UP IMPORTANT DATA FIRST — these errors often precede disk death',
    ],
  },
  {
    re: /time (jump|drift)|clock.*(skew|unsynchron)|NTP.*(fail|unreach)/i,
    title: 'Clock/time sync problem',
    why: 'Wrong system time breaks TLS, logs ordering and schedulers.',
    steps: [
      'Status: timedatectl',
      'Enable NTP: timedatectl set-ntp true (uses systemd-timesyncd)',
      'Or install chrony: apt install chrony && systemctl enable --now chrony',
    ],
  },
  {
    re: /link (is )?down|carrier lost|eth\d.*down|network unreachable/i,
    title: 'Network link down',
    why: 'A network interface lost its connection.',
    steps: [
      'Interface state: ip link',
      'Physical: check cable/switch port (for VMs: the virtual NIC/bridge)',
      'Bring it up: ip link set <iface> up; check DHCP/static config',
      'Logs: journalctl -u systemd-networkd (or NetworkManager) -n 50',
    ],
  },
];

// Returns { title, why, steps } for a log entry, or a generic fallback for
// error-level entries, or null when no advice applies.
export function suggestFix(entry) {
  const msg = entry.message || '';
  for (const item of KB) {
    if (item.re.test(msg)) return { title: item.title, why: item.why, steps: item.steps };
  }
  if (entry.level === 'error' || entry.level === 'critical') {
    return {
      title: 'General troubleshooting',
      why: 'No specific pattern matched this error.',
      steps: [
        `Service logs: journalctl -u ${entry.service || '<service>'} -n 50 --no-pager`,
        'Check service state: systemctl status ' + (entry.service || '<service>'),
        'Search the exact message — paste the quoted part into a search engine',
        'Check resources: df -h (disk), free -h (RAM), uptime (load)',
      ],
    };
  }
  return null;
}
