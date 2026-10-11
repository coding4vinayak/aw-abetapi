import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireKey, logSuccess, notFound } from "@/lib/auth";
import { scopesCover } from "@/lib/keys";
import { readJson, validateBody } from "@/lib/validate";
import { KEY_PATCH } from "@/lib/fields";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const startedAt = Date.now();
  const { id } = await params;
  const auth = await requireKey(request, []);
  if (!auth.ok) return auth.response;

  const row = await prisma.apiKey.findFirst({
    where: { id, workspaceId: auth.key.workspaceId },
    select: { id: true, name: true, prefix: true, scopes: true, rateLimitPerMin: true, lastUsedAt: true, revokedAt: true, createdAt: true },
  });
  if (!row) {
    return notFound(auth.key, request, startedAt, "No such key in this workspace.");
  }

  await logSuccess(auth.key, request, 200, startedAt);
  return NextResponse.json(row);
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const startedAt = Date.now();
  const { id } = await params;
  const auth = await requireKey(request, ["keys:write"]);
  if (!auth.ok) return auth.response;

  const row = await prisma.apiKey.findFirst({ where: { id, workspaceId: auth.key.workspaceId } });
  if (!row) {
    return notFound(auth.key, request, startedAt, "No such key in this workspace.");
  }

  const refused = async (response: NextResponse) => {
    await logSuccess(auth.key, request, response.status, startedAt);
    return response;
  };

  // The row is looked up above, before the body is walked, so a caller who
  // cannot see this key never gets a field-level answer about it.
  const read = await readJson(request);
  if (!read.ok) return refused(read.error);
  const parsed = validateBody(read.body, KEY_PATCH, { requireWrite: true });
  if (!parsed.ok) return refused(parsed.error);
  const { name, rateLimitPerMin } = parsed.data;
  const scopes = parsed.data.scopes ? [...new Set(parsed.data.scopes)] : undefined;

  // Re-scoping is granting, so it is the mint's rule: a key may not hand out a
  // scope it does not hold. Measured before this line existed — `keys:write`
  // alone could widen any key in the workspace to `*` with a PATCH, which is the
  // same escalation as the default `scopes` omitted, reached from the other
  // direction.
  if (scopes) {
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
  }

  // Same rule as the mint: only a root key may set an unlimited (0) or
  // sub-60 ceiling. `Math.floor` is gone with the fraction it used to need.
  const unlimited = auth.key.scopes.includes("*");
  const quota =
    rateLimitPerMin === undefined ? undefined : unlimited ? rateLimitPerMin : Math.max(60, rateLimitPerMin);

  const updated = await prisma.apiKey.update({
    where: { id },
    data: {
      ...(name !== undefined ? { name } : {}),
      ...(scopes !== undefined ? { scopes } : {}),
      ...(quota !== undefined ? { rateLimitPerMin: quota } : {}),
    },
    select: { id: true, name: true, prefix: true, scopes: true, rateLimitPerMin: true, lastUsedAt: true, revokedAt: true, createdAt: true },
  });

  await logSuccess(auth.key, request, 200, startedAt);
  return NextResponse.json(updated);
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const startedAt = Date.now();
  const { id } = await params;
  const auth = await requireKey(request, ["keys:write"]);
  if (!auth.ok) return auth.response;

  // Revoke, never delete: the audit trail must survive the key. A revoked
  // row 401s on its next request, immediately.
  const revoked = await prisma.apiKey.updateMany({
    where: { id, workspaceId: auth.key.workspaceId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  if (revoked.count === 0) {
    return notFound(auth.key, request, startedAt, "No live key with that id in this workspace.");
  }

  await logSuccess(auth.key, request, 200, startedAt);
  return NextResponse.json({ revoked: true, id });
}
