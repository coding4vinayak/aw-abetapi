// Retry policy, offline and exhaustive.
//
// This is the part of the engine that decides whether a customer gets their
// event eventually, or whether we waste their quota asking a question whose
// answer cannot change. Both mistakes are invisible in a demo, so the policy is
// tested as pure functions with no database and no clock.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isRetryable,
  nextStatus,
  retryDelayMs,
  backoffScheduleMs,
  describeFailure,
  MAX_ATTEMPTS,
  BASE_DELAY_MS,
  MAX_DELAY_MS,
  FAILURES_BEFORE_DISABLE,
} from "../../src/lib/retry";

describe("isRetryable", () => {
  it("retries what might succeed later", () => {
    for (const statusCode of [null, 408, 425, 429, 500, 502, 503, 504, 599]) {
      assert.equal(isRetryable({ statusCode }), true, `${statusCode} should retry`);
    }
  });

  it("never retries a decision the endpoint has already made", () => {
    // A 400 from a customer handler is a bug in their code. Sending the same
    // body again produces the same 400, eight times over.
    for (const statusCode of [400, 401, 403, 404, 405, 409, 410, 422]) {
      assert.equal(isRetryable({ statusCode }), false, `${statusCode} must not retry`);
    }
  });

  it("treats 2xx as not-a-failure at all", () => {
    assert.equal(isRetryable({ statusCode: 200 }), false);
    assert.equal(isRetryable({ statusCode: 204 }), false);
  });

  it("retries a request that never reached the endpoint", () => {
    // No status means DNS, refused connection, TLS failure or our own timeout —
    // the endpoint may well be healthy in a minute.
    assert.equal(isRetryable({ statusCode: null, error: "ECONNREFUSED" }), true);
  });

  it("never retries our own egress refusal", () => {
    // `statusCode === null` alone means "ask again", so a refusal has to say so
    // explicitly or an internal target is re-attempted eight times over a day of
    // backoff for an address we already decided not to connect to.
    assert.equal(isRetryable({ statusCode: null, refused: true }), false);
    assert.equal(isRetryable({ statusCode: null, refused: true, error: "blocked: 127.0.0.1" }), false);
  });
});

describe("retryDelayMs", () => {
  it("grows exponentially and is capped", () => {
    const noJitter = () => 1; // the maximum random value
    assert.equal(retryDelayMs(1, noJitter), BASE_DELAY_MS);
    assert.equal(retryDelayMs(2, noJitter), BASE_DELAY_MS * 2);
    assert.equal(retryDelayMs(3, noJitter), BASE_DELAY_MS * 4);
    // Beyond the cap, the ceiling holds even at maximum jitter.
    assert.equal(retryDelayMs(20, noJitter), MAX_DELAY_MS);
  });

  it("spreads retries with jitter so failures do not return in lockstep", () => {
    // Every delivery that failed at the same moment would otherwise be retried
    // at the same moment — a thundering herd aimed at a service that just
    // recovered.
    const samples = Array.from({ length: 200 }, () => retryDelayMs(5));
    const unique = new Set(samples);
    assert.ok(unique.size > 100, `expected a spread, got ${unique.size} distinct values`);

    const floor = MAX_DELAY_MS / 2 / 2; // attempt 5 ceiling is 8*base, capped
    for (const s of samples) {
      const ceiling = Math.min(BASE_DELAY_MS * 2 ** 4, MAX_DELAY_MS);
      assert.ok(s >= ceiling / 2, "jitter must not fall below half the delay");
      assert.ok(s <= ceiling, "jitter must not exceed the ceiling");
      assert.ok(s > 0, "a retry delay is never zero");
      void floor;
    }
  });

  it("is deterministic when the random source is", () => {
    assert.equal(retryDelayMs(3, () => 0), retryDelayMs(3, () => 0));
    assert.equal(retryDelayMs(3, () => 0.5), Math.round((BASE_DELAY_MS * 4) / 2 + 0.5 * ((BASE_DELAY_MS * 4) / 2)));
  });
});

