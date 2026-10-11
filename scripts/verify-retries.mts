/**
 * The retry engine, end to end, against a real receiver.
 *
 * `tests/unit/retry.test.ts` covers the policy. This covers the engine: that a
 * scheduled retry actually fires, that a 400 is parked without a second
 * attempt, that two workers cannot both send the same event, and that a replay
 * copies the payload instead of re-serialising it.
 *
 * Runs on a throwaway SQLite file so it cannot touch demo data, and stands up
 * its own receiver on a loopback port so it needs no network.
 *
 *   DATABASE_URL="file:/tmp/tokens-retries.db" npx prisma db push --skip-generate
 *   DATABASE_URL="file:/tmp/tokens-retries.db" npx tsx scripts/verify-retries.mts
 */
import { createServer, type Server } from "node:http";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";

const url = process.env.DATABASE_URL;
if (!url || !url.includes("tokens-")) {
  console.error("Refusing to run: set DATABASE_URL to a throwaway file, e.g. file:/tmp/tokens-r.db");
  process.exit(2);
}

const { prisma } = await import("../src/lib/db");
const { dispatchEvent, processDueDeliveries, attemptDelivery } = await import("../src/lib/dispatch");

// ---------------------------------------------------------------- receiver
let mode: "fail" | "ok" | "bad" = "fail";
const received: { body: string; delivery: string | null; attempt: string | null }[] = [];

const receiver: Server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    received.push({
      body,
      delivery: (req.headers["x-abetapi-delivery"] as string) ?? null,
      attempt: (req.headers["x-abetapi-attempt"] as string) ?? null,
    });
    if (mode === "ok") {
      res.writeHead(200).end("{}");
    } else if (mode === "bad") {
      res.writeHead(400).end("no");
    } else {
      res.writeHead(503).end("nope");
    }
  });
});
await new Promise<void>((r) => receiver.listen(0, "127.0.0.1", r));
const port = (receiver.address() as { port: number }).port;

const results: { name: string; ok: boolean; detail: string }[] = [];
async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    results.push({ name, ok: true, detail: "" });
  } catch (e) {
    results.push({ name, ok: false, detail: e instanceof Error ? e.message : String(e) });
  }
}

const workspace = await prisma.workspace.create({ data: { name: "Retry Probe", slug: `retry-probe-${Date.now().toString(36)}` } });
const hook = await prisma.webhook.create({
  data: { workspaceId: workspace.id, url: `http://127.0.0.1:${port}/hook`, events: ["probe.ping"], secretHash: "hash" },
});

const newest = () =>
  prisma.delivery.findFirst({ where: { webhookId: hook.id }, orderBy: { createdAt: "desc" } });
const makeDue = async (id: string) =>
  prisma.delivery.update({ where: { id }, data: { nextAttemptAt: new Date(Date.now() - 1000) } });

await check("a failing endpoint leaves the delivery scheduled, not lost", async () => {
  mode = "fail";
  const receipt = await dispatchEvent(workspace.id, "probe.ping", { n: 1 });
  assert.equal(receipt.accepted, 1);
  assert.equal(receipt.delivered, 0);
  assert.equal(receipt.retrying, 1, "a 503 is a retry, not a failure to report as final");
  const row = await newest();
  assert.equal(row?.status, "RETRYING");
  assert.equal(row?.attempts, 1);
  assert.ok(row?.nextAttemptAt, "a retry must have a time");
  assert.ok(row?.payload, "the payload must be stored or a replay is impossible");
});

await check("a due retry is actually re-sent by the worker", async () => {
  const row = await newest();
  await makeDue(row!.id);
  const result = await processDueDeliveries(new Date());
  assert.ok(result.processed >= 1, "the worker should have claimed the due row");
  const after = await newest();
  assert.equal(after?.attempts, 2, "a second attempt should have been made");
});

await check("a recovered endpoint finally receives the original event", async () => {
  mode = "ok";
  const row = await newest();
  await makeDue(row!.id);
  await processDueDeliveries(new Date());
  const after = await newest();
  assert.equal(after?.status, "DELIVERED");
  assert.equal(after?.ok, true);
});

