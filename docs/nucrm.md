# Connecting NuCRM to AbetAPI

The two products integrate over HTTP, in both directions, with no shared
database. NuCRM is Postgres + Drizzle; AbetAPI and the AW suite are SQLite +
Prisma by default — the wire is the only meeting point, and everything here is
about that wire.

There are two directions, and they do not use the same signature scheme. The
NuCRM → AbetAPI direction is drop-in: NuCRM signs `sha256=<HMAC of the raw
body>` with the per-integration secret, and this receiver verifies exactly
that and nothing else — every real-delivery test in this document is written
against what NuCRM's `fireWebhooks` actually puts on the wire (measured
against its `main`, 24 Oct 2026), not against what an integrator must
hand-configure. The other direction is documented in full so an integrator can
verify it, but its construction is ours and a receiver has to expect it.

---

## 1. NuCRM → AbetAPI (the inbound bridge)

```
NuCRM tenant ──webhook(POST)──▶ /api/v1/inbound/nucrm/{source}
                                   │  verify x-nucrm-signature (the signature
                                   │  alone authenticates; a Bearer key, when
                                   │  one is sent, must also pass)
                                   │  dedupe on x-nucrm-delivery
                                   ▼
                              matching subscriptions
                          (one Delivery each, retried)
```

### Set it up

