import { NextResponse } from "next/server";
import { requireKey, logSuccess } from "@/lib/auth";
import { gateKey } from "@/lib/ratelimit";

export const dynamic = "force-dynamic";

/** Who am I: workspace, scopes, and this key's current quota state. */
export async function GET(request: Request) {
  const startedAt = Date.now();
  const auth = await requireKey(request, []);
  if (!auth.ok) return auth.response;

  const gate = await gateKey(auth.key.keyId, auth.key.rateLimitPerMin);
  await logSuccess(auth.key, request, 200, startedAt);
  return NextResponse.json({
    workspace: { id: auth.key.workspaceId, name: auth.key.workspaceName },
    keyId: auth.key.keyId,
    scopes: auth.key.scopes,
    quota: { limit: gate.limit, remaining: gate.remaining, resetSecs: gate.resetSecs },
  });
}
