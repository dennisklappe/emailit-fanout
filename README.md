# emailit-fanout

Free webhook fan-out for Emailit. Enter **one** webhook URL in Emailit, and this Cloudflare Worker forwards each event to as many destinations as you like, each with its own filters. Built to get around the 3 webhook limit on AppSumo plans. Runs on the Cloudflare free tier.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/dennisklappe/emailit-fanout)

## Setup (2 minutes)

1. Click **Deploy to Cloudflare** above. When asked, fill in:
   - `EMAILIT_SIGNING_SECRET`: leave empty for now (the Worker answers 503 until you set it in step 3).
   - `DESTINATIONS`: your destinations as JSON (see below). Start with `[{"name":"test","url":"https://example.com/hook"}]`.
2. In Emailit, create a webhook pointing at your Worker URL (`https://emailit-fanout.<you>.workers.dev`) and subscribe it to the events you want. Copy its `whsec_...` secret.
3. In Cloudflare (Workers, emailit-fanout, Settings, Variables and Secrets) set `EMAILIT_SIGNING_SECRET` to that secret. From now on, requests with a bad signature are rejected with 401.

Change destinations any time by editing `DESTINATIONS` there. No redeploy needed.

## Destinations

`DESTINATIONS` is a JSON array:

```json
[
  { "name": "everything", "url": "https://logs.example.com/emailit" },
  {
    "name": "bounces-to-slackbridge",
    "url": "https://bridge.example.com/hook",
    "headers": { "Authorization": "Bearer abc" },
    "secret": "whsec_for_this_destination",
    "filter": { "types": ["email.bounced", "email.complained"], "domains": ["shop.example.com"] }
  },
  {
    "name": "crm-no-opens",
    "url": "https://crm.example.com/emailit",
    "filter": { "types": ["email.*"] },
    "exclude": { "types": ["email.loaded", "email.clicked"] }
  }
]
```

| Field | Meaning |
|---|---|
| `name`, `url` | Required. URL must be https. |
| `filter` | Event must match all given keys (non-empty). Omit to receive everything. |
| `exclude` | Event is skipped if it matches. Same keys as `filter`. |
| `headers` | Extra headers sent with every request. |
| `secret` | Re-sign the body with this secret using Emailit's scheme (`X-Emailit-Signature`, `X-Emailit-Timestamp`), so your existing verification code keeps working. |
| `format` | `"batch"` (default) sends Emailit's JSON array of matching events. `"single"` sends one bare event object per request, for receivers that cannot read arrays. |
| `disabled` | `true` to pause a destination. |

Filter keys (each a list, `*` is a wildcard, case-insensitive, any value in the list can match):

- `types`: event type, e.g. `email.bounced`, `email.*`, `domain.*`
- `domains`: sending domain (taken from the `from` address)
- `from`: sender address, e.g. `*@shop.example.com`
- `to`: recipient address, e.g. `*@customer.com`

By default destinations get a JSON array with only the events that matched, in Emailit's original format (see `format` for one event per request).

## Behavior

- Every delivery is stored in a Cloudflare Queue **before** Emailit gets its `200`. If storing fails, Emailit gets a `503` and retries the batch itself, so nothing is lost silently.
- Each destination gets its own queued job per webhook request, so a broken destination never blocks or duplicates the others.
- Failed deliveries (network errors, timeouts, 5xx, 408, 429) are retried with backoff (30s, 1m, 2m, ... up to 1h) for up to 13 attempts in total (the first plus 12 retries, about 5 hours), then moved to the `emailit-fanout-dead` queue. 401, 403 and 404 are retried too, because a rotated token or a typo in the URL is fixed by editing the config. Other 4xx and redirects are dropped and logged, because retrying will not help.
- Destinations are looked up when a job runs, so edits to `DESTINATIONS` apply to events already waiting.
- Delivery is at least once. A destination can see an event twice (for example after a timeout), so dedupe on `event_id` if it matters.
- On the Workers Free plan queues keep messages for 24 hours and allow 10,000 operations a day. A queued job (the events of one Emailit request that match one destination) costs 3 operations plus 1 per retry, so roughly 3,000 jobs a day. One email usually produces several events and each matching destination gets its own job, so narrow filters stretch the limit. On the paid plan retention is 4 days by default, up to 14 days (set with `wrangler queues update emailit-fanout-deliveries --message-retention-period-secs 1209600`), and 1 million operations a month are included.
- Failures are logged, see `wrangler tail`.
- Signature check follows the [Emailit docs](https://emailit.com/docs/webhooks/request-signature/): HMAC-SHA256 of `{timestamp}.{raw body}`, 5 minute tolerance.
- If `EMAILIT_SIGNING_SECRET` is not set the Worker refuses everything (503). Set `ALLOW_UNSIGNED=true` to skip verification (not recommended).
- An invalid `DESTINATIONS` value makes the Worker answer 400 (see `wrangler tail` for the reason), so Emailit will retry until you fix it.
- Without the queue binding (for example if you remove it from `wrangler.jsonc`) the Worker falls back to best effort delivery in the background with 3 quick attempts.

## Development

```sh
npm install
cp .dev.vars.example .dev.vars
npm run dev
npm test
```

## License

MIT
