// The export surface, pinned without a database.
//
// The route scanner proves the handlers authenticate. This file owns the parts
// a request would not make obvious: the filename cannot carry a header, a
// webhook row loses its secret hash, an inbound source loses its HMAC secret,
// an SSO connection loses its client secret, the delivery audit keeps its
// payload and attempt log, user text cannot become a spreadsheet formula, and
// the JSON builder does not quietly select a credential column.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  deliveryCsvHeader,
  deliveryCsvRow,
  exportDownloadHeaders,
  exportFilename,
  publicInboundSource,
  publicSsoConnection,
  publicWebhook,
  requestLogCsvHeader,
  requestLogCsvRow,
} from "../../src/lib/export";

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

/** Minimal RFC 4180 reader for one encoded line; CRLF inside a cell is not in these fixtures. */
function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (quoted) {
      if (char === '"' && line[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      cells.push(cell);
      cell = "";
    } else {
      cell += char;
    }
  }
  cells.push(cell);
  return cells;
}

describe("export filenames", () => {
  it("sanitises a slug before it reaches Content-Disposition", () => {
    const name = exportFilename('Acme "EU"/Ops\r\n', "workspace", new Date("2026-10-20T12:00:00Z"));
    assert.equal(name, "abetapi-acme-eu-ops-workspace-2026-10-20.json");
    assert.equal(
      exportFilename("", "deliveries", new Date("2026-10-20T12:00:00Z")),
      "abetapi-workspace-deliveries-2026-10-20.csv",
    );
    assert.equal(
      exportFilename("Acme", "requestlogs", new Date("2026-10-20T12:00:00Z")),
      "abetapi-acme-requestlogs-2026-10-20.csv",
    );
  });

  it("marks every download no-store and nosniff", () => {
    const headers = exportDownloadHeaders("abetapi-acme-requestlogs-2026-10-20.csv", "text/csv; charset=utf-8");
    assert.equal(headers["content-disposition"], 'attachment; filename="abetapi-acme-requestlogs-2026-10-20.csv"');
    assert.equal(headers["cache-control"], "no-store");
    assert.equal(headers["x-content-type-options"], "nosniff");
  });
});

describe("the public webhook projection", () => {
  it("returns the webhook row as-is (secretHash is never selected)", () => {
    const hook = { id: "w_1", url: "https://example.test/hook", events: ["lead.created"], secretPrefix: "whsec_", isActive: true, consecutiveFailures: 0, disabledReason: null, createdAt: new Date(), updatedAt: new Date() };
    const exported = publicWebhook(hook);
    assert.deepEqual(exported, { id: "w_1", url: "https://example.test/hook", events: ["lead.created"], secretPrefix: "whsec_", isActive: true, consecutiveFailures: 0, disabledReason: null, createdAt: hook.createdAt, updatedAt: hook.updatedAt });
  });
});

describe("the public inbound source projection", () => {
  it("returns the inbound source row as-is (secret is never selected)", () => {
    const src = { id: "is_1", name: "NuCRM", provider: "nucrm", secretPrefix: "in_live_", isActive: true, lastEventAt: null, lastEventName: null, receivedEvents: 0, createdAt: new Date(), updatedAt: new Date() };
    const exported = publicInboundSource(src);
    assert.deepEqual(exported, { id: "is_1", name: "NuCRM", provider: "nucrm", secretPrefix: "in_live_", isActive: true, lastEventAt: null, lastEventName: null, receivedEvents: 0, createdAt: src.createdAt, updatedAt: src.updatedAt });
  });
});

describe("the public SSO connection projection", () => {
  it("keeps issuer and metadata, drops clientSecret without mutating", () => {
    const sso = { id: "sso_1", name: "Corp SSO", type: "oidc", issuer: "https://idp.example.test", metadataUrl: "https://idp.example.test/.well-known/openid-configuration", clientId: "client_1", status: "VERIFIED", lastCheckedAt: new Date(), lastError: null, createdAt: new Date(), updatedAt: new Date() };
    const exported = publicSsoConnection(sso);
    assert.deepEqual(exported, { id: "sso_1", name: "Corp SSO", type: "oidc", issuer: "https://idp.example.test", metadataUrl: "https://idp.example.test/.well-known/openid-configuration", clientId: "client_1", status: "VERIFIED", lastCheckedAt: sso.lastCheckedAt, lastError: null, createdAt: sso.createdAt, updatedAt: sso.updatedAt });
  });
});

