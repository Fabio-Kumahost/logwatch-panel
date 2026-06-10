// Package sender ships batches to the panel ingest API over HTTPS.
package sender

import (
	"bytes"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/Fabio-Kumahost/logwatch-panel/agent/internal/config"
	"github.com/Fabio-Kumahost/logwatch-panel/agent/internal/model"
	"github.com/Fabio-Kumahost/logwatch-panel/agent/internal/version"
)

type Sender struct {
	cfg    *config.Config
	client *http.Client
}

type payload struct {
	Host         string        `json:"host"`
	OS           string        `json:"os"`
	OSVersion    string        `json:"os_version"`
	AgentVersion string        `json:"agent_version"`
	Entries      []model.Entry `json:"entries,omitempty"`
}

func New(cfg *config.Config) *Sender {
	tr := &http.Transport{
		MaxIdleConns:        4,
		IdleConnTimeout:     60 * time.Second,
		TLSHandshakeTimeout: 10 * time.Second,
	}
	if cfg.InsecureTLS {
		tr.TLSClientConfig = &tls.Config{InsecureSkipVerify: true} // opt-in for self-signed panels
	}
	return &Sender{cfg: cfg, client: &http.Client{Timeout: 30 * time.Second, Transport: tr}}
}

func (s *Sender) meta(entries []model.Entry) payload {
	return payload{
		Host:         s.cfg.Hostname,
		OS:           s.cfg.OS,
		OSVersion:    s.cfg.OSVersion,
		AgentVersion: version.Version,
		Entries:      entries,
	}
}

func (s *Sender) post(path string, body payload) error {
	buf, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequest(http.MethodPost, s.cfg.PanelURL+path, bytes.NewReader(buf))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+s.cfg.Token)
	req.Header.Set("User-Agent", "logwatch-agent/"+version.Version)

	resp, err := s.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("panel returned HTTP %d", resp.StatusCode)
	}
	return nil
}

// Send ships a batch of log entries.
func (s *Sender) Send(entries []model.Entry) error {
	if len(entries) == 0 {
		return nil
	}
	return s.post("/api/v1/ingest", s.meta(entries))
}

// Heartbeat tells the panel the agent is alive when there are no new logs.
func (s *Sender) Heartbeat() error {
	return s.post("/api/v1/heartbeat", s.meta(nil))
}

// PostJSON sends an arbitrary JSON body to a panel path with agent auth.
func (s *Sender) PostJSON(path string, body any) error {
	buf, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequest(http.MethodPost, s.cfg.PanelURL+path, bytes.NewReader(buf))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+s.cfg.Token)
	resp, err := s.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("panel returned HTTP %d", resp.StatusCode)
	}
	return nil
}
