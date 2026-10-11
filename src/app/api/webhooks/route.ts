import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { classifyTarget } from "@/lib/egress";
import { requireKey, logSuccess } from "@/lib/auth";
import { generateWebhookSecret } from "@/lib/dispatch";
import { readJson, validateBody, fieldProblem } from "@/lib/validate";
import { WEBHOOK_POST } from "@/lib/fields";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const startedAt = Date.now();
  const auth = await requireKey(request, []);
  if (!auth.ok) return auth.response;

  const hooks = await prisma.webhook.findMany({
    where: { workspaceId: auth.key.workspaceId },
    select: { id: true, url: true, events: true, secretPrefix: true, isActive: true, createdAt: true, updatedAt: true, _count: { select: { deliveries: true } } },
    orderBy: { createdAt: "desc" },
  });

  await logSuccess(auth.key, request, 200, startedAt);
  return NextResponse.json({ webhooks: hooks });
}

export async function POST(request: Request) {
  const startedAt = Date.now();
  const auth = await requireKey(request, ["webhooks:write"]);
  if (!auth.ok) return auth.response;

  // A refusal this route raises goes in the request log, as `requireKey`'s own
  // 401/403/429 already do — see the note in `POST /api/keys`.
  const refused = async (response: NextResponse) => {
    await logSuccess(auth.key, request, response.status, startedAt);
    return response;
  };

  const read = await readJson(request);
  if (!read.ok) return refused(read.error);
  const parsed = validateBody(read.body, WEBHOOK_POST);
  if (!parsed.ok) return refused(parsed.error);
  const { url, events } = parsed.data;

  const target = await classifyTarget(url, "url");
  if (!target.ok) return refused(fieldProblem("url", target.reason));

  const { plaintext, hash, prefix } = generateWebhookSecret();
  const hook = await prisma.webhook.create({
    data: {
      workspaceId: auth.key.workspaceId,
      url,
      events: events ?? [],
      secretHash: hash,
      secretPrefix: prefix,
    },
  });

  await logSuccess(auth.key, request, 201, startedAt);
  return NextResponse.json({ ...hook, secret: plaintext }, { status: 201 });
}
