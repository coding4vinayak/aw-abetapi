import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const KEY_PREFIX = "ab_live_";
export const ALL_SCOPES = ["keys:write", "events:write", "webhooks:write", "sso:write"] as const;
export type Scope = (typeof ALL_SCOPES)[number] | "*";

export function hashKey(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

/** Mint a key. The plaintext is returned once and never persisted. */
export function generateApiKey(): { plaintext: string; hashedKey: string; prefix: string } {
  const plaintext = `${KEY_PREFIX}${randomBytes(24).toString("base64url")}`;
  return { plaintext, hashedKey: hashKey(plaintext), prefix: plaintext.slice(0, KEY_PREFIX.length + 6) };
}

export function looksLikeApiKey(token: string): boolean {
  return token.startsWith(KEY_PREFIX) && token.length > KEY_PREFIX.length + 10;
}

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** True when the key's scopes cover every required scope. */
export function scopesCover(granted: string[], required: string[]): boolean {
  if (granted.includes("*")) return true;
  return required.every((s) => granted.includes(s));
}

export function normalizeScopes(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const known = new Set<string>([...ALL_SCOPES, "*"]);
  const out = [...new Set(raw.filter((s): s is string => typeof s === "string" && known.has(s)))];
  return out.length > 0 ? out : null;
}
