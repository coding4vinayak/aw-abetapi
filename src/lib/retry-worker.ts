import { processDueDeliveries } from "./dispatch";

/**
 * The retry worker.
 *
 * Polls for deliveries whose next attempt is due and re-sends them. Started from
 * `instrumentation.ts` alongside the server, and shut down on SIGTERM so a
 * deploy does not leave a timer running.
 *
 * How often it looks is a deliberate trade. Every second is responsive but
 * costs a query per second per instance; every thirty seconds is nearly free
 * but adds up to half a minute of delay. Thirty is chosen because the shortest
 * retry backoff is 30 seconds, so a poll that frequent never misses the moment
 * something becomes due by more than its own backoff — polling faster would buy
 * precision nobody can observe on a webhook.
 *
 * Concurrency: `processDueDeliveries` claims each row with a conditional
 * update, so running several of these — or several instances — cannot send the
 * same event twice. The worst case of a slow shutdown is that an in-flight
 * attempt finishes and is recorded; the row moves on, it is not lost.
 */

const POLL_INTERVAL_MS = 30_000;
const BATCH_SIZE = 25;

let timer: NodeJS.Timeout | null = null;
let running = false;

async function tick(): Promise<void> {
  if (running) return; // a slow batch must not overlap the next poll
  running = true;
  try {
    const result = await processDueDeliveries(new Date(), BATCH_SIZE);
    if (result.processed > 0) {
      console.log(
        `AbetAPI retry worker: ${result.processed} attempted, ${result.delivered} delivered, ${result.dead} dead`,
      );
    }
  } catch (error) {
    // A failure here must never take the server down: the next poll will
    // simply try again, and the rows are still sitting there waiting.
    console.error("AbetAPI retry worker failed:", error instanceof Error ? error.message : error);
  } finally {
    running = false;
  }
}

export function startRetryWorker(): void {
  if (timer) return;
  timer = setInterval(tick, POLL_INTERVAL_MS);
  // Do not hold the process open on its own account; the HTTP server does that.
  timer.unref?.();
  console.log("AbetAPI retry worker started");
}

export function stopRetryWorker(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
  console.log("AbetAPI retry worker stopped");
}
