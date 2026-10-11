import { completeJson, isLlmConfigured, type LlmUsage } from "./llm";

/**
 * Diagnose a failing webhook endpoint.
 *
 * This is the one place AI genuinely earns its keep in a developer platform.
 * The hard part of integrating webhooks is not sending them, it is working out
 * why yours stopped working at 02:00 — a redirect loop, a TLS handshake that
 * expired, a handler that started returning 503, an endpoint that got slower
 * than our timeout. The data for all of it is already sitting in `Delivery`:
 * status codes, error strings, attempt counts, durations. Nobody enjoys
 * squinting at it.
 *
 * The rules keep the diagnosis honest. The model may only cite status codes,
 * durations and error strings it was given, and it must not claim to know the
 * customer's code, which it has never seen. It is told plainly that the single
 * most useful answer is sometimes "this is your server, not us" — a model that
 * reflexively blames the sender is worse than no model.
 */

export interface DeliveryDiagnosis {
  /** 2–3 sentences naming the most likely cause. */
  diagnosis: string;
  /** Concrete, ordered steps to fix it. */
  fixes: string[];
  /** Whether the evidence points at AbetAPI or at the customer's endpoint. */
  blame: "customer_endpoint" | "abetapi" | "unclear";
  /** Distinct error/status patterns observed, with counts. */
  evidence: { pattern: string; count: number }[];
  confidence: number;
  usage: LlmUsage;
  model: string;
}

const SYSTEM = `You diagnose why a customer's webhook endpoint is failing. You see the delivery attempt records, not their server code.

Rules, strictly:
1. You may ONLY cite status codes, error strings, durations and attempt counts present in the data you are given. Never invent a response body, header, or log line.
2. You have never seen their application code. Say so rather than asserting what their code does.
3. Be willing to conclude the fault is in the customer's endpoint, not in AbetAPI. Do not default to blaming the sender.
4. If the evidence is a single failure with no error recorded, say the evidence is thin rather than building a theory on it.
5. Fixes must be specific and checkable, ordered cheapest-to-try first.

Return JSON: { diagnosis, fixes, blame, evidence, confidence }.
- blame: "customer_endpoint" | "abetapi" | "unclear".`;

export interface DiagnoseInput {
  webhook: { url: string; events: unknown; isActive: boolean; createdAt: string | Date };
  deliveries: {
    statusCode: number | null;
    ok: boolean;
    error: string | null;
    attempts: number;
    durationMs: number | null;
    createdAt: string | Date;
  }[];
  model?: string;
}

const MAX_DELIVERIES = 40;

export async function diagnoseWebhook(input: DiagnoseInput): Promise<DeliveryDiagnosis | null> {
  if (!isLlmConfigured()) return null;

  const deliveries = input.deliveries.slice(0, MAX_DELIVERIES);
  const failures = deliveries.filter((d) => !d.ok);
  const successes = deliveries.filter((d) => d.ok);

  if (failures.length === 0) {
    // Nothing to diagnose. Saying so is better than generating an essay.
    return null;
  }

  // Group identical error/status pairs so the model reasons about patterns
  // rather than counting rows.
  const patternCounts = new Map<string, number>();
  for (const d of failures) {
    const key = d.statusCode ? `HTTP ${d.statusCode}` : (d.error ?? "failed, no error recorded").slice(0, 120);
    patternCounts.set(key, (patternCounts.get(key) ?? 0) + 1);
  }

  const durations = deliveries.map((d) => d.durationMs).filter((n): n is number => typeof n === "number");
  const avgDuration = durations.length
    ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
    : null;

  const user = [
    `Endpoint: ${input.webhook.url}`,
    `Subscribed to: ${JSON.stringify(input.webhook.events)}`,
    `Active: ${input.webhook.isActive}`,
    `Created: ${String(input.webhook.createdAt)}`,
    ``,
    `Recent delivery attempts (most recent ${deliveries.length}, ${failures.length} failed, ${successes.length} succeeded):`,
    ...deliveries.map(
      (d, i) =>
        `  ${i + 1}. ${d.ok ? "OK" : "FAILED"} status=${d.statusCode ?? "—"} attempts=${d.attempts} ${
          d.durationMs === null ? "" : `duration=${d.durationMs}ms`
        }${d.error ? ` error="${String(d.error).slice(0, 160)}"` : ""}`,
    ),
    ``,
    `Distinct failure patterns: ${[...patternCounts.entries()]
      .map(([k, v]) => `${k} (${v}x)`)
      .join("; ")}`,
    avgDuration !== null ? `Mean response duration: ${avgDuration}ms` : "Mean response duration: not recorded",
    successes.length > 0
      ? `Note: the most recent attempts include ${successes.length} success(es), so the endpoint is intermittent rather than fully down.`
      : `Note: none of these attempts succeeded.`,
  ].join("\n");

  const result = await completeJson<{
    diagnosis?: string;
    fixes?: string[];
    blame?: string;
    evidence?: { pattern?: string; count?: number }[];
    confidence?: number;
  }>(SYSTEM, user, {
    model: input.model,
    temperature: 0,
    schemaHint:
      '{ "diagnosis": string, "fixes": string[], "blame": "customer_endpoint" | "abetapi" | "unclear", "evidence": [{ "pattern": string, "count": number }], "confidence": number }',
  });

  if (!result) return null;
  const diagnosis = typeof result.data.diagnosis === "string" ? result.data.diagnosis.trim() : "";
  if (!diagnosis) return null;

  const blame =
    result.data.blame === "customer_endpoint" || result.data.blame === "abetapi"
      ? result.data.blame
      : "unclear";

  return {
    diagnosis,
    fixes: Array.isArray(result.data.fixes)
      ? result.data.fixes.filter((f): f is string => typeof f === "string" && f.trim().length > 0)
      : [],
    blame,
    // Only accept evidence the model derived from patterns we actually sent.
    evidence: Array.isArray(result.data.evidence)
      ? result.data.evidence
          .filter(
            (e): e is { pattern: string; count: number } =>
              typeof e?.pattern === "string" && typeof e?.count === "number",
          )
          .map((e) => ({ pattern: e.pattern, count: e.count }))
      : [...patternCounts.entries()].map(([pattern, count]) => ({ pattern, count })),
    confidence:
      typeof result.data.confidence === "number" ? Math.max(0, Math.min(1, result.data.confidence)) : 0.5,
    usage: result.usage,
    model: result.model,
  };
}
