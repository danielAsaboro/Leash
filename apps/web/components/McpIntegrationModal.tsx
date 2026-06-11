"use client";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { XIcon, PlusIcon, Trash2Icon, WandSparklesIcon } from "lucide-react";
import { fetchWithTimeout } from "../lib/http.ts";
import { IconButton } from "./IconButton.tsx";
import type { McpServerStatus } from "../lib/leash/mcp.ts";
import {
  validateServerInput,
  parseMcpJson,
  formatMcpJson,
  serverSignature,
  MCP_JSON_EXAMPLE,
  type McpServerInput,
  type McpTransport,
} from "../lib/leash/mcp-config.ts";

/**
 * "Create Custom Integration" modal — Manual + JSON paths over one validation core
 * (`mcp-config.ts`, shared with the server). Manual: name, transport, url|command, auth
 * headers / env. JSON: a lenient `{ "<name>": { type, url, headers } }` (or `{mcpServers}`)
 * blob with a LIVE parsed preview, Format button, and partial-success add. Adds POST to
 * `/api/leash/mcp` one entry at a time, then refreshes the panel.
 */

interface Pair {
  k: string;
  v: string;
}

const fieldStyle = { borderColor: "var(--color-rule-strong)", fontFamily: "var(--font-mono)", fontSize: "0.78rem" } as const;
const labelCls = "kicker";
const labelStyle = { color: "var(--color-muted)" } as const;

function PairRows({ rows, setRows, keyPlaceholder, valuePlaceholder }: { rows: Pair[]; setRows: (r: Pair[]) => void; keyPlaceholder: string; valuePlaceholder: string }) {
  return (
    <div className="flex flex-col gap-2">
      {rows.map((row, i) => (
        <div key={i} className="flex items-center gap-2">
          <input
            value={row.k}
            onChange={(e) => setRows(rows.map((r, j) => (j === i ? { ...r, k: e.target.value } : r)))}
            placeholder={keyPlaceholder}
            aria-label={keyPlaceholder}
            className="w-2/5 border bg-transparent px-3 py-2"
            style={fieldStyle}
          />
          <input
            value={row.v}
            onChange={(e) => setRows(rows.map((r, j) => (j === i ? { ...r, v: e.target.value } : r)))}
            placeholder={valuePlaceholder}
            aria-label={valuePlaceholder}
            type="password"
            className="min-w-0 flex-1 border bg-transparent px-3 py-2"
            style={fieldStyle}
          />
          {rows.length > 1 && (
            <IconButton title="Remove" danger onClick={() => setRows(rows.filter((_, j) => j !== i))}>
              <Trash2Icon size={14} />
            </IconButton>
          )}
        </div>
      ))}
      <button type="button" onClick={() => setRows([...rows, { k: "", v: "" }])} className="kicker self-start" style={{ color: "var(--color-sage-deep)" }}>
        <PlusIcon size={12} className="mb-0.5 mr-1 inline" />
        add
      </button>
    </div>
  );
}

function pairsToRecord(rows: Pair[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { k, v } of rows) if (k.trim() && v) out[k.trim()] = v;
  return out;
}

