import { NextResponse } from "next/server";

/**
 * A wrongly-typed scalar in a request body is this app's oldest bug class, and
 * unlike the other five products in the family it also has a published contract
 * to keep. The table below is what its write routes did before this file
 * existed. Every row was recorded by `n5-api-before.mts`: 165 cases sent over
 * HTTP to this app's own dev server on :3700, one wrong field per case in an
 * otherwise-valid body, authenticated with a minted key (output:
 * `n5-api-before.txt`). The server's `DATABASE_URL` pointed at a COPY of
 * `prisma/dev.db`, so the rows described here were real rows in a real database
 * that was not the product's. What each answer *stored* is the read-back at the
 * end of that file.
 *
 *   POST /api/keys            body "prose" / (empty) / null   500 — `request.json()`
 *                                                         throws, and a `null` body
 *                                                         throws again on `body.name`
 *   POST /api/keys            body []                         422 "name required" —
 *                                                         an array has no `name`, so
 *                                                         the shape got a field's
 *                                                         message
 *   POST /api/keys            name 42 / [] / "  "             422 "name required" —
 *                                                         right status, wrong reason:
 *                                                         a number is *present*
 *   POST /api/keys            name 4999 / 201 chars           201, and stored (`max`
 *                                                         read back 4999)
 *   POST /api/keys            scopes "keys:write" (text)      422 "must be known
 *                                                         scope names" — refused, but
 *                                                         a text value and an unknown
 *                                                         member get the same message
 *   POST /api/keys            scopes ["keys:write","bogus"]   201, and `"bogus"`
 *                                                         dropped: `normalizeScopes`
 *                                                         filters rather than refuses,
 *                                                         so the caller was handed a
 *                                                         key that is not the one they
 *                                                         described
 *   POST /api/keys            scopes omitted                  201 with `["*"]` — every
 *                                                         scope. Measured from a key
 *                                                         holding only `keys:write`,
 *                                                         which is privilege escalation
 *                                                         inside the route whose own
 *                                                         comment guards it
 *   POST /api/keys            rateLimitPerMin "1000"/true/[]/ -5/NaN   201, and the
 *                                                         600 default — the `typeof
 *                                                         === "number"` test reads a
 *                                                         wrong type as "not sent"
 *   POST /api/keys            rateLimitPerMin 1.9             201, stored 1 (`Math.floor`)
 *   POST /api/keys            rateLimitPerMin 1e21            500 — Prisma's `Int`
 *                                                         overflow, from a `typeof`
 *                                                         check the value passes
 *   PATCH /api/keys/:id       body "prose"                    500
 *   PATCH /api/keys/:id       {}                              200 — an UPDATE with
 *                                                         nothing in `data`
 *   PATCH /api/keys/:id       name 42 / [] / "  "             200, and not stored
 *   PATCH /api/keys/:id       rateLimitPerMin "1000"/true/-1  200, and not stored
 *   PATCH /api/keys/:id       revokedAt 42, hashedKey "deadbeef", workspaceId <foreign>
 *                                                             200 — three fields this
 *                                                         route does not own, accepted
 *                                                         and ignored; the plaintext
 *                                                         hash of a live key is not a
 *                                                         field a caller may name
 *   POST /api/webhooks        body "prose" / null             500
 *   POST /api/webhooks        url 42 / {} / [] / "ftp://x"    422 "url must be an
 *                                                         http(s) URL" — `String(url)`
 *                                                         then `new URL()` does the
 *                                                         accepting
 *   POST /api/webhooks        url ["https://…"]               201, and stored as that
 *                                                         URL: `String(["https://x"])`
 *                                                         is `https://x`, so an array
 *                                                         is a string in disguise
 *   POST /api/webhooks        url http://127.0.0.1:6379/      201, and stored — the
 *                                                         gateway will POST signed
 *                                                         payloads to a loopback port
 *   POST /api/webhooks        url 5000 chars                  201, read back `length`
 *                                                         5004
 *   POST /api/webhooks        events 42/"prose"/{}/[42]/null  422 "events must be
 *                                                         string[]" — correct, and
 *                                                         silent about which element
 *   POST /api/webhooks        events ["   "]                  201, stored `["   "]`: a
 *                                                         subscription no event can
 *                                                         ever match
 *   POST /api/webhooks        events 101 entries              201, stored (no bound
 *                                                         on the fan-out filter)
 *   PATCH /api/webhooks/:id   {}                              200
 *   PATCH /api/webhooks/:id   url ["https://…"]               200, and stored
 *   PATCH /api/webhooks/:id   isActive "no"                   200, stored **true**
 *   PATCH /api/webhooks/:id   isActive [] / 42                200, stored **true** —
 *                                                         `Boolean(isActive)`; the same
 *                                                         conversion in leadworks,
 *                                                         abetagent and abetanalytics
 *   PATCH /api/webhooks/:id   isActive "" / null              200, stored **false** —
 *                                                         so sending the empty string
 *                                                         switches a live subscription
 *                                                         off, and the answer says
 *                                                         nothing about it
 *   PATCH /webhooks/:id       consecutiveFailures -9, secretHash "x"
 *                                                             200 — accepted, ignored
 *   POST /api/sso             body "prose" / null             500
 *   POST /api/sso             name 42 / []                    422 "name required"
 *   POST /api/sso             name "   "                      201, stored `"   "` (the
 *                                                         `(workspaceId, name)` unique
 *                                                         index then treats three
 *                                                         spaces as a name in use)
 *   POST /api/sso             name 5001 chars                 201, and stored
 *   POST /api/sso             issuer "not a url"              201, stored — `Webhook.url`
 *                                                         is parsed, these two are not
 *   POST /api/sso             issuer 5000 chars               201, stored (read back 4988)
 *   POST /api/sso             clientId 42 / true              201, and `clientId: null`
 *   POST /api/sso             status "VERIFIED" / 42          201, stored UNCHECKED —
 *                                                         right outcome, and by accident:
 *                                                         the field is simply not in the
 *                                                         create object
 *   PATCH /api/sso/:id        {}                              200
 *   PATCH /api/sso/:id        name 42 / "" / issuer 42 / clientId 42 / metadataUrl 42
 *                                                             200, and none of them stored
 *   PATCH /api/sso/:id        name = another connection's name  500 — not in the 165:
 *                                                             measured afterwards, still
 *                                                             on unwired code, by
 *                                                             `n5-api-ssoconf.mts`. The
 *                                                             before-run's own row
 *                                                             (`name dup of own
 *                                                             workspace`) renamed a
 *                                                             connection to the name it
 *                                                             already had, which a unique
 *                                                             index allows, so it passed
 *                                                             as a 200 and the real
 *                                                             duplicate went unasked
 *                                                             until then
 *   POST /api/v1/events       body "prose" / null             500
 *   POST /api/v1/events       type 42 / [] / "has space"      422 "type required,
 *                                                         [a-z0-9._-]" — a number is
 *                                                         present; it is the shape
 *                                                         that is wrong
 *   POST /api/v1/events       type 5001 chars                 201, and stored as
 *                                                         `Delivery.event` (a String
 *                                                         column) — read back three
 *                                                         rows carrying it
 *   POST /api/v1/events       type 128 chars                  201, and stored. The case
 *                                                         label says "129 chars";
 *                                                         `"n5." + "e".repeat(125)` is
 *                                                         128, which is the cap this
 *                                                         file sets, so the row is
 *                                                         legal on both sides and the
 *                                                         after-run shows it unchanged.
 *                                                         The 129-character case is in
 *                                                         the AFTER-ONLY block there.
 *   POST /api/v1/events       data 42 / "prose" / []          201 — the payload every
 *                                                         subscriber receives, of any
 *                                                         type the caller names
 *   POST /api/v1/events       data 2 MB                       201, and one row per
 *                                                         matching subscription, each
 *                                                         POSTed to the customer
 *   POST /api/v1/events       workspaceId 42                  201 — ignored, correctly
 *   POST …/deliveries/replay  body "prose"                    400 — `.catch(() => ({}))`,
 *                                                         which is the right idea and
 *                                                         answers "deliveryId, or
 *                                                         all:true, is required" about a
 *                                                         caller who sent prose
 *   POST …/deliveries/replay  deliveryId 42 / [] / true       500 — Prisma's `where: { id }`
 *   POST …/deliveries/replay  all:true status 42              500, same reason
 *   POST …/deliveries/replay  all "yes" / 1                   400, blamed on the missing
 *                                                         `deliveryId`
 *   POST /api/ai/diagnose-webhook  webhookId 42 / []          400 `{error: "…string"}` —
 *                                                         the one route in this app whose
 *                                                         answer is not the published
 *                                                         envelope
 *   POST /api/ai/diagnose-webhook  {} with no key            400 — the body is read and
 *                                                         answered *before* the
 *                                                         credential is checked, so an
 *                                                         anonymous caller gets a
 *                                                         field-level reply
 *
 * Nineteen 500s — eighteen in the 165 plus the one the run could not ask. The rest
 * is the part a caller cannot see: eighty-five cases answered 2xx, and the two
 * halves of that are a wrong row (`"   "` as a name, `["   "]` as an event
 * filter, 5004 characters of URL, an array pretending to be a URL, `isActive:
 * true` for the word `"no"`) and no row at all where the caller believed they
 * had written one (`rateLimitPerMin "1000"`, `clientId 42`, `name 42`, three
 * empty PATCHes). Two classes came out right and stay: every foreign-id route
 * 404s rather than writing, and `NO KEY` 401s.
 *
 * The same 165 labels, sent in the same order against this code, are in
 * `n5-api-after.txt`, along with the cases only the fixed code can pose.
 * **Nineteen 500s → 0.** Of the 85 cases that answered 2xx, 60 are refusals now —
 * all 60 are 422s carrying the offending field in `error.fields`. The 25 that stay
 * are: sixteen valid controls (a create for `keys` — two of them minted by a
 * `keys:write` holder at `rateLimitPerMin` 0 and 5 — for `webhooks`, for `sso` and
 * for the subscriber's event, one of those events with an object `data` and one
 * with no `data` key at all; a `PATCH` to a real name and a `PATCH` of
 * `rateLimitPerMin` by that same holder; `isActive false` — the boolean — and a
 * re-enable; `clientId null`, which a nullable column accepts; a rename to the name
 * the row already has, which a unique index allows; and the two replays that had
 * parked rows to copy); two at-the-cap values (a 200-character key name, and the
 * event `type` this table caps at 128 — see the row above); four cases where a
 * value no table declares (`status` twice, `workspaceId` twice) was ignored, as it
 * was before, and never reached Prisma; `scopes` omitted, which now inherits the
 * caller's own list instead of minting `["*"]` — a product rule stated in the route
 * and echoed back in the response, not a coercion; an array as an event payload,
 * which `json` declares as object-or-array; and the loopback subscription this
 * round deliberately leaves for #32. The
 * read-backs are the part that matters, because a refusal
 * only counts if nothing was stored on the way to it: 11 keys created instead of
 * 21, longest stored URL 29 characters instead of 5004, no event filter over 128
 * characters, no stored name that is whitespace, every `SsoConnection` still
 * `UNCHECKED` after two callers tried to set it, and the workspace the cross-
 * tenant cases attacked still holding the one key this probe minted for it.
 * Refusals are auditable too, which they were not before this file existed: every
 * handler here now answers through a `refused()` wrapper that writes the status to
 * `RequestLog`, so the after-run reads back 422×116, 400×15, 403×4 and 409×2
 * sitting next to 200×8, 201×20 and 202×2. What that read-back did *not* cover was
 * a route that answers "no such row" from its own lookup miss and returns before
 * any logging call — nine 404s were asked, two were in the log, and `[code]` said
 * which two: `ai/diagnose-webhook` and the replay route each call `logSuccess`
 * with 404 spelled out, while `keys/[id]`, `webhooks/[id]`, `sso/[id]` and
 * replay's own webhook lookup did not. That is pre-existing and not a validation
 * refusal — there is no body in those cases to have gotten wrong — so it was owed
 * as its own item rather than fixed quietly beside this one. That item (#33) is now
 * closed: every lookup-miss 404 answers through `notFound()` in `lib/auth.ts`, which
 * writes the `RequestLog` row before returning; `diagnose-webhook` keeps its own
 * bare-string envelope but logs the same way. See §8.39 of the ledger.
 *
 * So the check belongs at the boundary, against a declared table per route —
 * with one difference from the other five apps, which is this file's reason to
 * exist separately rather than as a copy:
 *
 * **abetapi's error envelope is its product.** `src/lib/openapi.ts` publishes
 * `{ error: { code, message } }` with `invalid_request` among the codes, and
 * documents `422` on four of these paths. leadworks, leadgenius, abetagent,
 * abetflow and abetanalytics answer a wrong field with `400` and
 * `{ error: "…"; fields: {…} }` — a bare string under `error`. Here that shape
 * would break every client that reads `error.code`, so the same problems are
 * projected into the published envelope at **422**, and `fields` rides alongside
 * it. Only one class stays at 400, and HTTP says why: bytes that are not a JSON
 * object cannot be a semantic error, so `readJson` answers 400 and the field
 * walk answers 422. That is a deliberate divergence from the family, not drift:
 * the engine's *rules* (no coercion, nothing dropped in silence, every problem
 * named at once) are shared; its *answer* is this app's.
 *
 * The rules, unchanged from the four apps that already have them:
 *
 *  - No coercion. `Boolean(isActive)` and `String(url)` both *accept* by
 *    converting, which is the opposite of checking.
 *  - Nothing dropped in silence. A declared field must arrive in the shape the
 *    route reads it, or the request is refused naming it. This is what turns
 *    `normalizeScopes`' filtering into a refusal: a key handed back with a scope
 *    the caller did not ask for is worse than no key.
 *  - An absent key means "not mentioned" and is omitted, so a PATCH cannot reset
 *    a column the caller never named. `null` means "clear it" and only works
 *    where the column is nullable.
 *  - A field the route did not declare never reaches Prisma — and here it is
 *    worth saying out loud which fields those are, because two of them are
 *    secrets: `ApiKey.hashedKey`, `Webhook.secretHash`, `Webhook.secretPrefix`
 *    and `SsoConnection.status` (which is a live check's finding, not an input)
 *    are deliberately not in any table.
 *  - Text is trimmed. `name: "   "` passes a type check and becomes a row no one
 *    can find by name, and in `SsoConnection`'s case a row that occupies the
 *    `(workspaceId, name)` unique index.
 *
 * Kinds this app needed that abetanalytics' copy does not have: `int` (its
 * `rateLimitPerMin` is the family's caller-facing `Int`; abetanalytics has no
 * integer column at all) and `strings` (two of its Json columns are lists of
 * names: `ApiKey.scopes`, `Webhook.events`). Kinds it dropped: `number` — this
 * schema has no `Float` anywhere, so there is no threshold like
 * `AlertRule.threshold` to take — and `date`: not one `DateTime` here is a
 * caller's to name (`lastUsedAt`, `revokedAt`, `nextAttemptAt`, `deadAt` are all
 * written by the gateway or the worker). Two additions that are properties of
 * these columns rather than of the family: `format: "url"`, because `Webhook.url`
 * is the address the product POSTes signed payloads to and `new URL(String(x))`
 * was the only thing standing between a caller and `http://127.0.0.1:6379/`; and
 * `pattern`, because `Delivery.event` is matched by exact string comparison, so
 * the namespaced-word rule the route already had (`/^[a-z0-9][a-z0-9._-]*$/i`)
 * belongs in the table that declares it.
 */

