import { prisma } from "./db";
import { asRecord } from "./json";

/**
 * The export surface for the API gateway — the connective tissue of the
 * Abetworks suite.
 *
 * Three doors:
 *
 *   - `buildWorkspaceExport` is the portable copy: team, invitations, API
 *     keys (scopes and config only), webhook destinations, inbound sources,
 *     SSO connections, and delivery/request-log counts with stream links.
 *   - `deliveryCsvHeader` / `deliveryCsvRow` are the webhook delivery audit:
 *     one row per delivery attempt with its payload, status and attempt log,
 *     streamed in batches so a high-volume workspace never has to fit in memory.
 *   - `requestLogCsvHeader` / `requestLogCsvRow` are the usage audit: one row
 *     per API call with method, path, status and latency, streamed in batches.
 *
 * Content, not credentials. The rows a buyer owns are API key definitions
 * (scopes, rate limits), webhook destinations and event filters, inbound
 * source configs, SSO connection configs, and the delivery/request logs.
 * Password digests, session tokens, API-key hashes, invitation token hashes,
 * webhook secret hashes, inbound source secrets, SSO client secrets and Stripe
 * ids are not exported. A webhook row keeps its destination and events but
 * drops its signing key hash. An inbound source keeps its provider and config
 * but drops its secret. An SSO connection keeps its issuer and metadata URL
 * but drops its client secret.
 *
 * Every query is scoped by workspaceId. A bug in the caller cannot turn one
 * buyer's export into another's.
 */
export const EXPORT_FORMAT = "abetapi.workspace";
export const EXPORT_VERSION = 1;

/** Collapse a slug to a filename-safe token, then fail closed to "workspace". */
function safeSlug(slug: string): string {
  return (
    slug
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "workspace"
  );
}

/** The download filename, pure so the header path is testable without a database. */
export function exportFilename(
  slug: string,
  part: "workspace" | "deliveries" | "requestlogs",
  at: Date = new Date(),
): string {
  const extension = part === "workspace" ? "json" : "csv";
  return `abetapi-${safeSlug(slug)}-${part}-${at.toISOString().slice(0, 10)}.${extension}`;
}

/** Every export shares these headers; `no-store` keeps a proxy from retaining a copy. */
export function exportDownloadHeaders(filename: string, contentType: string): Record<string, string> {
  return {
    "content-type": contentType,
    "content-disposition": `attachment; filename="${filename}"`,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  };
}

/** Drop a webhook's signing secret hash. */
export function publicWebhook(hook: { id: string; url: string; events: unknown; secretPrefix: string; isActive: boolean; consecutiveFailures: number; disabledReason: string | null; createdAt: Date; updatedAt: Date }): Record<string, unknown> {
  return hook;
}

/** Drop an inbound source's HMAC secret. */
export function publicInboundSource(src: { id: string; name: string; provider: string; secretPrefix: string; isActive: boolean; lastEventAt: Date | null; lastEventName: string | null; receivedEvents: number; createdAt: Date; updatedAt: Date }): Record<string, unknown> {
  return src;
}

/** Drop an SSO connection's client secret. */
export function publicSsoConnection(sso: { id: string; name: string; type: string; issuer: string; metadataUrl: string; clientId: string | null; status: string; lastCheckedAt: Date | null; lastError: string | null; createdAt: Date; updatedAt: Date }): Record<string, unknown> {
  return sso;
}

