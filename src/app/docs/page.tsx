import type { Metadata } from "next";
import { SiteNav, SiteFooter } from "@/components/site";

export const metadata: Metadata = {
  title: "API docs — AbetAPI",
  description: "AbetAPI quickstart: keys, rate limits, versioning, and webhook verification.",
};

export default function Page() {
  return (
    <div className="min-h-screen bg-white text-gray-900">
      <SiteNav />
      <main className="mx-auto max-w-4xl px-6 py-12">
        <h1 className="text-3xl font-bold tracking-tight">API docs</h1>
        <p className="mt-2 text-gray-600">The full machine contract lives at <a className="underline" href="/api/v1/openapi">/api/v1/openapi</a> (generated from code, no key). This page is the human version.</p>
        <h2 className="mt-10 text-xl font-bold">Quickstart</h2>
        <ol className="mt-3 list-decimal space-y-2 pl-6 text-gray-600">
          <li>Mint a key: <code>POST /api/keys</code> with <code>scopes</code> — copy the plaintext once, it is never shown again.</li>
          <li>Send it as <code>Authorization: Bearer ab_live_…</code> on every request.</li>
          <li>Check yourself: <code>GET /api/v1/whoami</code> returns your identity and live quota.</li>
        </ol>
        <h2 className="mt-10 text-xl font-bold">Rate limits</h2>
        <p className="mt-3 text-gray-600">600 requests/min default, 60/min floor on sub-keys, unlimited only for root keys. Exhaustion answers <code>429</code> with <code>retry-after</code> and IETF <code>ratelimit</code> / <code>ratelimit-policy</code> headers. Back off — never retry-storm.</p>
        <h2 className="mt-10 text-xl font-bold">Versioning</h2>
        <p className="mt-3 text-gray-600">Stable endpoints live under <code>/api/v1</code>. Breaking changes get a new version prefix and 30 days' notice in the changelog — v1 keeps working. Additive fields are not breaking and ship without a version bump.</p>
        <h2 className="mt-10 text-xl font-bold">Verifying webhooks</h2>
        <p className="mt-3 text-gray-600">Each delivery signs <code>timestamp.body</code> with HMAC-SHA256 keyed by the hash of your secret. Receivers hold the plaintext, hash it first, and compare:</p>
        <pre className="mt-3 overflow-x-auto rounded-xl bg-gray-900 p-4 text-sm text-gray-100"><code>{`const [t, body] = [req.headers["x-abetapi-timestamp"], await req.text()];
const expected = hmacSha256(sha256Hex(YOUR_SECRET), t + "." + body);
if (expected !== req.headers["x-abetapi-signature"]) throw 401;`}</code></pre>
        <h2 className="mt-10 text-xl font-bold">Errors</h2>
        <p className="mt-3 text-gray-600"><code>400</code> bytes that are not a JSON object · <code>401</code> missing/unknown key · <code>403</code> key lacks the scope · <code>404</code> no such object · <code>422</code> valid JSON, invalid field — every problem named at once in <code>error.fields</code>, keyed by the name you sent (<code>events[3]</code> for a list element) · <code>429</code> quota spent. Nothing is coerced: a field you sent wrong is refused, never stored as something else. Every error body names the problem in plain language.</p>
      </main>
      <SiteFooter />
    </div>
  );
}
