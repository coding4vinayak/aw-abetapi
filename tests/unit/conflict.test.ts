// abetapi's routes pre-check for a name before inserting, which is only a fast
// path: two concurrent callers both read "free" and one throws. These pin the
// backstop — the loser gets 409 in the same envelope the pre-check already uses,
// and nothing else is swallowed.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { conflictFor } from "../../src/lib/auth";

function prismaError(code: string, meta?: unknown): Error {
  const error = new Error("Unique constraint failed on the fields: (`name`)") as Error & {
    code: string;
    meta?: unknown;
  };
  error.name = "PrismaClientKnownRequestError";
  error.code = code;
  if (meta !== undefined) error.meta = meta;
  return error;
}

describe("the unique-violation backstop", () => {
  it("answers a lost race with 409 in the documented envelope", async () => {
    const response = conflictFor(prismaError("P2002", { modelName: "SsoConnection", target: ["workspaceId", "name"] }));
    assert.equal(response?.status, 409);
    const body = (await response!.json()) as { error: { code: string; message: string } };
    assert.equal(body.error.code, "conflict");
    assert.match(body.error.message, /A SsoConnection with this name already exists in this workspace\./);
    assert.doesNotMatch(body.error.message, /workspaceId/);
  });

  it("still conflicts when the metadata is missing", async () => {
    const response = conflictFor(prismaError("P2002"));
    assert.equal(response?.status, 409);
    const body = (await response!.json()) as { error: { code: string } };
    assert.equal(body.error.code, "conflict");
  });

  it("propagates every other failure unchanged", () => {
    assert.equal(conflictFor(prismaError("P2025", { modelName: "ApiKey" })), null);
    assert.equal(conflictFor(new TypeError("boom")), null);
    assert.equal(conflictFor(undefined), null);
  });
});
