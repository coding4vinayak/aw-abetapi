import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireKey, logSuccess, type AuthedKey } from "@/lib/auth";
import { resolveAiActor, AiAuthError } from "@/lib/ai-actor";
import { isLlmConfigured } from "@/lib/llm";
import { diagnoseWebhook } from "@/lib/ai-diagnose";
import { readJson, validateBody } from "@/lib/validate";
import { DIAGNOSE_POST } from "@/lib/fields";

export const dynamic = "force-dynamic";

const MAX_AGE_DAYS = 30;

/**
 * POST /api/ai/diagnose-webhook
 *
 * Reads a webhook's recent delivery attempts and explains the failures.
 *
 * Read-only, and scoped to the caller's own workspace — a key from workspace A
 * cannot diagnose workspace B's endpoint. The `secretHash` is never selected,
 * so the signing secret cannot leak into a model prompt.
 *
 * `requireKey` speaks in returned responses, `resolveAiActor` in thrown errors;
 * this is the one seam between the two. A key refusal carries the response
 * `requireKey` already built and already logged (every outcome, per `auth.ts`),
 * so it passes through untouched rather than being re-rendered here — the
 * envelope, the `code`, the rate-limit headers, all stay `requireKey`'s.
 */
class KeyRefusal extends Error {
  constructor(readonly response: NextResponse) {
    super("api key refused");
  }
}

