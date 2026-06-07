"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { fetchWithTimeout } from "../lib/http.ts";
import type { McpServerStatus } from "../lib/leash/mcp.ts";

/**
 * MCP servers (client) — list configured servers with live connection status + tool
 * names, add new ones, toggle/remove stored rows. Env-seeded rows (LEASH_MCP_SERVERS)
 * are read-only. Tools from connected servers appear in Brain → Tools and in chat.
 */

export function McpPanel({ servers }: { servers: McpServerStatus[] }) {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [transport, setTransport] = useState<"http" | "sse">("http");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const call = async (fn: () => Promise<Response>) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fn();
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? `Request failed (${res.status}).`);
        return false;
      }
      router.refresh();
      return true;
    } catch {
      setError("Request failed — is the app still running?");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const add = async () => {
    if (!url.trim()) return;
    const ok = await call(() =>
      fetchWithTimeout("/api/leash/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: url.trim(), ...(name.trim() ? { name: name.trim() } : {}), transport }),
      }),
    );
    if (ok) {
      setUrl("");
      setName("");
    }
  };

  const toggle = (s: McpServerStatus) =>
    void call(() => fetchWithTimeout(`/api/leash/mcp/${encodeURIComponent(s.id)}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: !s.enabled }) }));

  const remove = (s: McpServerStatus) => {
    if (!confirm(`Remove the MCP server "${s.name}"?`)) return;
    void call(() => fetchWithTimeout(`/api/leash/mcp/${encodeURIComponent(s.id)}`, { method: "DELETE" }));
  };

  return (
    <div className="flex flex-col gap-4">
      {error && (
        <p className="kicker" style={{ color: "var(--color-brick)" }} role="alert">
          {error}
        </p>
      )}

      <section className="border p-4" style={{ borderColor: "var(--color-rule-strong)", background: "var(--color-paper)" }}>
        <span className="kicker kicker-sage">Add an MCP server</span>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="http://127.0.0.1:11439/mcp"
            aria-label="MCP server URL"
            className="min-w-[18rem] flex-1 border bg-transparent px-3 py-2"
            style={{ borderColor: "var(--color-rule-strong)", fontFamily: "var(--font-mono)", fontSize: "0.78rem" }}
          />
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="name (optional)"
            aria-label="MCP server name"
            className="w-40 border bg-transparent px-3 py-2"
            style={{ borderColor: "var(--color-rule)", fontFamily: "var(--font-body)", fontSize: "0.85rem" }}
          />
          <select value={transport} onChange={(e) => setTransport(e.target.value === "sse" ? "sse" : "http")} aria-label="Transport" className="border bg-transparent px-2 py-2" style={{ borderColor: "var(--color-rule)", fontFamily: "var(--font-mono)", fontSize: "0.78rem" }}>
            <option value="http">http</option>
            <option value="sse">sse</option>
          </select>
          <button type="button" disabled={busy || !url.trim()} onClick={() => void add()} className="kicker px-3 py-2 transition-opacity hover:opacity-80 disabled:opacity-40" style={{ background: "var(--color-sage-deep)", color: "var(--color-cream)" }}>
            Add
          </button>
        </div>
        <p className="kicker mt-2" style={{ color: "var(--color-faint)" }}>
          Tip: start the “MCP (Mesh Tools)” service on the Services page, then add http://127.0.0.1:11439/mcp here to chat-drive mesh pairing.
        </p>
      </section>

      {servers.length === 0 ? (
        <p className="kicker py-6 text-center" style={{ color: "var(--color-faint)" }}>
          No MCP servers configured — the assistant has only its built-in tools.
        </p>
      ) : (
        <ul>
          {servers.map((s) => (
            <li key={s.id} className="flex flex-wrap items-start gap-3 border-b py-3" style={{ borderColor: "var(--color-rule)", opacity: s.enabled ? 1 : 0.55 }}>
              <input type="checkbox" className="mt-1" checked={s.enabled} onChange={() => toggle(s)} disabled={busy || s.fromEnv} aria-label={`Enable ${s.name}`} title={s.fromEnv ? "From LEASH_MCP_SERVERS — read-only" : undefined} />
              <div className="min-w-0 flex-1">
                <p style={{ fontFamily: "var(--font-body)", fontSize: "1rem" }}>
                  {s.name}
                  <span className="kicker ml-2" style={{ color: s.connected ? "var(--color-sage-deep)" : "var(--color-faint)" }}>
                    {s.connected ? "● connected" : s.enabled ? "○ not connected" : "○ disabled"}
                  </span>
                  {s.fromEnv && (
                    <span className="kicker ml-2" style={{ color: "var(--color-faint)" }}>
                      env
                    </span>
                  )}
                </p>
                <p style={{ color: "var(--color-muted)", fontSize: "0.82rem", fontFamily: "var(--font-mono)" }}>{s.url}</p>
                {s.connected && s.toolNames.length > 0 && (
                  <p style={{ color: "var(--color-muted)", fontSize: "0.85rem", fontFamily: "var(--font-body)" }}>tools: {s.toolNames.join(", ")}</p>
                )}
                {s.error && (
                  <p className="kicker" style={{ color: "var(--color-brick)" }}>
                    {s.error}
                  </p>
                )}
              </div>
              {!s.fromEnv && (
                <button type="button" onClick={() => remove(s)} disabled={busy} title="Remove server" aria-label={`Remove ${s.name}`} className="px-2 transition-opacity hover:opacity-60" style={{ color: "var(--color-faint)" }}>
                  ×
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
