# Discord webhook notifications

## 1. Create a webhook in Discord
1. Open your Discord **Server Settings → Integrations → Webhooks**.
2. Click **New Webhook**, choose a channel, copy the **Webhook URL**. It looks like:
   `https://discord.com/api/webhooks/123456789012345678/AbCdEf...`

## 2. Add the channel in LogWatch
UI: **Alerts → + Add channel → type `discord`**, paste the webhook URL.

Or via API:
```bash
curl -X POST https://panel.example.com/api/v1/channels \
  -H "authorization: Bearer $JWT" -H 'content-type: application/json' \
  -d '{
    "name": "Ops Discord",
    "type": "discord",
    "config": {
      "webhook_url": "https://discord.com/api/webhooks/123/AbCdEf",
      "username": "LogWatch"
    }
  }'
```

## 3. Test it
**Alerts → channel → Test**, or:
```bash
curl -X POST https://panel.example.com/api/v1/channels/<id>/test \
  -H "authorization: Bearer $JWT"
```
You should receive an embedded message in Discord. Alerts are sent as rich embeds
colored by level (critical = red, warning = orange, info = green) with the server,
source and rule name as fields.

## 4. Route a rule to it
Create a rule (e.g. *SSH brute force*) and select this channel as the target.
Example payload Discord receives:
```json
{
  "username": "LogWatch",
  "embeds": [{
    "title": "[ERROR] SSH brute force",
    "description": "```\nFailed password for invalid user admin from 10.0.0.9\n```",
    "color": 14431557,
    "fields": [
      { "name": "Server", "value": "web-01", "inline": true },
      { "name": "Source", "value": "auth", "inline": true },
      { "name": "Rule", "value": "SSH brute force", "inline": true }
    ]
  }]
}
```
