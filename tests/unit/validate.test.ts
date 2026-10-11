// N5: a wrong-typed field used to be the database's problem, and abetapi's
// database answered in every way there is — a *500* for a value Prisma could not
// bind to an `Int`, a *stored word* where the schema comment named an enum, an
// *array coerced into a URL*, and a *silently dropped* value the route had
// defaulting for. Measured over HTTP against a dev server whose `DATABASE_URL`
// pointed at a copy of `prisma/dev.db`, one wrong field per request (the full
// 165-case table is in the header of `src/lib/validate.ts`):
//
//   POST  /api/keys           rateLimitPerMin 1e21   500 — Prisma's `Int` overflow
//   POST  /api/keys           rateLimitPerMin "1000" 201, and the 600 default
//   POST  /api/keys           scopes omitted         201 with `["*"]`
//   POST  /api/keys           scopes [42,"bogus"]    201, filtered to what it knew
//   PATCH /api/webhooks/:id   isActive "no"          200, stored **true**
//   POST  /api/webhooks       url ["https://x"]      201, stored as that URL
//   POST  /api/sso            issuer "not a url"     201, stored, never parsed
//   POST  /api/v1/events      data 2 MB              201, fanned out to every subscriber
//   POST  /api/…/replay       deliveryId 42          500
//
// These pin the engine's contract, because every write route here is written
// against it — including the one thing that is *not* shared with the other five
// apps, the published error envelope, which is this file's first describe block.
// Each row was replayed through the running app with the tables wired (after-probe:
// same cases, `n5-api-after.txt`). What pins the routes against someone forgetting
// the next one is `route-validation.test.ts`.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  boolFlag,
  fieldProblem,
  NO_FIELD_TO_UPDATE,
  readJson,
  validateBody,
  type Schema,
} from "../../src/lib/validate";
import {
  DIAGNOSE_POST,
  EVENT_POST,
  KEY_PATCH,
  KEY_POST,
  REPLAY_POST,
  SSO_PATCH,
  SSO_POST,
  WEBHOOK_PATCH,
  WEBHOOK_POST,
} from "../../src/lib/fields";

/**
 * This app's published envelope: `{ error: { code, message } }`, with `fields`
 * beside it on a 422. Read as an object, not a string — the other five apps put a
 * string under `error` and a wrong field here must not look like one of theirs.
 */
const envelope = async (response: Response) =>
  (await response.json()) as { error: { code: string; message: string; fields?: Record<string, string> } };

/** An otherwise-valid mint, so a test can send exactly one wrong field. */
const GOOD_KEY = { name: "ci deploy", scopes: ["events:write"] };
const GOOD_WEBHOOK = { url: "https://example.invalid/hook" };
const GOOD_SSO = {
  name: "work",
  issuer: "https://idp.example.invalid/",
  metadataUrl: "https://idp.example.invalid/.well-known/openid-configuration",
};

const ONE = {
  name: { kind: "text", required: true, max: 20 },
  nickname: { kind: "text", nullable: true },
} as const satisfies Schema;

