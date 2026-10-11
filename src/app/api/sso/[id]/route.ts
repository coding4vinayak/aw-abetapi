import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { classifyTarget } from "@/lib/egress";
import { requireKey, logSuccess, conflictFor, notFound } from "@/lib/auth";
import { readJson, validateBody, fieldProblem } from "@/lib/validate";
import { SSO_PATCH } from "@/lib/fields";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const startedAt = Date.now();
  const { id } = await params;
  const auth = await requireKey(request, []);
  if (!auth.ok) return auth.response;

  const conn = await prisma.ssoConnection.findFirst({ where: { id, workspaceId: auth.key.workspaceId } });
  if (!conn) {
    return notFound(auth.key, request, startedAt, "No such connection.");
  }

  await logSuccess(auth.key, request, 200, startedAt);
  return NextResponse.json(conn);
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const startedAt = Date.now();
  const { id } = await params;
  const auth = await requireKey(request, ["sso:write"]);
  if (!auth.ok) return auth.response;

  const conn = await prisma.ssoConnection.findFirst({ where: { id, workspaceId: auth.key.workspaceId } });
  if (!conn) {
    return notFound(auth.key, request, startedAt, "No such connection.");
  }

  // A refusal this route raises goes in the request log, as `requireKey`'s own
  // 401/403/429 already do — see the note in `POST /api/keys`.
  const refused = async (response: NextResponse) => {
    await logSuccess(auth.key, request, response.status, startedAt);
    return response;
  };

  const read = await readJson(request);
  if (!read.ok) return refused(read.error);
  const parsed = validateBody(read.body, SSO_PATCH, { requireWrite: true });
  if (!parsed.ok) return refused(parsed.error);
  const { name, issuer, metadataUrl, clientId } = parsed.data;

  if (metadataUrl !== undefined) {
    const target = await classifyTarget(metadataUrl, "metadataUrl");
    if (!target.ok) return refused(fieldProblem("metadataUrl", target.reason));
  }

  try {
    const updated = await prisma.ssoConnection.update({
      where: { id },
      data: {
        ...(name !== undefined ? { name } : {}),
        ...(issuer !== undefined ? { issuer } : {}),
        // A new metadata document invalidates whatever the last check found,
        // so the verification columns move with the field the caller named —
        // `status` is still not something a caller may set directly.
        ...(metadataUrl !== undefined ? { metadataUrl, status: "UNCHECKED", lastError: null } : {}),
        ...(clientId !== undefined ? { clientId } : {}),
      },
    });

    await logSuccess(auth.key, request, 200, startedAt);
    return NextResponse.json(updated);
  } catch (error) {
    // Measured, pre-change: renaming a connection to a name this same workspace
    // already holds answered 500. The `(workspaceId, name)` index is the whole
    // reason, and it is a known state, not a server fault — the create route has
    // said so through `conflictFor` since that route was written, and this one
    // never got the same wrapper.
    const conflict = conflictFor(error);
    if (conflict) return refused(conflict);
    throw error;
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const startedAt = Date.now();
  const { id } = await params;
  const auth = await requireKey(request, ["sso:write"]);
  if (!auth.ok) return auth.response;

  const deleted = await prisma.ssoConnection.deleteMany({ where: { id, workspaceId: auth.key.workspaceId } });
  if (deleted.count === 0) {
    return notFound(auth.key, request, startedAt, "No such connection.");
  }

  await logSuccess(auth.key, request, 200, startedAt);
  return NextResponse.json({ revoked: true, id });
}
