/**
 * The OpenAPI 3.1 description of AbetAPI. Small on purpose: every path here
 * has a handler, every handler is here, and the README lists the same set.
 *
 * The limits are imported from `./fields` rather than typed out again. That is
 * the difference between a document and a promise: `body(["name"], …)` used to
 * describe a mint that accepted an omitted `scopes` (and answered it with every
 * scope), while the same file's `422: fails("Bad scopes")` covered a check that
 * refused a *word* the same way it refused an unknown scope name. Now the table
 * the routes validate against is the thing this renders, so a cap can be raised
 * in one place and cannot be forgotten in the other.
 */

import { ALL_SCOPES } from "./keys";
import { version as packageVersion } from "../../package.json";
import {
  DELIVERY_STATUSES,
  EVENT_TYPES_MAX,
  EVENT_TYPE_MAX,
  EVENT_TYPE_PATTERN,
  ID_MAX,
  NAME_MAX,
  RATE_LIMIT_MAX,
  SCOPES_MAX,
  SCOPE_VALUES,
  SSO_TYPES,
  URL_MAX,
} from "./fields";

type Schema = Record<string, unknown>;

const ref = (name: string): Schema => ({ $ref: `#/components/schemas/${name}` });
const media = (schema: Schema): Schema => ({ content: { "application/json": { schema } } });
const ok = (description: string, schema: Schema): Schema => ({ description, ...media(schema) });
const fails = (description: string): Schema => ({ description, ...media(ref("Error")) });
const query = (name: string, description: string): Schema => ({
  name,
  in: "query",
  description,
  required: false,
  schema: { type: "string" },
});
const pathParam = (name: string, description: string): Schema => ({
  name,
  in: "path",
  description,
  required: true,
  schema: { type: "string" },
});
const headerParam = (name: string, description: string, required = true): Schema => ({
  name,
  in: "header",
  description,
  required,
  schema: { type: "string" },
});
const body = (required: string[], properties: Record<string, unknown>, description?: string): Schema => ({
  ...(description ? { description } : {}),
  required: true,
  content: { "application/json": { schema: { type: "object", required, properties } } },
});

/**
 * A request body has two ways to be wrong, and they are different sentences.
 * Bytes that are not a JSON object have no fields to report on, so they get 400
 * and a single message. A JSON object whose *field* is wrong gets 422 and the
 * same message plus `error.fields`, keyed the way the caller keyed the body.
 * Both answers carry `code: "invalid_request"`, so a client that only reads the
 * code sees one class of failure and a client that reads the status sees two.
 */
const malformedBody = (): Schema => fails("Body is not a JSON object");
const refusedField = (): Schema => fails("A field was refused; see error.fields");

const schemas: Record<string, Schema> = {
  Error: {
    type: "object",
    required: ["error"],
    properties: {
      error: {
        type: "object",
        required: ["code", "message"],
        properties: {
          code: {
            type: "string",
            enum: ["authentication_error", "permission_error", "rate_limit_error", "invalid_request", "not_found", "conflict", "internal_error"],
          },
          message: { type: "string" },
          /**
           * Present on 422. One entry per problem, all of them reported at once
           * rather than one per round trip. The keys are the body's own field
           * names; an element of a list is addressed `events[3]`.
           */
          fields: { type: "object", additionalProperties: { type: "string" } },
        },
      },
    },
  },
  ApiKey: {
    type: "object",
    properties: {
      id: { type: "string" },
      name: { type: "string" },
      prefix: { type: "string" },
      scopes: { type: "array", items: { type: "string" } },
      rateLimitPerMin: { type: "integer" },
      lastUsedAt: { type: ["string", "null"], format: "date-time" },
      revokedAt: { type: ["string", "null"], format: "date-time" },
      createdAt: { type: "string", format: "date-time" },
    },
  },
};

const keyAuth = [{ bearerAuth: [] }, { apiKeyHeader: [] }];

