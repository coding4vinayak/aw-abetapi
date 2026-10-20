import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { canManageRoles } from "@/lib/roles";
import { prisma } from "@/lib/db";
import { exportDownloadHeaders, exportFilename, requestLogCsvHeader, requestLogCsvRow } from "@/lib/export";

export const dynamic = "force-dynamic";

/**
 * Request logs per batch.
 */
const REQUESTLOG_BATCH = 500;

/**
 * GET /api/export/requestlogs — the usage audit, streamed as CSV.
 *
 * The product's claim is that every API call is metered and auditable. This is
 * the door for that: one row per API call with method, path, status and
 * latency. Request logs have no useful upper bound, so loading them into the
 * workspace JSON would turn a data-rights feature into an out-of-memory error.
 * The stream pages by primary key (`id > cursor`) and writes each batch as it
 * arrives.
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
        controller.enqueue(encoder.encode(requestLogCsvHeader()));
        for (;;) {
          const logs = await prisma.requestLog.findMany({
            where: { workspaceId, ...(cursor ? { id: { gt: cursor } } : {}) },
            orderBy: { id: "asc" },
            take: REQUESTLOG_BATCH,
            select: {
              id: true,
              keyId: true,
              method: true,
              path: true,
              status: true,
              durationMs: true,
              createdAt: true,
            },
          });
          if (logs.length === 0) break;

          let chunk = "";
          for (const log of logs) chunk += requestLogCsvRow(log);
          controller.enqueue(encoder.encode(chunk));

          cursor = logs[logs.length - 1].id;
          if (logs.length < REQUESTLOG_BATCH) break;
        }
        controller.close();
      } catch (err) {
        console.error("[export] request-log audit stream failed:", err);
        controller.error(err);
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: exportDownloadHeaders(
      exportFilename(session.workspaceSlug, "requestlogs"),
      "text/csv; charset=utf-8",
    ),
  });
}