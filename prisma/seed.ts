import { prisma } from "../src/lib/db";
import { generateApiKey } from "../src/lib/keys";

async function main() {
  console.log("Seeding AbetAPI...");

  const workspace = await prisma.workspace.upsert({
    where: { slug: "demo" },
    update: {},
    create: { name: "Demo Workspace", slug: "demo" },
  });
  console.log("Workspace:", workspace.id);

  // Root key: unlimited quota, every scope. Guard it like production data.
  const { plaintext, hashedKey, prefix } = generateApiKey();
  await prisma.apiKey.deleteMany({ where: { workspaceId: workspace.id, name: "Root key" } });
  const root = await prisma.apiKey.create({
    data: {
      workspaceId: workspace.id,
      name: "Root key",
      hashedKey,
      prefix,
      scopes: ["*"],
      rateLimitPerMin: 0,
    },
  });

  // A limited demo key so the quota headers are explorable without the root.
  const demo = generateApiKey();
  await prisma.apiKey.deleteMany({ where: { workspaceId: workspace.id, name: "Demo key" } });
  await prisma.apiKey.create({
    data: {
      workspaceId: workspace.id,
      name: "Demo key",
      hashedKey: demo.hashedKey,
      prefix: demo.prefix,
      scopes: ["events:write"],
      rateLimitPerMin: 60,
    },
  });

  console.log("Root key (copy now, never shown again):", plaintext);
  console.log("Demo key (events:write, 60/min):", demo.plaintext);
  console.log("Root id:", root.id);
  console.log("Seeding complete!");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
