import type { Metadata } from "next";
import Link from "next/link";
import { SiteNav, SiteFooter } from "@/components/site";
import { VERSION } from "@/lib/version";

export const metadata: Metadata = {
  title: "AbetAPI — The platform underneath the platform.",
  description: "Scoped API keys, HMAC-signed webhooks, per-key usage metering, and SSO — one contract, one audit trail, 22 operations.",
};

export default function Home() {
  return (
    <div className="min-h-screen bg-white text-gray-900">
      <SiteNav />
      <main>
        <section className="mx-auto max-w-4xl px-6 pb-16 pt-20 text-center">
          <p className="inline-block rounded-full bg-blue-50 text-blue-700 px-3 py-1 text-xs font-semibold uppercase tracking-wide">
            v{VERSION} · Now generally available
          </p>
          <h1 className="mt-6 text-5xl font-bold tracking-tight">AbetAPI</h1>
          <p className="mx-auto mt-4 max-w-2xl text-xl text-gray-600">The platform underneath the platform.</p>
          <p className="mx-auto mt-3 max-w-2xl text-gray-600">Scoped API keys, HMAC-signed webhooks, per-key usage metering, and SSO — one contract, one audit trail, 22 operations.</p>
          <div className="mt-8 flex justify-center gap-4">
            <a href="/dashboard?workspace=demo" className="rounded-lg bg-blue-600 px-6 py-3 font-semibold text-white hover:bg-blue-700 transition">
              Open live demo
            </a>
            <Link href="/pricing" className="rounded-lg border border-gray-300 hover:bg-gray-50 px-6 py-3 font-semibold transition">
              Pricing · $0 included with the Abetworks suite
            </Link>
          </div>
        </section>
        <section id="features" className="mx-auto max-w-6xl px-6 py-12">
          <h2 className="text-center text-2xl font-bold">Why teams pick AbetAPI</h2>
          <div className="mt-8 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          <div className="rounded-2xl border p-6 border-gray-200 bg-white shadow-sm">
            <h3 className="font-bold text-gray-900">Keys with least privilege</h3>
            <p className="mt-2 text-sm text-gray-600">ab_live_… keys carry explicit scopes. Plaintext shown once, only its sha256 stored.</p>
          </div>
          <div className="rounded-2xl border p-6 border-gray-200 bg-white shadow-sm">
            <h3 className="font-bold text-gray-900">Quotas that contain blasts</h3>
            <p className="mt-2 text-sm text-gray-600">Per-key per-minute limits (default 600, floor 60). A compromised sub-key cannot promote itself.</p>
          </div>
          <div className="rounded-2xl border p-6 border-gray-200 bg-white shadow-sm">
            <h3 className="font-bold text-gray-900">Webhooks with receipts</h3>
            <p className="mt-2 text-sm text-gray-600">HMAC-SHA256 over timestamp plus body, 3 retries with backoff, successes logged too.</p>
          </div>
          <div className="rounded-2xl border p-6 border-gray-200 bg-white shadow-sm">
            <h3 className="font-bold text-gray-900">Rate limits, RFC-style</h3>
            <p className="mt-2 text-sm text-gray-600">Exhaustion answers 429 with retry-after plus IETF ratelimit headers — no guessing.</p>
          </div>
          <div className="rounded-2xl border p-6 border-gray-200 bg-white shadow-sm">
            <h3 className="font-bold text-gray-900">SSO without the enterprise call</h3>
            <p className="mt-2 text-sm text-gray-600">Wire identity providers per workspace from the dashboard.</p>
          </div>
          <div className="rounded-2xl border p-6 border-gray-200 bg-white shadow-sm">
            <h3 className="font-bold text-gray-900">OpenAPI 3.1, always current</h3>
            <p className="mt-2 text-sm text-gray-600">The contract is generated from the code at /api/v1/openapi — docs cannot drift.</p>
          </div>
          </div>
        </section>
        <section className="border-y border-gray-200 bg-gray-50">
          <div className="mx-auto max-w-4xl space-y-6 px-6 py-12">
            <h2 className="text-2xl font-bold">Live in three steps</h2>
          <div className="flex gap-4">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-blue-600 text-sm font-bold text-white">1</span>
            <div><p className="font-bold text-gray-900">Mint a key</p><p className="mt-1 text-sm text-gray-600">The demo workspace has a key ready. Scope it to exactly what your app needs.</p></div>
          </div>
          <div className="flex gap-4">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-blue-600 text-sm font-bold text-white">2</span>
            <div><p className="font-bold text-gray-900">Publish an event</p><p className="mt-1 text-sm text-gray-600">POST /api/v1/events and watch fan-out, signing, and delivery receipts.</p></div>
          </div>
          <div className="flex gap-4">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-blue-600 text-sm font-bold text-white">3</span>
            <div><p className="font-bold text-gray-900">Verify a webhook</p><p className="mt-1 text-sm text-gray-600">Hash your plaintext secret with sha256, check the HMAC. Three lines, in the docs.</p></div>
          </div>
          </div>
        </section>
        <section className="mx-auto max-w-4xl px-6 py-12">
          <h2 className="text-2xl font-bold">Questions, answered</h2>
          <div className="mt-6 space-y-4">
          <div><p className="font-semibold text-gray-900">Is there a trial?</p><p className="mt-1 text-gray-600">It is included — mint a demo key and publish your first event in minutes.</p></div>
          <div><p className="font-semibold text-gray-900">I lost my key plaintext. Can you recover it?</p><p className="mt-1 text-gray-600">No — and that is the point. Only hashes are stored. Mint a new key and revoke the old one.</p></div>
          <div><p className="font-semibold text-gray-900">How do I verify webhooks?</p><p className="mt-1 text-gray-600">Hash your secret (sha256), recompute HMAC-SHA256 over timestamp.body, compare. Full snippet in /docs.</p></div>
          <div><p className="font-semibold text-gray-900">What are the rate limits?</p><p className="mt-1 text-gray-600">600/min default, 60/min floor on sub-keys, unlimited only for root keys. 429s carry retry-after.</p></div>
          </div>
        </section>
        <section className="mx-auto max-w-4xl px-6 pb-16 text-center">
          <h2 className="text-2xl font-bold">Try the live demo — no card, no call.</h2>
          <div className="mt-6 flex justify-center gap-4">
            <a href="/dashboard?workspace=demo" className="rounded-lg bg-blue-600 px-6 py-3 font-semibold text-white hover:bg-blue-700 transition">
              Open live demo
            </a>
            <Link href="/pricing" className="rounded-lg border border-gray-300 hover:bg-gray-50 px-6 py-3 font-semibold transition">
              See pricing
            </Link>
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
