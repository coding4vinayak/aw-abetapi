/**
 * Retry policy for webhook delivery.
 *
 * Pure functions only — no database, no clock, no network — so the policy can be
 * tested exhaustively and cannot drift from what the worker actually does.
 *
 * The three decisions that matter, and why they are what they are:
 *
 * 1. **Which failures are worth retrying.** A `400` from a customer endpoint is
 *    a bug in their handler; sending the identical body again will produce the
 *    identical `400`, eight times, while their quota burns down. Only genuinely
 *    transient conditions are retried: 5xx, `408`/`425` (timeout / too early),
 *    `429` (they asked us to slow down), and network-level failures where we
 *    never got a status at all.
 *
 * 2. **How long to wait.** Exponential backoff, because a service that is down
 *    stays down for a while and hammering it prevents it from recovering. Plus
 *    **jitter**, because without it every delivery that failed at the same
 *    moment comes back at the same moment — a thundering herd aimed at a
 *    service that has only just come back up. Half the delay is fixed and half
 *    is random, which keeps retries spread out without letting one unlucky
 *    delivery retry instantly forever.
 *
 * 3. **When to stop.** After a bounded number of attempts, spanning roughly a
 *    day, the delivery is parked as dead rather than retried indefinitely. A
 *    message that needs a week-long retry schedule is a message someone has to
 *    look at, and parking it in an explicit dead state is what makes that
 *    possible — the alternative is a queue that grows forever.
 */

export type DeliveryStatus =
  | "PENDING" // queued, never attempted
  | "DELIVERED" // the endpoint returned 2xx
  | "RETRYING" // failed, another attempt is scheduled
  | "DEAD"; // attempts exhausted, parked for a human

export const MAX_ATTEMPTS = 8;
export const BASE_DELAY_MS = 30_000; // 30s
export const MAX_DELAY_MS = 6 * 60 * 60 * 1000; // 6h

/**
 * Cumulative schedule at the configured settings, ignoring jitter.
 *
 * 30s, 1m, 2m, 4m, 8m, 16m, 32m, 64m → about 2h of retries, which with the
 * 6h ceiling and a final re-attempt spans a working day. Exported because a
 * customer reading the docs deserves the actual numbers rather than "we retry
 * a few times".
 */
export function backoffScheduleMs(maxAttempts = MAX_ATTEMPTS): number[] {
  const out: number[] = [];
  for (let attempt = 1; attempt < maxAttempts; attempt++) {
    out.push(Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), MAX_DELAY_MS));
  }
  return out;
}

/**
 * Delay before the given attempt number (1-based: the delay *after* attempt 1).
 *
 * `random` is injectable so the schedule is deterministic under test.
 */
export function retryDelayMs(
  attempt: number,
  random: () => number = Math.random,
  base = BASE_DELAY_MS,
  max = MAX_DELAY_MS,
): number {
  const ceiling = Math.min(base * 2 ** Math.max(0, attempt - 1), max);
  // Equal jitter: half fixed, half random. Never zero, so a retry cannot
  // degenerate into a tight loop, and never more than the ceiling, so the
  // backoff guarantee still holds.
  return Math.round(ceiling / 2 + random() * (ceiling / 2));
}

export interface AttemptOutcome {
  /** The endpoint's status, or null when the request never produced one. */
  statusCode: number | null;
  /** A transport-level message, when there was no status. */
  error?: string;
  /**
   * This process decided not to send the request — an egress refusal.
   *
   * It cannot be left as plain `statusCode === null`, because that value already
   * means "we never got an answer, so ask again". A refusal is the opposite: the
   * endpoint was never contacted, and a later attempt would run into the same
   * policy on the same address.
   */
  refused?: boolean;
}

/**
 * Is this failure worth trying again?
 *
 * `statusCode === null` means the request never got an answer — DNS, refused
 * connection, TLS failure, our own timeout. Those are the cases where the
 * endpoint may well be fine a minute later, so they retry.
 */
export function isRetryable(outcome: AttemptOutcome): boolean {
  // Our own decision, not the endpoint's condition. Retrying it sends the same
  // refusal eight times over a day of backoff for a target that was never asked.
  if (outcome.refused) return false;
  const { statusCode } = outcome;
  if (statusCode === null) return true; // never reached the endpoint
  if (statusCode === 408 || statusCode === 425 || statusCode === 429) return true;
  if (statusCode >= 500) return true;
  // Everything else — 400, 401, 403, 404, 422 — is a decision the endpoint
  // already made. Repeating the request cannot change its mind.
  return false;
}

export function nextStatus(
  outcome: AttemptOutcome,
  attempt: number,
  maxAttempts = MAX_ATTEMPTS,
): { status: DeliveryStatus; terminal: boolean } {
  if (outcome.statusCode !== null && outcome.statusCode >= 200 && outcome.statusCode < 300) {
    return { status: "DELIVERED", terminal: true };
  }
  if (!isRetryable(outcome)) {
    // A permanent refusal. Parked immediately rather than after eight rounds
    // of asking a question whose answer will not change.
    return { status: "DEAD", terminal: true };
  }
  if (attempt >= maxAttempts) {
    return { status: "DEAD", terminal: true };
  }
  return { status: "RETRYING", terminal: false };
}

/**
 * Consecutive failures before an endpoint is switched off automatically.
 *
 * A hook that has failed this many times in a row is broken, and continuing to
 * spend every event on it means the customer's other subscriptions look fine
 * while this one silently eats traffic. It is switched off, and the reason is
 * recorded so it can be re-enabled with an explanation rather than a mystery.
 */
export const FAILURES_BEFORE_DISABLE = 20;

/** A short, human-readable summary safe to store on the webhook row. */
export function describeFailure(outcome: AttemptOutcome): string {
  // Distinguish "the endpoint refused us" from "we refused to go there" — an
  // operator reading the row needs to know which side said no.
  if (outcome.refused) return `refused: ${(outcome.error ?? "egress policy").slice(0, 180)}`;
  if (outcome.statusCode === null) return outcome.error?.slice(0, 200) ?? "no response from endpoint";
  if (outcome.statusCode >= 200 && outcome.statusCode < 300) return "delivered";
  return `HTTP ${outcome.statusCode}`;
}
