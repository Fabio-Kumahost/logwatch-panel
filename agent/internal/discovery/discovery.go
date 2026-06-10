// Package discovery detects which log sources are present on the host so the
// agent never errors on missing files and adapts to each distribution.
package discovery

import (
	"os/exec"
	"path/filepath"
	"sort"
)

// Default file globs covering the sources requested across common distros.
// Missing paths are silently skipped.
var defaultGlobs = []string{
	"/var/log/syslog",
	"/var/log/messages",
	"/var/log/auth.log",
	"/var/log/secure",
	"/var/log/kern.log",
	"/var/log/dmesg",
	"/var/log/cron",
	"/var/log/cron.log",
	"/var/log/maillog",
	"/var/log/mail.log",
	"/var/log/daemon.log",
	"/var/log/nginx/*.log",
	"/var/log/apache2/*.log",
	"/var/log/httpd/*.log",
	"/var/log/mysql/*.log",
	"/var/log/mariadb/*.log",
	"/var/log/postgresql/*.log",
	"/var/log/redis/*.log",
	"/var/log/*.log",
	"/var/log/**/*.log",
}

// SourceFor returns a coarse "source" label from a file path.
func SourceFor(path string) string {
	switch {
	case contains(path, "nginx"):
		return "nginx"
	case contains(path, "apache2"), contains(path, "httpd"):
		return "apache"
	case contains(path, "mysql"), contains(path, "mariadb"):
		return "mysql"
	case contains(path, "postgres"):
		return "postgresql"
	case contains(path, "auth.log"), contains(path, "secure"):
		return "auth"
	case contains(path, "kern"), contains(path, "dmesg"):
		return "kernel"
	case contains(path, "mail"):
		return "mail"
	case contains(path, "cron"):
		return "cron"
	case contains(path, "syslog"), contains(path, "messages"):
		return "syslog"
	default:
		return "file"
	}
}

// Files returns the de-duplicated set of existing log files. If explicit globs
// are provided they replace the defaults.
func Files(explicit []string) []string {
	globs := defaultGlobs
	if len(explicit) > 0 {
		globs = explicit
	}
	seen := map[string]bool{}
	var out []string
	for _, g := range globs {
		matches, err := filepath.Glob(g)
		if err != nil {
			continue
		}
		for _, m := range matches {
			if seen[m] {
				continue
			}
			// Skip rotated/compressed archives; the tailer follows rotation live.
			if hasSuffixAny(m, ".gz", ".bz2", ".xz", ".zip", ".1", ".old") {
				continue
			}
			seen[m] = true
			out = append(out, m)
		}
	}
	sort.Strings(out)
	return out
}

// HasJournal reports whether journalctl is usable on this host.
func HasJournal() bool {
	_, err := exec.LookPath("journalctl")
	return err == nil
}

// HasDocker reports whether the docker CLI is usable.
func HasDocker() bool {
	_, err := exec.LookPath("docker")
	return err == nil
}

func contains(s, sub string) bool {
	return len(sub) > 0 && indexOf(s, sub) >= 0
}
func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}
func hasSuffixAny(s string, suf ...string) bool {
	for _, x := range suf {
		if len(s) >= len(x) && s[len(s)-len(x):] == x {
			return true
		}
	}
	return false
}
