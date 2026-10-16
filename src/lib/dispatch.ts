import { randomBytes, randomUUID } from "node:crypto";
import { prisma } from "./db";
import { assertAllowedTarget } from "./egress";
import { hashKey, safeEqual } from "./keys";
import { signDelivery } from "./sign";
import {
  describeFailure,
  nextStatus,
  retryDelayMs,
  FAILURES_BEFORE_DISABLE,
  MAX_ATTEMPTS,
  type AttemptOutcome,
  type DeliveryStatus,
} from "./retry";

const DELIVERY_TIMEOUT_MS = 10_000;

export function generateWebhookSecret(): { plaintext: string; hash: string; prefix: string } {
  const plaintext = `whsec_${randomBytes(24).toString("base64url")}`;
  return { plaintext, hash: hashKey(plaintext), prefix: plaintext.slice(0, 12) };
}

export function verifyWebhookSecret(plaintext: string, storedHash: string): boolean {
  return safeEqual(hashKey(plaintext), storedHash);
}


export interface DispatchResult {
  /** Accepted and delivered within this request. */
  delivered: number;
  /** Accepted but the first attempt failed; a retry is scheduled. */
  retrying: number;
  /** No matching active subscription. */
  skipped: number;
  /** How many rows were created — the honest total, regardless of outcome. */
  accepted: number;
}

/**
 * Build the exact bytes of a delivery.
 *
 * Extracted so the first attempt and every later attempt — and every replay —
 * send byte-identical payloads. A signature is computed over those bytes, so a
 * replay that re-serialised the event would produce a different body and a
 * receiver would rightly reject it as tampered.
 */
export function buildPayload(eventId: string, event: string, data: unknown): string {
  return JSON.stringify({
    id: eventId,
    event,
    timestamp: Math.floor(Date.now() / 1000),
    data,
  });
}

interface HookRow {
  id: string;
  url: string;
  secretHash: string;
}

/**
 * Make one attempt and persist the outcome.
 *
 * Never throws: a delivery failure is a recorded fact about a customer's
 * endpoint, not an error in this process. Anything thrown here would take down
 * the publisher's request for a problem the publisher cannot fix.
 */
export async function attemptDelivery(
  delivery: { id: string; workspaceId: string; webhookId: string; event: string; eventId: string | null; payload: unknown; attempts: number },
  hook: HookRow,
): Promise<{ status: DeliveryStatus; statusCode: number | null }> {
  const body = typeof delivery.payload === "string" ? delivery.payload : JSON.stringify(delivery.payload ?? null);
  const attempt = delivery.attempts + 1;
  const began = Date.now();

  let outcome: AttemptOutcome = { statusCode: null, error: "no attempt made" };
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), DELIVERY_TIMEOUT_MS);
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = signDelivery(hook.secretHash, timestamp, body);
    try {
      // Checked on the way out rather than only when the row was created. A
      // subscription can predate this policy, and a name that resolved publicly
      // last week can resolve to 169.254.169.254 today.
      await assertAllowedTarget(hook.url, "url");
      const res = await fetch(hook.url, {
        method: "POST",
        signal: ctrl.signal,
        headers: {
          "content-type": "application/json",
          "x-abetapi-event": delivery.event,
          "x-abetapi-timestamp": timestamp,
          "x-abetapi-signature": signature,
          // The idempotency key. At-least-once delivery means the receiver will
          // see this more than once; this is how it knows to process it once.
          "x-abetapi-delivery": delivery.id,
          "x-abetapi-event-id": delivery.eventId ?? delivery.id,
          "x-abetapi-attempt": String(attempt),
        },
        body,
      });
      // Drain so the socket is released rather than left half-read.
      await res.arrayBuffer().catch(() => undefined);
      outcome = { statusCode: res.status, error: res.ok ? undefined : `HTTP ${res.status}` };
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    // An egress refusal is tagged by the code `assertAllowedTarget` puts on the
    // error; anything else is a transport failure and stays retryable.
    outcome =
      typeof (e as { egressCode?: unknown })?.egressCode === "string"
        ? { statusCode: null, error: e instanceof Error ? e.message : "egress refused", refused: true }
        : { statusCode: null, error: e instanceof Error ? e.message : "delivery failed" };
  }

  const durationMs = Date.now() - began;
  const verdict = nextStatus(outcome, attempt);
  const now = new Date();

  const entry = {
    at: now.toISOString(),
    attempt,
    statusCode: outcome.statusCode,
    error: outcome.error ?? null,
    durationMs,
  };

  // Read the existing log, append, write back. Small arrays, and it keeps the
  // per-attempt detail that a single overwritten error column throws away.
  const previous = (await prisma.delivery.findUnique({ where: { id: delivery.id }, select: { attemptLog: true } }))
    ?.attemptLog;
  const log = Array.isArray(previous) ? [...previous, entry] : [entry];

  await prisma.delivery.update({
    where: { id: delivery.id },
    data: {
      attempts: attempt,
      durationMs,
      statusCode: outcome.statusCode,
      ok: verdict.status === "DELIVERED",
      ...(verdict.status === "DELIVERED" ? { error: null } : { error: describeFailure(outcome) }),
      status: verdict.status,
      lastAttemptAt: now,
      attemptLog: log,
      nextAttemptAt: verdict.status === "RETRYING" ? new Date(now.getTime() + retryDelayMs(attempt)) : null,
      ...(verdict.status === "DEAD" ? { deadAt: now } : {}),
    },
  });

  await recordEndpointHealth(delivery.workspaceId, delivery.webhookId, verdict.status, describeFailure(outcome));

  return { status: verdict.status, statusCode: outcome.statusCode };
}

