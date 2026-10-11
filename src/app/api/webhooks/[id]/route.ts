import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { classifyTarget } from "@/lib/egress";
import { requireKey, logSuccess, notFound } from "@/lib/auth";
import { generateWebhookSecret } from "@/lib/dispatch";
import { boolFlag, NO_FIELD_TO_UPDATE, readJson, validateBody, fieldProblem } from "@/lib/validate";
import { WEBHOOK_PATCH } from "@/lib/fields";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const startedAt = Date.now();
  const { id } = await params;
  const auth = await requireKey(request, []);
  if (!auth.ok) return auth.response;

  const hook = await prisma.webhook.findFirst({
    where: { id, workspaceId: auth.key.workspaceId },
    select: { id: true, url: true, events: true, secretPrefix: true, isActive: true, createdAt: true, updatedAt: true },
  });
  if (!hook) {
    return notFound(auth.key, request, startedAt, "No such webhook.");
  }

  await logSuccess(auth.key, request, 200, startedAt);
  return NextResponse.json(hook);
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const startedAt = Date.now();
  const { id } = await params;
  const auth = await requireKey(request, ["webhooks:write"]);
  if (!auth.ok) return auth.response;

  const hook = await prisma.webhook.findFirst({ where: { id, workspaceId: auth.key.workspaceId } });
  if (!hook) {
    return notFound(auth.key, request, startedAt, "No such webhook.");
  }

  // A refusal this route raises goes in the request log, as `requireKey`'s own
  // 401/403/429 already do — see the note in `POST /api/keys`.
  const refused = async (response: NextResponse) => {
    await logSuccess(auth.key, request, response.status, startedAt);
    return response;
  };

  const read = await readJson(request);
  if (!read.ok) return refused(read.error);
  const rotate = boolFlag(read.body.rotate, "rotate");
  if (!rotate.ok) return refused(rotate.error);
  const parsed = validateBody(read.body, WEBHOOK_PATCH);
  if (!parsed.ok) return refused(parsed.error);
  const { url, events, isActive } = parsed.data;

  if (url !== undefined) {
    const target = await classifyTarget(url, "url");
    if (!target.ok) return refused(fieldProblem("url", target.reason));
  }

  // `rotate` is a route-control flag rather than a column, so `requireWrite`
  // cannot see that asking for a new signing secret is asking for a write. The
  // check it would have made is done here instead, with the same wording: a
  // PATCH that names no column and no flag is the 200-for-nothing this route
  // used to answer `{}` with.
  if (rotate.value !== true && [url, events, isActive].every((value) => value === undefined)) {
    return refused(fieldProblem("body", NO_FIELD_TO_UPDATE));
  }

  let rotated: string | undefined;
  let secretHash = hook.secretHash;
  let secretPrefix = hook.secretPrefix;
  if (rotate.value === true) {
    const fresh = generateWebhookSecret();
    secretHash = fresh.hash;
    secretPrefix = fresh.prefix;
    rotated = fresh.plaintext;
  }

  const updated = await prisma.webhook.update({
    where: { id },
    data: {
      ...(url !== undefined ? { url } : {}),
      ...(events !== undefined ? { events } : {}),
      ...(isActive !== undefined ? { isActive } : {}),
      secretHash,
      secretPrefix,
    },
    select: { id: true, url: true, events: true, secretPrefix: true, isActive: true, updatedAt: true },
  });

  await logSuccess(auth.key, request, 200, startedAt);
  return NextResponse.json({ ...updated, ...(rotated ? { secret: rotated } : {}) });
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const startedAt = Date.now();
  const { id } = await params;
  const auth = await requireKey(request, ["webhooks:write"]);
  if (!auth.ok) return auth.response;

  const deleted = await prisma.webhook.deleteMany({ where: { id, workspaceId: auth.key.workspaceId } });
  if (deleted.count === 0) {
    return notFound(auth.key, request, startedAt, "No such webhook.");
  }

  await logSuccess(auth.key, request, 200, startedAt);
  return NextResponse.json({ revoked: true, id });
}
