import { NextResponse } from "next/server";
import { prisma } from "./db";
import { hashKey, looksLikeApiKey, safeEqual, scopesCover } from "./keys";
import { gateKey, tallyKey, rateLimitHeaders } from "./ratelimit";

export interface AuthedKey {
  keyId: string;
  workspaceId: string;
  workspaceName: string;
  scopes: string[];
  rateLimitPerMin: number;
}

function extractToken(request: Request): string | undefined {
  const header = request.headers.get("authorization");
  if (header?.toLowerCase().startsWith("bearer ")) {
    return header.slice(7).trim() || undefined;
  }
  const alt = request.headers.get("x-api-key");
  if (alt?.trim()) return alt.trim();
  return undefined;
}

async function logRequest(
  workspaceId: string,
  keyId: string | undefined,
  request: Request,
  status: number,
  startedAt: number,
): Promise<void> {
  const url = new URL(request.url);
  await prisma.requestLog
    .create({
      data: {
        workspaceId,
        ...(keyId ? { keyId } : {}),
        method: request.method,
        path: url.pathname,
        status,
        durationMs: Date.now() - startedAt,
      },
    })
    .catch(() => undefined);
}

/**
 * Authenticate a platform request by API key and enforce scopes + quota.
 * Every outcome — including refusals — is logged, because an audit trail
 * with holes is where abuse hides.
 */
export async function requireKey(
  request: Request,
  requiredScopes: string[],
): Promise<{ ok: true; key: AuthedKey; startedAt: number } | { ok: false; response: NextResponse }> {
  const startedAt = Date.now();
  const fail = async (status: number, code: string, message: string, workspaceId?: string, keyId?: string) => {
    if (workspaceId) await logRequest(workspaceId, keyId, request, status, startedAt);
    return {
      ok: false as const,
      response: NextResponse.json({ error: { code, message } }, { status }),
    };
  };

  const token = extractToken(request);
  if (!token || !looksLikeApiKey(token)) {
    return fail(401, "authentication_error", "Missing API key. Send 'Authorization: Bearer <key>'.");
  }

  const record = await prisma.apiKey.findUnique({
    where: { hashedKey: hashKey(token) },
    include: { workspace: true },
  });
  if (!record || record.revokedAt) {
    return fail(401, "authentication_error", "Invalid or revoked API key.");
  }
  if (!safeEqual(record.hashedKey, hashKey(token))) {
    return fail(401, "authentication_error", "Invalid API key.");
  }

  const scopes = (record.scopes ?? []) as unknown as string[];
  if (!scopesCover(Array.isArray(scopes) ? scopes : [], requiredScopes)) {
    await logRequest(record.workspaceId, record.id, request, 403, startedAt);
    return {
      ok: false as const,
      response: NextResponse.json(
        { error: { code: "permission_error", message: "This key lacks a required scope." } },
        { status: 403 },
      ),
    };
  }

  const gate = await gateKey(record.id, record.rateLimitPerMin);
  if (!gate.allowed) {
    await logRequest(record.workspaceId, record.id, request, 429, startedAt);
    const response = NextResponse.json(
      { error: { code: "rate_limit_error", message: "Quota exhausted for this key." } },
      { status: 429 },
    );
    for (const [name, value] of Object.entries(rateLimitHeaders(gate))) {
      response.headers.set(name, value);
    }
    return { ok: false as const, response };
  }
  await tallyKey(record.id);

  void prisma.apiKey
    .update({ where: { id: record.id }, data: { lastUsedAt: new Date() } })
    .catch(() => undefined);

  const key: AuthedKey = {
    keyId: record.id,
    workspaceId: record.workspaceId,
    workspaceName: record.workspace.name,
    scopes: Array.isArray(scopes) ? scopes : [],
    rateLimitPerMin: record.rateLimitPerMin,
  };

  return {
    ok: true as const,
    key,
    // The caller passes this back to logSuccess so success and refusal
    // share one clock instead of two.
    startedAt,
  };
}

/** Log a successful authed call. Pair with requireKey's startedAt. */
export async function logSuccess(key: AuthedKey, request: Request, status: number, startedAt: number): Promise<void> {
  await logRequest(key.workspaceId, key.keyId, request, status, startedAt);
}

/**
 * A route's own "no such row" answer, in the published `{ error: { code, message } }`
 * envelope. It exists so that the audit entry is not the part a route can forget:
 * going through here, rather than `NextResponse.json(..., { status: 404 })`, writes
 * the `RequestLog` row before returning, so `GET /api/usage` sees an enumeration
 * probe against `keys/[id]`, `webhooks/[id]`, `sso/[id]` and the replay/deliveries
 * routes just as it sees a 401 or a 429. Measured before this helper: thirteen such
 * 404s were returned from a lookup miss with no logging call ahead of them.
 *
 * `ai/diagnose-webhook` deliberately does not use it: that route prints a bare
 * `{ error: "…" }` string its own dashboard renders, and it already logs the 404
 * inline — see its comment. A helper built for one envelope must not be forced onto
 * a route whose envelope is different on purpose.
 */
export async function notFound(
  key: AuthedKey,
  request: Request,
  startedAt: number,
  message: string,
): Promise<NextResponse> {
  await logSuccess(key, request, 404, startedAt);
  return NextResponse.json({ error: { code: "not_found", message } }, { status: 404 });
}

/**
 * A route's findUnique pre-check is only a fast path: two requests that both
 * pass it reach the database together, and one of them throws here. A unique
 * violation is a known state, not a server fault, and it must not leave as 5xx
 * because 5xx is the one status a correct client retries. Detection is
 * structural (error name + code) rather than an instanceof on the generated
 * client, so the unit suite can cover it without reaching a database.
 */
export function conflictFor(error: unknown): NextResponse | null {
  if (!(error instanceof Error) || !error.name.startsWith("PrismaClient")) return null;
  if ((error as { code?: unknown }).code !== "P2002") return null;

  const meta = (error as { meta?: { modelName?: unknown; target?: unknown } }).meta ?? {};
  const raw = Array.isArray(meta.target) ? meta.target : typeof meta.target === "string" ? meta.target.split(/[\s,]+/) : [];
  const fields = raw.filter((f): f is string => typeof f === "string" && f.length > 0);
  // workspaceId is the tenant the caller authenticated as, so it describes the
  // scope of the constraint rather than the value that collided.
  const shown = fields.filter((f) => f !== "workspaceId");
  const list = (shown.length ? shown : fields).join(" + ");
  const message = list ? `A ${typeof meta.modelName === "string" ? meta.modelName : "record"} with this ${list} already exists in this workspace.` : `That ${typeof meta.modelName === "string" ? meta.modelName : "record"} already exists in this workspace.`;
  return NextResponse.json({ error: { code: "conflict", message } }, { status: 409 });
}
