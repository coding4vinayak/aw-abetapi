import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireKey, logSuccess, notFound } from "@/lib/auth";
import { attemptDelivery } from "@/lib/dispatch";
import { boolFlag, fieldProblem, readJson, validateBody } from "@/lib/validate";
import { REPLAY_POST } from "@/lib/fields";

export const dynamic = "force-dynamic";

/**
 * POST /api/webhooks/{id}/deliveries/replay
 *
 * Re-send deliveries that were parked. A dead-letter queue nobody can drain is
 * just a slower way of losing events, so the parked rows have to be actionable:
 *
 *   { "deliveryId": "…" }              re-send one delivery
 *   { "all": true, "status": "DEAD" }  re-send a batch
 *
 * The replay is a **new** `Delivery` row, not a mutation of the old one. That
 * matters: the original record stays as the historical fact that it failed, and
 * the retry is an auditable separate event rather than an edit that makes a
 * failure look like a success. The old row's id is kept on the new one as
 * `replayedFrom`.
 *
 * The payload is copied from the original row, so the replay is byte-identical
 * to what failed — a receiver verifying the HMAC sees a consistent body rather
 * than a re-serialisation of today's data.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const startedAt = Date.now();
  const { id } = await params;
  const auth = await requireKey(request, ["webhooks:write"]);
  if (!auth.ok) return auth.response;

  const hook = await prisma.webhook.findFirst({
    where: { id, workspaceId: auth.key.workspaceId },
  });
  if (!hook) {
    return notFound(auth.key, request, startedAt, "No such webhook.");
  }

  // This route logs every answer it gives, including its refusals, so the
  // status is read off the response rather than repeated beside it — the three
  // hand-written refusals below were already doing this with literals.
  const refused = async (response: NextResponse) => {
    await logSuccess(auth.key, request, response.status, startedAt);
    return response;
  };

  const read = await readJson(request);
  if (!read.ok) return refused(read.error);
  const all = boolFlag(read.body.all, "all");
  if (!all.ok) return refused(all.error);
  const parsed = validateBody(read.body, REPLAY_POST);
  if (!parsed.ok) return refused(parsed.error);
  const { deliveryId, status } = parsed.data;

  if (deliveryId === undefined && all.value !== true) {
    return refused(fieldProblem("deliveryId", "deliveryId, or all:true, is required"));
  }

  const targets = await prisma.delivery.findMany({
    where: deliveryId
      ? { id: deliveryId, webhookId: id }
      : { webhookId: id, status: status ?? "DEAD" },
    orderBy: { createdAt: "asc" },
    take: deliveryId ? 1 : 100,
  });

  if (targets.length === 0) {
    return notFound(auth.key, request, startedAt, "Nothing to replay.");
  }

  // Refuse to replay onto a disabled endpoint: the operator turned it off, and
  // silently re-enabling traffic would undo that decision.
  if (!hook.isActive) {
    await logSuccess(auth.key, request, 409, startedAt);
    return NextResponse.json(
      {
        error: {
          code: "conflict",
          message: "This endpoint is disabled. Re-enable it first, then replay.",
          disabledReason: hook.disabledReason,
        },
      },
      { status: 409 },
    );
  }

  const results: { deliveryId: string; originalId: string; status: string; statusCode: number | null }[] = [];

  for (const original of targets) {
    if (!original.payload) continue; // nothing to replay; a pre-upgrade row
    const row = await prisma.delivery.create({
      data: {
        workspaceId: original.workspaceId,
        webhookId: original.webhookId,
        event: original.event,
        eventId: original.eventId,
        payload: original.payload as never,
        status: "PENDING",
        attempts: 0,
        ok: false,
        replayedFrom: original.id,
      },
    });
    const outcome = await attemptDelivery(row, hook);
    results.push({
      deliveryId: row.id,
      originalId: original.id,
      status: outcome.status,
      statusCode: outcome.statusCode,
    });
  }

  await logSuccess(auth.key, request, 202, startedAt);
  return NextResponse.json(
    {
      replayed: results.length,
      // The originals are untouched: a failed delivery stays on the record.
      deliveries: results,
    },
    { status: 202 },
  );
}
