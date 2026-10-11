// #33, held in place: a route that answers "no such row" from its own lookup miss
// and returns before any logging call leaves a hole in `RequestLog`, and
// `GET /api/usage` reads that log. Measured against source before the fix, thirteen
// `:id`/deliveries/replay 404s were returned with no `logSuccess` ahead of them
// (`keys/[id]` GET+PATCH+DELETE, `webhooks/[id]` GET+PATCH+DELETE, `sso/[id]`
// GET+PATCH+DELETE, `deliveries` GET, `replay` webhook-lookup + nothing-to-replay,
// `sso/[id]/check` POST) — so an enumeration probe across those routes was invisible
// next to a 401 or a 429, which `requireKey` does log. The fix routes every such
// answer through `notFound()` in `lib/auth.ts`, which logs before it returns.
//
// The rule this file pins is the invariant, not the mechanism: **a 404 never leaves
// a handler unlogged.** `notFound()` satisfies it; `ai/diagnose-webhook` satisfies
// it by calling `logSuccess(..., 404, ...)` on the line above its own bare-string
// 404 — a shape kept on purpose because that route's dashboard renders `data.error`
// as text, so it cannot take the published envelope. Both are allowed; a bare
// `NextResponse.json(..., { status: 404 })` with nothing before it is not.
//
// The scanner is `collectHandlers` from `./route-handlers`, the same one
// `route-auth`/`route-validation` trust, and it is distrusted the same way: the
// synthetic bodies after the real ones pin it in both directions, so a scan that
// stopped seeing 404s fails loudly instead of passing on silence.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { collectHandlers } from "./route-handlers";

/** Comments talk about statuses; only code can answer with one. */
const strip = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

const answers404 = /status:\s*404/g;
const logs404 = /logSuccess\s*\([^)]*\b404\b[^)]*\)|\bnotFound\s*\(/g;

/**
 * A handler answers a 404 before it logs one — walking the body left to right, the
 * logging steps must never fall behind the answers. `notFound()` both logs and
 * answers, and its `status: 404` literal lives in `lib/auth.ts`, not here, so a
 * compliant handler's `notFound(` call reads as +1 and never goes negative. A bare
 * literal is a -1 with nothing to cancel it. Returns whether the handler breaks it.
 */
function unlogged404Handlers(body: string): boolean {
  const events: { i: number; delta: number }[] = [];
  for (const m of body.matchAll(logs404)) events.push({ i: m.index!, delta: +1 });
  for (const m of body.matchAll(answers404)) events.push({ i: m.index!, delta: -1 });
  events.sort((a, b) => a.i - b.i);
  let balance = 0;
  for (const e of events) {
    balance += e.delta;
    if (balance < 0) return true;
  }
  return false;
}

test("no handler answers a 404 before it logs one", () => {
  const offenders: string[] = [];
  for (const h of collectHandlers()) {
    if (unlogged404Handlers(strip(h.body))) offenders.push(`${h.file} ${h.method}`);
  }
  assert.deepEqual(
    offenders,
    [],
    `404s returned with no logging step ahead of them — use notFound(), or log the status first:\n  ${offenders.join("\n  ")}`,
  );
});

// The scanner above is only as good as its pattern, and a scan that said "clean" for
// everything would pass this file. These are the two shapes the rule turns on, so
// both directions are pinned against known input rather than only the real routes.
test("the 404 scan flags a bare literal and clears a logged one", () => {
  const bare = `{
    const row = await prisma.webhook.findFirst({ where: { id } });
    if (!row) {
      return NextResponse.json({ error: { code: "not_found" } }, { status: 404 });
    }
  }`;
  assert.equal(unlogged404Handlers(bare), true, "a bare unlogged 404 must be caught");

  const viaHelper = `{
    const row = await prisma.webhook.findFirst({ where: { id } });
    if (!row) {
      return notFound(auth.key, request, startedAt, "No such webhook.");
    }
  }`;
  assert.equal(unlogged404Handlers(viaHelper), false);

  const inlineLogged = `{
    if (!row) {
      await logSuccess(auth.key, request, 404, startedAt);
      return NextResponse.json({ error: "webhook not found" }, { status: 404 });
    }
  }`;
  assert.equal(unlogged404Handlers(inlineLogged), false);

  const loggedAfter = `{
    if (!row) {
      return NextResponse.json({ error: { code: "not_found" } }, { status: 404 });
    }
    await logSuccess(auth.key, request, 404, startedAt);
  }`;
  assert.equal(unlogged404Handlers(loggedAfter), true, "a log that runs after the return never fires");
});

/**
 * Positive adoption: the exact sites #33 fixed now answer through `notFound()`. Pinned
 * by count per file so that quietly dropping one back to a bare literal (which the
 * invariant test above would catch) or re-implementing it inline is visible here too,
 * and so a scanner that stopped resolving these files is not a silent pass.
 */
const NOT_FOUND_SITES: Record<string, number> = {
  "src/app/api/keys/[id]/route.ts": 3,
  "src/app/api/webhooks/[id]/route.ts": 3,
  "src/app/api/sso/[id]/route.ts": 3,
  "src/app/api/sso/[id]/check/route.ts": 1,
  "src/app/api/webhooks/[id]/deliveries/route.ts": 1,
  "src/app/api/webhooks/[id]/deliveries/replay/route.ts": 2,
};

test("the routes #33 fixed answer through notFound", () => {
  for (const [file, n] of Object.entries(NOT_FOUND_SITES)) {
    const src = strip(readFileSync(join(process.cwd(), file), "utf8"));
    const calls = (src.match(/\bnotFound\s*\(/g) ?? []).length;
    assert.equal(calls, n, `${file}: expected ${n} notFound() calls, found ${calls}`);
  }
});
