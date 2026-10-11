// N5, held in place: a request body that reaches Prisma unvalidated is a 500 or a
// wrong row, and nothing in the type system notices when the next route forgets.
//
// Measured against this app's own routes, over HTTP, before the field tables
// existed — 165 cases through a dev server whose `DATABASE_URL` pointed at a copy
// of `prisma/dev.db`, plus one case measured afterwards on the still-unwired
// route (full table in the header of `src/lib/validate.ts`, read-backs in
// `/tmp/abectorial/n5-api-before.txt`). Replayed against this code in
// `n5-api-after.mts` — 178 rows, the 165 under the same labels plus 13 only the
// fixed code can pose: nineteen 500s became none, and 60 of the 85 cases that
// answered 2xx became 422s naming the field in `error.fields`. The five that
// decided the shape of this file:
//
//   POST /api/keys            scopes ["*"], from a key holding only `keys:write`
//                                                201, and the row said so — the
//                                                escalation this file's own route
//                                                guards, closed by a grant check
//   POST /api/keys            rateLimitPerMin 1e21   500 — Prisma's `Int` overflow
//   PATCH /api/webhooks/:id   isActive "no"      200, stored **true** (`Boolean`)
//   POST /api/v1/events       data 2 MB          201, one Delivery row per
//                                                subscriber, each POSTed to the
//                                                customer
//   POST /api/…/replay        deliveryId 42      500
//
// Four of those five are 422s now, the grant case is a 403, and `scopes` omitted
// is the one before-state row this round answered by keeping the request legal: it
// inherits the caller's own scopes rather than either minting `["*"]` or refusing a
// body that used to work. All of them are refusals or documented inheritance now,
// in this app's published envelope, with the field
// named. What this file pins is that they stay that way: `validate.test.ts`
// proves the engine, and these prove that every route is actually plugged into
// it. The scanner is shared with `route-auth.test.ts` for the reason given there
// — a copy scanned twice drifts twice.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { collectHandlers, countCodeMentions, schemaArgs, unresolvedTailCalls } from "./route-handlers";
import * as FIELDS from "../../src/lib/fields";

