"use client";
/**
 * Settings → Storage (right). User-content data categories with per-category clear, via the
 * allow-listed data/clear route. Clearing never touches device identity, the mesh, the economy
 * ledger, or secrets. Every clear confirms first.
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

export function AppDataCard({ data }: { data: StorageUsage["data"] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const clear = async (category: string, label: string, bytes: number) => {
    if (!window.confirm(`Clear ${label} (${fmt(bytes)})? This permanently deletes it from this device.`)) return;
    setBusy(true);
    try {
      await fetchWithTimeout("/api/leash/data/clear", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ category }) });
      router.refresh();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div>
      <span className="kicker kicker-sage">App data</span>
      {data.map((d) => (
        <div key={d.category} className="flex items-center gap-2 border-b py-1" style={{ borderColor: "var(--color-rule)" }}>
          <span className="kicker" style={{ flex: 1 }}>{d.label}</span>
          <span className="mono kicker" style={{ color: "var(--color-faint)" }}>{fmt(d.bytes)}</span>
          <button
            type="button"
            disabled={busy || d.bytes === 0}
            onClick={() => void clear(d.category, d.label, d.bytes)}
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
  );
}
