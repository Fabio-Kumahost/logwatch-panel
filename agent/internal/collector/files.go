// Package collector implements log sources: tailed files, the systemd journal
// and Docker containers. Each emits model.Entry values on a shared channel.
package collector

import (
	"bufio"
	"context"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/Fabio-Kumahost/logwatch-panel/agent/internal/discovery"
	"github.com/Fabio-Kumahost/logwatch-panel/agent/internal/model"
)

// FileCollector tails a dynamic set of log files, following rotation/truncation.
type FileCollector struct {
	explicit []string
	host     string
	backfill int // ship the last N existing lines per file on first run
	out      chan<- model.Entry
	mu       sync.Mutex
	active   map[string]context.CancelFunc
}

func NewFileCollector(explicit []string, host string, backfill int, out chan<- model.Entry) *FileCollector {
	return &FileCollector{explicit: explicit, host: host, backfill: backfill, out: out, active: map[string]context.CancelFunc{}}
}

// Run periodically rescans for log files and tails any new ones until ctx ends.
func (c *FileCollector) Run(ctx context.Context) {
	c.rescan(ctx)
	t := time.NewTicker(30 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			c.rescan(ctx)
		}
	}
}

func (c *FileCollector) rescan(ctx context.Context) {
	for _, path := range discovery.Files(c.explicit) {
		c.mu.Lock()
		_, running := c.active[path]
		if !running {
			tctx, cancel := context.WithCancel(ctx)
			c.active[path] = cancel
			go c.tail(tctx, path)
		}
		c.mu.Unlock()
	}
}

func inode(fi os.FileInfo) uint64 {
	if st, ok := fi.Sys().(*syscall.Stat_t); ok {
		return st.Ino
	}
	return 0
}

// tail follows a single file, handling rotation (inode change) and truncation.
func (c *FileCollector) tail(ctx context.Context, path string) {
	defer func() {
		c.mu.Lock()
		delete(c.active, path)
		c.mu.Unlock()
	}()

	source := discovery.SourceFor(path)
	service := filepath.Base(path)
	var f *os.File
	var reader *bufio.Reader
	var curIno uint64
	var offset int64

	open := func(fromStart bool) bool {
		if f != nil {
			f.Close()
		}
		nf, err := os.Open(path)
		if err != nil {
			f = nil
			return false
		}
		fi, err := nf.Stat()
		if err != nil {
			nf.Close()
			f = nil
			return false
		}
		curIno = inode(fi)
		if fromStart {
			offset = 0
		} else {
			offset = fi.Size()
		}
		nf.Seek(offset, io.SeekStart)
		f = nf
		reader = bufio.NewReader(nf)
		return true
	}

	// First run: ship the most recent existing lines so the panel has history.
	if c.backfill > 0 {
		c.emitBackfill(ctx, path, source, service)
	}

	// Start at EOF so we only ship new lines, not the entire historical file.
	open(false)

	for {
		select {
		case <-ctx.Done():
			if f != nil {
				f.Close()
			}
			return
		default:
		}

		if f == nil {
			// File missing (e.g. mid-rotation) — wait and retry from start.
			if !sleepCtx(ctx, time.Second) {
				return
			}
			open(true)
			continue
		}

		line, err := reader.ReadString('\n')
		if len(line) > 0 {
			msg := trimNewline(line)
			if msg != "" {
				offset += int64(len(line))
				c.emit(ctx, model.Entry{
					Ts:      time.Now().Unix(),
					Source:  source,
					Service: service,
					Host:    c.host,
					Message: msg,
				})
			}
			continue
		}
		if err == io.EOF {
			// Detect rotation/truncation before sleeping.
			fi, statErr := os.Stat(path)
			if statErr != nil {
				f.Close()
				f = nil
				continue
			}
			if inode(fi) != curIno {
				// Rotated: reopen the new file from the beginning.
				open(true)
				continue
			}
			if fi.Size() < offset {
				// Truncated in place: restart from the beginning.
				f.Seek(0, io.SeekStart)
				reader = bufio.NewReader(f)
				offset = 0
				continue
			}
			if !sleepCtx(ctx, 500*time.Millisecond) {
				return
			}
			continue
		}
		if err != nil {
			f.Close()
			f = nil
		}
	}
}

// emitBackfill ships the last N lines of an existing file (reads at most the
// final 256KB so huge logs stay cheap).
func (c *FileCollector) emitBackfill(ctx context.Context, path, source, service string) {
	f, err := os.Open(path)
	if err != nil {
		return
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		return
	}
	const window = int64(256 * 1024)
	off := fi.Size() - window
	if off < 0 {
		off = 0
	}
	if _, err := f.Seek(off, io.SeekStart); err != nil {
		return
	}
	data, err := io.ReadAll(io.LimitReader(f, window))
	if err != nil {
		return
	}
	lines := strings.Split(string(data), "\n")
	if off > 0 && len(lines) > 0 {
		lines = lines[1:] // drop the partial first line
	}
	if len(lines) > c.backfill {
		lines = lines[len(lines)-c.backfill:]
	}
	now := time.Now().Unix()
	for _, ln := range lines {
		ln = trimNewline(ln)
		if ln == "" {
			continue
		}
		c.emit(ctx, model.Entry{Ts: now, Source: source, Service: service, Host: c.host, Message: ln})
	}
}

func (c *FileCollector) emit(ctx context.Context, e model.Entry) {
	select {
	case c.out <- e:
	case <-ctx.Done():
	}
}

func sleepCtx(ctx context.Context, d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-t.C:
		return true
	}
}

func trimNewline(s string) string {
	for len(s) > 0 && (s[len(s)-1] == '\n' || s[len(s)-1] == '\r') {
		s = s[:len(s)-1]
	}
	return s
}
