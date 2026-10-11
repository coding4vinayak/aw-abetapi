import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireKey, logSuccess, notFound } from "@/lib/auth";
import { runSsoCheck } from "@/lib/sso";

export const dynamic = "force-dynamic";

/** Run the live OIDC discovery check for one connection, now. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const startedAt = Date.now();
  const { id } = await params;
  const auth = await requireKey(request, ["sso:write"]);
  if (!auth.ok) return auth.response;

  const conn = await prisma.ssoConnection.findFirst({ where: { id, workspaceId: auth.key.workspaceId } });
  if (!conn) {
    return notFound(auth.key, request, startedAt, "No such connection.");
  }

  const result = await runSsoCheck(id);

  await logSuccess(auth.key, request, 200, startedAt);
  return NextResponse.json({ connection: id, ...result });
}
