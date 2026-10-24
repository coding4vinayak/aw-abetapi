import { NextResponse } from "next/server";
import type { InboundSource } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { requireKey, logRequest, notFound } from "@/lib/auth";
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
 * Auth has two doors, and a delivery comes through one of them:
 *
 * - **API key + signature.** When a bearer key (scope `events:write`) is sent
 *   — a forwarder or relay posting on NuCRM's behalf — it must authenticate,
 *   and the source is required to live in that key's workspace. A
 *   present-but-bad key is a 401, never a silent downgrade.
 * - **Signature only.** NuCRM itself can only take this door: its integration
 *   webhook config carries `url`, `events` and `secret` and no custom-header
 *   field (measured against `lib/webhooks.ts` and `app/api/tenant/webhooks` on
 *   NuCRM's `main`, 24 Oct 2026), so it can never attach an API key. The source
 *   id in the path selects the workspace, the HMAC over the raw body proves the
 *   sender, and every outcome after the source resolves still lands in
 *   `RequestLog` with that workspace.
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
  const { id } = await params;

  // The raw bytes, not a parsed object: the signature is over exactly what was
  // sent, and re-serialising a parsed body would change whitespace and key
  // order and fail verification on deliveries that are perfectly valid.
  const raw = await request.text();

  // NuCRM's main integration path signs `X-NuCRM-Signature`; the convention of
  // its plugin receiver is `X-Webhook-Signature`. Same construction, same
  // secret, so both spellings verify here.
  const signature = request.headers.get("x-nucrm-signature") ?? request.headers.get("x-webhook-signature");

  const keyed =
    request.headers.get("authorization")?.toLowerCase().startsWith("bearer ") ||
    request.headers.get("x-api-key");

  let keyId: string | undefined;
  let workspaceId: string;
  let source: InboundSource | null;

  if (keyed) {
    const auth = await requireKey(request, ["events:write"]);
    if (!auth.ok) return auth.response;
    keyId = auth.key.keyId;
    workspaceId = auth.key.workspaceId;
    source = await prisma.inboundSource.findFirst({
      where: { id, workspaceId: auth.key.workspaceId },
    });
    if (!source) {
      return notFound(auth.key, request, startedAt, "No such inbound source in this workspace.");
    }
    workspaceId = source.workspaceId;
  } else {
    // Signature-only door: the id names the source, the secret names the
    // sender. An unknown id has no workspace to attribute the probe to — the
    // row cannot exist before the source resolves, which is why this 404 is
    // logged nowhere (same as `requireKey`'s anonymous 401s).
    source = await prisma.inboundSource.findUnique({ where: { id } });
    if (!source) {
      // The row is the only workspace link, so an id matching no source has no
      // workspace to attribute this probe to — like requireKey's anonymous 401s.
      return NextResponse.json(
        { error: { code: "not_found", message: "No such inbound source." } },
        // unlogged: pre-resolution unknown id; every other refusal in this route logs.
        { status: 404 },
      );
    }
    workspaceId = source.workspaceId;
  }

  const refused = async (response: NextResponse) => {
    await logRequest(workspaceId, keyId, request, response.status, startedAt);
    return response;
  };

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

  if (!verifyInboundSignature(source.secret, raw, signature)) {
    return refused(
      NextResponse.json(
        {
          error: {
            code: "authentication_error",
            message:
              "x-nucrm-signature (or x-webhook-signature) is missing, or does not match this source's secret. Copy the secret into the NuCRM integration unchanged.",
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
  const header = request.headers.get("x-nucrm-delivery") ?? request.headers.get("x-webhook-delivery");
  const eventId = header && header.length <= ID_MAX ? header : undefined;

  if (eventId) {
    const seen = await prisma.delivery.findFirst({
      where: { workspaceId, eventId },
      select: { id: true },
    });
    if (seen) {
      await logRequest(workspaceId, keyId, request, 200, startedAt);
      return NextResponse.json({ event, duplicate: true, delivered: 0, retrying: 0, skipped: 0, accepted: 0 });
    }
  }

  const receipt = await dispatchEvent(workspaceId, event, data ?? null, eventId ? { eventId } : {});

  await prisma.inboundSource.update({
    where: { id: source.id },
    data: { lastEventAt: new Date(), lastEventName: event, receivedEvents: { increment: 1 } },
  });

  await logRequest(workspaceId, keyId, request, 202, startedAt);
  return NextResponse.json({ event, ...receipt }, { status: 202 });
}