import { collectBody, describe } from "./validation-engine";
import type { Schema, Validated, ValidationProblem } from "./validation-engine";

export type { FieldKind, Field, JsonObject, JsonArray, Schema, Validated, ValidationProblem } from "./validation-engine";
export { NO_FIELD_TO_UPDATE } from "./validation-engine";


export type Validation<S extends Schema> =
  | { ok: true; data: Validated<S>; error?: undefined }
  | { ok: false; data?: undefined; error: NextResponse };

/**
 * The engine's walk, projected into this app's envelope. Every rule — which kinds
 * exist, what a wrong value is called, what `null` and an absent key mean — is in
 * `./validation-engine`, one file for all six apps. This function is here because
 * what a problem *becomes* on the wire is this app's own decision, and the six
 * have never agreed about it: five answer 400 with `{ error, fields }`, abetapi
 * answers 422 with `{ error: { code, message }, fields }` because that envelope is
 * what its published OpenAPI document promises. Reunited rules, forked answer.
 */
export function validateBody<S extends Schema>(
  body: unknown,
  schema: S,
  opts: { requireWrite?: boolean } = {},
): Validation<S> {
  const result = collectBody(body, schema, opts);
  return result.ok ? result : fail(result.problems);
}

/**
 * Parse the body of a request that is required to carry one, and require that it
 * is a JSON *object*. Three failures, all measured as a 500 here (`body "prose"`,
 * `body (empty)`, `body null`) on every one of the seven routes that read a body
 * with a bare `await request.json()`: the call throws on bytes that are not JSON,
 * and a `null` body parses but throws on the handler's next line at `body.name`.
 * A throw inside a handler is Next's 500, which is a status a correct client
 * retries — so a malformed request was being answered as though this server had
 * broken, and retried as though the first attempt had counted.
 *
 * This is 400, not 422: bytes that are not a JSON object have no fields to
 * report on. A well-shaped body is then checked field by field by `validateBody`,
 * which keeps its own copy of the object rule because the unit tests call it
 * directly.
 */
