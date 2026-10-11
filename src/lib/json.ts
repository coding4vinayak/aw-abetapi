import type { InputJsonValue } from "@prisma/client/runtime/library";

/**
 * Re-wrap a JSON blob read back from our own database for a Prisma write.
 */
export function asInputJson(value: unknown): InputJsonValue {
  return value as InputJsonValue;
}

/** Spread-safe view of a stored JSON object. */
export function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

/** String list stored as JSON (scopes, event names). */
export function asStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}
