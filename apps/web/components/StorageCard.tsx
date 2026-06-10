"use client";
/**
 * Settings → Storage. Shows the model cache (per file, with delete) and user-content data
 * categories (with clear). Deletes go through the guarded models/file route; clears go through
 * the allow-listed data/clear route. Every destructive action confirms first.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { fetchWithTimeout } from "../lib/http.ts";
import type { StorageUsage } from "../lib/leash/storage.ts";

function fmt(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(bytes >= 1e10 ? 0 : 1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  if (bytes >= 1e3) return `${Math.round(bytes / 1e3)} KB`;
  return `${bytes} B`;
}

export function StorageCard({ usage }: { usage: StorageUsage }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  const act = async (fn: () => Promise<Response>, confirmMsg: string) => {
    if (!window.confirm(confirmMsg)) return;
    setBusy(true);
    try {
      await fn();
      router.refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <div>
        <div className="mb-1 flex items-baseline justify-between">
          <span className="kicker kicker-sage">Model cache</span>
          <span className="mono kicker">{fmt(usage.modelBytes)}</span>
        </div>
        {usage.modelFiles.length === 0 && <span className="kicker" style={{ color: "var(--color-faint)" }}>no cached models</span>}
        {usage.modelFiles.map((m) => (
          <div key={m.file} className="flex items-center gap-2 border-b py-1" style={{ borderColor: "var(--color-rule)" }}>
            <span className="mono kicker truncate" style={{ flex: 1, minWidth: 0 }} title={m.file}>{m.file}</span>
            <span className="mono kicker" style={{ color: "var(--color-faint)" }}>{fmt(m.bytes)}</span>
            <button
              type="button"
              disabled={busy}
              onClick={() => void act(() => fetchWithTimeout(`/api/leash/models/file/${encodeURIComponent(m.file)}?force=1`, { method: "DELETE" }), `Delete ${m.file} (${fmt(m.bytes)})? If it backs a configured model, the next serve restart re-downloads it.`)}
              className="kicker border px-2 py-0.5 transition-opacity hover:opacity-70 disabled:opacity-40"
              style={{ borderColor: "var(--color-brick)", color: "var(--color-brick)" }}
            >
              delete
            </button>
          </div>
        ))}
      </div>

      <div>
        <span className="kicker kicker-sage">App data</span>
        {usage.data.map((d) => (
          <div key={d.category} className="flex items-center gap-2 border-b py-1" style={{ borderColor: "var(--color-rule)" }}>
            <span className="kicker" style={{ flex: 1 }}>{d.label}</span>
            <span className="mono kicker" style={{ color: "var(--color-faint)" }}>{fmt(d.bytes)}</span>
            <button
              type="button"
              disabled={busy || d.bytes === 0}
              onClick={() => void act(() => fetchWithTimeout("/api/leash/data/clear", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ category: d.category }) }), `Clear ${d.label} (${fmt(d.bytes)})? This permanently deletes it from this device.`)}
              className="kicker border px-2 py-0.5 transition-opacity hover:opacity-70 disabled:opacity-40"
              style={{ borderColor: "var(--color-ink)" }}
            >
              clear
            </button>
          </div>
        ))}
        <p className="kicker" style={{ color: "var(--color-faint)", marginTop: "0.5rem" }}>
          Clearing never touches device identity, the mesh, the economy ledger, or secrets.
        </p>
      </div>
    </div>
  );
}