/** The calls that decide what a body may contain. */
const VALIDATES = /validateBody\s*\(|boolFlag\s*\(/;

/**
 * Reading a body at all, however the handler spells it. `request.json()` is in
 * this list as the thing that must *stop* appearing: it is the call that threw on
 * `prose` and answered 500, and every one of them is `readJson` now. The rule
 * that keeps it that way is its own test below, separate from the validate check
 * because "reads through the boundary" and "checks what it read" are two
 * different promises — a route could `readJson` and hand the object straight to
 * Prisma, and pass a rule that only looks for a validator.
 */
const READS_A_BODY = /readJson\s*\(|\brequest\.json\s*\(\s*\)/;

/**
 * Handlers that read a body and are excused from validating it, each with the
 * reason. Adding a line here is the review step, same as `PUBLIC` is for
 * authentication.
 *
 * It is empty, and that is the finding: unlike abetflow, which excuses the
 * inbound trigger because its payload *is* the product, every body abetapi reads
 * is a description of a row in one of its own tables — a key, a subscription, an
 * SSO connection, one event to fan out, one delivery to replay. There is nothing
 * here whose payload a caller is entitled to get wrong.
 */
const UNVALIDATED: Record<string, string[]> = {};

/** Every route file the scanner found, once. */
const ROUTE_FILES = [...new Set(collectHandlers().map((h) => h.file))];
const routeSource = (file: string) => readFileSync(join(process.cwd(), file), "utf8");

test("every handler that reads a body validates it", () => {
  const offenders: string[] = [];
  for (const h of collectHandlers()) {
    if (!READS_A_BODY.test(h.body)) continue;
    if (VALIDATES.test(h.body)) continue;
    if ((UNVALIDATED[h.file] ?? []).includes(h.method)) continue;
    offenders.push(`${h.file} ${h.method}`);
  }
  assert.deepEqual(offenders, [], `handlers that read a body and hand it to Prisma unchecked:\n  ${offenders.join("\n  ")}`);
});

test("no handler reads a body with request.json()", () => {
  const offenders = collectHandlers()
    .filter((h) => /\brequest\.json\s*\(\s*\)/.test(h.body))
    .map((h) => `${h.file} ${h.method}`);
  assert.deepEqual(offenders, [], `bodies read past the boundary — use readJson, which answers 400 where these threw 500:\n  ${offenders.join("\n  ")}`);
});

test("UNVALIDATED names handlers that still exist", () => {
  const seen = new Set(collectHandlers().map((h) => `${h.file} ${h.method}`));
  const stale = Object.entries(UNVALIDATED).flatMap(([file, methods]) => methods.filter((m) => !seen.has(`${file} ${m}`)));
  assert.deepEqual(stale, [], `excused but not found — delete the entry or fix the scanner:\n  ${stale.join("\n  ")}`);
});

test("a route validates against a declared table, never an inline one", () => {
  const declared = new Set(Object.keys(FIELDS));
  const offenders: string[] = [];
  for (const file of ROUTE_FILES) {
    for (const arg of schemaArgs(routeSource(file))) {
      if (arg.startsWith("{")) offenders.push(`${file} — an inline schema`);
      else if (!declared.has(arg)) offenders.push(`${file} — ${arg} is not exported from lib/fields`);
    }
  }
  assert.deepEqual(offenders, [], `validate calls with no table in lib/fields:\n  ${offenders.join("\n  ")}`);
});

test("every declared table and every cap is used by something", () => {
  const fieldSource = routeSource("src/lib/fields.ts");
  const unusedTables = Object.keys(FIELDS).filter(
    (name) => !ROUTE_FILES.some((file) => new RegExp(`\\b${name}\\b`).test(routeSource(file)))
      && countCodeMentions(fieldSource, name) === 0,
  );
  assert.deepEqual(unusedTables, [], `tables in lib/fields nothing uses — delete them or wire them:\n  ${unusedTables.join("\n  ")}`);

  // The sets and numbers a table is built from. A cap no field cites is a number
  // someone will read as a rule that does not exist.
  const unusedCaps = Object.keys(FIELDS).filter((name) => !/_POST|_PATCH/.test(name) && countCodeMentions(fieldSource, name) === 0);
  assert.deepEqual(unusedCaps, [], `caps in lib/fields no field uses:\n  ${unusedCaps.join("\n  ")}`);
});

/**
 * A PATCH that names no column answers the 200-for-nothing this app measured
 * three times over (`POST/PATCH /api/keys/:id {}`, webhooks, sso). `requireWrite`
 * is how a route says it made that check; the one route that cannot use it —
 * `webhooks/[id]`, where `rotate: true` asks for a write without naming a column
 * — says so by citing the same constant. Both spellings are the same promise, so
 * this rule is about the promise, not about the option.
 */
test("every PATCH route refuses a body that asks for no change", () => {
  const offenders: string[] = [];
  for (const h of collectHandlers()) {
    if (h.method !== "PATCH") continue;
    const src = routeSource(h.file);
    if (!/requireWrite:\s*true/.test(src) && !src.includes("NO_FIELD_TO_UPDATE")) {
      offenders.push(`${h.file} ${h.method}`);
    }
  }
  assert.deepEqual(offenders, [], `PATCHes that will answer 200 for an empty write:\n  ${offenders.join("\n  ")}`);
});

/**
 * Text fields whose name ends in `Id` and that address no row, each with the
 * reason. A review step like `UNVALIDATED` is, and the test below refuses an
 * entry that no longer matches anything.
 */
const NOT_A_FOREIGN_KEY: Record<string, string> = {
  clientId:
    "SsoConnection.clientId is a plain `String?` with no relation to anything " +
    "(prisma/schema.prisma:159) — the id the *provider* issued, not a primary " +
    "key of ours. No lookup could answer for it; what checks it is runSsoCheck, " +
    "which asks the issuer over the network. [prisma]",
};

/**
 * A text field called `somethingId` names a row rather than filling a column, so
 * the type check is only half the rule: measured, `POST /api/…/replay` with
 * `deliveryId: 42` threw on the way into Prisma's `where`, and a real id from
 * another workspace has to 404 rather than replay. The route has to say whether
 * the row exists and belongs to this workspace. The lookup may be spelled
 * `id: deliveryId` or `id: parsed.data.deliveryId`, because the validated value
 * comes out of the engine under a prefix.
 */
test("an id-typed field is checked for existence where it is accepted", () => {
  const offenders: string[] = [];
  const idFields = new Set<string>();
  for (const [name, schema] of Object.entries(FIELDS)) {
    for (const [field, spec] of Object.entries(schema as Record<string, { kind?: string }>)) {
      if (/Id$/.test(field) && spec?.kind === "text") idFields.add(field);
    }
  }
  for (const [name, schema] of Object.entries(FIELDS)) {
    const fields = Object.entries(schema as Record<string, { kind?: string }>)
      .filter(([field, spec]) => /Id$/.test(field) && spec?.kind === "text")
      .map(([field]) => field)
      .filter((field) => !NOT_A_FOREIGN_KEY[field]);
    if (!fields.length) continue;
    for (const file of ROUTE_FILES.filter((f) => new RegExp(`\\b${name}\\b`).test(routeSource(f)))) {
      const src = routeSource(file);
      for (const field of fields) {
        const batchChecked = new RegExp(`(unknownIdError|unknownIdsError|missingIds)[^)]*\\b${field}\\b`).test(src);
        // A short window after `where:`, because replay's clause is a ternary —
        // `where: deliveryId ? { id: deliveryId, webhookId: id } : …` — and the
        // `id:` the rule is looking for is one object literal past the keyword.
        const lookedUp = new RegExp(`where:[\\s\\S]{0,120}?\\bid:\\s*(?:[\\w.]+\\.)?${field}\\b`).test(src);
        if (!batchChecked && !lookedUp) {
          offenders.push(`${file} accepts ${name}.${field} without checking the row exists`);
        }
      }
    }
  }
  // An exemption nobody can apply is a rule that silently stopped existing.
  const stale = Object.keys(NOT_A_FOREIGN_KEY).filter((field) => !idFields.has(field));
  assert.deepEqual(stale, [], `excused as not-a-foreign-key, but no text field ends that way now: ${stale.join(", ")}`);
  assert.deepEqual(offenders, [], `foreign keys taken on faith:\n  ${offenders.join("\n  ")}`);
});

/**
 * A handler whose body is `return helper(request)` validates nothing and writes nothing
 * until the helper is read. The scanner resolves same-file tail calls (§8.41); this asks
 * it, once per handler, whether the callee's block actually came back — so the day the
 * resolution breaks, the rules above fail loudly instead of passing on a thinner body.
 * Vendored mechanism, local assertion: 181 handlers across the six apps, none hidden.
 */
test("no handler hides a same-file helper behind a tail call", () => {
  const hidden = unresolvedTailCalls(collectHandlers());
  assert.deepEqual(hidden, [], `scanned without the function they return:\n  ${hidden.join("\n  ")}`);
});