export async function readJson(
  request: Request,
): Promise<{ ok: true; body: Record<string, unknown>; error?: undefined } | { ok: false; body?: undefined; error: NextResponse }> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return { ok: false, error: malformed("request body is not valid JSON") };
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: malformed(`request body must be a JSON object, got ${describe(body)}`) };
  }
  return { ok: true, body: body as Record<string, unknown> };
}

/**
 * A route-control flag that is not a column — here, `rotate` (should this
 * subscription get a new signing secret?) and `all` (replay every parked
 * delivery, or just the one named). Neither is a field Prisma is given, so
 * neither belongs in a table; both were measured as accepted and then
 * reinterpreted. `rotate === true` is the only spelling the route honours, so
 * `rotate: "yes"` answers 200 with the old secret still in place; `all: "yes"`
 * is not `true`, and the caller is told their *deliveryId* is missing.
 */
export function boolFlag(
  value: unknown,
  name: string,
): { ok: true; value: boolean | undefined; error?: undefined } | { ok: false; value?: undefined; error: NextResponse } {
  if (value === undefined || value === null) return { ok: true, value: undefined };
  if (typeof value !== "boolean") {
    return {
      ok: false,
      error: unprocessable([[name, `${name} must be true or false, got ${describe(value)}${typeof value === "string" ? " — send it unquoted" : ""}`]]),
    };
  }
  return { ok: true, value };
}

