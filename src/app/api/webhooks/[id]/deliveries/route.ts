import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireKey, logSuccess, notFound } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const startedAt = Date.now();
  const { id } = await params;
  const auth = await requireKey(request, []);
  if (!auth.ok) return auth.response;

  const hook = await prisma.webhook.findFirst({ where: { id, workspaceId: auth.key.workspaceId }, select: { id: true } });
  if (!hook) {
    return notFound(auth.key, request, startedAt, "No such webhook.");
  }

  const deliveries = await prisma.delivery.findMany({
    where: { webhookId: id },
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  await logSuccess(auth.key, request, 200, startedAt);
  return NextResponse.json({ deliveries });
}
