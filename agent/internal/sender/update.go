package sender

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"runtime"
	"strings"
)

// GOARCH -> binary suffix served by the panel.
var archSuffix = map[string]string{
	"amd64": "amd64",
	"arm64": "arm64",
	"arm":   "armv7",
	"386":   "386",
}

// LatestAgentVersion asks the panel which agent version it distributes.
func (s *Sender) LatestAgentVersion() (string, error) {
	resp, err := s.client.Get(s.cfg.PanelURL + "/api/v1/agent/version")
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("panel returned HTTP %d", resp.StatusCode)
	}
	var v struct {
		Version string `json:"version"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&v); err != nil {
		return "", err
	}
	return strings.TrimSpace(v.Version), nil
}

// SelfUpdate downloads and atomically installs the panel's latest agent binary
// when it differs from the running version. The replacement is verified by
// executing it with --version before the rename. Returns true when the caller
// should exit so systemd restarts the new binary.
func (s *Sender) SelfUpdate(current string) (bool, error) {
	latest, err := s.LatestAgentVersion()
	if err != nil {
		return false, err
	}
	if latest == "" || latest == current {
		return false, nil
	}
	arch := archSuffix[runtime.GOARCH]
	if arch == "" {
		return false, fmt.Errorf("unsupported architecture %s", runtime.GOARCH)
	}
	exe, err := os.Executable()
	if err != nil {
		return false, err
	}

	url := fmt.Sprintf("%s/agent/download/logwatch-agent-linux-%s", s.cfg.PanelURL, arch)
	resp, err := s.client.Get(url)
	if err != nil {
		return false, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return false, fmt.Errorf("binary download returned HTTP %d", resp.StatusCode)
	}

	tmp := exe + ".new"
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o755)
	if err != nil {
		return false, fmt.Errorf("cannot write %s (binary not owned by agent user, or unit lacks ReadWritePaths): %w", tmp, err)
	}
	if _, err := io.Copy(f, resp.Body); err != nil {
		f.Close()
		os.Remove(tmp)
		return false, err
	}
	f.Close()

	// Verify the download actually runs and reports the expected version.
	out, err := exec.Command(tmp, "--version").Output()
	if err != nil || !strings.Contains(string(out), latest) {
		os.Remove(tmp)
		return false, fmt.Errorf("downloaded binary failed verification (got %q)", strings.TrimSpace(string(out)))
	}
	if err := os.Rename(tmp, exe); err != nil {
		os.Remove(tmp)
		return false, err
	}
	return true, nil
}
