// The inbound half of the NuCRM bridge: the secret minted for a source, the
// verification of the sender's signature, and the envelope parse in front of
// the field table. These are the unit-level pieces of
// `POST /api/v1/inbound/nucrm/{id}` — the route's own guards (auth, validation
// table, OpenAPI entry) are covered by the scanners, not here.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { authSites } from "./route-handlers";
import {
  INBOUND_SECRET_PREFIX,
  generateInboundSecret,
  parseInboundEnvelope,
  verifyInboundSignature,
} from "../../src/lib/inbound";

describe("inbound source secrets", () => {
  it("mints a prefixed, unique secret", () => {
    const a = generateInboundSecret();
    const b = generateInboundSecret();
    assert.ok(a.plaintext.startsWith(INBOUND_SECRET_PREFIX));
    assert.ok(a.plaintext.startsWith(a.prefix));
    assert.equal(a.prefix.length, INBOUND_SECRET_PREFIX.length + 6);
    assert.notEqual(a.plaintext, b.plaintext);
  });
});

describe("inbound signature verification", () => {
  const secret = "in_live_test-secret";
  const body = JSON.stringify({
    event: "contact.created",
    timestamp: "2026-10-16T09:00:00.000Z",
    tenant_id: "t_123",
    data: { contact: { id: "c_1" } },
  });
  const sign = (raw: string, key: string) => createHmac("sha256", key).update(raw).digest("hex");

  it("accepts NuCRM's exact spelling, prefixed", () => {
    assert.equal(verifyInboundSignature(secret, body, `sha256=${sign(body, secret)}`), true);
  });

  it("accepts the bare hex the SDK's verifier compares", () => {
    assert.equal(verifyInboundSignature(secret, body, sign(body, secret)), true);
  });

  it("accepts uppercase hex", () => {
    assert.equal(verifyInboundSignature(secret, body, `sha256=${sign(body, secret).toUpperCase()}`), true);
  });

  it("refuses a tampered body, whitespace included", () => {
    const signature = sign(body, secret);
    assert.equal(verifyInboundSignature(secret, `${body} `, `sha256=${signature}`), false);
    assert.equal(verifyInboundSignature(secret, body.replace("c_1", "c_2"), `sha256=${signature}`), false);
  });

  it("refuses the wrong secret", () => {
    assert.equal(verifyInboundSignature(secret, body, `sha256=${sign(body, "in_live_other")}`), false);
  });

  it("refuses missing, empty and malformed headers without throwing", () => {
    assert.equal(verifyInboundSignature(secret, body, null), false);
    assert.equal(verifyInboundSignature(secret, body, ""), false);
    assert.equal(verifyInboundSignature(secret, body, "sha256="), false);
    assert.equal(verifyInboundSignature(secret, body, "sha256=zzzz"), false);
    assert.equal(verifyInboundSignature(secret, body, sign(body, secret).slice(0, 32)), false);
  });

  it("verifies the sender's own construction, byte for byte", () => {
    // The shape `fireWebhooks` sends: stringify once, sign the same string.
    const payload = { event: "deal.won", timestamp: new Date().toISOString(), tenant_id: "t_9", data: { amount: 42 } };
    const raw = JSON.stringify(payload);
    assert.equal(verifyInboundSignature(secret, raw, `sha256=${sign(raw, secret)}`), true);
  });
});

describe("inbound envelope parsing", () => {
  it("parses NuCRM's envelope verbatim", () => {
    const envelope = { event: "lead.created", timestamp: "2026-10-16T09:00:00.000Z", tenant_id: "t_1", data: {} };
    const parsed = parseInboundEnvelope(JSON.stringify(envelope));
    assert.equal(parsed.ok, true);
    if (parsed.ok) assert.deepEqual(parsed.body, envelope);
  });

  it("rejects bytes that are not a JSON object", () => {
    for (const raw of ["prose", "", "null", "[1,2]", '"a string"', "42"]) {
      const parsed = parseInboundEnvelope(raw);
      assert.equal(parsed.ok, false, `expected ${JSON.stringify(raw)} to be refused`);
    }
  });

  it("lets the field table own the fields", () => {
    // `{}` is a well-formed object; `event` being required is the 422 the
    // route's `validateBody(…, INBOUND_NUCRM_EVENT)` answers, not this layer's.
    const parsed = parseInboundEnvelope("{}");
    assert.equal(parsed.ok, true);
    if (parsed.ok) assert.deepEqual(parsed.body, {});
  });
});

