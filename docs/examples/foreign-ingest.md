# Ingesting logs from non-agent sources

Any tool that can POST over HTTP can ship logs to LogWatch using a **server token**
(create a server in the panel, copy its token). Endpoint:

```
POST {PANEL}/api/v1/ingest/raw?source=<label>
Authorization: Bearer <SERVER_TOKEN>
```

## rsyslog (omhttp)
```rsyslog
module(load="omhttp")
action(
  type="omhttp"
  server="panel.example.com" serverport="443" usehttps="on"
  restpath="api/v1/ingest/raw?source=syslog"
  httpheaderkey="Authorization" httpheadervalue="Bearer <SERVER_TOKEN>"
  template="RSYSLOG_TraditionalFileFormat"
)
```

## Vector
```toml
[sinks.logwatch]
type = "http"
inputs = ["my_source"]
uri = "https://panel.example.com/api/v1/ingest/raw?source=vector"
encoding.codec = "text"
request.headers.Authorization = "Bearer <SERVER_TOKEN>"
```

## Fluent Bit
```ini
[OUTPUT]
    Name        http
    Match       *
    Host        panel.example.com
    Port        443
    TLS         On
    URI         /api/v1/ingest/raw?source=fluentbit
    Format      json_lines
    Header      Authorization Bearer <SERVER_TOKEN>
```

## Docker logging driver (per container)
Pipe `docker logs` or use a sidecar (Vector/Fluent Bit). For ad-hoc:
```bash
docker logs -f mycontainer | while read -r line; do
  curl -s -X POST "https://panel.example.com/api/v1/ingest/raw?source=docker&service=mycontainer" \
    -H "Authorization: Bearer <SERVER_TOKEN>" -H 'content-type: text/plain' --data-binary "$line"
done
```

## Native UDP syslog (network gear, firewalls, switches)
Enable on the panel host: set `SYSLOG_UDP_PORT=5514` and restart. Create a server
with its **Source IP** set to the device's IP, then point the device's syslog at
`udp://panel-host:5514`. Messages are mapped to that server by source IP.

> NDJSON works too — send `content-type: application/x-ndjson` with one JSON
> object (`{"message":"...","level":"error","service":"..."}`) per line. Fields
> are auto-extracted and become searchable.
