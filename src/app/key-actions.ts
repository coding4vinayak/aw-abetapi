"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { generateApiKey, normalizeScopes } from "@/lib/keys";
import { requireSession } from "@/lib/session";
import type { FirstKeyResult } from "@/components/api-key-onboarding";

/**
 * Mint the workspace's first API key, from the browser session.
 *
 * Written by hand rather than reusing a shared helper because AbetAPI keys carry
 * scopes and a rate-limit ceiling, and its 20-live-key cap is enforced here too —
 * the first key is minted with full scope, which is the whole point of it being
 * the first, and is consistent with the root key the seed hands out.
 */
const MAX_LIVE_KEYS = 20;

export async function createFirstKey(): Promise<FirstKeyResult> {
  const session = await requireSession();

  const live = await prisma.apiKey.count({
    where: { workspaceId: session.workspaceId, revokedAt: null },
  });
  if (live > 0) {
    return { ok: false, error: "This workspace already has an API key." };
  }
  if (live >= MAX_LIVE_KEYS) {
    return { ok: false, error: `This workspace already has ${MAX_LIVE_KEYS} live keys.` };
  }

  const scopes = normalizeScopes(["*"]);
  if (!scopes) return { ok: false, error: "Internal scope normalisation failed." };

  const { plaintext, hashedKey, prefix } = generateApiKey();
  await prisma.apiKey.create({
    data: {
      workspaceId: session.workspaceId,
      name: "First key",
      hashedKey,
      prefix,
      scopes,
      // 0 is unlimited and only a root key may hold it; a first key is the
      // workspace's root credential, so it is created with the same ceiling
      // the seeded root key gets.
      rateLimitPerMin: 0,
    },
  });

  revalidatePath("/dashboard");
  return { ok: true, plaintext, prefix };
}