/**
 * Track consecutive failures and switch off an endpoint that has stopped
 * listening.
 *
 * A hook failing forever still accepts new events, so without this the
 * customer's queue fills with deliveries to an address that stopped answering
 * days ago, and their working subscriptions become invisible in the noise.
 */
async function recordEndpointHealth(
  workspaceId: string,
  webhookId: string,
  status: DeliveryStatus,
  reason: string,
): Promise<void> {
  const hook = await prisma.webhook.findUnique({ where: { id: webhookId }, select: { consecutiveFailures: true, isActive: true, disabledReason: true } });
  if (!hook) return;

  if (status === "DELIVERED") {
    // A success clears the counter and the stale explanation. `isActive` is
    // deliberately left alone: a delivery that was already in flight landing
    // successfully is not a reason to silently re-enable an endpoint the
    // operator switched off.
    if (hook.consecutiveFailures !== 0 || hook.disabledReason !== null) {
      await prisma.webhook.update({
        where: { id: webhookId },
        data: { consecutiveFailures: 0, disabledReason: null },
      });
    }
    return;
  }

  const failures = hook.consecutiveFailures + 1;
  if (failures >= FAILURES_BEFORE_DISABLE) {
    await prisma.webhook.update({
      where: { id: webhookId },
      data: {
        consecutiveFailures: failures,
        isActive: false,
        disabledReason: `Disabled automatically after ${failures} consecutive failed deliveries (last: ${reason}). Re-enable with PATCH {"isActive":true} once the endpoint is healthy.`,
      },
    });
    return;
  }
  await prisma.webhook.update({ where: { id: webhookId }, data: { consecutiveFailures: failures } });
}

/**
 * Fan out one event to every matching subscription.
 *
 * Each subscription gets one row in `Delivery`, created **before** the first
 * attempt. That ordering is the whole point: if the process dies mid-request,
 * the event is already recorded and the worker will pick it up, rather than
 * being lost with the request that carried it.
 */
export async function dispatchEvent(
  workspaceId: string,
  event: string,
  data: unknown,
  options: { eventId?: string } = {},
): Promise<DispatchResult> {
  const hooks = await prisma.webhook.findMany({ where: { workspaceId, isActive: true } });
  const matching = hooks.filter((h) => {
    const events = h.events as unknown;
    if (!Array.isArray(events) || events.length === 0) return true;
    return events.includes(event);
  });

  let delivered = 0;
  let retrying = 0;

  for (const hook of matching) {
    // A caller that brought its own event id keeps it: the inbound bridge
    // passes the sender's delivery id through so a retried webhook can be
    // recognised (the route checks `Delivery.eventId` before dispatching) and
    // so every subscriber of one event sees the same `id` in the payload.
    // Without one — `POST /api/v1/events` — each delivery mints its own, which
    // is what it always did.
    const eventId = options.eventId ?? randomUUID();
    const row = await prisma.delivery.create({
      data: {
        workspaceId,
        webhookId: hook.id,
        event,
        eventId,
        payload: buildPayload(eventId, event, data),
        status: "PENDING",
        attempts: 0,
        // Required column with no default. A delivery that has not been
        // attempted has not succeeded; the explicit false is clearer than
        // letting the shape imply it.
        ok: false,
      },
    });

    const first = await attemptDelivery(row, hook);
    if (first.status === "DELIVERED") delivered++;
    else retrying++;
  }

  return { delivered, retrying, skipped: hooks.length - matching.length, accepted: matching.length };
}

/**
 * Claim and run deliveries whose retry is due.
 *
 * The claim is a conditional `updateMany` on `status`, so exactly one worker can
 * take a given row even if several are running: the loser's update matches
 * nothing and it moves on. That is what stops two workers sending the same
 * event twice, which for a billing webhook is worse than a late one.
 */
export async function processDueDeliveries(now = new Date(), limit = 25): Promise<{ processed: number; delivered: number; dead: number }> {
  const due = await prisma.delivery.findMany({
    where: { status: "RETRYING", nextAttemptAt: { lte: now } },
    orderBy: { nextAttemptAt: "asc" },
    take: limit,
    select: { id: true },
  });

  let processed = 0;
  let delivered = 0;
  let dead = 0;

  for (const candidate of due) {
    const claimed = await prisma.delivery.updateMany({
      where: { id: candidate.id, status: "RETRYING" },
      data: { status: "PENDING", nextAttemptAt: null },
    });
    if (claimed.count === 0) continue; // another worker got there first

    const row = await prisma.delivery.findUnique({ where: { id: candidate.id } });
    if (!row) continue;
    const hook = await prisma.webhook.findUnique({ where: { id: row.webhookId } });
    if (!hook) continue;

    // A subscription switched off mid-retry is respected: do not keep spending
    // the customer's events on an endpoint they turned off.
    if (!hook.isActive) {
      await prisma.delivery.update({
        where: { id: row.id },
        data: { status: "DEAD", error: "endpoint is disabled", deadAt: new Date() },
      });
      dead++;
      processed++;
      continue;
    }

    const result = await attemptDelivery(row, hook);
    processed++;
    if (result.status === "DELIVERED") delivered++;
    if (result.status === "DEAD") dead++;
  }

  return { processed, delivered, dead };
}

export { MAX_ATTEMPTS };
