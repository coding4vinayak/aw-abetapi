// N1 for abetapi: /api/usage windowed its groupBy with
// Math.min(Math.max(parseInt(days), 1), 90). Math.max(NaN, 1) is NaN and
// Math.min(NaN, 90) is NaN, so days=abc produced an Invalid Date for the
// `createdAt: { gte: since }` filter — the cap was enforced for real numbers
// only, which is the half that was already safe.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { intParam } from "../../src/lib/pagination";

const params = (query: Record<string, string>) => new URLSearchParams(query);

describe("the usage window cannot be NaN", () => {
  const days = (v?: string) => intParam(params(v === undefined ? {} : { days: v }), "days", 7, 1, 90);

  it("falls back to the default for anything unparseable", () => {
    for (const v of ["abc", "", "  ", "0", "-1"]) assert.equal(days(v), 7, JSON.stringify(v));
  });

  it("reads an exponential as its leading digit, not as NaN", () => {
    // parseInt stops at "e", so "1e9x" is 1 and "1e9" is 1. The honest
    // behaviour is a one-day window, not the default and not a crash.
    assert.equal(days("1e9x"), 1);
    assert.equal(days("1e9"), 1);
  });

  it("clamps the top of the range instead of refusing it", () => {
    assert.equal(days("3650"), 90);
  });

  it("honours a real window inside the range", () => {
    assert.equal(days("30"), 30);
    assert.equal(days("1"), 1);
  });
});
