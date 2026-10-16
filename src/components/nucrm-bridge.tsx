"use client";

import { useState } from "react";
import type { CreateInboundSourceResult } from "@/app/inbound-actions";

/**
 * The dashboard panel for the inbound half of the NuCRM bridge.
 *
 * It exists because the endpoint is not usable from a README alone: the person
 * wiring NuCRM up needs the URL, the secret, and the two headers in one place,
 * and the values are per-workspace. The secret is held in component state after
 * creation and never read back from the server — the row stores it, but the
 * show-once discipline is what teaches people to keep it, and a "reveal"
 * button would make it a value nobody treats as a credential.
 */

export interface InboundSourceView {
  id: string;
  name: string;
  secretPrefix: string;
  isActive: boolean;
  /** ISO, already serialized by the server component. */
  lastEventAt: string | null;
  lastEventName: string | null;
  receivedEvents: number;
}

interface Props {
  sources: InboundSourceView[];
  /** This deployment's origin, so the URL shown is the one to paste. */
  origin: string;
  create: (name: string) => Promise<CreateInboundSourceResult>;
  toggle: (id: string) => Promise<{ ok: boolean; error?: string }>;
  remove: (id: string) => Promise<{ ok: boolean; error?: string }>;
}

/** Deterministic to the minute and in UTC, so the server and the browser agree. */
function when(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

function Copy({ value, testId }: { value: string; testId?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard?.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className="shrink-0 rounded-md border border-gray-300 px-2 py-1 text-[11px] font-medium text-gray-700 hover:bg-gray-50"
      data-testid={testId}
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

export function NucrmBridge({ sources, origin, create, toggle, remove }: Props) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ id: string; name: string; secret: string } | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await create(name);
      if (result.ok && result.id && result.secret) {
        setCreated({ id: result.id, name: result.name ?? name, secret: result.secret });
        setAdding(false);
        setName("");
      } else {
        setError(result.error ?? "Could not create the source.");
      }
    } catch {
      setError("Could not reach the server. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function run(action: () => Promise<{ ok: boolean; error?: string }>) {
    setError(null);
    const result = await action();
    if (!result.ok) setError(result.error ?? "That did not work. Try again.");
  }

  const endpoint = (id: string) => `${origin}/api/v1/inbound/nucrm/${id}`;

  return (
    <div className="bg-white rounded-2xl shadow-sm p-6 mb-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-bold text-gray-900">Connect NuCRM</h2>
          <p className="mt-1 text-sm text-gray-600">
            NuCRM&apos;s integration webhooks post to a source below. Every verified event is republished to matching
            subscriptions above — same deliveries, retries and receipts as{" "}
            <code className="font-mono text-xs">POST /api/v1/events</code>.
          </p>
        </div>
        {!adding && !created && (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="shrink-0 rounded-md bg-gray-900 px-3 py-2 text-xs font-semibold text-white hover:bg-gray-700"
          >
            Add source
          </button>
        )}
      </div>

      {error && <p className="mt-3 text-sm text-red-700">{error}</p>}

      {adding && (
        <form onSubmit={submit} className="mt-4 flex items-center gap-2 rounded-xl border border-gray-200 bg-gray-50 p-3">
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Source name — e.g. NuCRM production"
            maxLength={200}
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900"
          />
          <button
            type="submit"
            disabled={busy || name.trim().length === 0}
            className="shrink-0 rounded-md bg-gray-900 px-3 py-2 text-xs font-semibold text-white hover:bg-gray-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy ? "Creating…" : "Create"}
          </button>
          <button
            type="button"
            onClick={() => {
              setAdding(false);
              setError(null);
            }}
            className="shrink-0 rounded-md border border-gray-300 px-3 py-2 text-xs font-medium text-gray-700 hover:bg-white"
          >
            Cancel
          </button>
        </form>
      )}

      {created && (
        <div className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 p-4">
          <h3 className="text-sm font-semibold text-emerald-900">Point NuCRM at “{created.name}”</h3>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-[13px] text-emerald-900">
            <li>
              In NuCRM, create a webhook integration with this URL:
              <div className="mt-1 flex items-center gap-2">
                <code
                  className="overflow-x-auto whitespace-nowrap rounded-md border border-emerald-300 bg-white px-2 py-1 font-mono text-[12px] text-gray-900"
                  data-testid="inbound-endpoint"
                >
                  {endpoint(created.id)}
                </code>
                <Copy value={endpoint(created.id)} />
              </div>
            </li>
            <li>
              Add the custom header{" "}
              <code className="font-mono text-[12px]">Authorization: Bearer &lt;your AbetAPI key&gt;</code> — the key
              needs the <code className="font-mono text-[12px]">events:write</code> scope.
            </li>
            <li>
              Set the webhook&apos;s signing secret to this value — it is shown once, and losing it means migrating to
              a new source:
              <div className="mt-1 flex items-center gap-2">
                <code
                  className="overflow-x-auto whitespace-nowrap rounded-md border border-emerald-300 bg-white px-2 py-1 font-mono text-[12px] text-gray-900"
                  data-testid="inbound-secret"
                >
                  {created.secret}
                </code>
                <Copy value={created.secret} />
              </div>
            </li>
            <li>Subscribe the webhook to the events you want forwarded, then send a test — it lands here in seconds.</li>
          </ol>
          <button
            type="button"
            onClick={() => setCreated(null)}
            className="mt-3 rounded-md bg-emerald-700 px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-emerald-800"
          >
            Done — I saved the secret
          </button>
        </div>
      )}

      {sources.length === 0 && !adding && !created ? (
        <p className="mt-4 text-sm text-gray-500">
          No inbound sources yet. Add one, then paste its URL and secret into a NuCRM webhook integration.
        </p>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-gray-500">
                <th className="pb-2 pr-4 font-medium">Source</th>
                <th className="pb-2 pr-4 font-medium">Endpoint</th>
                <th className="pb-2 pr-4 font-medium">Status</th>
                <th className="pb-2 pr-4 font-medium">Last event</th>
                <th className="pb-2 font-medium" />
              </tr>
            </thead>
            <tbody>
              {sources.map((s) => (
                <tr key={s.id} className="border-t border-gray-100">
                  <td className="py-3 pr-4">
                    <p className="font-medium text-gray-900">{s.name}</p>
                    <p className="font-mono text-[11px] text-gray-500">{s.secretPrefix}…</p>
                  </td>
                  <td className="py-3 pr-4">
                    <div className="flex items-center gap-2">
                      <span className="max-w-xs truncate font-mono text-xs text-gray-600">{endpoint(s.id)}</span>
                      <Copy value={endpoint(s.id)} />
                    </div>
                  </td>
                  <td className="py-3 pr-4">
                    <span
                      className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                        s.isActive ? "bg-green-100 text-green-800" : "bg-gray-100 text-gray-600"
                      }`}
                    >
                      {s.isActive ? "listening" : "paused"}
                    </span>
                  </td>
                  <td className="py-3 pr-4 text-gray-600">
                    {s.lastEventAt ? (
                      <>
                        <span className="font-mono text-xs">{s.lastEventName}</span>
                        <span className="block text-[11px] text-gray-500">
                          {when(s.lastEventAt)} · {s.receivedEvents} received
                        </span>
                      </>
                    ) : (
                      <span className="text-xs text-gray-400">nothing yet</span>
                    )}
                  </td>
                  <td className="py-3">
                    <div className="flex items-center justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => run(() => toggle(s.id))}
                        className="rounded-md border border-gray-300 px-2 py-1 text-[11px] font-medium text-gray-700 hover:bg-gray-50"
                      >
                        {s.isActive ? "Pause" : "Resume"}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          if (window.confirm(`Delete “${s.name}”? NuCRM deliveries to its URL will be refused.`)) {
                            void run(() => remove(s.id));
                          }
                        }}
                        className="rounded-md border border-red-200 px-2 py-1 text-[11px] font-medium text-red-700 hover:bg-red-50"
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
