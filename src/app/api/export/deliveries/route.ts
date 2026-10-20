import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { canManageRoles } from "@/lib/roles";
import { prisma } from "@/lib/db";
import { exportDownloadHeaders, exportFilename, deliveryCsvHeader, deliveryCsvRow } from "@/lib/export";

export const dynamic = "force-dynamic";

/**
 * Deliveries per batch. Each row carries its own payload and attempt log, so
 * the batch bounds the number of delivery objects held at once.
 */
const DELIVERY_BATCH = 200;

/**
 * GET /api/export/deliveries — the webhook delivery audit, streamed as CSV.
 *
 * The product's claim is that every delivery is verifiable. This is the door
 * for that: one row per delivery attempt with its payload, status code, error
 * and attempt log. Deliveries have no useful upper bound, so loading them into
 * the workspace JSON would turn a data-rights feature into an out-of-memory
 * error. The stream pages by primary key (`id > cursor`) and writes each batch
 * as it arrives.
 *
 * Authentication is checked before the stream is constructed. The stream only
 * reads the workspaceId captured from that session.
 */
export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }
  if (!canManageRoles(session.role)) {
    return NextResponse.json(
      { error: "Only an owner or admin can export the workspace." },
      { status: 403 },
    );
  }

  const workspaceId = session.workspaceId;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let cursor: string | undefined;
      try {
        controller.enqueue(encoder.encode(deliveryCsvHeader()));
        for (;;) {
          const deliveries = await prisma.delivery.findMany({
            where: { workspaceId, ...(cursor ? { id: { gt: cursor } } : {}) },
            orderBy: { id: "asc" },
            take: DELIVERY_BATCH,
            select: {
              id: true,
              webhookId: true,
              event: true,
              statusCode: true,
              ok: true,
              error: true,
              attempts: true,
              durationMs: true,
              createdAt: true,
              eventId: true,
              payload: true,
              status: true,
              nextAttemptAt: true,
              lastAttemptAt: true,
              deadAt: true,
              attemptLog: true,
              replayedFrom: true,
            },
          });
          if (deliveries.length === 0) break;

          let chunk = "";
          for (const d of deliveries) chunk += deliveryCsvRow(d);
          controller.enqueue(encoder.encode(chunk));

          cursor = deliveries[deliveries.length - 1].id;
          if (deliveries.length < DELIVERY_BATCH) break;
        }
        controller.close();
      } catch (err) {
        console.error("[export] delivery audit stream failed:", err);
        controller.error(err);
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: exportDownloadHeaders(
      exportFilename(session.workspaceSlug, "deliveries"),
      "text/csv; charset=utf-8",
    ),
  });
}