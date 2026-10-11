/**
 * AbetAPI instrumentation — runs once per server boot.
 *
 * Lives at the app root rather than in `src/` because Sentry auto-registers
 * `src/instrumentation.ts` and claims that path; keeping ours beside it is what
 * the rest of the portfolio does and the only arrangement that reliably runs
 * both. The retry worker is loaded with a dynamic import so its database and
 * network dependencies are never pulled into the edge bundle.
 */
import * as Sentry from "@sentry/nextjs";

export function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  Sentry.addEventProcessor((event) => {
    if (event.tags) {
      event.tags.product = "abetapi";
    } else {
      event.tags = { product: "abetapi" };
    }
    return event;
  });

  import("@/lib/retry-worker")
    .then(({ startRetryWorker, stopRetryWorker }) => {
      startRetryWorker();
      // A deploy sends SIGTERM; without this the timer keeps the old process
      // alive and an in-flight delivery can be interrupted.
      process.once("SIGTERM", stopRetryWorker);
      process.once("SIGINT", stopRetryWorker);
    })
    .catch((error) => {
      console.error("[AbetAPI] retry worker failed to load:", error);
    });

  console.log("[Sentry] AbetAPI server instrumentation registered");
}
