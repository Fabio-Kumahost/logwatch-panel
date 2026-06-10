// LogWatch Agent — collects logs from the host and ships them to the panel.
// Single static binary, standard library only.
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"regexp"
	"syscall"
	"time"

	"github.com/Fabio-Kumahost/logwatch-panel/agent/internal/buffer"
	"github.com/Fabio-Kumahost/logwatch-panel/agent/internal/collector"
	"github.com/Fabio-Kumahost/logwatch-panel/agent/internal/config"
	"github.com/Fabio-Kumahost/logwatch-panel/agent/internal/discovery"
	"github.com/Fabio-Kumahost/logwatch-panel/agent/internal/metrics"
	"github.com/Fabio-Kumahost/logwatch-panel/agent/internal/model"
	"github.com/Fabio-Kumahost/logwatch-panel/agent/internal/sender"
	"github.com/Fabio-Kumahost/logwatch-panel/agent/internal/version"
)

func main() {
	configPath := flag.String("config", "/etc/logwatch-agent/config.json", "path to config file")
	showVersion := flag.Bool("version", false, "print version and exit")
	flag.Parse()

	if *showVersion {
		fmt.Printf("logwatch-agent %s\n", version.Version)
		return
	}

	cfg, err := config.Load(*configPath)
	if err != nil {
		log.Fatalf("config: %v", err)
	}

	buf, err := buffer.New(cfg.BufferDir)
	if err != nil {
		log.Fatalf("buffer: %v", err)
	}
	snd := sender.New(cfg)

	excludes := compileExcludes(cfg.Exclude)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	entries := make(chan model.Entry, 4096)

	// Backfill recent history only on the very first run (marker file).
	backfill := cfg.BackfillLines
	marker := filepath.Join(cfg.BufferDir, ".backfill-done")
	if _, err := os.Stat(marker); err == nil {
		backfill = 0
	}

	// Start collectors based on what the host actually provides.
	fc := collector.NewFileCollector(cfg.Files, cfg.Hostname, backfill, entries)
	go fc.Run(ctx)
	log.Printf("file collector started (%d files discovered, backfill=%d)", len(discovery.Files(cfg.Files)), backfill)

	if cfg.Journal && discovery.HasJournal() {
		go collector.NewJournalCollector(cfg.Hostname, backfill*3, entries).Run(ctx)
		log.Printf("journal collector started")
	}
	if cfg.Docker && discovery.HasDocker() {
		go collector.NewDockerCollector(cfg.Hostname, backfill, entries).Run(ctx)
		log.Printf("docker collector started")
	}
	if backfill > 0 {
		_ = os.WriteFile(marker, []byte(time.Now().UTC().Format(time.RFC3339)+"\n"), 0o640)
	}

	// Periodic host metrics (CPU/RAM/disk/load) every 30s.
	if cfg.MetricsEnabled() {
		go func() {
			tick := time.NewTicker(30 * time.Second)
			defer tick.Stop()
			for {
				if err := snd.PostJSON("/api/v1/metrics", metrics.Collect()); err != nil {
					log.Printf("metrics send: %v", err)
				}
				select {
				case <-ctx.Done():
					return
				case <-tick.C:
				}
			}
		}()
		log.Printf("host metrics reporting started")
	}

	// Periodic self-update against the panel's distributed agent version.
	if cfg.AutoUpdateEnabled() {
		go func() {
			delay := time.NewTimer(2 * time.Minute)
			defer delay.Stop()
			select {
			case <-ctx.Done():
				return
			case <-delay.C:
			}
			tick := time.NewTicker(time.Hour)
			defer tick.Stop()
			for {
				if updated, err := snd.SelfUpdate(version.Version); err != nil {
					log.Printf("self-update check: %v", err)
				} else if updated {
					log.Printf("agent updated — exiting so systemd restarts the new binary")
					os.Exit(0)
				}
				select {
				case <-ctx.Done():
					return
				case <-tick.C:
				}
			}
		}()
	}

	log.Printf("logwatch-agent %s shipping to %s every %ds", version.Version, cfg.PanelURL, cfg.IntervalSeconds)
	runBatcher(ctx, cfg, snd, buf, entries, excludes)
	log.Printf("shutdown complete")
}

func compileExcludes(patterns []string) []*regexp.Regexp {
	var out []*regexp.Regexp
	for _, p := range patterns {
		if re, err := regexp.Compile(p); err == nil {
			out = append(out, re)
		}
	}
	return out
}

func dropped(msg string, excludes []*regexp.Regexp) bool {
	for _, re := range excludes {
		if re.MatchString(msg) {
			return true
		}
	}
	return false
}

// runBatcher accumulates entries and flushes them on an interval or when full.
func runBatcher(ctx context.Context, cfg *config.Config, snd *sender.Sender, buf *buffer.Buffer, entries <-chan model.Entry, excludes []*regexp.Regexp) {
	ticker := time.NewTicker(time.Duration(cfg.IntervalSeconds) * time.Second)
	defer ticker.Stop()

	batch := make([]model.Entry, 0, cfg.BatchSize)

	flush := func() {
		if len(batch) == 0 {
			// Nothing to send — keep the panel's "last seen" fresh.
			if err := snd.Heartbeat(); err != nil {
				log.Printf("heartbeat failed: %v", err)
			}
			return
		}
		toSend := batch
		batch = make([]model.Entry, 0, cfg.BatchSize)
		if err := snd.Send(toSend); err != nil {
			log.Printf("send failed (%d buffered): %v", len(toSend), err)
			if serr := buf.Save(toSend); serr != nil {
				log.Printf("buffer save failed: %v", serr)
			}
			return
		}
		// Success: replay anything previously buffered.
		_ = buf.Drain(snd.Send)
	}

	for {
		select {
		case <-ctx.Done():
			flush()
			return
		case e := <-entries:
			if dropped(e.Message, excludes) {
				continue
			}
			batch = append(batch, e)
			if len(batch) >= cfg.BatchSize {
				flush()
			}
		case <-ticker.C:
			flush()
		}
	}
}
