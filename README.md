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
| `disabled` | `true` to pause a destination. |

Filter keys (each a list, `*` is a wildcard, case-insensitive, any value in the list can match):

- `types`: event type, e.g. `email.bounced`, `email.*`, `domain.*`
- `domains`: sending domain (taken from the `from` address)
- `from`: sender address, e.g. `*@shop.example.com`
- `to`: recipient address, e.g. `*@customer.com`

Destinations get a JSON array with only the events that matched, in Emailit's original format.

## Behavior

- Emailit gets a `200` immediately; delivery continues in the background.
- Each destination is tried up to 3 times on network errors, timeouts, 5xx, 408 and 429. Other 4xx are not retried.
- Delivery failures are logged (`wrangler tail`) and not sent back to Emailit, so one broken destination never causes duplicate deliveries to the others.
- Signature check follows the [Emailit docs](https://emailit.com/docs/webhooks/request-signature/): HMAC-SHA256 of `{timestamp}.{raw body}`, 5 minute tolerance.
- If `EMAILIT_SIGNING_SECRET` is not set the Worker refuses everything (503). Set `ALLOW_UNSIGNED=true` to skip verification (not recommended).
- An invalid `DESTINATIONS` value makes the Worker answer 400 (see `wrangler tail` for the reason), so Emailit will retry until you fix it.
- Redirects are not followed or retried.

## Development

```sh
npm install
cp .dev.vars.example .dev.vars
npm run dev
npm test
```

## License

MIT