describe("backoffScheduleMs", () => {
  it("spans a working day rather than minutes", () => {
    const schedule = backoffScheduleMs();
    assert.equal(schedule.length, MAX_ATTEMPTS - 1);
    const totalHours = schedule.reduce((a, b) => a + b, 0) / 3_600_000;
    assert.ok(totalHours > 1, `schedule spans only ${totalHours.toFixed(2)}h`);
    for (let i = 1; i < schedule.length; i++) {
      assert.ok(schedule[i] >= schedule[i - 1], "delays must not decrease");
    }
  });
});

describe("nextStatus", () => {
  it("delivers on 2xx", () => {
    for (const code of [200, 201, 204]) {
      const v = nextStatus({ statusCode: code }, 1);
      assert.equal(v.status, "DELIVERED");
      assert.equal(v.terminal, true);
    }
  });

  it("schedules a retry for a transient failure", () => {
    const v = nextStatus({ statusCode: 503 }, 1);
    assert.equal(v.status, "RETRYING");
    assert.equal(v.terminal, false);
  });

  it("parks a permanent refusal immediately, without burning the schedule", () => {
    // Eight rounds of a 400 is eight rounds of nothing.
    const v = nextStatus({ statusCode: 400 }, 1);
    assert.equal(v.status, "DEAD");
    assert.equal(v.terminal, true);
  });

  it("parks an egress refusal on the first attempt, not the eighth", () => {
    // The endpoint was never contacted; the address is internal. This is the
    // case the `refused` flag exists for — `statusCode: null` would otherwise
    // read as a network hiccup and re-attempt the same refusal to exhaustion.
    const v = nextStatus({ statusCode: null, refused: true }, 1);
    assert.equal(v.status, "DEAD");
    assert.equal(v.terminal, true);
  });

  it("parks on the last attempt even when the failure was transient", () => {
    const v = nextStatus({ statusCode: 500 }, MAX_ATTEMPTS);
    assert.equal(v.status, "DEAD");
  });

  it("keeps retrying right up to the final attempt", () => {
    assert.equal(nextStatus({ statusCode: 500 }, MAX_ATTEMPTS - 1).status, "RETRYING");
  });
});

describe("describeFailure", () => {
  it("summarises a status, a transport error, and a success", () => {
    assert.equal(describeFailure({ statusCode: 503 }), "HTTP 503");
    assert.equal(describeFailure({ statusCode: null, error: "ECONNREFUSED" }), "ECONNREFUSED");
    assert.equal(describeFailure({ statusCode: null }), "no response from endpoint");
    assert.equal(describeFailure({ statusCode: 200 }), "delivered");
  });

  it("names an egress refusal as ours, not the endpoint's", () => {
    // An operator reading the row needs to know which side said no: "HTTP 403"
    // is the customer rejecting us, "refused: …" is us refusing to go there.
    assert.equal(
      describeFailure({ statusCode: null, refused: true, error: "url host 169.254.169.254 is internal" }),
      "refused: url host 169.254.169.254 is internal",
    );
    assert.equal(describeFailure({ statusCode: null, refused: true }), "refused: egress policy");
  });

  it("truncates a hostile or enormous error string", () => {
    const long = describeFailure({ statusCode: null, error: "x".repeat(5000) });
    assert.ok(long.length <= 200, `error summary was ${long.length} chars`);
  });
});

describe("policy constants", () => {
  it("keeps the attempt count and the auto-disable threshold as declared", () => {
    assert.equal(MAX_ATTEMPTS, 8);
    assert.ok(FAILURES_BEFORE_DISABLE > 0);
    // A customer should not have to guess: the schedule is derived, not hidden.
    assert.ok(backoffScheduleMs().every((d) => d > 0));
  });
});