describe("the answer is the published envelope", () => {
  it("refuses a wrong field at 422, with code invalid_request", async () => {
    const result = validateBody({ ...GOOD_KEY, name: 42 }, KEY_POST);
    assert.equal(result.ok, false);
    const payload = await envelope(result.error!);
    assert.equal(result.error!.status, 422);
    assert.equal(payload.error.code, "invalid_request");
    assert.match(payload.error.message, /name must be text, got a number/);
  });

  it("reports every problem at once, keyed by the body's own field names", async () => {
    const result = validateBody({ name: 42, nickname: [] }, ONE);
    assert.equal(result.ok, false);
    const payload = await envelope(result.error!);
    assert.deepEqual(Object.keys(payload.error.fields ?? {}).sort(), ["name", "nickname"]);
    assert.equal(payload.error.message, Object.values(payload.error.fields!).join("; "));
  });

  it("addresses an element of a list as name[index]", async () => {
    const result = validateBody({ ...GOOD_KEY, scopes: ["events:write", "bogus"] }, KEY_POST);
    assert.equal(result.ok, false);
    const payload = await envelope(result.error!);
    assert.deepEqual(Object.keys(payload.error.fields!), ["scopes[1]"]);
    assert.match(payload.error.fields!["scopes[1]"], /must be one of/);
  });

  it("describes a wrong type the way a person would say it", async () => {
    // "got a object" sent people looking for the bug in their own request. `null`
    // is not in this list because a null never reaches the type sentence: the walk
    // answers "cannot be null" first, which is its own describe block below.
    for (const [value, word] of [[[], "an array"], [{}, "an object"], [42, "a number"], [true, "a boolean"]] as const) {
      const result = validateBody({ ...GOOD_KEY, name: value }, KEY_POST);
      assert.equal(result.ok, false, JSON.stringify(value));
      assert.match((await envelope(result.error!)).error.message, new RegExp(`got ${word}$`));
    }
  });

  it("answers 400 rather than 422 when the bytes are not a JSON object", async () => {
    const parsed = await readJson(request("prose"));
    assert.equal(parsed.ok, false);
    const payload = await envelope(parsed.error!);
    assert.equal(parsed.error!.status, 400);
    assert.equal(payload.error.code, "invalid_request");
    assert.equal(payload.error.fields, undefined);
  });
});

describe("the request body itself", () => {
  const body = async (payload: string | undefined) =>
    (await readJson(request(payload))).ok === true;

  it("parses an object and hands the route something it can index", async () => {
    const parsed = await readJson(request('{"name":"ci deploy"}'));
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.body, { name: "ci deploy" });
  });

  it("is a 400 when it is not JSON, where request.json() was a 500", async () => {
    // Measured on all seven routes that read a body with a bare `await
    // request.json()`: the throw happened inside the handler, and a throw inside a
    // handler is Next's 500 — a status a correct client retries.
    for (const payload of ["", "not json", "{", '{"name": "Ada",}', "prose"]) {
      assert.equal(await body(payload), false, JSON.stringify(payload));
      const parsed = await readJson(request(payload));
      assert.equal(parsed.error!.status, 400);
      assert.equal((await envelope(parsed.error!)).error.message, "request body is not valid JSON");
    }
  });

  it("is a 400 when it is JSON but not an object", async () => {
    // `null` parsed and then threw on the handler's next line at `body.name`; a
    // number or an array parsed, threw nothing, and produced `undefined` fields.
    for (const payload of ["null", "42", '"prose"', "[1,2]"]) {
      const parsed = await readJson(request(payload));
      assert.equal(parsed.ok, false, payload);
      assert.match((await envelope(parsed.error!)).error.message, /^request body must be a JSON object, got /);
    }
  });

  it("keeps its own copy of the object rule, because a route may pass anything", async () => {
    // `validateBody` is called with the parsed body, and the unit tests and any
    // future caller can hand it a scalar. Same answer either way.
    const result = validateBody("prose", KEY_POST);
    assert.equal(result.ok, false);
    assert.match((await envelope(result.error!)).error.message, /^request body must be a JSON object, got a string/);
  });
});

function request(payload: string | undefined): Request {
  return new Request("http://localhost/api/keys", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: payload,
  });
}

describe("text", () => {
  it("trims, and refuses what trimming leaves empty", async () => {
    const result = validateBody({ ...GOOD_KEY, name: "   " }, KEY_POST);
    assert.equal(result.ok, false);
    assert.match((await envelope(result.error!)).error.message, /name must be a non-empty string/);

    const trimmed = validateBody({ ...GOOD_KEY, name: "  ci deploy  " }, KEY_POST);
    assert.equal(trimmed.data?.name, "ci deploy");
  });

  it("clears a nullable column with blank text, and writes nothing for an omitted one", () => {
    const cleared = validateBody({ name: "ok", nickname: "   " }, ONE);
    assert.equal(cleared.ok, true);
    assert.equal(cleared.data?.nickname, null);

    const omitted = validateBody({ name: "ok" }, ONE);
    assert.equal("nickname" in (omitted.data ?? {}), false);
  });

  it("caps a name at the length the list can show", async () => {
    // Measured: a 4,999-character key name answered 201 and read back 4,999.
    const result = validateBody({ ...GOOD_KEY, name: "x".repeat(201) }, KEY_POST);
    assert.equal(result.ok, false);
    assert.match((await envelope(result.error!)).error.message, /name is 201 characters; at most 200/);

    const edge = validateBody({ ...GOOD_KEY, name: "x".repeat(200) }, KEY_POST);
    assert.equal(edge.ok, true);
  });

  it("requires a field it says is required", async () => {
    const result = validateBody({ scopes: ["events:write"] }, KEY_POST);
    assert.equal(result.ok, false);
    assert.match((await envelope(result.error!)).error.message, /name is required/);
  });
});

