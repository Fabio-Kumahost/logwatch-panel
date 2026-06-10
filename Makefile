VERSION ?= 1.2.0
LDFLAGS := -s -w -X github.com/Fabio-Kumahost/logwatch-panel/agent/internal/version.Version=$(VERSION)
BIN_DIR := agent-bin

.PHONY: all agent agent-all test clean panel-test

all: agent-all

# Build the agent for the host architecture (linux).
agent:
	cd agent && CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags "$(LDFLAGS)" -o ../$(BIN_DIR)/logwatch-agent-linux-amd64 .

# Cross-compile the agent for all supported Linux architectures.
agent-all:
	mkdir -p $(BIN_DIR)
	cd agent && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags "$(LDFLAGS)" -o ../$(BIN_DIR)/logwatch-agent-linux-amd64 .
	cd agent && CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -trimpath -ldflags "$(LDFLAGS)" -o ../$(BIN_DIR)/logwatch-agent-linux-arm64 .
	cd agent && CGO_ENABLED=0 GOOS=linux GOARCH=arm GOARM=7 go build -trimpath -ldflags "$(LDFLAGS)" -o ../$(BIN_DIR)/logwatch-agent-linux-armv7 .
	cd agent && CGO_ENABLED=0 GOOS=linux GOARCH=386 go build -trimpath -ldflags "$(LDFLAGS)" -o ../$(BIN_DIR)/logwatch-agent-linux-386 .
	@echo "$(VERSION)" > $(BIN_DIR)/VERSION
	@echo "built agent binaries $(VERSION) in $(BIN_DIR)/"

# Run the panel test suite.
panel-test test:
	cd panel && npm test

clean:
	rm -f $(BIN_DIR)/logwatch-agent-*
