import { prisma } from "./db";
import { classifyTarget } from "./egress";

const DISCOVERY_TIMEOUT_MS = 10000;

export interface DiscoveryResult {
  ok: boolean;
  issuer?: string;
  authorizationEndpoint?: string;
  error?: string;
}

/**
 * Live-check an OIDC issuer: fetch its discovery document and confirm the
 * shape (issuer + authorization_endpoint). This proves the connection points
 * at a real identity provider. The interactive login handshake itself needs
 * the customer's client credentials and stays out of scope until one exists —
 * this registry refuses to pretend otherwise.
 */
export async function checkOidcDiscovery(metadataUrl: string): Promise<DiscoveryResult> {
  let url: URL;
  try {
    url = new URL(metadataUrl);
  } catch {
    return { ok: false, error: "metadataUrl is not a URL" };
  }
  if (url.protocol !== "https:") {
    return { ok: false, error: "metadataUrl must be https" };
  }
  // The discovery document is fetched by this server, at an address the caller
  // typed, so it goes through the same egress policy as a webhook target.
  const target = await classifyTarget(url.toString(), "metadataUrl");
  if (!target.ok) return { ok: false, error: target.reason };

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), DISCOVERY_TIMEOUT_MS);
    const res = await fetch(url.toString(), {
      signal: ctrl.signal,
      headers: { accept: "application/json" },
    });
    clearTimeout(timer);
    if (!res.ok) return { ok: false, error: `Discovery returned HTTP ${res.status}` };
    const doc = (await res.json()) as Record<string, unknown>;
    if (typeof doc.issuer !== "string" || typeof doc.authorization_endpoint !== "string") {
      return { ok: false, error: "Discovery document lacks issuer or authorization_endpoint" };
    }
    return { ok: true, issuer: doc.issuer, authorizationEndpoint: doc.authorization_endpoint };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "discovery failed" };
  }
}

export async function runSsoCheck(connectionId: string): Promise<DiscoveryResult> {
  const conn = await prisma.ssoConnection.findUnique({ where: { id: connectionId } });
  if (!conn) throw new Error("Connection not found");

  if (conn.type !== "OIDC") {
    const result = { ok: false, error: `type '${conn.type}' is not supported in v1 (OIDC only)` };
    await prisma.ssoConnection.update({
      where: { id: connectionId },
      data: { status: "FAILED", lastCheckedAt: new Date(), lastError: result.error },
    });
    return result;
  }

  const result = await checkOidcDiscovery(conn.metadataUrl);
  await prisma.ssoConnection.update({
    where: { id: connectionId },
    data: {
      status: result.ok ? "VERIFIED" : "FAILED",
      lastCheckedAt: new Date(),
      lastError: result.ok ? null : result.error,
    },
  });
  return result;
}