describe("url is a format, not a hope", () => {
  it("accepts http and https", () => {
    assert.equal(validateBody(GOOD_WEBHOOK, WEBHOOK_POST).ok, true);
    assert.equal(validateBody({ url: "http://example.invalid/a" }, WEBHOOK_POST).ok, true);
  });

  it("refuses a scheme a signer would happily POST to", async () => {
    // `new URL` alone accepts all of these; the protocol check is the point.
    for (const url of ["javascript:alert(1)", "file:///etc/passwd", "data:text/plain,x", "ftp://x.invalid/y", "not a url"]) {
      const result = validateBody({ url }, WEBHOOK_POST);
      assert.equal(result.ok, false, url);
      assert.match((await envelope(result.error!)).error.message, /must be an http\(s\) URL/);
    }
  });

  it("refuses the array that used to become an address", async () => {
    // `String(["https://example.invalid/hook"])` is `https://example.invalid/hook`.
    // The pre-change route called exactly that, and stored the result.
    const result = validateBody({ url: ["https://example.invalid/hook"] }, WEBHOOK_POST);
    assert.equal(result.ok, false);
    assert.match((await envelope(result.error!)).error.message, /url must be text, got an array/);
  });

  it("says what it does not: an address on your own network still passes", () => {
    // `http://127.0.0.1:6379/` is a well-formed http URL and this boundary's job is
    // shape. It measured as accepted before this file existed, it is accepted now,
    // and refusing it is task #32 — a rule about where the gateway may POST, not
    // about whether a string is a URL. Pinned here so the day #32 lands, this
    // assertion is the line that changes.
    assert.equal(validateBody({ url: "http://127.0.0.1:6379/" }, WEBHOOK_POST).ok, true);
  });
});

describe("pattern", () => {
  it("keeps the event-name rule the route already had", async () => {
    assert.equal(validateBody({ type: "lead.created" }, EVENT_POST).ok, true);
    const result = validateBody({ type: "has space" }, EVENT_POST);
    assert.equal(result.ok, false);
    assert.match((await envelope(result.error!)).error.message, /does not match/);
  });

  it("applies the same rule to every element of a list", async () => {
    const result = validateBody({ url: "https://example.invalid/hook", events: ["lead.created", "not a name"] }, WEBHOOK_POST);
    assert.equal(result.ok, false);
    assert.deepEqual(Object.keys((await envelope(result.error!)).error.fields ?? {}), ["events[1]"]);
  });

  it("bounds each name in a list, not only the list", async () => {
    // A 5,000-character filter can never match a published type, because the type
    // is capped at 128; the pre-change check was `typeof e === "string"` and
    // nothing else.
    const result = validateBody({ url: "https://example.invalid/hook", events: ["e".repeat(129)] }, WEBHOOK_POST);
    assert.equal(result.ok, false);
    assert.match((await envelope(result.error!)).error.message, /events\[0\] is 129 characters; at most 128/);
  });
});

