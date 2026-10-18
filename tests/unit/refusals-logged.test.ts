// Every refusal an authed route raises leaves a row in the request log.
//
// README: "Every authed outcome — including 401s, 403s and 429s — lands in the
// request log, which is what /api/usage reads. An audit trail with holes is
// where abuse hides." The holes were three, measured on 18 Oct 2026:
//
//   · a revoked key's continued use — requireKey resolved the record, saw
//     revokedAt, and refused without attributing the refusal to the workspace
//     it was holding, so hammering a killed key left no trace;
//   · POST /api/keys at the 20-live-key cap — the route's own `refused()`
//     helper, whose comment promises every refusal it raises goes in the log,
//     was bypassed by a direct NextResponse.json;
//   · POST /api/sso's duplicate-name 409 — the same bypass, same envelope.
//
// All three passed every existing guard because they are not missing an auth
// check and not missing validation — they answer correctly and simply forget
// the log line. So this file counts the log line.
//
// The scan is a window, not a parser: it walks each literal response and
// requires a logging call within reach. It can pass on a neighbouring
// refusal's logging call, which is why the domination-grade checks in
// route-auth.test.ts remain the other half of the net. MIN/MAX are measured
// counts, deliberately wide — they catch a scan that went blind (zero
// matches) or started double-counting, never a healthy refactor of a few
// routes.
import { test, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");
const API = join(ROOT, "src", "app", "api");
const WINDOW = 14;
const MIN_LITERALS = 8;
const MAX_LITERALS = 45;

/** Refusals with no workspace to attribute them to, and what makes each safe. */
const NO_WORKSPACE: Record<string, string> = {
  "src/app/api/health/route.ts":
    "the liveness probe is unauthenticated by design — there is no tenant this refusal could name",
};

function* routeFiles(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* routeFiles(path);
    else if (name === "route.ts") yield path;
  }
}

test("every 4xx/5xx literal in an authed route has a logging call in reach", () => {
  let literals = 0;
  const missing: string[] = [];
  for (const file of routeFiles(API)) {
    const relative = file.slice(ROOT.length + 1);
    if (NO_WORKSPACE[relative]) continue;
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      const match = /status:\s*(4\d{2}|5\d{2})/.exec(line);
      if (!match) return;
      literals += 1;
      const lookback = lines.slice(Math.max(0, i - WINDOW), i + 1).join("\n");
      if (!/refused\(|logSuccess\(|await log\(/.test(lookback)) {
        missing.push(`${relative}:${i + 1} (status ${match[1]})`);
      }
    });
  }
  assert.equal(missing.join(", "), "", "a refusal reaches a caller without reaching the log");
  assert.ok(
    literals >= MIN_LITERALS,
    `the scan found ${literals} refusal literals; below ${MIN_LITERALS} it may have gone blind`,
  );
  assert.ok(
    literals <= MAX_LITERALS,
    `the scan found ${literals} refusal literals; above ${MAX_LITERALS} it may be double-counting`,
  );
});

describe("a revoked key's refusals are attributable", () => {
  const auth = readFileSync(join(ROOT, "src", "lib", "auth.ts"), "utf8");

  it("the revoked branch is its own guard, so the log call can name the record", () => {
    const revoked = /if\s*\(record\.revokedAt\)\s*\{([\s\S]*?)\n\}/.exec(auth);
    assert.ok(revoked, "requireKey must branch on record.revokedAt on its own");
    assert.match(
      revoked[1],
      /fail\(\s*401[\s\S]*?record\.workspaceId\s*,\s*record\.id\s*\)/,
      "the refusal must pass the record's own workspace and key id into the log",
    );
  });

  it("the unknown-token branch stays anonymous — there is nothing to attribute", () => {
    assert.match(auth, /if\s*\(!record\)\s*\{/, "the missing-record case is still its own branch");
    assert.doesNotMatch(
      auth,
      /!record\s*\|\|\s*record\.revokedAt/,
      "recombining the branches would silently drop the attribution again",
    );
  });
});
