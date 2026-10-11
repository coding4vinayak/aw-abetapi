import { createHmac, timingSafeEqual } from "node:crypto";
import { prisma } from "./db";

/** Refills every minute. Rows prune themselves when tallied. */
const WINDOW_MS = 60_000;

export interface Gate {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetSecs: number;
}

/**
 * Fixed-window gate per API key. Unlimited keys (rateLimitPerMin 0) always
 * pass — that tier exists for the root key only.
 */
export async function gateKey(keyId: string, limitPerMin: number): Promise<Gate> {
  if (limitPerMin <= 0) {
    return { allowed: true, limit: 0, remaining: Number.MAX_SAFE_INTEGER, resetSecs: 0 };
  }
  const now = Date.now();
  const windowStart = new Date(Math.floor(now / WINDOW_MS) * WINDOW_MS);
  const key = `key:${keyId}:${windowStart.getTime()}`;

  const row = await prisma.rateBucket.findUnique({ where: { key } });
  const count = row?.count ?? 0;
  const resetSecs = Math.max(1, Math.ceil((windowStart.getTime() + WINDOW_MS - now) / 1000));

  if (count >= limitPerMin) {
    return { allowed: false, limit: limitPerMin, remaining: 0, resetSecs };
  }
  return { allowed: true, limit: limitPerMin, remaining: limitPerMin - count - 1, resetSecs };
}

export async function tallyKey(keyId: string): Promise<void> {
  const now = Date.now();
  const windowStart = new Date(Math.floor(now / WINDOW_MS) * WINDOW_MS);
  const key = `key:${keyId}:${windowStart.getTime()}`;

  await prisma.rateBucket.upsert({
    where: { key },
    create: { key, count: 1, windowStart },
    update: { count: { increment: 1 } },
  });

  await prisma.rateBucket.deleteMany({
    where: { windowStart: { lt: new Date(now - 2 * WINDOW_MS) } },
  });
}

/** IETF RateLimit fields + Retry-After, one reset moment for all three. */
export function rateLimitHeaders(gate: Gate): Record<string, string> {
  if (gate.limit <= 0) return {};
  return {
    "retry-after": String(gate.resetSecs),
    ratelimit: `"api";r=${gate.remaining};t=${gate.resetSecs}`,
    "ratelimit-policy": `"api";q=${gate.limit};w=60`,
  };
}
