import type { Metadata } from "next";
import { SiteNav, SiteFooter } from "@/components/site";

export const metadata: Metadata = {
  title: "Changelog — AbetAPI",
  description: "What changed in AbetAPI, newest first.",
};

export default function Page() {
  return (
    <div className="min-h-screen bg-white text-gray-900">
      <SiteNav />
      <main className="mx-auto max-w-4xl px-6 py-12">
        <h1 className="text-3xl font-bold tracking-tight">Changelog</h1>
        <p className="mt-2 text-gray-600">Newest first. Breaking changes are marked <strong>BREAKING</strong> and get 30 days&apos; notice here before they ship.</p>
        <div className="mt-8 space-y-8 border-l-2 border-blue-600 pl-6">
          <div>
            <p className="text-sm text-gray-600">October 2026</p>
            <h2 className="text-lg font-bold">v1.3.0 — The suite&rsquo;s companions link to their own sign-ups</h2>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-gray-600">
              <li>On this page&rsquo;s suite section, AbetAgent, LeadGenius and LeadWorks now link to their own products&rsquo; homes instead of a letter to support — a buyer who wants that product can start there. The one-contract offer stays one click away as a mailto.</li>
            </ul>
          </div>
          <div>
            <p className="text-sm text-gray-600">October 2026</p>
            <h2 className="text-lg font-bold">v1.2.0 — Take the gateway with you</h2>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-gray-600">
              <li>Owners and admins can download a workspace JSON with API keys, webhook destinations, inbound sources, SSO connections and team.</li>
              <li>Delivery and usage audits download as streamed CSV: one row per delivery attempt with its payload and attempt log, and one row per API call with method, path, status and latency. API key hashes, webhook secret hashes, inbound source secrets, SSO client secrets and invitation tokens are never included.</li>
            </ul>
          </div>
          <div>
            <p className="text-sm text-gray-600">October 2026</p>
            <h2 className="text-lg font-bold">v1.1.0 — The NuCRM bridge: signed inbound events</h2>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-gray-600">
              <li>New endpoint: <code>POST /api/v1/inbound/nucrm/&#123;id&#125;</code>. Point a NuCRM integration webhook at it and every verified event is republished to your matching subscriptions — one Delivery per subscriber, with the same retries, logs and receipts as <code>POST /api/v1/events</code>. The receiver verifies <code>x-nucrm-signature</code> (HMAC-SHA256 over the raw body, <code>sha256=</code> prefix optional) against the source&apos;s secret before anything fans out, and <code>x-nucrm-delivery</code> answers a repeat of NuCRM&apos;s own retry with <code>duplicate: true</code> instead of publishing twice.</li>
              <li>Authentication is deliberately two credentials that answer different questions: your workspace key (scope <code>events:write</code>) carries the quota, the audit trail and the revocation, and the source&apos;s secret proves the body is NuCRM&apos;s. NuCRM&apos;s integration config sends custom headers, so both travel in one configured webhook.</li>
              <li>The dashboard has a <strong>Connect NuCRM</strong> panel: create a source, copy its URL and secret (shown once), pause it, delete it, and see the last accepted event per source.</li>
              <li>Additive only: no existing request behaves differently, and both new <code>200</code>/<code>202</code>/<code>409</code> answers are documented in <code>/api/v1/openapi</code>, which is a minor release by the rule below — no 30 days&apos; notice needed because nothing existing changed.</li>
            </ul>
          </div>
          <div>
            <p className="text-sm text-gray-600">October 2026</p>
            <h2 className="text-lg font-bold">v1.0.2 — The contract now says what the gateway answers</h2>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-gray-600">
              <li>Every endpoint that requires a write scope can answer <code>403</code> to a key that holds an unrelated one — <code>requireKey</code> has always returned it, and since the last release it is written to the request log. But <code>/api/v1/openapi</code> listed that <code>403</code> on only three of the ten scoped operations; a client coding strictly against the document would have treated it as undeclared. All ten list it now. The read endpoints, which ask no scope and so cannot be refused for scope, still list no <code>403</code> — that is correct, and a new test fails if the document and the code&apos;s real scope checks ever drift apart again.</li>
              <li>No request&apos;s outcome changed; this is the document catching up to the gateway, not a contract change. It also fixes the version: <code>info.version</code> and the package version were each hand-typed and had fallen behind the release announced here. <code>/api/v1/openapi</code> now reads its version from <code>package.json</code>, so the machine-readable contract and the package are the same number by construction, and a test fails if the package, the document and this changelog ever name three different versions again.</li>
            </ul>
          </div>
          <div>
            <p className="text-sm text-gray-600">October 2026</p>
            <h2 className="text-lg font-bold">v1.0.1 — Every write endpoint checks its input</h2>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-gray-600">
              <li>Each write endpoint now validates the body field by field against a declared table before anything reaches the database. A wrong type or an unknown list member answers <code>422</code> naming every field at once, in <code>error.fields</code> (<code>scopes[1]</code> for an element of a list); bytes that are not a JSON object answer <code>400</code>.</li>
              <li>Before this, a request that <em>succeeded</em> could store something the request never said — <code>isActive: "no"</code> switched a subscription <strong>on</strong>, <code>url: ["https://…"]</code> became an address, <code>rateLimitPerMin: "1000"</code> took the default, and 19 requests answered <code>500</code>. None of those behaviours was documented: <code>/api/v1/openapi</code> already said <code>boolean</code>, <code>string</code> and <code>integer</code>, so a client sending what the document describes is unaffected. This is a bug fix, not a contract change — and <code>/api/v1/openapi</code> now also lists the <code>400</code>s and <code>422</code>s and documents <code>POST /api/ai/diagnose-webhook</code>, which was missing.</li>
              <li>Omitting <code>scopes</code> on <code>POST /api/keys</code> mints a key with the scopes of the key that minted it, instead of <code>*</code>. The request is still accepted and the response still echoes the list, so nothing documented is refused; what stops working is a sub-key handing out every scope by naming none. Its sibling is refused on purpose: a <code>scopes</code> list naming something the calling key does not hold — <code>["*"]</code> from a <code>keys:write</code> key — is now <code>403</code>, on <code>POST</code> and on the <code>PATCH</code> that re-scopes, because re-scoping is granting. That one request was answered <code>201</code> until today, so it is a change for anyone who relied on it; it is the escalation this release exists to close, and <code>/api/v1/openapi</code> never described it, so it ships as a security fix rather than waiting out the 30 days a documented contract change would get.</li>
              <li>An empty <code>PATCH</code> is refused rather than answered <code>200</code> with the row untouched, and renaming an SSO connection onto a name this workspace already holds answers <code>409</code> instead of <code>500</code>.</li>
            </ul>
          </div>
          <div>
            <p className="text-sm text-gray-600">September 2026</p>
            <h2 className="text-lg font-bold">v1.0.0 — Initial public release</h2>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-gray-600">
              <li>General availability: Scoped API keys, HMAC-signed webhooks, per-key usage metering, and SSO — one contract, one audit trail, 22 operations.</li>
              <li>Public pricing, terms, privacy, and support pages.</li>
              <li>Live demo workspace, no card required.</li>
            </ul>
          </div>
        </div>
        <p className="mt-8 text-gray-600">How we version: <code>major.minor.patch</code>. Minor adds features, patch fixes bugs, major is reserved for contract changes — and those are announced here first.</p>
      </main>
      <SiteFooter />
    </div>
  );
}
