// Guard-rail tests for AI webhook diagnosis. No network, no key, no DB.
// The property under test: with no failures there is nothing to diagnose,
// and with no model the delivery records stand on their own.
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { diagnoseWebhook } from "../../src/lib/ai-diagnose";

beforeEach(() => {
  delete process.env.LLM_API_KEY;
});

const webhook = {
  url: "https://customer.test/hooks/lead",
  events: ["lead.created"],
  isActive: true,
  createdAt: new Date("2026-01-01"),
};

describe("diagnoseWebhook offline contract", () => {
  it("returns null when every delivery succeeded — nothing to diagnose", async () => {
    const diagnosis = await diagnoseWebhook({
      webhook,
      deliveries: [
        { statusCode: 200, ok: true, error: null, attempts: 1, durationMs: 120, createdAt: new Date() },
      ],
    });
    assert.equal(diagnosis, null, "saying nothing is better than generating an essay");
  });

  it("returns null when no model is configured, even with real failures", async () => {
    const diagnosis = await diagnoseWebhook({
      webhook,
      deliveries: [
        { statusCode: 503, ok: false, error: "upstream timeout", attempts: 3, durationMs: 10000, createdAt: new Date() },
        { statusCode: 503, ok: false, error: "upstream timeout", attempts: 3, durationMs: 10050, createdAt: new Date() },
      ],
    });
    assert.equal(diagnosis, null, "the records are the diagnosis until a model reads them");
  });
});
