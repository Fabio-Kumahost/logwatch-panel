package collector

import (
	"bufio"
	"context"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/Fabio-Kumahost/logwatch-panel/agent/internal/model"
)

// DockerCollector tails logs of all running containers, picking up new ones.
type DockerCollector struct {
	host   string
	out    chan<- model.Entry
	mu     sync.Mutex
	active map[string]context.CancelFunc
}

func NewDockerCollector(host string, out chan<- model.Entry) *DockerCollector {
	return &DockerCollector{host: host, out: out, active: map[string]context.CancelFunc{}}
}

func (c *DockerCollector) Run(ctx context.Context) {
	c.scan(ctx)
	t := time.NewTicker(30 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			c.scan(ctx)
		}
	}
}

func (c *DockerCollector) scan(ctx context.Context) {
	out, err := exec.CommandContext(ctx, "docker", "ps", "--format", "{{.Names}}").Output()
	if err != nil {
		return
	}
	for _, name := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		name = strings.TrimSpace(name)
		if name == "" {
			continue
		}
		c.mu.Lock()
		if _, running := c.active[name]; !running {
			tctx, cancel := context.WithCancel(ctx)
			c.active[name] = cancel
			go c.tail(tctx, name)
		}
		c.mu.Unlock()
	}
}

func (c *DockerCollector) tail(ctx context.Context, name string) {
	defer func() {
		c.mu.Lock()
		delete(c.active, name)
		c.mu.Unlock()
	}()
	// --tail 0 = only new lines; combine stdout+stderr (default).
	cmd := exec.CommandContext(ctx, "docker", "logs", "-f", "--tail", "0", "--timestamps", name)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return
	}
	cmd.Stderr = cmd.Stdout
	if err := cmd.Start(); err != nil {
		return
	}
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		msg := strings.TrimRight(scanner.Text(), "\r\n")
		if msg == "" {
			continue
		}
		select {
		case c.out <- model.Entry{Ts: time.Now().Unix(), Source: "docker", Service: name, Host: c.host, Message: msg}:
		case <-ctx.Done():
			_ = cmd.Process.Kill()
			return
		}
	}
	_ = cmd.Wait()
}
