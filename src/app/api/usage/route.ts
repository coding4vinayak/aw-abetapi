import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireKey, logSuccess } from "@/lib/auth";
import { intParam } from "@/lib/pagination";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const startedAt = Date.now();
  const auth = await requireKey(request, []);
  if (!auth.ok) return auth.response;

  const { searchParams } = new URL(request.url);
  const days = intParam(searchParams, "days", 7, 1, 90);
  const since = new Date(Date.now() - days * 86400000);

  const rows = await prisma.requestLog.groupBy({
    by: ["keyId", "status"],
    where: { workspaceId: auth.key.workspaceId, createdAt: { gte: since } },
    _count: true,
  });

  const keys = await prisma.apiKey.findMany({
    where: { workspaceId: auth.key.workspaceId },
    select: { id: true, name: true, prefix: true, revokedAt: true },
  });
  const names = new Map(keys.map((k) => [k.id, { name: k.name, prefix: k.prefix, revoked: k.revokedAt !== null }]));

  const perKey = new Map<string, { calls: number; errors: number }>();
  for (const r of rows) {
    const key = r.keyId ?? "anonymous";
    const slot = perKey.get(key) ?? { calls: 0, errors: 0 };
    slot.calls += r._count;
    if (r.status >= 400) slot.errors += r._count;
    perKey.set(key, slot);
  }

  await logSuccess(auth.key, request, 200, startedAt);
  return NextResponse.json({
    days,
    keys: [...perKey.entries()].map(([keyId, stats]) => ({
      keyId,
      ...(names.get(keyId) ?? {}),
      ...stats,
      errorRate: stats.calls > 0 ? stats.errors / stats.calls : 0,
    })),
  });
}