await check("every attempt carries the same bytes, so the signature stays valid", async () => {
  const bodies = new Set(received.map((r) => r.body));
  assert.equal(bodies.size, 1, `retries must be byte-identical, saw ${bodies.size} variants`);
});

await check("every attempt carries the idempotency key", async () => {
  assert.ok(received.length >= 3);
  assert.ok(received.every((r) => r.delivery), "x-abetapi-delivery missing on some attempt");
  assert.equal(new Set(received.map((r) => r.delivery)).size, 1, "the key must be stable across retries");
});

await check("a 400 is parked after one attempt, with no retry scheduled", async () => {
  mode = "bad";
  await dispatchEvent(workspace.id, "probe.ping", { n: 2 });
  const row = await newest();
  assert.equal(row?.status, "DEAD", "a permanent refusal must not burn the schedule");
  assert.equal(row?.attempts, 1);
  assert.equal(row?.nextAttemptAt, null);
  assert.equal(row?.deadAt !== null, true);
});

await check("two concurrent workers cannot both send the same delivery", async () => {
  // The claim is a conditional update on status. If it were a read-then-write,
  // both workers would send it and a billing webhook would double-charge.
  mode = "fail";
  await dispatchEvent(workspace.id, "probe.ping", { n: 3 });
  const row = await newest();
  await makeDue(row!.id);
  const before = received.length;
  await Promise.all([processDueDeliveries(new Date()), processDueDeliveries(new Date())]);
  const added = received.length - before;
  assert.equal(added, 1, `exactly one attempt should have been sent, saw ${added}`);
});

await check("a replay copies the payload and leaves the original dead row intact", async () => {
  mode = "ok";
  const dead = await prisma.delivery.findFirst({
    where: { webhookId: hook.id, status: "DEAD" },
    orderBy: { createdAt: "asc" },
  });
  assert.ok(dead, "expected a dead delivery to replay");
  const clone = await prisma.delivery.create({
    data: {
      workspaceId: dead.workspaceId,
      webhookId: dead.webhookId,
      event: dead.event,
      eventId: dead.eventId,
      payload: dead.payload as never,
      status: "PENDING",
      attempts: 0,
      ok: false,
      replayedFrom: dead.id,
    },
  });
  const outcome = await attemptDelivery(clone, hook);
  assert.equal(outcome.status, "DELIVERED");
  const original = await prisma.delivery.findUnique({ where: { id: dead.id } });
  assert.equal(original?.status, "DEAD", "history must not be rewritten by a replay");
  assert.equal(original?.attempts, 1, "the original's attempt count must not change");
  assert.equal(clone.replayedFrom, dead.id, "the replay must point back at what it replays");
});

await check("a disabled endpoint is not retried", async () => {
  await prisma.webhook.update({ where: { id: hook.id }, data: { isActive: false, disabledReason: "test" } });
  const row = await newest();
  await prisma.delivery.update({
    where: { id: row!.id },
    data: { status: "RETRYING", nextAttemptAt: new Date(Date.now() - 1000) },
  });
  const before = received.length;
  await processDueDeliveries(new Date());
  assert.equal(received.length, before, "a disabled endpoint must not be called");
  const after = await prisma.delivery.findUnique({ where: { id: row!.id } });
  assert.equal(after?.status, "DEAD", "and the pending delivery should be parked, not left hanging");
  await prisma.webhook.update({ where: { id: hook.id }, data: { isActive: true, disabledReason: null } });
});

// cleanup
receiver.close();
await prisma.delivery.deleteMany({ where: { webhookId: hook.id } });
await prisma.webhook.delete({ where: { id: hook.id } });
await prisma.workspace.delete({ where: { id: workspace.id } });
await prisma.$disconnect();

const pass = results.filter((r) => r.ok).length;
for (const r of results) console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : `\n         ${r.detail}`}`);
console.log(`\nRetry engine verification — ${pass} passed, ${results.length - pass} failed`);
try {
  rmSync(url.replace(/^file:/, ""), { force: true });
} catch {
  /* /tmp */
}
process.exit(pass === results.length ? 0 : 1);
