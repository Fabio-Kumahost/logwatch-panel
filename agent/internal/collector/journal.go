package collector

import (
	"bufio"
	"context"
	"encoding/json"
	"os/exec"
	"strconv"
	"time"

	"github.com/fabioagostinho/logwatch-panel/agent/internal/model"
)

// JournalCollector streams the systemd journal as JSON via `journalctl -f`.
type JournalCollector struct {
	host string
	out  chan<- model.Entry
}

func NewJournalCollector(host string, out chan<- model.Entry) *JournalCollector {
	return &JournalCollector{host: host, out: out}
}

// journald PRIORITY (syslog severity) -> our level names.
var prioLevel = map[string]string{
	"0": "critical", "1": "critical", "2": "critical", "3": "error",
	"4": "warning", "5": "notice", "6": "info", "7": "debug",
}

func (c *JournalCollector) Run(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		default:
		}
		c.stream(ctx)
		// journalctl exited (rotation, restart) — back off and retry.
		if !sleepCtx(ctx, 2*time.Second) {
			return
		}
	}
}

func (c *JournalCollector) stream(ctx context.Context) {
	cmd := exec.CommandContext(ctx, "journalctl", "-f", "-o", "json", "--no-pager", "-n", "0")
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return
	}
	if err := cmd.Start(); err != nil {
		return
	}
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		entry := c.parse(scanner.Bytes())
		if entry != nil {
			select {
			case c.out <- *entry:
			case <-ctx.Done():
				_ = cmd.Process.Kill()
				return
			}
		}
	}
	_ = cmd.Wait()
}

func (c *JournalCollector) parse(line []byte) *model.Entry {
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(line, &raw); err != nil {
		return nil
	}
	msg := jstr(raw["MESSAGE"])
	if msg == "" {
		return nil
	}
	service := jstr(raw["_SYSTEMD_UNIT"])
	if service == "" {
		service = jstr(raw["SYSLOG_IDENTIFIER"])
	}
	level := prioLevel[jstr(raw["PRIORITY"])]
	ts := time.Now().Unix()
	if rt := jstr(raw["__REALTIME_TIMESTAMP"]); rt != "" {
		if usec, err := strconv.ParseInt(rt, 10, 64); err == nil {
			ts = usec / 1_000_000
		}
	}
	host := jstr(raw["_HOSTNAME"])
	if host == "" {
		host = c.host
	}
	return &model.Entry{Ts: ts, Source: "journal", Service: service, Level: level, Host: host, Message: msg}
}

// jstr decodes a journal field that may be a string or an array of byte values.
func jstr(r json.RawMessage) string {
	if len(r) == 0 {
		return ""
	}
	var s string
	if err := json.Unmarshal(r, &s); err == nil {
		return s
	}
	var b []byte
	if err := json.Unmarshal(r, &b); err == nil {
		return string(b)
	}
	return ""
}
