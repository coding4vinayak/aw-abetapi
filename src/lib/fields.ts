import { ALL_SCOPES } from "./keys";
import type { Schema } from "./validate";

/**
 * One declared table per request body in this app, and the numbers in them are
 * decisions rather than column properties — `prisma/schema.prisma` is SQLite, so
 * it has no length limits, no enum type and no way to say that a `String` column
 * is an address. Every cap below is justified by what the value is *used for*,
 * because a limit nobody can explain is a limit the next person raises.
 *
 * The before-runs say what happens without them. `POST /api/keys` with a
 * 4999-character name answered 201 and stored 4999; `POST /api/webhooks` with a
 * 5004-character url answered 201 and stored it; `POST /api/sso` stored a
 * 5001-character name and a 4988-character issuer. None of those columns is read
 * by anything that can survive them: `prefix` is sliced from the key, the URL is
 * handed to `fetch`, the event name is compared by `Array.includes`, and a name is
 * what a person types into a list. (`n5-api-before.mts`, read-back section.)
 *
 * The scopes list is imported from `./keys` rather than repeated here: `ALL_SCOPES`
 * is what `scopesCover` compares against, so a scope this table allowed and that
 * constant did not would be a row the gateway refuses to use.
 */

export const NAME_MAX = 200;
/** A signed delivery's address: past this it is not a URL a human maintains. */
export const URL_MAX = 2048;
/** A cuid is 25 characters; 100 is room for an id format change, not an inch. */
export const ID_MAX = 100;
/** `Delivery.event` is compared by exact match, so a name is not a paragraph. */
export const EVENT_TYPE_MAX = 128;
/** How many event names one subscription may filter on. */
export const EVENT_TYPES_MAX = 100;
export const SCOPES_MAX = 10;
/** Requests per minute. 0 means unlimited and is the root tier; 1e6 is past any
 *  tenant this gateway would serve and stays well inside `2**53`, which is where
 *  `1e21` became a 500 on the way to Prisma's `Int`. */
export const RATE_LIMIT_MAX = 1_000_000;
/** One event's payload, per subscription. 64 KB is measured against the before-run
 *  that sent 2 MB and got `{"accepted":2}` — that is two rows in `Delivery` and two
 *  signed POSTs, so the cap bounds the fan-out as well as the column. */
export const EVENT_PAYLOAD_MAX = 64 * 1024;

/** Namespaced words, the route's own rule (`lead.created`), kept as it was. */
export const EVENT_TYPE_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;

export const SCOPE_VALUES = [...ALL_SCOPES, "*"] as const;

/** `Delivery.status`, from `lib/retry.ts`: PENDING -> DELIVERED | RETRYING | DEAD. */
export const DELIVERY_STATUSES = ["PENDING", "DELIVERED", "RETRYING", "DEAD"] as const;

/** `SsoConnection.type`. SAML is a row in the schema's comment, not an option. */
export const SSO_TYPES = ["OIDC"] as const;

/** POST /api/keys. `scopes` is optional in the *shape* and never defaulted to
 *  everything: absent means the route inherits the minting key's own scopes, so
 *  the escalation this round found (`["*"]` from a caller holding only
 *  `keys:write`, measured) is closed by a rule about *who* is asking rather than
 *  by refusing a request that used to work. Refusing it would have been a
 *  contract change, and `src/app/changelog/page.tsx:15` promises thirty days'
 *  notice for those. A `scopes` that *is* sent is checked like any other field:
 *  `normalizeScopes` filtered an unknown member out and answered 201 with a
 *  narrower key than the caller described, so a wrong member is refused by name
 *  here, and an empty list is refused rather than quietly meaning "nothing". */
export const KEY_POST = {
  name: { kind: "text", required: true, max: NAME_MAX },
  scopes: { kind: "strings", values: SCOPE_VALUES, min: 1, max: SCOPES_MAX },
  rateLimitPerMin: { kind: "int", min: 0, max: RATE_LIMIT_MAX },
} as const satisfies Schema;

/** PATCH /api/keys/{id}. No `revokedAt`: revoking is DELETE's job so the audit
 *  trail's own column stays the gateway's, and `hashedKey` stays unwritable for
 *  the same reason the plaintext is shown once. */
