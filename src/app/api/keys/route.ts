import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { generateApiKey, scopesCover } from "@/lib/keys";
import { requireKey, logSuccess } from "@/lib/auth";
import { readJson, validateBody } from "@/lib/validate";
import { KEY_POST } from "@/lib/fields";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const startedAt = Date.now();
  const auth = await requireKey(request, []);
  if (!auth.ok) return auth.response;

  const keys = await prisma.apiKey.findMany({
    where: { workspaceId: auth.key.workspaceId, revokedAt: null },
    select: { id: true, name: true, prefix: true, scopes: true, rateLimitPerMin: true, lastUsedAt: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  });

  await logSuccess(auth.key, request, 200, startedAt);
  return NextResponse.json({ keys });
}

export async function POST(request: Request) {
  const startedAt = Date.now();
  const auth = await requireKey(request, ["keys:write"]);
  if (!auth.ok) return auth.response;

  // `requireKey` logs its own 401/403/429, and `/api/usage` reads that log. A
  // refusal this route raises is the same kind of authed outcome — a caller
  // probing the bug class these tables close is exactly what an audit trail is
  // for — so it goes in before the response leaves.
  const refused = async (response: NextResponse) => {
    await logSuccess(auth.key, request, response.status, startedAt);
    return response;
  };

  const read = await readJson(request);
  if (!read.ok) return refused(read.error);
  const parsed = validateBody(read.body, KEY_POST);
  if (!parsed.ok) return refused(parsed.error);
  const { name, rateLimitPerMin } = parsed.data;
  // `normalizeScopes` filtered an unknown member out and answered 201 with a
  // narrower key than the caller described; the table refuses it by name now.
  // What is still worth doing here is the dedupe — `["keys:write", "keys:write"]`
  // is two known scopes and a valid request, and the stored list is what GET
  // shows a person who has to read it.
  //
  // An omitted `scopes` inherits the caller's own list rather than `["*"]`, and
  // the check below refuses a *named* scope the caller does not hold. Together
  // those two are one rule — a minted key never holds more authority than the
  // key that minted it — and the rule is what closes the escalation this round
  // measured. Inheriting rather than requiring the field also matters to the
  // contract: `src/app/changelog/page.tsx` promises thirty days' notice before a
  // breaking change ships, and a request that used to work is not the place to
  // break one. The response body echoes the stored list either way, so nothing
  // is decided in silence.
  const scopes = [...new Set(parsed.data.scopes ?? auth.key.scopes)];

  // A key may hand out only what it holds. Measured with a key holding only
  // `keys:write`: `scopes: ["*"]` minted a key with every scope and the row
  // answered 201 about it happily. 403 rather than 422 because the body's shape
  // was fine and the authority was not — this is a statement about the calling
  // key, which is what 403 means here. `scopesCover` treats `*` as everything,
  // so `["*"]` passes for a `*` holder and is the one name anyone else is
  // refused for. Checked before the live-key count, so a caller cannot learn
  // this workspace's key population from a request that was going to be refused
  // anyway.
  const notHeld = scopes.filter((scope) => !scopesCover(auth.key.scopes, [scope]));
  if (notHeld.length > 0) {
    return refused(
      NextResponse.json(
        {
          error: {
            code: "permission_error",
            message: `This key may not grant scopes it does not hold: ${notHeld.join(", ")}.`,
          },
        },
        { status: 403 },
      ),
    );
  }

  const live = await prisma.apiKey.count({
    where: { workspaceId: auth.key.workspaceId, revokedAt: null },
  });
  if (live >= 20) {
    return refused(
      NextResponse.json(
        { error: { code: "conflict", message: "This workspace already has 20 live keys. Revoke one first." } },
        { status: 409 },
      ),
    );
  }

  const { plaintext, hashedKey, prefix } = generateApiKey();
  // Only a root key may mint an unlimited key. Anything else gets at least
  // a 60/min ceiling, so a compromised sub-key cannot be turned into an
  // uncapped one by its own holder. This is a product rule about *who* is
  // asking, not a type check, so it stays here; the `Math.floor` it used to
  // need is gone because the `int` kind refuses a fraction before it arrives.
  const unlimited = auth.key.scopes.includes("*");
  const quota =
    rateLimitPerMin === undefined
      ? undefined
      : unlimited
        ? rateLimitPerMin
        : Math.max(60, rateLimitPerMin);
  const row = await prisma.apiKey.create({
    data: {
      workspaceId: auth.key.workspaceId,
      name,
      hashedKey,
      prefix,
      scopes,
      ...(quota !== undefined ? { rateLimitPerMin: quota } : {}),
    },
  });

  await logSuccess(auth.key, request, 201, startedAt);
  // The only response that ever carries a plaintext. Close the page and
  // the next step is creating a new key.
  return NextResponse.json(
    { id: row.id, name: row.name, prefix: row.prefix, scopes, key: plaintext },
    { status: 201 },
  );
}
