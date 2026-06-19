"use client";
/**
 * Settings → Storage (right). User-content data categories with per-category clear, via the
 * allow-listed data/clear route. Clearing never touches device identity, the mesh, the economy
 * ledger, or secrets. Every clear confirms first.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { fetchWithTimeout } from "../lib/http.ts";
import { activateAndGo } from "../lib/auth-handshake.ts";
import { appAlert, appConfirm } from "../lib/prompt.ts";
import { toast } from "./Toast.tsx";
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
    if (!(await appConfirm(`Clear ${label} (${fmt(bytes)})? This permanently deletes it from this device.`, { confirmLabel: "Clear", destructive: true }))) return;
    setBusy(true);
    try {
      const res = await fetchWithTimeout("/api/leash/data/clear", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ category }) });
      if (!res.ok) {
        toast.error(`Clear failed (${res.status})`);
        return;
      }
      toast.success(`${label} cleared`);
      router.refresh();
    } catch {
      toast.error("Clear failed");
    } finally {
      setBusy(false);
    }
  };

  const factoryReset = async () => {
    if (!(await appConfirm("FACTORY RESET? Permanently deletes EVERY account, all data and all downloaded models on this device, returning the app to first-run setup.", { confirmLabel: "Factory reset", destructive: true }))) return;
    if (!(await appConfirm("This wipes everything for every user. Are you absolutely sure?", { confirmLabel: "Wipe everything", destructive: true }))) return;
    setBusy(true);
    try {
      const r = await fetchWithTimeout("/api/leash/data/reset", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scope: "factory" }) });
      if (!r.ok) {
        const msg = (await r.json().catch(() => ({})))?.error ?? "Reset failed.";
        toast.error(msg);
        await appAlert(msg, { tone: "error" });
        setBusy(false);
        return;
      }
      toast.success("Factory reset started");
      await activateAndGo(null, "/login"); // supervisor wipes + respawns to bootstrap
    } catch {
      toast.error("Reset failed");
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

      <div className="mt-4 border-t pt-3" style={{ borderColor: "var(--color-rule)" }}>
        <span className="kicker" style={{ color: "var(--color-brick)" }}>Danger zone</span>
        <div className="mt-2 flex flex-wrap gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => void factoryReset()}
            className="kicker border px-2 py-0.5 transition-opacity hover:opacity-70 disabled:opacity-40"
            style={{ borderColor: "var(--color-brick)", color: "var(--color-cream)", background: "var(--color-brick)" }}
          >
            factory reset
          </button>
        </div>
        <p className="kicker" style={{ color: "var(--color-faint)", marginTop: "0.4rem" }}>
          Factory reset wipes every account on this device. To reset just your own account, see Account → Danger zone.
        </p>
      </div>
    </div>
  );
}