export const KEY_PATCH = {
  name: { kind: "text", max: NAME_MAX },
  scopes: { kind: "strings", values: SCOPE_VALUES, min: 1, max: SCOPES_MAX },
  rateLimitPerMin: { kind: "int", min: 0, max: RATE_LIMIT_MAX },
} as const satisfies Schema;

/** POST /api/webhooks. `format: "url"` is the check the route already made by
 *  hand, moved to where it can also refuse `["https://…"]` before `String()`
 *  turns it into an address. `itemMax` is the cap that hand-written check never
 *  had, and `EVENT_TYPE_MAX` is the number `POST /api/v1/events` already holds a
 *  published name to: a filter longer than the longest legal event is a filter
 *  that cannot match anything, which is the `["   "]` bug in a different shape. */
export const WEBHOOK_POST = {
  url: { kind: "text", required: true, format: "url", max: URL_MAX },
  events: { kind: "strings", pattern: EVENT_TYPE_PATTERN, itemMax: EVENT_TYPE_MAX, max: EVENT_TYPES_MAX },
} as const satisfies Schema;

/** PATCH /api/webhooks/{id}. `rotate` is not here: it is a route-control flag
 *  that decides whether to mint a secret, not a column, so it goes through
 *  `boolFlag`. `consecutiveFailures`, `disabledReason` and `secretHash` are the
 *  gateway's own record of what happened to the endpoint. */
export const WEBHOOK_PATCH = {
  url: { kind: "text", format: "url", max: URL_MAX },
  events: { kind: "strings", pattern: EVENT_TYPE_PATTERN, itemMax: EVENT_TYPE_MAX, max: EVENT_TYPES_MAX },
  isActive: { kind: "bool" },
} as const satisfies Schema;

/** POST /api/sso. `status` is deliberately absent — it is what `runSsoCheck`
 *  found, and before this file the only reason a caller could not set it was that
 *  the create object did not mention it. `type` is refused rather than defaulted
 *  when it arrives wrong: `type !== "OIDC"` used to answer "type must be OIDC in
 *  v1" for `type: ["OIDC"]`, which is an array saying the one legal word. */
export const SSO_POST = {
  name: { kind: "text", required: true, max: NAME_MAX },
  type: { kind: "enum", values: SSO_TYPES },
  issuer: { kind: "text", required: true, format: "url", max: URL_MAX },
  metadataUrl: { kind: "text", required: true, format: "url", max: URL_MAX },
  clientId: { kind: "text", nullable: true, max: NAME_MAX },
} as const satisfies Schema;

/** PATCH /api/sso/{id}. `clientId` is nullable, so `null` means "this connection
 *  has no client id yet" and omitting it means "leave it alone" — the two were
 *  both `undefined` on the way in, and the route's `typeof clientId === "string"`
 *  spread answered a `null` by not touching the column. */
export const SSO_PATCH = {
  name: { kind: "text", max: NAME_MAX },
  issuer: { kind: "text", format: "url", max: URL_MAX },
  metadataUrl: { kind: "text", format: "url", max: URL_MAX },
  clientId: { kind: "text", nullable: true, max: NAME_MAX },
} as const satisfies Schema;

/** POST /api/v1/events. `data` is the payload every matching subscriber is
 *  handed, signed, so its type is the product's: an object or an array of JSON,
 *  bounded, never a bare scalar. `null` is refused rather than forwarded — a
 *  receiver that sees `"data":null` cannot tell an empty event from a caller who
 *  forgot the field, and `{}` says which. */
export const EVENT_POST = {
  type: { kind: "text", required: true, max: EVENT_TYPE_MAX, pattern: EVENT_TYPE_PATTERN },
  data: { kind: "json", max: EVENT_PAYLOAD_MAX },
} as const satisfies Schema;

/** POST /api/webhooks/{id}/deliveries/replay. `status` is a filter on which
 *  parked rows to take, so it is checked as the enum it is: `status: "BOGUS"`
 *  measured as a 404 "Nothing to replay.", which sends a caller looking for
 *  missing deliveries rather than a misspelled word. */
export const REPLAY_POST = {
  deliveryId: { kind: "text", max: ID_MAX },
  status: { kind: "enum", values: DELIVERY_STATUSES },
} as const satisfies Schema;

/** POST /api/ai/diagnose-webhook. `model` reaches the LLM call as a name. */
export const DIAGNOSE_POST = {
  webhookId: { kind: "text", required: true, max: ID_MAX },
  model: { kind: "text", max: NAME_MAX },
} as const satisfies Schema;
