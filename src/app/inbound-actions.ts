"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { generateInboundSecret } from "@/lib/inbound";
import { requireSession } from "@/lib/session";
import { NAME_MAX } from "@/lib/fields";

/**
 * Managing the inbound bridge, from the browser session.
 *
 * Same reasoning as `key-actions.ts`: the secret is returned through a server
 * action straight into component state, so the one value the bridge can never
 * re-show never lands in a URL, a referrer or an access log. (It *is* stored —
 * see `InboundSource.secret` — but the copy shown here is the one the person
 * pastes into NuCRM, and losing it means migrating to a fresh source, so the
 * show-once discipline still applies.)
 */

const MAX_INBOUND_SOURCES = 10;

export interface CreateInboundSourceResult {
  ok: boolean;
  id?: string;
  name?: string;
  /** The secret to paste into NuCRM's integration config. Present once. */
  secret?: string;
  error?: string;
}

export async function createInboundSource(name: string): Promise<CreateInboundSourceResult> {
  const session = await requireSession();
  const trimmed = (name ?? "").trim();
  if (!trimmed) return { ok: false, error: "Give the source a name — it is how you tell two NuCRM tenants apart." };
  if (trimmed.length > NAME_MAX) return { ok: false, error: `Names are at most ${NAME_MAX} characters.` };

  const count = await prisma.inboundSource.count({ where: { workspaceId: session.workspaceId } });
  if (count >= MAX_INBOUND_SOURCES) {
    return { ok: false, error: `This workspace already has ${MAX_INBOUND_SOURCES} inbound sources.` };
  }

  const existing = await prisma.inboundSource.findFirst({
    where: { workspaceId: session.workspaceId, name: trimmed },
    select: { id: true },
  });
  if (existing) return { ok: false, error: "A source with this name already exists." };

  const secret = generateInboundSecret();
  const row = await prisma.inboundSource.create({
    data: {
      workspaceId: session.workspaceId,
      name: trimmed,
      secret: secret.plaintext,
      secretPrefix: secret.prefix,
    },
  });

  revalidatePath("/dashboard");
  return { ok: true, id: row.id, name: row.name, secret: secret.plaintext };
}

export interface InboundSourceActionResult {
  ok: boolean;
  error?: string;
}

export async function toggleInboundSource(id: string): Promise<InboundSourceActionResult> {
  const session = await requireSession();
  const source = await prisma.inboundSource.findFirst({
    where: { id, workspaceId: session.workspaceId },
    select: { id: true, isActive: true },
  });
  if (!source) return { ok: false, error: "That source is not in this workspace." };

  await prisma.inboundSource.update({
    where: { id: source.id },
    data: { isActive: !source.isActive },
  });

  revalidatePath("/dashboard");
  return { ok: true };
}

export async function deleteInboundSource(id: string): Promise<InboundSourceActionResult> {
  const session = await requireSession();
  const source = await prisma.inboundSource.findFirst({
    where: { id, workspaceId: session.workspaceId },
    select: { id: true },
  });
  if (!source) return { ok: false, error: "That source is not in this workspace." };

  await prisma.inboundSource.delete({ where: { id: source.id } });

  revalidatePath("/dashboard");
  return { ok: true };
}
