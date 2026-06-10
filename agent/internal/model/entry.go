package model

// Entry is a single normalized log line ready to ship to the panel.
// Field names match the panel's ingest API.
type Entry struct {
	Ts      int64  `json:"ts,omitempty"`
	Source  string `json:"source,omitempty"`
	Service string `json:"service,omitempty"`
	Level   string `json:"level,omitempty"`
	Host    string `json:"host,omitempty"`
	Message string `json:"message"`
}