describe("int", () => {
  it("refuses a number in quotes and says how to send it", async () => {
    // Measured: `"1000"` answered 201 with the 600 default — `typeof` read it as
    // "not sent".
    const result = validateBody({ ...GOOD_KEY, rateLimitPerMin: "1000" }, KEY_POST);
    assert.equal(result.ok, false);
    assert.match((await envelope(result.error!)).error.message, /must be a whole number, got "1000" as text — send it unquoted/);
  });

  it("refuses a fraction instead of flooring it", async () => {
    // Measured: `1.9` stored 1.
    const result = validateBody({ ...GOOD_KEY, rateLimitPerMin: 1.9 }, KEY_POST);
    assert.equal(result.ok, false);
    assert.match((await envelope(result.error!)).error.message, /send it without a fraction/);
  });

  it("refuses the value that overflows Prisma's Int", async () => {
    // Measured as a 500: `1e21` is a whole number and passes `Number.isInteger`.
    const result = validateBody({ ...GOOD_KEY, rateLimitPerMin: 1e21 }, KEY_POST);
    assert.equal(result.ok, false);
    assert.match((await envelope(result.error!)).error.message, /must be at most 1000000/);
  });

  it("refuses a negative and accepts zero, which means unlimited", async () => {
    const negative = validateBody({ ...GOOD_KEY, rateLimitPerMin: -5 }, KEY_POST);
    assert.equal(negative.ok, false);
    assert.match((await envelope(negative.error!)).error.message, /must be at least 0/);
    assert.equal(validateBody({ ...GOOD_KEY, rateLimitPerMin: 0 }, KEY_POST).ok, true);
  });

  it("keeps an omitted limit omitted, so the column default stands", () => {
    const result = validateBody(GOOD_KEY, KEY_POST);
    assert.equal(result.ok, true);
    assert.equal("rateLimitPerMin" in (result.data ?? {}), false);
  });
});

describe("strings", () => {
  it("refuses a bare string and tells the caller the shape", async () => {
    // `scopes: "keys:write"` and `scopes: ["bogus"]` used to get one message for
    // two different mistakes.
    const result = validateBody({ ...GOOD_KEY, scopes: "keys:write" }, KEY_POST);
    assert.equal(result.ok, false);
    assert.match((await envelope(result.error!)).error.message, /must be an array of strings, got a string — send it as a one-element array/);
  });

  it("refuses an empty list, which used to mean every scope", async () => {
    const result = validateBody({ name: "x", scopes: [] }, KEY_POST);
    assert.equal(result.ok, false);
    assert.match((await envelope(result.error!)).error.message, /must hold at least one entry/);
  });

  it("refuses an unknown member rather than filtering it out", async () => {
    // Measured: `["keys:write","bogus"]` answered 201 with `["keys:write"]` stored,
    // so the caller held a key that was not the one they described.
    const result = validateBody({ ...GOOD_KEY, scopes: ["keys:write", 42, "bogus", "   "] }, KEY_POST);
    assert.equal(result.ok, false);
    const payload = await envelope(result.error!);
    assert.deepEqual(Object.keys(payload.error.fields ?? {}), ["scopes[1]", "scopes[2]", "scopes[3]"]);
  });

  it("accepts every scope name the gateway itself compares against", () => {
    assert.equal(validateBody({ ...GOOD_KEY, scopes: ["*"] }, KEY_POST).ok, true);
    assert.equal(validateBody({ ...GOOD_KEY, scopes: ["keys:write", "events:write", "webhooks:write", "sso:write"] }, KEY_POST).ok, true);
  });

  it("bounds how many entries a list holds", async () => {
    const result = validateBody({ url: "https://example.invalid/hook", events: Array.from({ length: 101 }, (_, i) => `e${i}`) }, WEBHOOK_POST);
    assert.equal(result.ok, false);
    assert.match((await envelope(result.error!)).error.message, /holds 101 entries; at most 100/);
  });
});

