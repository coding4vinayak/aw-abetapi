import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireKey, logSuccess, notFound } from "@/lib/auth";
import { dispatchEvent } from "@/lib/dispatch";
import { validateBody } from "@/lib/validate";
import { INBOUND_NUCRM_POST, ID_MAX } from "@/lib/fields";
import { parseInboundEnvelope, verifyInboundSignature } from "@/lib/inbound";

export const dynamic = "force-dynamic";

/**
 * Receive one signed NuCRM webhook and republish it as a platform event.
 *
 * The other direction of the bridge — subscriptions under `/api/webhooks` are
 * addresses *this* gateway POSTs to; this route is the address NuCRM's
 * integration webhook POSTs to, and it verifies that before anything fans out.
 *
 * Auth is two credentials on purpose, and they answer different questions. The
 * API key (scope `events:write`) says *whose* workspace this is and carries the
 * quota, the audit trail and the revocation; the signature says the body came
 * from the sender holding this source's secret. Either alone is a weaker
 * product: a key alone is one static string that cannot prove the payload is
 * NuCRM's, and a secret alone has nowhere to be revoked from and nothing to
 * meter. NuCRM's integration config carries custom headers, so both travel in
 * one configured webhook.
 *
 * Responses are shaped for a retrying sender. 202 means accepted: matching
 * subscribers have a Delivery row each, their first attempt may already have
 * failed and be scheduled for retry, and this receipt counts like the one from
 * `POST /api/v1/events`. A repeat of a delivery id already accepted answers 200
 * with `duplicate: true` and publishes nothing, because NuCRM retries on
 * timeouts and an at-least-once sender must not become an at-least-twice
 * fan-out. Everything else — bad signature, paused source, malformed body —
 * is a refusal NuCRM's own retry policy handles: it parks the delivery after
 * five attempts.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const startedAt = Date.now();
  const auth = await requireKey(request, ["events:write"]);
  if (!auth.ok) return auth.response;

  // A refusal this route raises goes in the request log, as `requireKey`'s own
  // 401/403/429 already do — see the note in `POST /api/keys`.
  const refused = async (response: NextResponse) => {
    await logSuccess(auth.key, request, response.status, startedAt);
    return response;
  };

  const { id } = await params;
  const source = await prisma.inboundSource.findFirst({
    where: { id, workspaceId: auth.key.workspaceId },
  });
  if (!source) {
    return notFound(auth.key, request, startedAt, "No such inbound source in this workspace.");
  }

  if (!source.isActive) {
    return refused(
      NextResponse.json(
        {
          error: {
            code: "conflict",
            message: "This inbound source is paused. Re-enable it in the dashboard, and NuCRM's retry will land.",
          },
        },
        { status: 409 },
      ),
    );
  }

  // The raw bytes, not a parsed object: the signature is over exactly what was
  // sent, and re-serialising a parsed body would change whitespace and key
  // order and fail verification on deliveries that are perfectly valid.
  const raw = await request.text();
  const signature = request.headers.get("x-nucrm-signature");
  if (!verifyInboundSignature(source.secret, raw, signature)) {
    return refused(
      NextResponse.json(
        {
          error: {
            code: "authentication_error",
            message:
              "x-nucrm-signature is missing, or does not match this source's secret. Copy the secret into the NuCRM integration unchanged.",
          },
        },
        { status: 401 },
      ),
    );
  }

  const parsed = parseInboundEnvelope(raw);
  if (!parsed.ok) {
    return refused(
      NextResponse.json({ error: { code: "invalid_request", message: parsed.message } }, { status: 400 }),
    );
  }

  const validated = validateBody(parsed.body, INBOUND_NUCRM_POST);
  if (!validated.ok) return refused(validated.error);
  const { event, data } = validated.data;

  // NuCRM's own id for this delivery, stable across its retries. Oversized
  // values are ignored rather than truncated: an id a receiver matches on has
  // to be the id the sender sent, or it is a different id.
  const header = request.headers.get("x-nucrm-delivery");
  const eventId = header && header.length <= ID_MAX ? header : undefined;

  if (eventId) {
    const seen = await prisma.delivery.findFirst({
      where: { workspaceId: auth.key.workspaceId, eventId },
      select: { id: true },
    });
    if (seen) {
      await logSuccess(auth.key, request, 200, startedAt);
      return NextResponse.json({ event, duplicate: true, delivered: 0, retrying: 0, skipped: 0, accepted: 0 });
    }
  }

  const receipt = await dispatchEvent(auth.key.workspaceId, event, data ?? null, eventId ? { eventId } : {});

  await prisma.inboundSource.update({
    where: { id: source.id },
    data: { lastEventAt: new Date(), lastEventName: event, receivedEvents: { increment: 1 } },
  });

  await logSuccess(auth.key, request, 202, startedAt);
  return NextResponse.json({ event, ...receipt }, { status: 202 });
}