1. **AbetAPI dashboard → Connect NuCRM → Add source.** Name it (e.g. "NuCRM
   production"). The endpoint URL and the source secret are shown **once**.
2. **NuCRM → Settings → Integrations → Webhooks** (the tenant's integration
   webhook). Its config is `{ url, events, secret }` — measured against
   NuCRM's `app/api/tenant/webhooks/route.ts` on `main` (24 Oct 2026), there
   is **no custom-header field**, which is why the signature alone must (and
   does) authenticate the bridge. Configure:
   - **URL**: the endpoint from step 1,
     `https://your-abetapi.example/api/v1/inbound/nucrm/<source-id>`.
   - **Secret**: the source secret from step 1, unchanged.
   - **Events**: subscribe to the ones you want forwarded (`contact.created`,
     `deal.won`, …). An empty list means every event.

   A relay or forwarder posting on NuCRM's behalf *may* add
   `Authorization: Bearer <an AbetAPI key>` with the `events:write` scope;
   when a key is sent it must authenticate and the source must live in its
   workspace. NuCRM itself never sends one.
3. Subscribe AbetAPI webhooks (below, `/api/webhooks`) to the events you care
   about, or use one empty filter to receive everything.
4. Press NuCRM's test button. Within seconds the event shows up as deliveries
   in the AbetAPI dashboard, and the source row reads the last event received.

### What NuCRM sends

Body (`application/json`):

```json
{
  "event": "contact.created",
  "timestamp": "2026-10-16T09:00:00.000Z",
  "tenant_id": "t_123",
  "data": { "contact": { "id": "c_1", "email": "ada@example.com" } }
}
```

Headers:

| Header | Meaning |
|---|---|
| `x-nucrm-signature` | `sha256=<hex>`, HMAC-SHA256 over the exact body keyed by the source secret. The `sha256=` prefix is optional — both spellings verify. `x-webhook-signature` (NuCRM's plugin-receiver convention) is accepted identically. |
| `x-nucrm-delivery` | NuCRM's delivery id, stable across its retries. A repeat of one already accepted answers `200 {duplicate: true}` and publishes nothing. `x-webhook-delivery` is read too. |
| `authorization` | `Bearer <AbetAPI key>` with `events:write` — **optional**. NuCRM's integration webhook cannot send it; a forwarder may. When present it must authenticate. |

One measured quirk to build against: NuCRM's **retry** deliveries re-serialize
the payload from its JSONB column (`retryWebhookItem`, `JSON.stringify
(item.payload)`) while replaying the original signature header — key order and
number formatting can change, so a retry's signature may not verify byte for
byte even though the delivery id does. That is exactly why dedupe keys on
`x-nucrm-delivery`, and why a first attempt that verified already covers the
event: a failed verification on a *repeat* is NuCRM's, not your misconfiguration.

### What AbetAPI answers

| Status | Meaning |
|---|---|
| `202` | Accepted. Receipt: `{ event, delivered, retrying, skipped, accepted }` — identical to `POST /api/v1/events`. |
| `200` | `{ duplicate: true, … }` — this delivery id was already accepted; nothing was published again. |
| `401` | The signature does not verify — or a Bearer key was sent and did not authenticate. NuCRM will retry five times and park it; fix the secret and re-send from NuCRM's delivery log. |
| `409` | The source is paused. Re-enable it in the dashboard; the retry (or a re-send) will land. |
| `422` | Valid JSON whose fields are wrong — `error.fields` names them. |

### Verify a delivery yourself

```js
import { createHmac, timingSafeEqual } from "node:crypto";

const expected = createHmac("sha256", SOURCE_SECRET)
  .update(rawBody)                       // the bytes, before JSON.parse
  .digest("hex");
const provided = (req.headers["x-nucrm-signature"] ?? "").replace(/^sha256=/, "");
const ok =
  provided.length === expected.length &&
  timingSafeEqual(Buffer.from(provided, "hex"), Buffer.from(expected, "hex"));
```

This is exactly what `src/lib/inbound.ts` does, constants included.

### Try it locally

With `npm run dev` running and a seeded database (the seed prints a demo
source id and secret):

```bash
SOURCE_ID=<printed by seed>
SECRET='<printed by seed>'
BODY='{"event":"contact.created","timestamp":"2026-10-16T09:00:00.000Z","tenant_id":"t_1","data":{"contact":{"id":"c_1"}}}'
SIG=$(printf %s "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | awk '{print $2}')

curl -sS -w '\n%{http_code}\n' -X POST \
  "http://localhost:3700/api/v1/inbound/nucrm/$SOURCE_ID" \
  -H "content-type: application/json" \
  -H "x-nucrm-signature: sha256=$SIG" \
  -H "x-nucrm-delivery: 11111111-1111-1111-1111-111111111111" \
  -d "$BODY"
```

No key, no headers beyond those three: this is exactly what NuCRM sends, and
it is the shape the bridge was measured against. Add
`-H "Authorization: Bearer $KEY"` (the demo key printed by the seed) to see
the relay door — same answer, plus key-scoped quota and audit.

Run it twice: the second answer is `200 {"duplicate":true,…}` and nothing fans
out again.

---

## 2. AbetAPI → NuCRM (outbound)

AbetAPI's subscriptions (`POST /api/webhooks`, see the README) POST to any
address, so landing events in NuCRM is a matter of giving them a receiver. Two
shapes work today:

**a. Push records through NuCRM's API (recommended for data, not events).**
NuCRM's REST surface (`/api/v1/contacts`, `/api/v1/leads`, `/api/v1/deals`,
`/api/v1/tasks` — migration path `/api/tenant/…`) authenticates with tenant API
keys (`ak_…`) and scopes. An AbetAPI subscriber URL can be a small forwarder
you host whose only job is mapping `{event, data}` onto those endpoints; or an
AbetAPI-side worker can do the calls directly. This is the path where a
`lead.created` becomes a real CRM row instead of a log line.

**b. Receive the event as a NuCRM plugin webhook.** NuCRM's plugin webhook
verifier strips an optional `sha256=` prefix and compares HMAC-SHA256 **of the
body alone** — note that this is *not* the construction AbetAPI signs.

### Our signature, so a receiver can verify it

| Header | Meaning |
|---|---|
| `x-abetapi-signature` | Bare hex HMAC-SHA256 over `` `${x-abetapi-timestamp}.${rawBody}` ``, keyed by `sha256(your_webhook_secret)`. |
| `x-abetapi-timestamp` | Unix seconds, included in the signed string (so a captured body cannot be re-dated). |
| `x-abetapi-event` / `x-abetapi-delivery` / `x-abetapi-event-id` / `x-abetapi-attempt` | Event name, at-least-once dedupe key, event id, attempt number. |

The key discipline: AbetAPI stores only `sha256(secret)` and signs with that
hash; receivers hash the plaintext secret they hold (`printf %s "$SECRET" |
sha256sum`) and verify with the same value — nobody transmits a recoverable
secret in either direction. The receiver computes `HMAC(sha256(secret),
timestamp + "." + body)`. A receiver built against NuCRM's body-only plugin
verifier therefore cannot validate our deliveries as-is: adapt with a
forwarder that re-signs, or use path **(a)**.

Envelopes — each direction, as measured, not as assumed:

```jsonc
// NuCRM → us (§1, verbatim from its fireWebhooks)
{ "event": "contact.created", "timestamp": "2026-10-16T09:00:00.000Z", "tenant_id": "t_1", "data": { } }

// us → anyone (§2, ours)
{ "id": "…", "event": "contact.created", "timestamp": 1760605200, "data": { } }
```

NuCRM sends an **ISO** `timestamp` and a `tenant_id`; we send **unix seconds**
and no tenant field. Inbound `timestamp` and `tenant_id` are declared and
validated but not interpreted or forwarded — the fan-out re-stamps the event,
and subscribers see `{ id, event, timestamp, data }`. Multi-tenant NuCRM
installations that need the tenant downstream should put it in `data`.

---

## 3. Event names

Both systems use the same convention: `entity.action`, lowercase, dots. NuCRM
emits `contact.*`, `company.*`, `deal.*`, `lead.*`, `task.*`, `ticket.*`,
`invoice.*`, `product.*`, `form.submitted`, `automation.triggered`, and
`module.*`. AbetAPI passes inbound events through **verbatim** — a subscription
filtered on `deal.won` receives exactly the events NuCRM named `deal.won`, so
NuCRM's catalog is the catalog. AW-suite apps publish their own
(`lead.created`, `reply.received`, …) into the same space; filters are exact
matches, so an integration that wants one app's `lead.created` and not NuCRM's
should live in that app's own webhooks (leadworks, leadgenius and abetConnect
each have one) and an integration that wants everything central should
subscribe here empty.