export function McpIntegrationModal({ existing, onClose }: { existing: McpServerStatus[]; onClose: () => void }) {
  const router = useRouter();
  const [tab, setTab] = useState<"manual" | "json">("manual");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Manual
  const [name, setName] = useState("");
  const [transport, setTransport] = useState<McpTransport>("http");
  const [url, setUrl] = useState("");
  const [command, setCommand] = useState("");
  const [argsText, setArgsText] = useState("");
  const [headers, setHeaders] = useState<Pair[]>([{ k: "", v: "" }]);
  const [envRows, setEnvRows] = useState<Pair[]>([{ k: "", v: "" }]);

  // JSON
  const [json, setJson] = useState("");
  const [jsonSummary, setJsonSummary] = useState<string | null>(null);

  const existingSigs = useMemo(() => new Set(existing.map((s) => serverSignature(s))), [existing]);

  const post = async (input: McpServerInput): Promise<{ ok: boolean; error?: string }> => {
    const res = await fetchWithTimeout("/api/leash/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
    if (res.ok) return { ok: true };
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    return { ok: false, error: body.error ?? `failed (${res.status})` };
  };

  const manualInput = (): McpServerInput =>
    transport === "stdio"
      ? { name, transport, command, args: argsText.split("\n").map((a) => a.trim()).filter(Boolean), env: pairsToRecord(envRows) }
      : { name, transport, url, headers: pairsToRecord(headers) };

  const submitManual = async () => {
    setError(null);
    try {
      validateServerInput(manualInput()); // instant inline feedback before the round-trip
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return;
    }
    setBusy(true);
    const r = await post(manualInput());
    setBusy(false);
    if (!r.ok) {
      setError(r.error ?? "failed");
      return;
    }
    router.refresh();
    onClose();
  };

  // Live JSON preview — parse on every keystroke; never throws to the render.
  const preview = useMemo(() => {
    if (!json.trim()) return null;
    try {
      const p = parseMcpJson(json);
      return { ...p, parseError: null as string | null };
    } catch (e) {
      return { ready: [], errors: [], parseError: e instanceof Error ? e.message : String(e) };
    }
  }, [json]);

  const canFormat = !!preview && !preview.parseError;

  const submitJson = async () => {
    setError(null);
    setJsonSummary(null);
    if (!preview || preview.parseError) {
      setError(preview?.parseError ?? "paste a JSON object of servers");
      return;
    }
    setBusy(true);
    let added = 0;
    let skipped = 0;
    const failed: string[] = [];
    for (const { key, server } of preview.ready) {
      if (existingSigs.has(serverSignature(server))) {
        skipped++;
        continue;
      }
      const r = await post(server);
      if (r.ok) added++;
      else failed.push(`${key}: ${r.error}`);
    }
    for (const e of preview.errors) failed.push(`${e.key}: ${e.error}`);
    setBusy(false);
    router.refresh();
    if (added > 0 && failed.length === 0) {
      onClose();
      return;
    }
    setJsonSummary(`Added ${added}${skipped ? ` · skipped ${skipped} (already configured)` : ""}${failed.length ? ` · ${failed.length} failed` : ""}`);
    if (failed.length) setError(failed.join("\n"));
  };

  return (
    <div role="dialog" aria-modal="true" aria-label="Create custom integration" className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-6" style={{ background: "rgba(20, 18, 14, 0.45)" }} onClick={onClose}>
      <div className="mt-10 w-full max-w-lg border shadow-lg" style={{ borderColor: "var(--color-rule-strong)", background: "var(--color-paper)" }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b px-5 py-4" style={{ borderColor: "var(--color-rule)" }}>
          <span style={{ fontFamily: "var(--font-body)", fontSize: "1.05rem" }}>Create Custom Integration</span>
          <IconButton title="Discard" onClick={onClose}>
            <XIcon size={16} />
          </IconButton>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 px-5 pt-4">
          {(["manual", "json"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => {
                setTab(t);
                setError(null);
              }}
              className="kicker flex-1 border px-3 py-2 transition-opacity"
              style={tab === t ? { background: "var(--color-sage-deep)", color: "var(--color-cream)", borderColor: "var(--color-sage-deep)" } : { borderColor: "var(--color-rule)", color: "var(--color-muted)" }}
            >
              {t === "json" ? "JSON" : "Manual"}
            </button>
          ))}
        </div>

        <div className="flex flex-col gap-4 px-5 py-4">
          {error && (
            <p className="kicker whitespace-pre-wrap" role="alert" style={{ color: "var(--color-brick)" }}>
              {error}
            </p>
          )}

          {tab === "manual" ? (
            <>
              <label className="flex flex-col gap-1">
                <span className={labelCls} style={labelStyle}>
                  Server Name
                </span>
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Tavily Search" className="border bg-transparent px-3 py-2" style={{ borderColor: "var(--color-rule)", fontFamily: "var(--font-body)", fontSize: "0.9rem" }} />
              </label>

              <div className="flex flex-col gap-1">
                <span className={labelCls} style={labelStyle}>
                  Server Type
                </span>
                <div className="flex gap-4">
                  {(["http", "sse", "stdio"] as const).map((t) => (
                    <label key={t} className="flex cursor-pointer items-center gap-1.5" style={{ fontFamily: "var(--font-mono)", fontSize: "0.8rem" }}>
                      <input type="radio" name="mcp-transport" checked={transport === t} onChange={() => setTransport(t)} />
                      {t === "http" ? "HTTP" : t === "sse" ? "SSE" : "Stdio"}
                    </label>
                  ))}
                </div>
              </div>

              {transport === "stdio" ? (
                <>
                  <label className="flex flex-col gap-1">
                    <span className={labelCls} style={labelStyle}>
                      Command
                    </span>
                    <input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npx" className="border bg-transparent px-3 py-2" style={fieldStyle} />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className={labelCls} style={labelStyle}>
                      Arguments <span style={{ color: "var(--color-faint)" }}>(one per line)</span>
                    </span>
                    <textarea value={argsText} onChange={(e) => setArgsText(e.target.value)} placeholder={"-y\n@modelcontextprotocol/server-filesystem\n/Users/me/notes"} rows={3} className="border bg-transparent px-3 py-2" style={fieldStyle} />
                  </label>
                  <div className="flex flex-col gap-1">
                    <span className={labelCls} style={labelStyle}>
                      Environment <span style={{ color: "var(--color-faint)" }}>(optional)</span>
                    </span>
                    <PairRows rows={envRows} setRows={setEnvRows} keyPlaceholder="API_KEY" valuePlaceholder="value" />
                  </div>
                </>
              ) : (
                <>
                  <label className="flex flex-col gap-1">
                    <span className={labelCls} style={labelStyle}>
                      Server URL
                    </span>
                    <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://api.example.com/mcp" className="border bg-transparent px-3 py-2" style={fieldStyle} />
                  </label>
                  <div className="flex flex-col gap-1">
                    <span className={labelCls} style={labelStyle}>
                      Authorization <span style={{ color: "var(--color-faint)" }}>(optional)</span>
                    </span>
                    <PairRows rows={headers} setRows={setHeaders} keyPlaceholder="Authorization" valuePlaceholder="Bearer YOUR_TOKEN" />
                  </div>
                </>
              )}
            </>
          ) : (
            <>
              <div className="flex flex-col gap-1">
                <span className={labelCls} style={labelStyle}>
                  Expected Format
                </span>
                <pre className="overflow-x-auto border p-3" style={{ borderColor: "var(--color-rule)", background: "var(--color-cream)", fontFamily: "var(--font-mono)", fontSize: "0.72rem", color: "var(--color-muted)", lineHeight: 1.5 }}>
                  {MCP_JSON_EXAMPLE}
                </pre>
              </div>
              <textarea value={json} onChange={(e) => setJson(e.target.value)} placeholder="Paste JSON here" rows={6} aria-label="MCP JSON config" className="border bg-transparent px-3 py-2" style={fieldStyle} />

              <div className="flex items-center justify-between gap-2">
                {/* Live parsed preview — honest about what will and won't import */}
                <div className="kicker min-w-0 flex-1 whitespace-pre-wrap">
                  {preview?.parseError ? (
                    <span style={{ color: "var(--color-brick)" }}>✗ {preview.parseError}</span>
                  ) : preview ? (
                    <span>
                      {preview.ready.map(({ key, server }) => {
                        const dupe = existingSigs.has(serverSignature(server));
                        return (
                          <span key={key} className="mr-2" style={{ color: dupe ? "var(--color-faint)" : "var(--color-sage-deep)" }}>
                            {dupe ? "⊘" : "✓"} {key} ({server.transport})
                          </span>
                        );
                      })}
                      {preview.errors.map((e) => (
                        <span key={e.key} className="mr-2" style={{ color: "var(--color-brick)" }}>
                          ✗ {e.key}: {e.error}
                        </span>
                      ))}
                    </span>
                  ) : null}
                </div>
                <button type="button" disabled={!canFormat} onClick={() => canFormat && setJson(formatMcpJson(json))} className="kicker flex shrink-0 items-center gap-1 border px-2 py-1.5 transition-opacity disabled:opacity-30" style={{ borderColor: "var(--color-rule)", color: "var(--color-muted)" }}>
                  <WandSparklesIcon size={13} />
                  Format JSON
                </button>
              </div>
              {jsonSummary && (
                <p className="kicker" style={{ color: "var(--color-muted)" }}>
                  {jsonSummary}
                </p>
              )}
            </>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t px-5 py-4" style={{ borderColor: "var(--color-rule)" }}>
          <button type="button" onClick={onClose} className="kicker border px-4 py-2 transition-opacity hover:opacity-80" style={{ borderColor: "var(--color-rule-strong)", color: "var(--color-muted)" }}>
            Discard
          </button>
          <button type="button" disabled={busy} onClick={() => void (tab === "manual" ? submitManual() : submitJson())} className="kicker px-4 py-2 transition-opacity hover:opacity-80 disabled:opacity-40" style={{ background: "var(--color-sage-deep)", color: "var(--color-cream)" }}>
            {busy ? "Adding…" : "Add Integration"}
          </button>
        </div>
      </div>
    </div>
  );
}
