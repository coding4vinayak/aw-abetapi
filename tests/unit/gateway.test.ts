// Unit tests for AbetAPI trust primitives: key shape, scopes, signatures.
// Run: npx tsx --test tests/unit/*.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  generateApiKey,
  hashKey,
  looksLikeApiKey,
  normalizeScopes,
  scopesCover,
} from "../../src/lib/keys";
import { signDelivery, verifyDelivery } from "../../src/lib/sign";

describe("api keys", () => {
  it("mints a verifiable, prefixed key", () => {
    const { plaintext, hashedKey, prefix } = generateApiKey();
    assert.ok(looksLikeApiKey(plaintext));
    assert.equal(hashedKey, hashKey(plaintext));
    assert.equal(hashedKey, createHash("sha256").update(plaintext).digest("hex"));
    assert.ok(plaintext.startsWith(prefix));
  });

  it("rejects non-keys", () => {
    assert.equal(looksLikeApiKey(""), false);
    assert.equal(looksLikeApiKey(" Bearer abc"), false);
    assert.equal(looksLikeApiKey("ab_live_short"), false);
  });

  it("normalizes scopes, dropping unknowns and empties", () => {
    assert.deepEqual(normalizeScopes(["keys:write", "events:write"]), ["keys:write", "events:write"]);
    assert.deepEqual(normalizeScopes(["keys:write", "banana", 42]), ["keys:write"]);
    assert.equal(normalizeScopes([]), null);
    assert.equal(normalizeScopes("keys:write"), null);
  });

  it("checks coverage with * as master", () => {
    assert.equal(scopesCover(["*"], ["keys:write", "sso:write"]), true);
    assert.equal(scopesCover(["events:write"], ["events:write"]), true);
    assert.equal(scopesCover(["events:write"], ["keys:write"]), false);
    assert.equal(scopesCover([], []), true);
  });
});

describe("webhook signatures", () => {
  it("round-trips across the hash boundary", () => {
    const plaintext = "whsec_test-secret";
    const storedHash = hashKey(plaintext);
    const timestamp = "1700000000";
    const body = '{"event":"lead.created"}';
    // Server signs with the stored hash; receiver hashes first. Same value.
    const sig = signDelivery(storedHash, timestamp, body);
    assert.equal(verifyDelivery(createHash("sha256").update(plaintext).digest("hex"), body, timestamp, sig), true);
  });

  it("refuses tampered bodies, times and signatures", () => {
    const key = hashKey("s3cret");
    const sig = signDelivery(key, "1700000000", '{"a":1}');
    assert.equal(verifyDelivery(key, '{"a":2}', "1700000000", sig), false);
    assert.equal(verifyDelivery(key, '{"a":1}', "1700000001", sig), false);
    assert.equal(verifyDelivery(key, '{"a":1}', "1700000000", "deadbeef"), false);
    assert.equal(verifyDelivery(key, '{"a":1}', "1700000000", ""), false);
  });
});
