# AbetAPI

![CI](https://github.com/coding4vinayak/aw-abetapi/actions/workflows/ci.yml/badge.svg)


The platform underneath the platform: scoped API keys, signed webhooks,
per-key usage metering and SSO connections — one contract, one audit trail.

## Quick start

```bash
npm install
cp .env.example .env        # DATABASE_URL points at the compose Postgres
docker compose up -d        # local Postgres 16
npx prisma migrate deploy   # applies the committed migrations
npm run db:seed             # demo workspace + root key (copy it once) + demo key
npm run dev                 # http://localhost:3700
```

`npm run test` runs 109 unit tests across ten files — key shape, scopes,
webhook signatures, retry, pagination, password and email handling, plus two
guards that read the route sources themselves: one that every handler
authenticates, one that every handler which reads a body checks it against a
declared field table. No server and no database: the guards are static, so a
forgotten route fails at the pull request rather than in production.

## Accounts (browser)

Machine callers authenticate with an API key above. Humans sign in:

```
GET  /login                # sign in
POST /signup               # create a workspace and an account
GET  /dashboard            # your own workspace (needs the session cookie)
GET  /members              # seats, invites, roles (owner/admin)
GET  /invite/{token}       # accept a one-time invitation link
```

A signup mints a `User` and a `Workspace` in one transaction and drops the
browser straight into it. Passwords are scrypt with the work factor recorded
beside the digest, so the cost can be raised later without invalidating anyone.
The session cookie holds a random 32-byte token and the database keeps only its
sha256; it is httpOnly, sameSite=lax, and `secure` outside development.

`?workspace=demo` stays public on purpose — it is what the landing pages link to
and what a prospect evaluates. Every other workspace requires the session that
owns it: naming someone else's slug is refused rather than served, and an
anonymous visitor is pointed at the login form instead of the data.

Sign-in is rate-limited per address (10 failures, 15-minute lock) and signup to
5 workspaces, so one client cannot grind through a list of accounts. Failed
logins take the same time whether or not the address exists.

A brand-new account has no API key, so the dashboard offers to mint one and
shows it exactly once — only a hash is stored. The prompt is scoped to
signed-in workspaces: a stranger on the public demo is never nagged to sign up.
It is a server action rather than a `POST /api/keys` call so the plaintext goes
straight into the page and never into a URL, a referrer, or an access log.

### Password reset and email verification

```
GET  /forgot-password             # request a reset link
GET  /reset-password?token=       # choose a new password
GET  /verify-email?token=         # confirm the address
```

Both links are **POST-only**: the page reads the token, the button redeems it. A
GET that changes state is triggered by link previewers, chat clients and
corporate scanners, so a single Slack unfurl would spend the token before the
person read it.

Tokens are stored hashed (sha256), single-use, and expired — reset in 1 hour,
verification in 24. Issuing a new one deletes the previous, so a link forwarded
last year stops working the moment a fresh one is requested. Reset requests are
rate limited to 3 per address per hour.

Redeeming a reset also **destroys every session on that account**. A password
change that leaves old cookies working evicts nobody, which defeats the entire
point of resetting. The same gap existed in abetConnect and is fixed there too.

The request endpoint answers identically whether or not the address has an
account — a "no such user" there is a customer enumeration oracle.

### Email delivery is honest about itself

`send()` returns which transport actually ran, and the UI says so:

| State | Behaviour |
|---|---|
| `RESEND_API_KEY` or `EMAIL_WEBHOOK_URL` set | Message is delivered; verification is enforced at sign-in |
| Neither set | Link is written to the server log, and the page says plainly that nothing was sent |

An account created with no provider configured starts **pre-verified**, because
enforcing a click on a message that can never arrive would lock the account out
of its own product. With a provider set, sign-up starts unverified, sends the
link, and `signIn` refuses until it is confirmed. A provider outage at
verification is swallowed deliberately — the account exists, and the link can be
re-sent from the dashboard — because failing signup after the row is written
would leave an account nobody can reach.

No new dependency: the HTTP sender is `fetch` only, and `setEmailSender()`
accepts SMTP, SES or anything else without touching a route.

### Teams

Anyone with an account belongs to one or more workspaces, each with a role:
`OWNER` (created at signup, never issuable by invite), `ADMIN`, or `MEMBER`.
Owners and admins invite by email from `/members`; the link is single-use,
expires in 7 days, names one address, and is shown once because only its hash
is stored. Re-inviting rotates the old link dead. Accepting moves the browser
into the new workspace. Removing a seat destroys that person's sessions in it
immediately — revoking access and leaving the cookie working would be the same
mistake twice. The dashboard bar lists every workspace the account can open.

An admin can invite members but cannot mint another admin; only an owner can.
A member cannot invite, see keys, or change seats. Ownership never transfers
through the invite path — that is a decision, not a missing feature.

Set `SESSION_COOKIE` if several of these products ever share one hostname, so
their cookies stay apart. It defaults to `abetworks_session`, which is safe as
long as each product has its own database — a token from one is simply not found
in another's session table.

This file's provenance: the auth surface shipped as one source, byte-copied across six
apps during the Abetworks campaign. The vendoring scripts and drift gate that enforced
identity are retired. This app's copy is its own and can evolve independently.
Full context: `abetworks-history` §8.20 and §8.44.

## Keys

`POST /api/keys` mints `ab_live_…` with explicit scopes (`keys:write`,
`events:write`, `webhooks:write`, `sso:write`, or `*`). Omitting `scopes` gives
the new key the scopes of the key that minted it — never `*`, which used to be
the default, so the one key this app lets a `keys:write` holder mint could hand
out every scope by naming none. A `scopes` you do send is checked: an unknown
member is refused by name instead of being filtered out of the key you get, and a
known member the calling key does not itself hold is a `403` — a key may hand out
its own authority and no more, which is also the rule when `PATCH /api/keys/{id}`
re-scopes a key, because re-scoping is granting. The
plaintext is returned once and never stored — only its sha256. Listing shows
prefixes. Revoking is a row update, so the next request 401s immediately; the
row itself survives for the audit trail.

Every write endpoint takes a JSON object and checks it field by field before
anything reaches the database. Bytes that are not a JSON object answer `400`;
a field that is the wrong shape answers `422` with every problem at once —
`error.message` joined for a human, `error.fields` keyed by the body's own field
names (`events[3]` for a list element) for a client. Nothing is coerced and
nothing is dropped in silence: `isActive: "no"`, `url: ["https://…"]` and
`rateLimitPerMin: "1000"` were all accepted before, each storing something the
request did not say. A `PATCH` that names no field is refused rather than
answered `200` with the row untouched.

Each write scope is enforced: a valid key that does not hold the scope a route
asks for is refused `403` before it can see or change the row. Every scoped
endpoint documents that `403` in `/api/v1/openapi`, and reads (which ask no
scope) correctly do not. The document's `info.version` is read from
`package.json`, not typed again, so the contract and the package carry one
number; the changelog, the package and the document are checked to agree.

Quotas ride on every key (`rateLimitPerMin`, default 600). Only a root key
may mint an unlimited one; anything else gets at least a 60/min ceiling, so
a compromised sub-key cannot promote itself. Exhaustion answers 429 with
`retry-after` plus IETF `ratelimit` / `ratelimit-policy`.

## Delivery guarantees

Deliveries are **at-least-once**, which means a retry is a duplicate by design.
Every attempt carries `x-abetapi-delivery` (stable across retries) and
`x-abetapi-event-id`, so a receiver dedupes on the former. Attempts are
**byte-identical**, so the HMAC signature stays valid across a retry.

| Behaviour | Rule |
|---|---|
| Retryable | No response, `408`, `425`, `429`, any `5xx` |
| Never retried | `400`, `401`, `403`, `404`, `422` — the endpoint already decided; repeating the identical body cannot change its answer, so it is parked immediately rather than after eight rounds |
| Backoff | Exponential from 30s, capped at 6h, with equal jitter (half fixed, half random) so a batch of failures does not return in lockstep |
| Attempts | 8, spanning roughly a working day |
| Dead letter | Parked as `DEAD` with `deadAt`; never retried automatically again |
| Auto-disable | 20 consecutive failures switches the endpoint off and records `disabledReason` |
| Replay | `POST /api/webhooks/{id}/deliveries/replay` — copies the stored payload into a **new** row, so the failed original stays on the record as history |

Retries run in a worker started at boot (`instrumentation.ts`), polling every 30s.
Each due row is claimed with a conditional update, so running several instances
cannot send the same event twice.

## Events → webhooks

`POST /api/v1/events { type, data }` fans out to every active subscription
matching the type (empty means all). Each delivery is HMAC-SHA256 over
`{timestamp}.{rawBody}`, retried 3 times with backoff, and logged either way —
successes included, because "it worked" also deserves a receipt at 3am.

Key discipline, documented so integrators get it right: the server stores
only the secret's hash and signs with that hash. Receivers hold the
plaintext, hash it first (`sha256(secret)`), and verify with the same value.
Nobody ever recovers a secret from the database, and both sides still meet.
Rotate via `PATCH /api/webhooks/{id} { rotate: true }` — the old secret dies
with the response that carries the new one.

## Inbound — NuCRM and other signed senders

`POST /api/v1/inbound/nucrm/{id}` is the bridge's receiving end: point a NuCRM
integration webhook at a source (dashboard → **Connect NuCRM**) and every
verified event is republished to matching subscriptions — one Delivery per
subscriber, with the retries, receipts and audit trail above.

The request carries two credentials on purpose. Your workspace key
(`Authorization: Bearer …`, scope `events:write`) is the tenant, the quota and
the audit trail; `x-nucrm-signature` — HMAC-SHA256 over the exact body keyed by
the source's secret, the `sha256=` prefix optional — is what proves the body is
NuCRM's. NuCRM's integration config sends custom headers, so both travel in one
configured webhook.

NuCRM retries its webhooks, so `x-nucrm-delivery` deduplicates: a repeat of a
delivery id already accepted answers `200 {duplicate: true}` and publishes
nothing. An accepted event answers `202` with the same receipt as
`POST /api/v1/events`; a signature that does not verify is refused `401` before
anything fans out, and the refusal is logged like every other one. The two-way
guide — setup steps, a verifier to paste, both signature schemes side by side —
lives in [`docs/nucrm.md`](docs/nucrm.md).

## API

```
GET    /api/health                         # liveness + DB ping, no key
GET    /login                                # sign in (see Accounts)
GET    /api/v1/openapi                     # this contract, no key
GET    /api/v1/whoami                      # key identity + live quota
GET    /api/keys                           # list (prefixes only)
POST   /api/keys                           # mint (needs keys:write)
GET    /api/keys/{id}                      # one key
PATCH  /api/keys/{id}                      # rename, re-scope, re-limit
DELETE /api/keys/{id}                      # revoke now
POST   /api/v1/events                      # publish (needs events:write)
POST   /api/v1/inbound/nucrm/{id}          # receive one signed NuCRM event (needs events:write)
GET    /api/webhooks                       # subscriptions, secrets never listed
POST   /api/webhooks                       # subscribe (needs webhooks:write)
GET    /api/webhooks/{id}                  # one subscription
PATCH  /api/webhooks/{id}                  # move, re-scope, silence, rotate
DELETE /api/webhooks/{id}                  # unsubscribe
GET    /api/webhooks/{id}/deliveries       # receipts + per-attempt log
POST   /api/webhooks/{id}/deliveries/replay  # re-send one, or a dead batch
POST   /api/ai/diagnose-webhook            # explain the failures, read-only
GET    /api/usage?workspaceId=&days=       # per-key calls, errors, error rate
GET    /api/sso                            # connections
POST   /api/sso                            # register OIDC (SAML refused)
GET    /api/sso/{id}                       # one connection
PATCH  /api/sso/{id}                       # edit (metadata change re-arms check)
DELETE /api/sso/{id}                       # remove
POST   /api/sso/{id}/check                 # live OIDC discovery check, now
```

Every authed outcome — including 401s, 403s and 429s — lands in the request
log, which is what `/api/usage` reads. An audit trail with holes is where
abuse hides. The `{id}` routes' own "no such row" 404s do too: they answer
through `notFound()` (`lib/auth.ts`), which writes the log row before
returning, so a probe enumerating key, webhook or SSO ids is visible next to a
refused credential rather than silently absent. (`ai/diagnose-webhook` keeps
its own bare-string response because its dashboard renders it as text, but it
logs the 404 the same way.)

## AI (optional)

`POST /api/ai/diagnose-webhook { webhookId, model? }` reads a webhook's
recent delivery attempts and explains the failures: most likely cause,
cheapest-first fixes, and whether the evidence points at your endpoint or at
AbetAPI. It may only cite status codes, durations and error strings from the
records — never your code, which it has never seen. No failures, or no
deliveries at all, returns an honest "nothing to diagnose". Read-only: nothing
is retried, nothing is modified, and the signing secret is never selected.
Without `LLM_API_KEY` the delivery stats are still returned with
`configured: false`.

Same key setup as the other apps (`LLM_API_KEY`, optional `LLM_BASE_URL`,
`LLM_MODEL`, `LLM_TIMEOUT_MS`). Offline contract unit-tested in
`tests/unit/ai-diagnose.test.ts`.

## SSO

Connections are a registry plus a live discovery check, nothing more: create
with an issuer and metadata URL, run `/check`, watch it go `VERIFIED`
(proven against Google's discovery document) or `FAILED` with the reason.
SAML rows are refused outright — v1 speaks OIDC, and saying so beats a
half-implemented handshake. The interactive login flow needs the customer's
client credentials and stays out of scope until one exists.

## Putting it somewhere

```bash
npm ci
npm run db:deploy
npm run build
npm start
```

Point the load balancer at `GET /api/health` (200 = serving, 503 = DB down).
Postgres is the runtime provider since `chore/postgres` (provider switch,
fresh migration history, regenerate — the abetConnect recipe). Guard the seeded root key like
production data — it has `*` scope and no quota.
