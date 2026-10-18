// #34, held in place: the published contract (`/api/v1/openapi`, `src/lib/openapi.ts`)
// is this app's product — a client codes against `error.code` and the response table.
// Two ways it lied, both measured against source before this round:
//
//   1. Ten operations demand a write scope via `requireKey(request, ["x:write"])`, so a
//      valid-but-under-scoped key gets a 403 — `requireKey` returns it, and after #33
//      it is logged. Only three of those ten documented it. `DELETE /api/keys/{id}`,
//      both webhook writes, the replay, all four sso writes, and `POST /api/webhooks`
//      answered a reachable status the machine-readable contract never listed. (The
//      seven read/no-scope endpoints ask `requireKey(request, [])`, and
//      `scopesCover(_, [])` is always true, so they correctly have no 403 — the rule
//      is scope ⟺ 403, not "add 403 everywhere".)
//   2. `info.version` was the literal `"0.1.0"` while the changelog announced `v1.0.1`
//      and package.json also said `0.1.0` — three places, two stories, no single source.
//
// The guard below checks the document against the code, not against a hand-copied list:
// it reads each authenticated handler's real scope requirement out of its body
// (comment-stripped, so a prose "403" cannot satisfy it), finds the matching operation in
// the imported spec, and asserts the 403 is documented exactly when a scope is demanded.
// The version assertion pins all three to one value so a future bump in one place cannot
// leave the others behind. The scanner is shared with `route-auth`/`route-validation`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { collectHandlers } from "./route-handlers";
import { openapiSpec } from "../../src/lib/openapi";

const strip = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

/** `src/app/api/sso/[id]/check/route.ts` GET → `/api/sso/{id}/check`. */
function openapiPath(file: string): string {
  return file
    .replace(/^src\/app\/api\//, "/api/")
    .replace(/\/route\.ts$/, "")
    .replace(/\[([^\]]+)\]/g, "{$1}");
}

/** The scope list passed to this handler's `requireKey`, or null if it never calls one. */
function requiredScopes(body: string): string[] | null {
  const m = /requireKey\(\s*request\s*,\s*\[([^\]]*)\]/.exec(body);
  if (!m) return null;
  return m[1]
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

type Operation = { responses?: Record<string, unknown> };
function operationFor(path: string, method: string): Operation | undefined {
  return (openapiSpec.paths as Record<string, Record<string, Operation>>)[path]?.[method.toLowerCase()];
}

test("every authenticated handler's operation is in the published document", () => {
  const offenders: string[] = [];
  for (const h of collectHandlers()) {
    const body = strip(h.body);
    if (requiredScopes(body) === null && !/requireKey\(/.test(body)) continue; // public endpoint
    if (!operationFor(openapiPath(h.file), h.method)) offenders.push(`${h.method} ${openapiPath(h.file)}`);
  }
  assert.deepEqual(offenders, [], `handlers the document does not describe:\n  ${offenders.join("\n  ")}`);
});

test("a 403 is documented exactly where requireKey can return one", () => {
  const offenders: string[] = [];
  for (const h of collectHandlers()) {
    const body = strip(h.body);
    const scopes = requiredScopes(body);
    if (scopes === null) continue; // not a scoped requireKey route
    const op = operationFor(openapiPath(h.file), h.method);
    if (!op) { offenders.push(`${h.method} ${openapiPath(h.file)} — no operation to check`); continue; }
    const documents403 = op.responses ? "403" in op.responses : false;
    if (scopes.length > 0 && !documents403) offenders.push(`${h.method} ${openapiPath(h.file)} — demands [${scopes.join(", ")}] but documents no 403`);
    if (scopes.length === 0 && documents403) offenders.push(`${h.method} ${openapiPath(h.file)} — demands no scope but documents a 403`);
  }
  assert.deepEqual(offenders, [], `documented scopes out of step with requireKey:\n  ${offenders.join("\n  ")}`);
});

test("the version is one number in all three places", () => {
  const pkgVersion: string = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")).version;
  const changelog = readFileSync(join(process.cwd(), "src/app/changelog/page.tsx"), "utf8");
  // Newest announced release: the changelog lists "Newest first", so the first v*.*.* wins.
  const announced = /v(\d+\.\d+\.\d+)/.exec(changelog)?.[1];
  assert.equal(openapiSpec.info.version, pkgVersion, "openapi.info.version must be the package version");
  assert.equal(pkgVersion, announced, "package.json version must match the changelog's newest entry");
});

// Crawlers and API tooling probe /openapi.json first. It must be the same
// document, not a second copy that can drift from the versioned path.
test("the conventional /openapi.json re-exports the versioned handler", () => {
  const alias = strip(readFileSync(join(process.cwd(), "src/app/openapi.json/route.ts"), "utf8"));
  assert.match(
    alias,
    /export\s*\{\s*GET\s*\}\s*from\s*["']\.\.\/api\/v1\/openapi\/route["']/,
    "/openapi.json must re-export the versioned handler",
  );
  assert.match(alias, /export\s+const\s+dynamic\s*=\s*["']force-dynamic["']/);
  assert.doesNotMatch(alias, /openapiSpec/, "the alias must not carry a second copy of the spec");
});

// A guard that only ever sees a compliant codebase would also pass if its regexes
// rotted. These pin the extractors on the shapes the real routes use, both directions.
test("the scope extractor reads the list, not the prose", () => {
  assert.deepEqual(requiredScopes(`  await requireKey(request, ["keys:write"]);`), ["keys:write"]);
  assert.deepEqual(requiredScopes("  const auth = await requireKey(request, []);"), []);
  assert.deepEqual(requiredScopes("  await requireKey(request, ['webhooks:write', 'keys:write']);"), ["webhooks:write", "keys:write"]);
  // Comment-stripping happens at the call site (real bodies are stripped first), so the
  // extractor sees code only; a doc comment naming requireKey is gone before it arrives.
  assert.equal(requiredScopes(strip('  // requireKey(request, ["*"]) is only prose\n  return null;')), null);
  assert.equal(requiredScopes("  return NextResponse.json({ ok: 1 });"), null);
});