export async function buildWorkspaceExport(workspaceId: string, exportedAt: Date = new Date()) {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { id: true, name: true, slug: true, createdAt: true, updatedAt: true },
  });
  if (!workspace) throw new Error("Workspace not found");

  const [members, invitations, apiKeys, webhooks, inboundSources, ssoConnections, deliveryCount, requestLogCount] =
    await Promise.all([
      prisma.membership.findMany({
        where: { workspaceId },
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          userId: true,
          role: true,
          createdAt: true,
          user: { select: { email: true, name: true, emailVerified: true } },
        },
      }),
      prisma.invite.findMany({
        where: { workspaceId },
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          email: true,
          role: true,
          createdById: true,
          createdAt: true,
          expiresAt: true,
          acceptedAt: true,
        },
      }),
      prisma.apiKey.findMany({
        where: { workspaceId },
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          name: true,
          prefix: true,
          scopes: true,
          rateLimitPerMin: true,
          lastUsedAt: true,
          revokedAt: true,
          createdAt: true,
        },
      }),
      prisma.webhook.findMany({
        where: { workspaceId },
        orderBy: { createdAt: "asc" },
        // The signing secret hash is a credential. The destination and event
        // list are configuration the buyer can recognize in a new home.
        select: {
          id: true,
          url: true,
          events: true,
          secretPrefix: true,
          isActive: true,
          consecutiveFailures: true,
          disabledReason: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
      prisma.inboundSource.findMany({
        where: { workspaceId },
        orderBy: { createdAt: "asc" },
        // The HMAC secret is a credential. The provider and config
        // are configuration the buyer can recognize in a new home.
        select: {
          id: true,
          name: true,
          provider: true,
          secretPrefix: true,
          isActive: true,
          lastEventAt: true,
          lastEventName: true,
          receivedEvents: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
      prisma.ssoConnection.findMany({
        where: { workspaceId },
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          name: true,
          type: true,
          issuer: true,
          metadataUrl: true,
          clientId: true,
          status: true,
          lastCheckedAt: true,
          lastError: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
      prisma.delivery.count({ where: { workspaceId } }),
      prisma.requestLog.count({ where: { workspaceId } }),
    ]);

  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: exportedAt.toISOString(),
    workspace,
    counts: {
      members: members.length,
      invitations: invitations.length,
      apiKeys: apiKeys.length,
      webhooks: webhooks.length,
      inboundSources: inboundSources.length,
      ssoConnections: ssoConnections.length,
      deliveries: deliveryCount,
      requestLogs: requestLogCount,
    },
    notes: [
      "Credentials are excluded: password digests, session tokens, API keys and their hashes, invitation token hashes, webhook secret hashes, inbound source HMAC secrets, SSO client secrets and Stripe billing ids.",
      "Delivery and request-log rows are not embedded in this document. Download them from GET /api/export/deliveries and GET /api/export/requestlogs, which stream CSV in batches.",
    ],
    deliveries: {
      count: deliveryCount,
      download: "/api/export/deliveries",
      contentType: "text/csv; charset=utf-8",
    },
    requestLogs: {
      count: requestLogCount,
      download: "/api/export/requestlogs",
      contentType: "text/csv; charset=utf-8",
    },
    members,
    invitations,
    apiKeys,
    webhooks: webhooks.map(publicWebhook),
    inboundSources: inboundSources.map(publicInboundSource),
    ssoConnections: ssoConnections.map(publicSsoConnection),
  };
}

export type WorkspaceExport = Awaited<ReturnType<typeof buildWorkspaceExport>>;

/* --------------------------------------------------------------------- delivery audit */

export interface DeliveryCsvRow {
  id: string;
  webhookId: string;
  event: string;
  statusCode: number | null;
  ok: boolean;
  error: string | null;
  attempts: number;
  durationMs: number | null;
  createdAt: Date | string;
  eventId: string | null;
  payload: unknown;
  status: string;
  nextAttemptAt: Date | string | null;
  lastAttemptAt: Date | string | null;
  deadAt: Date | string | null;
  attemptLog: unknown;
  replayedFrom: string | null;
}

/**
 * A text cell that cannot become a spreadsheet formula. Delivery error
 * messages and payloads are user/model text; a leading `=`, `+`, `-`, `@`,
 * tab or CR is the CSV injection shape, so it gets an apostrophe.
 */
const FORMULA_START = /^[=+\-@\t\r]/;

function textCell(value: unknown): string {
  let text = value === null || value === undefined ? "" : String(value);
  if (FORMULA_START.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function iso(value: Date | string | null): string {
  if (value === null) return "";
  return value instanceof Date ? value.toISOString() : value;
}

function jsonText(value: unknown): string {
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

const DELIVERY_HEADER = [
  "delivery_id",
  "webhook_id",
  "event",
  "status_code",
  "ok",
  "error",
  "attempts",
  "duration_ms",
  "created_at",
  "event_id",
  "payload",
  "status",
  "next_attempt_at",
  "last_attempt_at",
  "dead_at",
  "attempt_log",
  "replayed_from",
];

export function deliveryCsvHeader(): string {
  return `${DELIVERY_HEADER.map(textCell).join(",")}\r\n`;
}

/**
 * One delivery attempt per line. `payload` and `attempt_log` preserve the
 * exact JSON that was sent and the per-attempt detail, so a reader can
 * replay or debug without calling back into the API.
 */
export function deliveryCsvRow(row: DeliveryCsvRow): string {
  return (
    [
      textCell(row.id),
      textCell(row.webhookId),
      textCell(row.event),
      textCell(row.statusCode),
      textCell(row.ok),
      textCell(row.error),
      textCell(row.attempts),
      textCell(row.durationMs),
      textCell(iso(row.createdAt)),
      textCell(iso(row.eventId)),
      textCell(jsonText(row.payload)),
      textCell(row.status),
      textCell(iso(row.nextAttemptAt)),
      textCell(iso(row.lastAttemptAt)),
      textCell(iso(row.deadAt)),
      textCell(jsonText(row.attemptLog)),
      textCell(iso(row.replayedFrom)),
    ].join(",") + "\r\n"
  );
}

/* --------------------------------------------------------------------- request-log audit */

export interface RequestLogCsvRow {
  id: string;
  keyId: string | null;
  method: string;
  path: string;
  status: number;
  durationMs: number | null;
  createdAt: Date | string;
}

const REQUESTLOG_HEADER = [
  "requestlog_id",
  "key_id",
  "method",
  "path",
  "status",
  "duration_ms",
  "created_at",
];

export function requestLogCsvHeader(): string {
  return `${REQUESTLOG_HEADER.map(textCell).join(",")}\r\n`;
}

export function requestLogCsvRow(row: RequestLogCsvRow): string {
  return (
    [
      textCell(row.id),
      textCell(row.keyId),
      textCell(row.method),
      textCell(row.path),
      textCell(row.status),
      textCell(row.durationMs),
      textCell(iso(row.createdAt)),
    ].join(",") + "\r\n"
  );
}