const paths: Record<string, Schema> = {
  "/api/health": {
    get: {
      operationId: "getHealth",
      summary: "Liveness probe with a database ping",
      security: [],
      responses: { 200: ok("Healthy", { type: "object" }), 503: fails("Database unreachable") },
    },
  },
  "/api/v1/openapi": {
    get: {
      operationId: "getOpenApiSpec",
      summary: "This document",
      security: [],
      responses: { 200: ok("The OpenAPI 3.1 document", { type: "object" }) },
    },
  },
  "/api/v1/whoami": {
    get: {
      operationId: "whoAmI",
      summary: "The calling key's workspace, scopes and quota",
      security: keyAuth,
      responses: { 200: ok("Key identity", { type: "object" }), 401: fails("No key") },
    },
  },
  "/api/keys": {
    get: {
      operationId: "listKeys",
      summary: "Keys in this workspace (prefixes only, never plaintext)",
      security: keyAuth,
      // No 403: this handler asks for no scope, and `scopesCover(granted, [])`
      // is true for every key. The document used to promise one anyway.
      responses: { 200: ok("Keys", { type: "object" }), 401: fails("No key") },
    },
    post: {
      operationId: "createKey",
      summary: "Mint a key; the plaintext is returned once",
      description:
        "`scopes` may be omitted, and then the new key inherits the scopes of the key that minted it. It used to inherit `*` instead, so a caller holding only `keys:write` could mint a key holding everything. A `scopes` that is sent must be a non-empty list of the names below, an unknown member is refused by name rather than filtered out, and a known one the calling key does not itself hold is a 403 — a key may hand out its own authority and no more. Re-scoping an existing key (`PATCH /api/keys/{id}`) follows the same rule.",
      security: keyAuth,
      requestBody: body(["name"], {
        name: { type: "string", minLength: 1, maxLength: NAME_MAX },
        scopes: { type: "array", items: { type: "string", enum: [...SCOPE_VALUES] }, minItems: 1, maxItems: SCOPES_MAX },
        rateLimitPerMin: { type: "integer", minimum: 0, maximum: RATE_LIMIT_MAX },
      }),
      responses: {
        201: ok("Created", { type: "object" }),
        400: malformedBody(),
        401: fails("No key"),
        403: fails("Needs keys:write, or asks for a scope the calling key does not hold"),
        409: fails("This workspace already has 20 live keys"),
        422: refusedField(),
      },
    },
  },
  "/api/keys/{id}": {
    get: {
      operationId: "getKey",
      summary: "One key",
      security: keyAuth,
      parameters: [pathParam("id", "Key id.")],
      responses: { 200: ok("Key", ref("ApiKey")), 401: fails("No key"), 404: fails("No such key") },
    },
    patch: {
      operationId: "updateKey",
      summary: "Rename, re-scope or re-limit a key",
      description:
        "Names at least one field: an empty body is refused rather than answered with the row it left untouched. Fields this route does not own (`revokedAt`, `hashedKey`) are not accepted — revoking is DELETE. `scopes` is checked against the key making the call, because re-scoping is granting: a key may set only scopes it holds, and `*` is a scope.",
      security: keyAuth,
      parameters: [pathParam("id", "Key id.")],
      requestBody: body([], {
        name: { type: "string", minLength: 1, maxLength: NAME_MAX },
        scopes: { type: "array", items: { type: "string", enum: [...SCOPE_VALUES] }, minItems: 1, maxItems: SCOPES_MAX },
        rateLimitPerMin: { type: "integer", minimum: 0, maximum: RATE_LIMIT_MAX },
      }),
      responses: {
        200: ok("Key", ref("ApiKey")),
        400: malformedBody(),
        401: fails("No key"),
        403: fails("Needs keys:write, or asks for a scope the calling key does not hold"),
        404: fails("No such key"),
        422: refusedField(),
      },
    },
    delete: {
      operationId: "revokeKey",
      summary: "Revoke now; the next request 401s",
      security: keyAuth,
      parameters: [pathParam("id", "Key id.")],
      responses: { 200: ok("Revoked", { type: "object" }), 401: fails("No key"), 403: fails("Needs keys:write"), 404: fails("No such key") },
    },
  },
  "/api/v1/events": {
    post: {
      operationId: "publishEvent",
      summary: "Publish an event to matching webhooks",
      security: keyAuth,
      requestBody: body(["type"], {
        type: { type: "string", minLength: 1, maxLength: EVENT_TYPE_MAX, pattern: EVENT_TYPE_PATTERN.source },
        data: {
          description: "The payload every matching subscriber receives, signed. Omit it for no payload; `null` is refused.",
          oneOf: [{ type: "object" }, { type: "array" }],
        },
      }),
      responses: {
        201: ok("Dispatch receipt", { type: "object" }),
        400: malformedBody(),
        401: fails("No key"),
        403: fails("Needs events:write"),
        422: refusedField(),
      },
    },
  },
  "/api/v1/inbound/nucrm/{id}": {
    post: {
      operationId: "receiveNucrmEvent",
      summary: "Receive a signed NuCRM webhook and publish it to matching subscriptions",
      description:
        "This is the address a NuCRM integration webhook posts to — the receiving end of the bridge, where `POST /api/v1/events` is the publishing end your own code calls. Create a source in the dashboard (Connect NuCRM), then configure the NuCRM integration with this URL, `Authorization: Bearer <key>` plus the integration's secret. The body is NuCRM's envelope; `x-nucrm-signature` is `sha256=` + HMAC-SHA256 of the exact bytes, keyed by the source's secret (the `sha256=` prefix is optional and both spellings verify). `x-nucrm-delivery` deduplicates NuCRM's own retries: a repeat answers `200` with `duplicate: true` and publishes nothing. An accepted event gets one Delivery per matching subscription, counted like `POST /api/v1/events`; a paused source answers 409 and NuCRM parks the delivery after its five attempts.",
      security: keyAuth,
      parameters: [
        pathParam("id", "Inbound source id (dashboard → Connect NuCRM)."),
        headerParam("x-nucrm-signature", "HMAC-SHA256 of the request body, hex, optionally prefixed `sha256=`."),
        headerParam(
          "x-nucrm-delivery",
          "NuCRM's delivery id. A repeat of one already accepted answers 200 with `duplicate: true`.",
          false,
        ),
      ],
      requestBody: body(["event"], {
        event: { type: "string", minLength: 1, maxLength: EVENT_TYPE_MAX, pattern: EVENT_TYPE_PATTERN.source },
        timestamp: { type: "string", description: "NuCRM's ISO moment. Declared, not interpreted — deliveries carry their own." },
        tenant_id: { type: "string", maxLength: ID_MAX, description: "NuCRM's tenant. Declared, not interpreted." },
        data: {
          description: "The payload every matching subscriber receives, signed. Omit it for none; `null` is refused.",
          oneOf: [{ type: "object" }, { type: "array" }],
        },
      }),
      responses: {
        202: ok("Accepted — one Delivery per matching subscription (same receipt as POST /api/v1/events)", { type: "object" }),
        200: ok("Duplicate delivery: already accepted, nothing published again", { type: "object" }),
        400: malformedBody(),
        401: fails("No key, or x-nucrm-signature missing/does not match the source's secret"),
        403: fails("Needs events:write"),
        404: fails("No such inbound source in this workspace"),
        409: fails("Source paused"),
        422: refusedField(),
      },
    },
  },
  "/api/webhooks": {
    get: {
      operationId: "listWebhooks",
      summary: "Subscriptions (secrets never listed)",
      security: keyAuth,
      responses: { 200: ok("Webhooks", { type: "object" }), 401: fails("No key") },
    },
    post: {
      operationId: "createWebhook",
      summary: "Subscribe; the signing secret returns once",
      security: keyAuth,
      requestBody: body(["url"], {
        url: { type: "string", format: "uri", maxLength: URL_MAX },
        events: {
          description: "Event names to filter on. Empty or omitted means every event.",
          type: "array",
          items: { type: "string", minLength: 1, maxLength: EVENT_TYPE_MAX, pattern: EVENT_TYPE_PATTERN.source },
          maxItems: EVENT_TYPES_MAX,
        },
      }),
      responses: {
        201: ok("Subscribed", { type: "object" }),
        400: malformedBody(),
        401: fails("No key"),
        403: fails("Needs webhooks:write"),
        422: refusedField(),
      },
    },
  },
  "/api/webhooks/{id}": {
    get: {
      operationId: "getWebhook",
      summary: "One subscription",
      security: keyAuth,
      parameters: [pathParam("id", "Webhook id.")],
      responses: { 200: ok("Webhook", { type: "object" }), 401: fails("No key"), 404: fails("None") },
    },
    patch: {
      operationId: "updateWebhook",
      summary: "Move, re-scope, silence or rotate a subscription",
      description:
        "Names at least one field, `rotate` included. `isActive` is a boolean: the word `\"no\"` used to be stored as `true`, and `\"\"` as `false`.",
      security: keyAuth,
      parameters: [pathParam("id", "Webhook id.")],
      requestBody: body([], {
        url: { type: "string", format: "uri", maxLength: URL_MAX },
        events: {
          type: "array",
          items: { type: "string", minLength: 1, maxLength: EVENT_TYPE_MAX, pattern: EVENT_TYPE_PATTERN.source },
          maxItems: EVENT_TYPES_MAX,
        },
        isActive: { type: "boolean" },
        rotate: { type: "boolean" },
      }),
      responses: {
        200: ok("Webhook", { type: "object" }),
        400: malformedBody(),
        401: fails("No key"),
        403: fails("Needs webhooks:write"),
        404: fails("None"),
        422: refusedField(),
      },
    },
    delete: {
      operationId: "deleteWebhook",
      summary: "Unsubscribe",
      security: keyAuth,
      parameters: [pathParam("id", "Webhook id.")],
      responses: { 200: ok("Gone", { type: "object" }), 401: fails("No key"), 403: fails("Needs webhooks:write"), 404: fails("None") },
    },
  },
  "/api/webhooks/{id}/deliveries": {
    get: {
      operationId: "listDeliveries",
      summary: "Delivery receipts, with every attempt",
      description:
        "Each delivery carries its status (PENDING, DELIVERED, RETRYING, DEAD), attempt log, and nextAttemptAt when a retry is scheduled.",
      security: keyAuth,
      parameters: [pathParam("id", "Webhook id.")],
      responses: { 200: ok("Deliveries", { type: "object" }), 401: fails("No key") },
    },
  },
  "/api/webhooks/{id}/deliveries/replay": {
    post: {
      operationId: "replayDeliveries",
      summary: "Re-send one delivery, or every dead one",
      description:
        "Copies the stored payload into a NEW delivery so the failed original stays on the record. Refused while the endpoint is disabled. Retries are at-least-once, so a receiver must dedupe on the x-abetapi-delivery header.",
      security: keyAuth,
      parameters: [pathParam("id", "Webhook id.")],
      requestBody: body(
        [],
        {
          deliveryId: { type: "string", maxLength: ID_MAX },
          all: { type: "boolean" },
          status: { type: "string", enum: [...DELIVERY_STATUSES] },
        },
        "Either `deliveryId`, or `all: true` with an optional `status` (defaults to DEAD). A boolean is a boolean: `all: \"yes\"` used to be answered as though `deliveryId` were the missing field.",
      ),
      responses: {
        202: ok("Replayed", { type: "object" }),
        400: malformedBody(),
        401: fails("No key"),
        403: fails("Needs webhooks:write"),
        404: fails("Nothing to replay"),
        409: fails("Endpoint disabled"),
        422: refusedField(),
      },
    },
  },
  "/api/ai/diagnose-webhook": {
    post: {
      operationId: "diagnoseWebhook",
      summary: "Explain a webhook's recent delivery failures",
      description:
        "Read-only and workspace-scoped: it selects no `secretHash` and retries nothing. A signed-in dashboard session is accepted as well as a key. Its refusals for a wrong field are this document's own envelope; the 404 below is not, and is described as it actually answers.",
      security: keyAuth,
      requestBody: body(["webhookId"], {
        webhookId: { type: "string", minLength: 1, maxLength: ID_MAX },
        model: { type: "string", maxLength: NAME_MAX },
      }),
      responses: {
        200: ok("A diagnosis, or an honest \"nothing to diagnose\" with the stats beside it", { type: "object" }),
        400: malformedBody(),
        401: fails("No key"),
        404: {
          description:
            "No such webhook in this workspace. This answer is `{ error: \"webhook not found\" }` — a bare string, not the envelope above — because the app's own dashboard prints it: `ai-panel.tsx` renders `data.error` as text. Documented rather than quietly different.",
          ...media({ type: "object", required: ["error"], properties: { error: { type: "string" } } }),
        },
        422: refusedField(),
        502: ok("The model was unreachable; delivery records are unaffected", { type: "object" }),
      },
    },
  },
  "/api/usage": {
    get: {
      operationId: "getUsage",
      summary: "Per-key request counts and error rates",
      security: keyAuth,
      parameters: [query("workspaceId", "Workspace id."), query("days", "Lookback window.")],
      responses: { 200: ok("Usage", { type: "object" }), 401: fails("No key") },
    },
  },
  "/api/sso": {
    get: {
      operationId: "listSso",
      summary: "SSO connections and their check status",
      security: keyAuth,
      responses: { 200: ok("Connections", { type: "object" }), 401: fails("No key") },
    },
    post: {
      operationId: "createSso",
      summary: "Register an OIDC connection (SAML stays refused)",
      security: keyAuth,
      requestBody: body(["name", "issuer", "metadataUrl"], {
        name: { type: "string", minLength: 1, maxLength: NAME_MAX },
        type: { type: "string", enum: [...SSO_TYPES] },
        issuer: { type: "string", format: "uri", maxLength: URL_MAX },
        metadataUrl: { type: "string", format: "uri", maxLength: URL_MAX },
        clientId: { type: ["string", "null"], maxLength: NAME_MAX },
      }),
      responses: {
        201: ok("Connection", { type: "object" }),
        400: malformedBody(),
        401: fails("No key"),
        403: fails("Needs sso:write"),
        409: fails("That name is taken in this workspace"),
        422: refusedField(),
      },
    },
  },
  "/api/sso/{id}": {
    get: {
      operationId: "getSso",
      summary: "One connection",
      security: keyAuth,
      parameters: [pathParam("id", "Connection id.")],
      responses: { 200: ok("Connection", { type: "object" }), 401: fails("No key"), 404: fails("None") },
    },
    patch: {
      operationId: "updateSso",
      summary: "Edit a connection (re-checks on metadata change)",
      description:
        "Names at least one field. `status` and `lastError` are what the live check found, not inputs; changing `metadataUrl` resets them to UNCHECKED.",
      security: keyAuth,
      parameters: [pathParam("id", "Connection id.")],
      requestBody: body([], {
        name: { type: "string", minLength: 1, maxLength: NAME_MAX },
        issuer: { type: "string", format: "uri", maxLength: URL_MAX },
        metadataUrl: { type: "string", format: "uri", maxLength: URL_MAX },
        clientId: { type: ["string", "null"], maxLength: NAME_MAX },
      }),
      responses: {
        200: ok("Connection", { type: "object" }),
        400: malformedBody(),
        401: fails("No key"),
        403: fails("Needs sso:write"),
        404: fails("None"),
        409: fails("That name is taken in this workspace"),
        422: refusedField(),
      },
    },
    delete: {
      operationId: "deleteSso",
      summary: "Remove a connection",
      security: keyAuth,
      parameters: [pathParam("id", "Connection id.")],
      responses: { 200: ok("Gone", { type: "object" }), 401: fails("No key"), 403: fails("Needs sso:write"), 404: fails("None") },
    },
  },
  "/api/sso/{id}/check": {
    post: {
      operationId: "checkSso",
      summary: "Run a live OIDC discovery check now",
      security: keyAuth,
      parameters: [pathParam("id", "Connection id.")],
      responses: { 200: ok("Check result", { type: "object" }), 401: fails("No key"), 403: fails("Needs sso:write"), 404: fails("None") },
    },
  },
};

export const openapiSpec = {
  openapi: "3.1.0",
  info: {
    title: "AbetAPI",
    version: packageVersion,
    description:
      "Keys, webhooks, usage and SSO connections. Auth is a workspace key in " +
      "`Authorization: Bearer ab_live_…` or `x-api-key`; only its hash is stored.",
  },
  servers: [{ url: "/", description: "The deployment serving the gateway." }],
  tags: [
    { name: "Keys", description: "Mint, list, revoke." },
    { name: "Events", description: "Publish to webhooks." },
    { name: "Webhooks", description: "Subscribe and inspect deliveries." },
    { name: "Usage", description: "Per-key audit." },
    { name: "SSO", description: "Identity provider connections." },
    { name: "Discovery", description: "Health and this document." },
  ],
  security: [{ bearerAuth: [] }, { apiKeyHeader: [] }],
  paths,
  components: {
    securitySchemes: {
      bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "ab_live_…" },
      apiKeyHeader: { type: "apiKey", in: "header", name: "x-api-key" },
    },
    schemas,
  },
} as const;

export type OpenApiSpec = typeof openapiSpec;
