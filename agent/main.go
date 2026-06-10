// LogWatch Agent — collects logs from the host and ships them to the panel.
// Single static binary, standard library only.
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os/signal"
	"regexp"
	"syscall"
	"time"

	"github.com/fabioagostinho/logwatch-panel/agent/internal/buffer"
	"github.com/fabioagostinho/logwatch-panel/agent/internal/collector"
	"github.com/fabioagostinho/logwatch-panel/agent/internal/config"
	"github.com/fabioagostinho/logwatch-panel/agent/internal/discovery"
	"github.com/fabioagostinho/logwatch-panel/agent/internal/model"
	"github.com/fabioagostinho/logwatch-panel/agent/internal/sender"
	"github.com/fabioagostinho/logwatch-panel/agent/internal/version"
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

	// Start collectors based on what the host actually provides.
	fc := collector.NewFileCollector(cfg.Files, cfg.Hostname, entries)
	go fc.Run(ctx)
	log.Printf("file collector started (%d files discovered)", len(discovery.Files(cfg.Files)))

	if cfg.Journal && discovery.HasJournal() {
		go collector.NewJournalCollector(cfg.Hostname, entries).Run(ctx)
		log.Printf("journal collector started")
	}
	if cfg.Docker && discovery.HasDocker() {
		go collector.NewDockerCollector(cfg.Hostname, entries).Run(ctx)
		log.Printf("docker collector started")
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