// The two auth doors of `POST /api/v1/inbound/nucrm/{id}`, pinned at the
// source and contract level the way this repo pins route behavior the unit
// layer cannot reach (no database under `npm test`). The measured fact that
// moved the route: NuCRM's integration webhook config is `{ url, events,
// secret }` — no custom-header field — so a route that demanded a Bearer key
// could never be delivered to by NuCRM itself.
describe("the bridge's auth doors", () => {
  const route = readFileSync(join(import.meta.dirname, "..", "..", "src", "app", "api", "v1", "inbound", "nucrm", "[id]", "route.ts"), "utf8");
  const keyedBranch = /if \(keyed\) \{([\s\S]*?)\n  \} else \{/.exec(route)?.[1] ?? "";
  const plainBranch = /\} else \{([\s\S]*?)\n  \}\n\n  const refused/.exec(route)?.[1] ?? "";

  it("splits into exactly two entry doors", () => {
    assert.ok(keyedBranch, "the keyed branch must be an `if (keyed) { … } else { … }`");
    assert.ok(plainBranch, "the signature-only branch must follow it");
    assert.match(route, /const bearer|const keyed =\s*\n?\s*request\.headers\.get\("authorization"\)/);
  });

  it("only the keyed door goes through requireKey", () => {
    // `authSites` tokenizes (comments and strings masked), so a comment that
    // merely mentions requireKey cannot pass for a check the way a regex would.
    const wrap = (body: string) => `{\n${body}\n}`;
    const keyedAuths = authSites(wrap(keyedBranch)).map((a) => a.name);
    const plainAuths = authSites(wrap(plainBranch)).map((a) => a.name);
    assert.ok(keyedAuths.includes("requireKey"), `keyed door must call requireKey, saw: ${keyedAuths}`);
    assert.deepEqual(plainAuths, [], `signature-only door must not consult a key, saw: ${plainAuths}`);
    assert.match(keyedBranch, /await requireKey\(request, \["events:write"\]\)/);
  });

  it("both doors rejoin ahead of one shared signature gate", () => {
    const gate = route.indexOf("verifyInboundSignature(source.secret, raw, signature)");
    assert.ok(gate > route.indexOf("const refused"), "the gate lives in the shared path, not inside a door");
    assert.ok(gate > route.lastIndexOf("workspaceId = source.workspaceId;"), "both doors have resolved their workspace by then");
  });

  it("a present key that fails authentication is the response, never a downgrade", () => {
    assert.match(keyedBranch, /if \(!auth\.ok\) return auth\.response;/);
  });

  it("reads both spellings of the signature and delivery headers", () => {
    assert.match(route, /headers\.get\("x-nucrm-signature"\)\s*\?\?\s*request\.headers\.get\("x-webhook-signature"\)/);
    assert.match(route, /headers\.get\("x-nucrm-delivery"\)\s*\?\?\s*request\.headers\.get\("x-webhook-delivery"\)/);
  });

  it("the published contract declares the key optional", () => {
    const text = readFileSync(join(import.meta.dirname, "..", "..", "src", "lib", "openapi.ts"), "utf8");
    const entry = /"\/api\/v1\/inbound\/nucrm\/\{id\}": \{\s*post: \{([\s\S]*?)\n      responses: \{/.exec(text);
    assert.ok(entry, "the inbound operation is declared");
    assert.doesNotMatch(entry[1], /security: keyAuth/, "the endpoint must not demand a key in the contract");
    assert.match(entry[1], /"authorization"/, "the optional key door is documented as a header");
    assert.match(entry[1], /optional/i, "the description says the key is optional");
  });
});