## 4. Retries, dedupe, and where events park

- **NuCRM retries us**: five attempts, 5m / 30m / 2h / 12h / 24h, then its
  dead-letter queue. Every retry carries the same `x-nucrm-delivery`, so the
  bridge answers `duplicate` instead of double-publishing.
- **We retry subscribers**: at-least-once, backoff from 30s capped at 6h, eight
  attempts, then `DEAD` with a replay button. Receivers dedupe on
  `x-abetapi-delivery`.
- **Paused sources refuse** (`409`) instead of silently dropping — NuCRM's
  retry schedule means nothing is lost while you are fixing a misconfigured
  secret, as long as the pause is shorter than a day.

## 5. Troubleshooting

| Symptom | Likely cause |
|---|---|
| Every delivery `401` | The secret pasted into NuCRM is not the source's secret (it was re-created). No `Authorization` header is required — NuCRM cannot send one. |
| NuCRM marks every delivery `dead_letter` without a request arriving | Its `safeFetch` refuses private and reserved targets (SSRF guard, on first send *and* on every retry). The bridge must be on a public HTTPS address. |
| Retries `401` after the first attempt verified | NuCRM re-signs nothing on retry; the JSONB round-trip changed the bytes. Dedupe on `x-nucrm-delivery` covers it — see §1's quirk note. |
| `404` | No source with the id in the URL. With a Bearer key sent: the id exists but belongs to a different workspace than the key's — that scoping is on purpose. |
| `409` after working | The source was paused (dashboard), or NuCRM is pointed at a deleted source's id. |
| `422` naming `event` | NuCRM payload body empty or field renamed — check which integration fired. |
| Duplicates despite dedupe | The sender is not NuCRM's webhook integration (no `x-nucrm-delivery`), or it re-uses a delivery id for different events. |
| Events delivered but missing in NuCRM (direction 2) | Our signature construction differs from NuCRM's body-only plugin verifier — see §2. |