/* ---------- the per-field walk ---------- */

/** Bytes that are not a JSON object: no fields to name, so 400 and one message. */
function malformed(message: string): NextResponse {
  return NextResponse.json({ error: { code: "invalid_request", message } }, { status: 400 });
}

/**
 * One message per problem, joined into the published `message`, plus a `fields`
 * object keyed the same way as the body the caller sent. The key is the point:
 * the 18 500s above named an argument only inside a Prisma stack line that never
 * reached the client, and eight of the 422s named two or three fields for
 * whichever one was wrong ("name required" for `name: 42`, "events must be
 * string[]" for a list holding one number).
 *
 * 422 rather than the family's 400 because `src/lib/openapi.ts` already promises
 * it: `422: fails("Bad scopes")`, `fails("Bad event")`, `fails("Bad URL")`,
 * `fails("Bad connection")`. Changing the status would be a wider contract change
 * than changing the code deserves, and `code: "invalid_request"` is in that
 * document's own enum.
 */
function unprocessable(problems: ValidationProblem[]): NextResponse {
  const fields: Record<string, string> = {};
  for (const [name, message] of problems) fields[name] = message;
  return NextResponse.json(
    { error: { code: "invalid_request", message: problems.map(([, message]) => message).join("; "), fields } },
    { status: 422 },
  );
}

function fail(problems: ValidationProblem[]): { ok: false; error: NextResponse } {
  return { ok: false, error: unprocessable(problems) };
}

/**
 * A refusal the field walk cannot express, because it is about which fields a
 * route needs *together* rather than about any one field's value. One route uses
 * it: `deliveries/replay`, where `{}` is well-typed and still says nothing — the
 * caller has to name a delivery or ask for a status's worth of them. It answers
 * in the same envelope and at the same 422 as the walk does, so a client cannot
 * tell "the rule is cross-field" from "the field is wrong" by status, only by
 * the message it was sent.
 */
export function fieldProblem(name: string, message: string): NextResponse {
  return unprocessable([[name, message]]);
}
