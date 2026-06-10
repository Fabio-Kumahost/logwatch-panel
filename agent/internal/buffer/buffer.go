// Package buffer persists log batches to disk when the panel is unreachable and
// replays them once connectivity returns. Bounded to avoid unbounded disk use.
package buffer

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"

	"github.com/fabioagostinho/logwatch-panel/agent/internal/model"
)

const maxFiles = 2000 // ~ cap on buffered batches

type Buffer struct {
	dir string
	mu  sync.Mutex
}

func New(dir string) (*Buffer, error) {
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return nil, err
	}
	return &Buffer{dir: dir}, nil
}

// Save writes a batch to a uniquely named file.
func (b *Buffer) Save(entries []model.Entry) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.enforceCap()
	name := filepath.Join(b.dir, time.Now().UTC().Format("20060102T150405.000000000")+".ndjson")
	f, err := os.OpenFile(name, os.O_CREATE|os.O_WRONLY|os.O_EXCL, 0o640)
	if err != nil {
		return err
	}
	defer f.Close()
	enc := json.NewEncoder(f)
	for i := range entries {
		if err := enc.Encode(entries[i]); err != nil {
			return err
		}
	}
	return nil
}

// Drain replays buffered batches oldest-first. send must return nil on success;
// on the first failure Drain stops (keeping the remaining files for later).
func (b *Buffer) Drain(send func([]model.Entry) error) error {
	b.mu.Lock()
	files := b.sortedFiles()
	b.mu.Unlock()

	for _, file := range files {
		entries, err := load(file)
		if err != nil {
			// Corrupt file: drop it so it doesn't block the queue forever.
			_ = os.Remove(file)
			continue
		}
		if len(entries) == 0 {
			_ = os.Remove(file)
			continue
		}
		if err := send(entries); err != nil {
			return err
		}
		_ = os.Remove(file)
	}
	return nil
}

func (b *Buffer) sortedFiles() []string {
	matches, _ := filepath.Glob(filepath.Join(b.dir, "*.ndjson"))
	sort.Strings(matches)
	return matches
}

// enforceCap drops the oldest files when over the limit. Caller holds the lock.
func (b *Buffer) enforceCap() {
	files := b.sortedFiles()
	for len(files) >= maxFiles {
		_ = os.Remove(files[0])
		files = files[1:]
	}
}

func load(path string) ([]model.Entry, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	var out []model.Entry
	dec := json.NewDecoder(f)
	for dec.More() {
		var e model.Entry
		if err := dec.Decode(&e); err != nil {
			return out, err
		}
		out = append(out, e)
	}
	return out, nil
}