describe("the delivery-audit CSV", () => {
  it("has a stable header and preserves the payload and attempt log", () => {
    assert.equal(
      deliveryCsvHeader(),
      '"delivery_id","webhook_id","event","status_code","ok","error","attempts","duration_ms","created_at","event_id","payload","status","next_attempt_at","last_attempt_at","dead_at","attempt_log","replayed_from"\r\n',
    );

    const row = parseCsvLine(
      deliveryCsvRow({
        id: "d_1",
        webhookId: "w_1",
        event: "lead.created",
        statusCode: 200,
        ok: true,
        error: null,
        attempts: 1,
        durationMs: 123,
        createdAt: new Date("2026-03-01T12:00:00Z"),
        eventId: "evt_1",
        payload: { leadId: "123" },
        status: "DELIVERED",
        nextAttemptAt: null,
        lastAttemptAt: new Date("2026-03-01T12:00:01Z"),
        deadAt: null,
        attemptLog: [{ attempt: 1, status: 200, durationMs: 123 }],
        replayedFrom: null,
      }).replace(/\r\n$/, ""),
    );

    assert.equal(row[0], "d_1");
    assert.equal(row[1], "w_1");
    assert.equal(row[2], "lead.created");
    assert.equal(row[3], "200");
    assert.equal(row[4], "true");
    assert.equal(row[5], "");
    assert.equal(row[6], "1");
    assert.equal(row[7], "123");
    assert.equal(row[8], "2026-03-01T12:00:00.000Z");
    assert.equal(row[9], "evt_1");
    assert.deepEqual(JSON.parse(row[10]), { leadId: "123" });
    assert.equal(row[11], "DELIVERED");
    assert.equal(row[12], "");
    assert.equal(row[13], "2026-03-01T12:00:01.000Z");
    assert.equal(row[14], "");
    assert.deepEqual(JSON.parse(row[15]), [{ attempt: 1, status: 200, durationMs: 123 }]);
    assert.equal(row[16], "");
  });

  it("refuses to let an error message become a formula", () => {
    const row = parseCsvLine(
      deliveryCsvRow({
        id: "d_2",
        webhookId: "w_2",
        event: "lead.created",
        statusCode: 500,
        ok: false,
        error: "=HYPERLINK(\"https://evil.test\")",
        attempts: 3,
        durationMs: 5000,
        createdAt: "2026-03-01T12:00:00.000Z",
        eventId: null,
        payload: null,
        status: "DEAD",
        nextAttemptAt: null,
        lastAttemptAt: null,
        deadAt: "2026-03-01T12:05:00.000Z",
        attemptLog: [],
        replayedFrom: null,
      }).replace(/\r\n$/, ""),
    );

    assert.equal(row[5], "'=HYPERLINK(\"https://evil.test\")");
    assert.equal(row[11], "DEAD");
  });
});

describe("the request-log-audit CSV", () => {
  it("has a stable header and writes nullable duration as empty", () => {
    assert.equal(
      requestLogCsvHeader(),
      '"requestlog_id","key_id","method","path","status","duration_ms","created_at"\r\n',
    );

    const row = parseCsvLine(
      requestLogCsvRow({
        id: "rl_1",
        keyId: "k_1",
        method: "POST",
        path: "/api/v1/events",
        status: 202,
        durationMs: 42,
        createdAt: new Date("2026-03-01T12:00:00Z"),
      }).replace(/\r\n$/, ""),
    );

    assert.equal(row[0], "rl_1");
    assert.equal(row[1], "k_1");
    assert.equal(row[2], "POST");
    assert.equal(row[3], "/api/v1/events");
    assert.equal(row[4], "202");
    assert.equal(row[5], "42");
    assert.equal(row[6], "2026-03-01T12:00:00.000Z");
  });

  it("writes empty for a null keyId and duration", () => {
    const row = parseCsvLine(
      requestLogCsvRow({
        id: "rl_2",
        keyId: null,
        method: "GET",
        path: "/api/health",
        status: 200,
        durationMs: null,
        createdAt: "2026-03-01T12:00:00.000Z",
      }).replace(/\r\n$/, ""),
    );

    assert.equal(row[0], "rl_2");
    assert.equal(row[1], "");
    assert.equal(row[3], "/api/health");
    assert.equal(row[5], "");
  });
});

describe("the export builder's boundaries", () => {
  const builder = source("../../src/lib/export.ts");

  it("selects content, never credential columns", () => {
    for (const forbidden of [
      "secretHash: true",
      "secret: true",
      "clientSecret: true",
      "tokenHash: true",
      "hashedKey: true",
      "passwordHash: true",
      "stripeCustomerId: true",
      "stripeSubscriptionId: true",
    ]) {
      assert.equal(builder.includes(forbidden), false, `${forbidden} must not be selected by an export`);
    }
  });

  it("scopes every collection query to the workspace", () => {
    const scoped = builder.match(/where:\s*\{\s*workspaceId/g) ?? [];
    assert.ok(scoped.length >= 8, `only ${scoped.length} workspace-scoped queries found — a query may be exporting another tenant's rows`);
  });

  it("keeps delivery and request-log rows out of the in-memory document and points at the streams", () => {
    assert.ok(builder.includes('download: "/api/export/deliveries"'));
    assert.ok(builder.includes('download: "/api/export/requestlogs"'));
    assert.ok(builder.includes("deliveries: {"));
    assert.ok(builder.includes("requestLogs: {"));
    assert.equal(/deliveries:\s*\[/.test(builder), false, "delivery rows must not be embedded as an array");
    assert.equal(/requestLogs:\s*\[/.test(builder), false, "request-log rows must not be embedded as an array");
  });

  it("every export route authenticates, checks the role, and uses the shared headers", () => {
    for (const route of [
      "../../src/app/api/export/route.ts",
      "../../src/app/api/export/deliveries/route.ts",
      "../../src/app/api/export/requestlogs/route.ts",
    ]) {
      const src = source(route);
      assert.match(src, /getSession\(\)/, `${route} must resolve the browser session`);
      assert.match(src, /canManageRoles\(session\.role\)/, `${route} must refuse a member`);
      assert.match(src, /exportDownloadHeaders/, `${route} must use the no-store download headers`);
    }
  });
});