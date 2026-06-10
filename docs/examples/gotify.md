# Gotify notifications

[Gotify](https://gotify.net) is a self-hosted push notification server — great for
keeping alerts inside your own infrastructure.

## 1. Create an application token in Gotify
1. Log into your Gotify server (e.g. `https://gotify.example.com`).
2. Go to **Apps → Create Application**, give it a name (e.g. `LogWatch`).
3. Copy the generated **token** (looks like `A1b2C3d4E5f6G7h`).

## 2. Add the channel in LogWatch
UI: **Alerts → + Add channel → type `gotify`**:
- **Gotify URL**: `https://gotify.example.com`
- **App token**: the token from step 1

Or via API:
```bash
curl -X POST https://panel.example.com/api/v1/channels \
  -H "authorization: Bearer $JWT" -H 'content-type: application/json' \
  -d '{
    "name": "Gotify",
    "type": "gotify",
    "config": {
      "url": "https://gotify.example.com",
      "token": "A1b2C3d4E5f6G7h"
    }
  }'
```

## 3. Test it
```bash
curl -X POST https://panel.example.com/api/v1/channels/<id>/test \
  -H "authorization: Bearer $JWT"
```

LogWatch maps levels to Gotify priorities so your devices can filter:

| LogWatch level | Gotify priority |
|----------------|-----------------|
| critical       | 10 |
| error          | 8  |
| warning        | 5  |
| info / other   | 3  |

The message body includes the server name, source, and the matched log line.

### Raw request LogWatch makes
```
POST https://gotify.example.com/message?token=A1b2C3d4E5f6G7h
Content-Type: application/json

{ "title": "[CRITICAL] Disk full", "message": "Server: db-01 | Source: syslog\n\nNo space left on device", "priority": 10 }
```
