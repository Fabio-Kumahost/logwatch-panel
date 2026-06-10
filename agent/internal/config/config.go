package config

import (
	"encoding/json"
	"errors"
	"os"
)

// Config mirrors the JSON written by the installer to
// /etc/logwatch-agent/config.json.
type Config struct {
	PanelURL        string   `json:"panel_url"`
	Token           string   `json:"token"`
	Hostname        string   `json:"hostname"`
	OS              string   `json:"os"`
	OSVersion       string   `json:"os_version"`
	IntervalSeconds int      `json:"interval_seconds"`
	BatchSize       int      `json:"batch_size"`
	BufferDir       string   `json:"buffer_dir"`
	InsecureTLS     bool     `json:"insecure_tls"`
	Journal         bool     `json:"journal"`
	Docker          bool     `json:"docker"`
	Files           []string `json:"files"`   // optional explicit globs (empty = auto-discover)
	Exclude         []string `json:"exclude"` // optional regex patterns to drop
}

// Load reads and validates the config file, applying sensible defaults.
func Load(path string) (*Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var c Config
	if err := json.Unmarshal(data, &c); err != nil {
		return nil, err
	}
	if c.PanelURL == "" {
		return nil, errors.New("panel_url is required in config")
	}
	if c.Token == "" {
		return nil, errors.New("token is required in config")
	}
	if c.IntervalSeconds <= 0 {
		c.IntervalSeconds = 5
	}
	if c.BatchSize <= 0 {
		c.BatchSize = 500
	}
	if c.BufferDir == "" {
		c.BufferDir = "/var/lib/logwatch-agent/buffer"
	}
	if c.Hostname == "" {
		if h, err := os.Hostname(); err == nil {
			c.Hostname = h
		}
	}
	return &c, nil
}