export async function POST(request: Request) {
  const startedAt = Date.now();

  // Read the body before the credential only so the workspace *claim* is
  // available to hand to `resolveAiActor`; the field-level answer still comes
  // after it. `validateBody` below is what names a missing `webhookId`, and it
  // is unreachable until a credential has resolved, which is the property this
  // route documented when it moved the credential ahead of the schema: measured
  // pre-change, `{}` sent with no key at all answered 400 "webhookId required"
  // — an anonymous caller getting a field-level reply out of a tenant-scoped
  // read. A 400 about bytes that are not JSON is not that reply: it names no
  // field and no row, and it is the shape the three sibling AI routes already
  // answer, so an unparseable body is refused before anyone is identified.
  const read = await readJson(request);
  if (!read.ok) return read.error;

  // The credential is now `resolveAiActor`'s to decide, and it is the same
  // decision the rest of the family's AI routes make: a signed-in browser
  // session or a bearer key, and the workspace comes from the credential in both
  // cases. What this route used to do inline — `getSession()`, then `requireKey`
  // only if there was no session, then `session ? … : key! …` — was that rule
  // re-derived here, and re-deriving it left out the half `resolveAiActor` adds:
  // a body that *claims* a different workspace is refused rather than ignored.
  // Measured before this move (`shared/verify-ai-claim.py`): a key whose body said
  // `workspaceId: "<another workspace>"`, or `workspaceId: 42`, answered 200 and
  // diagnosed the key's own webhook — safe (the lookup is scoped to the
  // credential, so no foreign row was ever read) but silently ignoring a caller
  // who asked about someone else's, which is exactly the disagreement #43 closed
  // everywhere else. Now it is one rule in one module: `""` stays absent, text
  // that is not the caller's is refused, a non-text claim is refused for being a
  // type that names no workspace.
  let key: AuthedKey | null = null;
  const claim = (read.body as { workspaceId?: unknown } | null)?.workspaceId;
  const refused = async (response: NextResponse) => {
    // A browser session has no key row to log against, which is why every
    // refusal below goes through this rather than calling `logSuccess` at each
    // return. A key-path claim refusal does — it is a refusal of an
    // authenticated call, and an audit trail with holes is where abuse hides.
    if (key) await logSuccess(key, request, response.status, startedAt);
    return response;
  };

  let workspaceId: string;
  try {
    const actor = await resolveAiActor(request, {
      // Handed over as it came out of the parsed body, uncoerced. Coercing it
      // first is what turned `false` into the text `"false"` and an array of the
      // caller's own id into that id — the module decides what a claim means, so
      // this route is not the app that gets to disagree.
      claimedWorkspaceId: claim,
      keyWorkspaceId: async () => {
        const auth = await requireKey(request, []);
        if (!auth.ok) throw new KeyRefusal(auth.response);
        key = auth.key;
        return auth.key.workspaceId;
      },
    });
    workspaceId = actor.workspaceId;
  } catch (error) {
    // `requireKey`'s own refusal — already logged, already in the published
    // `{ error: { code, message } }` envelope. Return it as it was built.
    if (error instanceof KeyRefusal) return error.response;
    // A claim refusal raised by the shared module. `withAiAuth` renders this
    // bare `{ error: message }` in the three sibling apps, and it is the shape
    // this route keeps for the row-shaped refusals below (404, the reasons)
    // because `ai-panel.tsx` prints `data.error` as text; keeping it here makes
    // the claim rule byte-identical family-wide, not a fourth envelope.
    if (error instanceof AiAuthError) {
      return refused(NextResponse.json({ error: error.message }, { status: error.status }));
    }
    throw error;
  }

  const parsed = validateBody(read.body, DIAGNOSE_POST);
  if (!parsed.ok) return refused(parsed.error);
  const { webhookId, model } = parsed.data;

  // Scoped in the query: another tenant's webhook is not found, not
  // fetched-then-refused, so this leaks no more than a wrong id would.
  //
  // These two refusals stay in the route's own shape (`{ error: "…" }`, a bare
  // string) rather than moving to the published envelope, because they are the
  // two this app's own dashboard prints: `ai-panel.tsx` renders `data.error` as
  // text, and the envelope's object would read "[object Object]" there. The
  // answers *above* it — the 400 for malformed bytes, the 422 for a wrong field
  // — are the envelope, and no browser path can produce them.
  const webhook = await prisma.webhook.findFirst({
    where: { id: webhookId, workspaceId },
  });
  if (!webhook) {
    if (key) await logSuccess(key, request, 404, startedAt);
    return NextResponse.json({ error: "webhook not found" }, { status: 404 });
  }

  const since = new Date(Date.now() - MAX_AGE_DAYS * 86_400_000);
  const deliveries = await prisma.delivery.findMany({
    where: { webhookId: webhook.id, createdAt: { gte: since } },
    orderBy: { createdAt: "desc" },
    take: 40,
    // secretHash deliberately absent.
    select: { statusCode: true, ok: true, error: true, attempts: true, durationMs: true, createdAt: true },
  });

  const stats = {
    total: deliveries.length,
    failed: deliveries.filter((d) => !d.ok).length,
    ok: deliveries.filter((d) => d.ok).length,
    windowDays: MAX_AGE_DAYS,
  };

  if (stats.total === 0) {
    if (key) await logSuccess(key, request, 200, startedAt);
    return NextResponse.json({
      diagnosed: false,
      stats,
      reason: `No deliveries in the last ${MAX_AGE_DAYS} days — there is nothing to diagnose.`,
    });
  }

  if (stats.failed === 0) {
    if (key) await logSuccess(key, request, 200, startedAt);
    return NextResponse.json({
      diagnosed: false,
      stats,
      reason: "No failed deliveries in the window — the endpoint is healthy.",
    });
  }

  if (!isLlmConfigured()) {
    if (key) await logSuccess(key, request, 200, startedAt);
    return NextResponse.json({
      diagnosed: false,
      configured: false,
      stats,
      reason: "No LLM_API_KEY set — delivery records are unaffected and still returned.",
    });
  }

  const diagnosis = await diagnoseWebhook({
    webhook: {
      url: webhook.url,
      events: webhook.events,
      isActive: webhook.isActive,
      createdAt: webhook.createdAt,
    },
    deliveries: deliveries.map((d) => ({
      statusCode: d.statusCode,
      ok: d.ok,
      error: d.error,
      attempts: d.attempts,
      durationMs: d.durationMs,
      createdAt: d.createdAt,
    })),
    model,
  });

  if (!diagnosis) {
    if (key) await logSuccess(key, request, 502, startedAt);
    return NextResponse.json(
      { diagnosed: false, stats, reason: "The model was unreachable or returned nothing usable." },
      { status: 502 },
    );
  }

  if (key) await logSuccess(key, request, 200, startedAt);
  return NextResponse.json({
    diagnosed: true,
    stats,
    diagnosis: {
      diagnosis: diagnosis.diagnosis,
      fixes: diagnosis.fixes,
      blame: diagnosis.blame,
      evidence: diagnosis.evidence,
      confidence: diagnosis.confidence,
    },
    usage: diagnosis.usage,
    model: diagnosis.model,
    note: "Read-only — no delivery was retried and no webhook was modified.",
  });
}
