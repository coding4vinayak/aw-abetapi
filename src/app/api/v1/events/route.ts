import { NextResponse } from "next/server";
import { requireKey, logSuccess } from "@/lib/auth";
import { dispatchEvent } from "@/lib/dispatch";
import { readJson, validateBody } from "@/lib/validate";
import { EVENT_POST } from "@/lib/fields";

export const dynamic = "force-dynamic";

/**
 * Publish one platform event. Matching subscriptions get a signed delivery
 * each. Events are namespaced by convention (`lead.created`) but the gateway
 * does not judge — subscribers filter by exact match, or empty means
 * everything.
 *
 * The receipt is explicit about the four outcomes, because collapsing them into
 * a delivered/failed pair loses the distinction a caller actually needs: an
 * event that is safely scheduled for retry is not a failure, and a publisher
 * that retries on top of our retry queue delivers everything twice.
 *
 *   delivered — the endpoint returned 2xx on the first attempt
 *   retrying  — accepted and recorded; a retry is scheduled
 *   skipped   — no matching active subscription
 *   accepted  — how many Delivery rows were created
 */
export async function POST(request: Request) {
  const startedAt = Date.now();
  const auth = await requireKey(request, ["events:write"]);
  if (!auth.ok) return auth.response;

  // A refusal this route raises goes in the request log, as `requireKey`'s own
  // 401/403/429 already do — see the note in `POST /api/keys`.
  const refused = async (response: NextResponse) => {
    await logSuccess(auth.key, request, response.status, startedAt);
    return response;
  };

  const read = await readJson(request);
  if (!read.ok) return refused(read.error);
  const parsed = validateBody(read.body, EVENT_POST);
  if (!parsed.ok) return refused(parsed.error);
  const { type, data } = parsed.data;

  // `data` absent is not `data: null`: it is a caller who sent no payload, and
  // it keeps storing what it always stored. An explicit `null` is refused by the
  // table, because a receiver cannot tell "this event carries nothing" from "the
  // publisher forgot the field" — `{}` says the first, omitting it says the
  // second, and the fan-out is signed either way.
  const receipt = await dispatchEvent(auth.key.workspaceId, type, data ?? null);

  await logSuccess(auth.key, request, 201, startedAt);
  return NextResponse.json({ event: type, ...receipt }, { status: 201 });
}
