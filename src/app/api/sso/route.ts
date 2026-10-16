import { NextResponse } from "next/server";
import type { SsoConnection } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { classifyTarget } from "@/lib/egress";
import { requireKey, logSuccess, conflictFor } from "@/lib/auth";
import { readJson, validateBody, fieldProblem } from "@/lib/validate";
import { SSO_POST } from "@/lib/fields";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const startedAt = Date.now();
  const auth = await requireKey(request, []);
  if (!auth.ok) return auth.response;

  const connections = await prisma.ssoConnection.findMany({
    where: { workspaceId: auth.key.workspaceId },
    orderBy: { updatedAt: "desc" },
  });

  await logSuccess(auth.key, request, 200, startedAt);
  return NextResponse.json({ connections });
}

export async function POST(request: Request) {
  const startedAt = Date.now();
  const auth = await requireKey(request, ["sso:write"]);
  if (!auth.ok) return auth.response;

  // A refusal this route raises goes in the request log, as `requireKey`'s own
  // 401/403/429 already do — see the note in `POST /api/keys`.
  const refused = async (response: NextResponse) => {
    await logSuccess(auth.key, request, response.status, startedAt);
    return response;
  };

  const read = await readJson(request);
  if (!read.ok) return refused(read.error);
  const parsed = validateBody(read.body, SSO_POST);
  if (!parsed.ok) return refused(parsed.error);
  const { name, issuer, metadataUrl, clientId } = parsed.data;

  // `metadataUrl` is the field this server fetches — `issuer` is a string a
  // discovery document answers with, never an address we connect to.
  const target = await classifyTarget(metadataUrl, "metadataUrl");
  if (!target.ok) return refused(fieldProblem("metadataUrl", target.reason));

  const existing = await prisma.ssoConnection.findUnique({
    where: { workspaceId_name: { workspaceId: auth.key.workspaceId, name } },
  });
  if (existing) {
    return NextResponse.json({ error: { code: "conflict", message: "A connection with that name exists." } }, { status: 409 });
  }

  let conn: SsoConnection;
  try {
    conn = await prisma.ssoConnection.create({
      data: {
        workspaceId: auth.key.workspaceId,
        name,
        // The table allows one word, so this is that word or no write at all;
        // reading it from the validated body keeps "OIDC only in v1" in one
        // place instead of a check here and a literal below it.
        type: parsed.data.type ?? "OIDC",
        issuer,
        metadataUrl,
        ...(clientId !== undefined ? { clientId } : {}),
      },
    });
  } catch (error) {
    // The findUnique above cannot close the gap between two concurrent callers:
    // both read "no such name", both insert, and one throws. That loser is a
    // conflict with a known cause, not a server fault to be retried.
    const conflict = conflictFor(error);
    if (conflict) return conflict;
    throw error;
  }

  await logSuccess(auth.key, request, 201, startedAt);
  return NextResponse.json(conn, { status: 201 });
}
