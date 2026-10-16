import Link from "next/link";
import { headers } from "next/headers";
import { prisma } from "@/lib/db";
import { DashboardShell } from "@/components/dashboard-shell";
import { resolveWorkspace } from "@/lib/resolve-workspace";
import { signOut } from "@/app/auth-actions";
import { switchWorkspaceAction } from "@/app/member-actions";
import { createFirstKey } from "@/app/key-actions";
import { createInboundSource, deleteInboundSource, toggleInboundSource } from "@/app/inbound-actions";
import { ApiKeyOnboarding } from "@/components/api-key-onboarding";
import { NucrmBridge } from "@/components/nucrm-bridge";
import { AiPanel, type AiField } from "@/components/ai-panel";

export const dynamic = "force-dynamic";

function Badge({ tone, children }: { tone: "green" | "blue" | "red" | "gray"; children: React.ReactNode }) {
  const tones: Record<string, string> = {
    green: "bg-green-100 text-green-800",
    blue: "bg-blue-100 text-blue-800",
    red: "bg-red-100 text-red-800",
    gray: "bg-gray-100 text-gray-600",
  };
  return (
    <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-semibold ${tones[tone]}`}>
      {children}
    </span>
  );
}

function Card({ label, value, sub }: { label: string; value: React.ReactNode; sub?: string }) {
  return (
    <div className="bg-white rounded-2xl shadow-sm p-5">
      <p className="text-xs font-medium uppercase tracking-wide text-gray-500">{label}</p>
      <p className="mt-1 text-2xl font-bold text-gray-900">{value}</p>
      {sub && <p className="mt-1 text-xs text-gray-500">{sub}</p>}
    </div>
  );
}

export default async function DashboardPage({ searchParams }: { searchParams: Promise<{ workspace?: string }> }) {
  const { workspace: requestedSlug } = await searchParams;
  // One policy, shared: the demo stays public, a customer's own workspace needs
  // their session, and naming anyone else's slug is refused rather than served.
  const resolved = await resolveWorkspace(requestedSlug);
  if (!resolved.workspace) {
    return (
      <main className="min-h-screen flex items-center justify-center p-8">
        <div className="max-w-sm text-center">
          <p className="text-gray-600">
            That workspace needs an account. Sign in to open yours.
          </p>
          <a
            href="/login"
            className="mt-4 inline-block rounded-lg bg-gray-900 px-5 py-2.5 text-sm font-semibold text-white hover:bg-gray-700"
          >
            Sign in
          </a>
        </div>
      </main>
    );
  }
  const workspace = resolved.workspace;
  const session = resolved.session;

  const webhookOptions = session ? await prisma.webhook.findMany({
    where: { workspaceId: workspace.id },
    orderBy: { createdAt: "desc" },
    take: 25,
    include: { _count: { select: { deliveries: true } } },
  }) : [];

  // The bar's workspace switcher needs the full list. Anonymous visitors get
  // none — the demo badge already says what they are looking at.
  const myWorkspaces = session
    ? await prisma.membership.findMany({
        where: { userId: session.userId },
        include: { workspace: { select: { id: true, name: true, slug: true } } },
        orderBy: { createdAt: "asc" },
      })
    : [];

  const liveKeyCount = session
    ? await prisma.apiKey.count({ where: { workspaceId: workspace.id, revokedAt: null } })
    : null;

  const [keys, webhooks, deliveries, calls, errors, inboundSources] = await Promise.all([
    prisma.apiKey.findMany({
      where: { workspaceId: workspace.id },
      select: { id: true, name: true, prefix: true, scopes: true, rateLimitPerMin: true, lastUsedAt: true, revokedAt: true },
      orderBy: { createdAt: "desc" },
    }),
    prisma.webhook.findMany({
      where: { workspaceId: workspace.id },
      include: { _count: { select: { deliveries: true } } },
      orderBy: { createdAt: "desc" },
    }),
    prisma.delivery.count({ where: { workspaceId: workspace.id } }),
    prisma.requestLog.count({ where: { workspaceId: workspace.id } }),
    prisma.requestLog.count({ where: { workspaceId: workspace.id, status: { gte: 400 } } }),
    prisma.inboundSource.findMany({
      where: { workspaceId: workspace.id },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  // The URL a person pastes into NuCRM has to be the one this deployment
  // serves, so it is built from the request's own host rather than a constant.
  const requestHeaders = await headers();
  const origin = `${requestHeaders.get("x-forwarded-proto") ?? "http"}://${requestHeaders.get("host") ?? "localhost:3700"}`;

  return (
    <DashboardShell
      product="AbetAPI"
      accent="text-teal-600"
      accentSoft="bg-teal-500"
      account={
        session
          ? {
              name: session.name,
              email: session.email,
              signOut,
              workspaces: myWorkspaces.map((m) => m.workspace),
              currentWorkspaceId: session.workspaceId,
              switchWorkspace: switchWorkspaceAction,
            }
          : null
      }
      workspace={workspace.name}
      title="Platform dashboard"
    >
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
          <Card label="API keys" value={keys.filter((k) => !k.revokedAt).length} sub={`${keys.length} total issued`} />
          <Card label="Webhooks" value={webhooks.filter((w) => w.isActive).length} sub={`${webhooks.length} subscriptions`} />
          <Card label="Deliveries" value={deliveries} />
          <Card
            label="API calls"
            value={calls.toLocaleString()}
            sub={calls > 0 ? `${((errors / calls) * 100).toFixed(1)}% errors` : "no traffic yet"}
          />
        </div>

        <div className="bg-white rounded-2xl shadow-sm p-6 mb-6">
          <h2 className="text-lg font-bold text-gray-900 mb-4">API keys</h2>
          {keys.length === 0 ? (
            <p className="text-sm text-gray-500">No keys yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-gray-500">
                    <th className="pb-2 pr-4 font-medium">Name</th>
                    <th className="pb-2 pr-4 font-medium">Prefix</th>
                    <th className="pb-2 pr-4 font-medium">Scopes</th>
                    <th className="pb-2 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {keys.map((k) => (
                    <tr key={k.id} className="border-t border-gray-100">
                      <td className="py-3 pr-4 font-medium text-gray-900">{k.name}</td>
                      <td className="py-3 pr-4 font-mono text-xs text-gray-600">{k.prefix}…</td>
                      <td className="py-3 pr-4 text-gray-600">{(k.scopes as unknown as string[]).join(", ")}</td>
                      <td className="py-3">
                        <Badge tone={k.revokedAt ? "red" : "green"}>{k.revokedAt ? "revoked" : "live"}</Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="bg-white rounded-2xl shadow-sm p-6">
          <h2 className="text-lg font-bold text-gray-900 mb-4">Webhooks</h2>
          {webhooks.length === 0 ? (
            <p className="text-sm text-gray-500">No subscriptions yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-gray-500">
                    <th className="pb-2 pr-4 font-medium">URL</th>
                    <th className="pb-2 pr-4 font-medium">Events</th>
                    <th className="pb-2 pr-4 font-medium">Status</th>
                    <th className="pb-2 font-medium">Deliveries</th>
                  </tr>
                </thead>
                <tbody>
                  {webhooks.map((w) => (
                    <tr key={w.id} className="border-t border-gray-100">
                      <td className="py-3 pr-4 font-mono text-xs text-gray-900 max-w-xs truncate">{w.url}</td>
                      <td className="py-3 pr-4 text-gray-600">{(w.events as unknown as string[]).join(", ") || "all"}</td>
                      <td className="py-3 pr-4">
                        <Badge tone={w.isActive ? "green" : "gray"}>{w.isActive ? "active" : "silent"}</Badge>
                      </td>
                      <td className="py-3 text-gray-600">{w._count.deliveries}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      {session && workspace.id === session.workspaceId && (
        // Management is scoped to the workspace the session actually holds:
        // opening the public demo while signed in must not offer a form whose
        // actions write into a different workspace than the list shows.
        <div className="mt-6">
          <NucrmBridge
            sources={inboundSources.map((s) => ({
              id: s.id,
              name: s.name,
              secretPrefix: s.secretPrefix,
              isActive: s.isActive,
              lastEventAt: s.lastEventAt?.toISOString() ?? null,
              lastEventName: s.lastEventName,
              receivedEvents: s.receivedEvents,
            }))}
            origin={origin}
            create={createInboundSource}
            toggle={toggleInboundSource}
            remove={deleteInboundSource}
          />
        </div>
      )}
      {session && (
        <div className="mt-6">
          <AiPanel
            config={{
              title: "Diagnose a failing webhook",
              blurb:
                "Reads recent delivery attempts and explains the failures. It may only cite status codes and errors from those records — it has never seen your server code — and it can conclude the fault is on your side.",
              endpoint: "/api/ai/diagnose-webhook",
              entityLabel: "Webhook",
              idField: "webhookId",
              buttonLabel: "Diagnose deliveries",
              emptyText: "No webhooks yet. Create one to see deliveries here.",
              options: webhookOptions.map((w) => ({
                id: w.id,
                label: `${w.url} — ${w._count.deliveries} deliver${w._count.deliveries === 1 ? "y" : "ies"}`,
              })),
            }}
            fields={[
              { path: "stats.total", title: "Deliveries in window" },
              { path: "stats.failed", title: "Failed" },
              { path: "diagnosis.diagnosis", title: "Likely cause" },
              { path: "diagnosis.blame", title: "Where the fault looks to be" },
              { path: "diagnosis.fixes", title: "Fixes, cheapest first", list: true },
            ] satisfies AiField[]}
          />
        </div>
      )}

      {session && liveKeyCount === 0 && (
        // Only for a signed-in workspace with no usable key: a stranger on the
        // public demo has no account to attach a key to, and prompting them
        // would be an invitation to sign up mid-demo.
        <div className="mt-6">
          <ApiKeyOnboarding createKey={createFirstKey} />
        </div>
      )}
      </DashboardShell>
  );
}