describe("enum", () => {
  it("refuses a word outside the set, naming the set", async () => {
    const result = validateBody({ ...GOOD_SSO, metadataUrl: GOOD_SSO.issuer, type: "SAML" }, SSO_POST);
    assert.equal(result.ok, false);
    assert.match((await envelope(result.error!)).error.message, /type must be one of OIDC, got "SAML"/);
  });

  it("refuses an array saying the one legal word", async () => {
    // Measured: `type: ["OIDC"]` answered "type must be OIDC in v1", which is an
    // answer to a different question than the caller asked.
    const result = validateBody({ ...GOOD_SSO, type: ["OIDC"] }, SSO_POST);
    assert.equal(result.ok, false);
    assert.match((await envelope(result.error!)).error.message, /type must be one of OIDC, got an array/);
  });

  it("accepts the member and leaves an omitted one absent", () => {
    assert.equal(validateBody({ ...GOOD_SSO, type: "OIDC" }, SSO_POST).ok, true);
    assert.equal("type" in (validateBody(GOOD_SSO, SSO_POST).data ?? {}), false);
  });
});

describe("json", () => {
  it("refuses a scalar payload", async () => {
    for (const data of [42, "prose", true]) {
      const result = validateBody({ type: "lead.created", data }, EVENT_POST);
      assert.equal(result.ok, false, JSON.stringify(data));
      assert.match((await envelope(result.error!)).error.message, /data must be an object or an array/);
    }
  });

  it("refuses null and names both things the caller could mean", async () => {
    const result = validateBody({ type: "lead.created", data: null }, EVENT_POST);
    assert.equal(result.ok, false);
    assert.match((await envelope(result.error!)).error.message, /send \{\} to clear it, or omit the key to leave it alone/);
  });

  it("bounds the payload that every subscriber is sent", async () => {
    // Measured: a 2 MB `data` answered 201 and produced one Delivery row per
    // matching subscription, each POSTed to the customer.
    const result = validateBody({ type: "lead.created", data: { blob: "x".repeat(64 * 1024) } }, EVENT_POST);
    assert.equal(result.ok, false);
    assert.match((await envelope(result.error!)).error.message, /bytes of JSON; at most 65536/);
  });

  it("accepts an object or an array unless the table says object", async () => {
    assert.equal(validateBody({ type: "lead.created", data: [1, 2] }, EVENT_POST).ok, true);
    const objectOnly = { dims: { kind: "json", objectOnly: true } } as const satisfies Schema;
    assert.equal(validateBody({ dims: [1, 2] }, objectOnly).ok, false);
    assert.equal(validateBody({ dims: { a: 1 } }, objectOnly).ok, true);
  });
});

describe("bool", () => {
  it("accepts only true and false", () => {
    assert.equal(validateBody({ isActive: true }, WEBHOOK_PATCH).ok, true);
    assert.equal(validateBody({ isActive: false }, WEBHOOK_PATCH).data?.isActive, false);
  });

  it("refuses the value that used to be stored as its opposite", async () => {
    // Measured, all three: `Boolean("no")`, `Boolean([])`, `Boolean(42)` are true,
    // so a caller turning a subscription off got one that stayed on.
    for (const isActive of ["no", [], 42, "true"]) {
      const result = validateBody({ isActive }, WEBHOOK_PATCH);
      assert.equal(result.ok, false, JSON.stringify(isActive));
      assert.match((await envelope(result.error!)).error.message, /isActive must be true or false/);
    }
  });

  it("refuses the empty string that used to switch a live endpoint off", async () => {
    const empty = validateBody({ isActive: "" }, WEBHOOK_PATCH);
    assert.equal(empty.ok, false);
    assert.match((await envelope(empty.error!)).error.message, /send it unquoted/);

    const nul = validateBody({ isActive: null }, WEBHOOK_PATCH);
    assert.equal(nul.ok, false);
    assert.match((await envelope(nul.error!)).error.message, /isActive cannot be null; omit it to leave the value alone/);
  });
});

describe("null is not absent", () => {
  it("clears only a column the table says is nullable", async () => {
    const cleared = validateBody({ clientId: null }, SSO_PATCH);
    assert.equal(cleared.data?.clientId, null);

    const required = validateBody({ name: null, issuer: "https://x.invalid", metadataUrl: "https://x.invalid/m" }, SSO_POST);
    assert.equal(required.ok, false);
    assert.match((await envelope(required.error!)).error.message, /name is required and cannot be null/);
  });

  it("never lets a caller write a column the table does not name", () => {
    // `hashedKey` and `revokedAt` are the gateway's own, and `workspaceId` comes
    // from the credential. Measured, `PATCH /api/keys/:id` answered 200 for a body
    // carrying all three.
    const ok = validateBody({ ...GOOD_KEY, hashedKey: "deadbeef", revokedAt: 42, workspaceId: "other" }, KEY_POST);
    assert.equal(ok.ok, true);
    for (const field of ["hashedKey", "revokedAt", "workspaceId"]) {
      assert.equal(field in (ok.data ?? {}), false, field);
    }
  });
});

describe("a PATCH that asks for no change", () => {
  it("is refused, where Prisma answered the untouched row", async () => {
    // Measured as three 200s — one per `[id]` PATCH route.
    for (const schema of [KEY_PATCH, SSO_PATCH]) {
      const result = validateBody({}, schema, { requireWrite: true });
      assert.equal(result.ok, false);
      assert.equal((await envelope(result.error!)).error.message, NO_FIELD_TO_UPDATE);
    }
  });

  it("is refused when the only fields sent are ones the route does not own", async () => {
    const result = validateBody({ revokedAt: null }, KEY_PATCH, { requireWrite: true });
    assert.equal(result.ok, false);
    assert.equal((await envelope(result.error!)).error.message, NO_FIELD_TO_UPDATE);
  });

  it("is accepted when a field is sent, even if it is the column's current value", () => {
    const result = validateBody({ name: "same as before" }, KEY_PATCH, { requireWrite: true });
    assert.equal(result.ok, true);
  });

  it("reports the field problems in preference to the empty-write message", async () => {
    // `{ name: 42 }` is not "nothing to update"; it is a wrong value. Saying the
    // first would send the caller to the wrong sentence.
    const result = validateBody({ name: 42 }, KEY_PATCH, { requireWrite: true });
    assert.equal(result.ok, false);
    assert.match((await envelope(result.error!)).error.message, /name must be text/);
  });
});

describe("boolFlag: a route-control flag is still typed", () => {
  it("treats absent and null as not sent", () => {
    assert.equal(boolFlag(undefined, "all").value, undefined);
    assert.equal(boolFlag(null, "all").value, undefined);
    assert.equal(boolFlag(true, "all").value, true);
    assert.equal(boolFlag(false, "all").value, false);
  });

  it("refuses the string that used to be blamed on another field", async () => {
    // Measured: `all: "yes"` is not `true`, so replay answered that the caller's
    // *deliveryId* was missing.
    const result = boolFlag("yes", "all");
    assert.equal(result.ok, false);
    const payload = await envelope(result.error!);
    assert.equal(result.error!.status, 422);
    assert.deepEqual(Object.keys(payload.error.fields ?? {}), ["all"]);
    assert.match(payload.error.message, /all must be true or false, got a string — send it unquoted/);
  });
});

describe("fieldProblem: a rule about two fields at once", () => {
  it("answers in the same envelope as the field walk", async () => {
    // `REPLAY_POST` declares `deliveryId` and `status` as optional because either
    // of two shapes is legal; the pair rule lives in the route.
    const response = fieldProblem("deliveryId", "deliveryId, or all:true, is required");
    assert.equal(response.status, 422);
    const payload = await envelope(response);
    assert.equal(payload.error.code, "invalid_request");
    assert.deepEqual(payload.error.fields, { deliveryId: "deliveryId, or all:true, is required" });
  });

  it("is reachable from the tables that need it", () => {
    const bothAbsent = validateBody({}, REPLAY_POST);
    assert.equal(bothAbsent.ok, true, "the walk alone cannot know that {} is not enough");
    const wrongType = validateBody({ deliveryId: 42 }, REPLAY_POST);
    assert.equal(wrongType.ok, false, "and 42 was a 500 on the way into Prisma's where clause");
    const longId = validateBody({ webhookId: "x".repeat(101) }, DIAGNOSE_POST);
    assert.equal(longId.ok, false);
  });
});
