"use client";
/**
 * Settings → Storage (left). The model cache, paginated, with per-row + bulk multi-select delete.
 * Deletes go through the guarded per-file models route (looped for bulk — surfaced if any fail).
 * Every destructive action confirms first.
 */
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { fetchWithTimeout } from "../lib/http.ts";
import { appAlert, appConfirm } from "../lib/prompt.ts";
import { toast } from "./Toast.tsx";
import type { StorageUsage } from "../lib/leash/storage.ts";
import { paginate, sumSelectedBytes } from "../lib/leash/storage-paging.ts";

const PER_PAGE = 8;

function fmt(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(bytes >= 1e10 ? 0 : 1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  if (bytes >= 1e3) return `${Math.round(bytes / 1e3)} KB`;
  return `${bytes} B`;
}

export function ModelCacheCard({ files, totalBytes }: { files: StorageUsage["modelFiles"]; totalBytes: number }) {
  const router = useRouter();
  const [page, setPage] = useState(1);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const view = useMemo(() => paginate(files, page, PER_PAGE), [files, page]);
  const selBytes = sumSelectedBytes(files, sel);

  const toggle = (file: string) =>
    setSel((s) => {
      const n = new Set(s);
      if (n.has(file)) n.delete(file);
      else n.add(file);
      return n;
    });
  const allOnPage = view.slice.length > 0 && view.slice.every((m) => sel.has(m.file));
  const togglePage = () =>
    setSel((s) => {
      const n = new Set(s);
      view.slice.forEach((m) => (allOnPage ? n.delete(m.file) : n.add(m.file)));
      return n;
    });

  const deleteFiles = async (targets: string[], confirmMsg: string) => {
    if (targets.length === 0 || !(await appConfirm(confirmMsg, { confirmLabel: "Delete", destructive: true }))) return;
    setBusy(true);
    const failed: string[] = [];
    try {
      for (const file of targets) {
        const r = await fetchWithTimeout(`/api/leash/models/file/${encodeURIComponent(file)}?force=1`, { method: "DELETE" });
        if (!r.ok) failed.push(file);
      }
      setSel(new Set());
      if (failed.length) {
        const msg = `Failed to delete: ${failed.join(", ")}`;
        toast.error(msg);
        await appAlert(msg, { tone: "error" });
      } else {
        toast.success(targets.length === 1 ? "Cached model deleted" : `${targets.length} cached models deleted`);
      }
      router.refresh();
    } catch {
      toast.error("Delete failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between">
        <span className="kicker kicker-sage">Model cache</span>
        <span className="mono kicker">{fmt(totalBytes)}</span>
      </div>
      {files.length === 0 && <span className="kicker" style={{ color: "var(--color-faint)" }}>no cached models</span>}

      {files.length > 0 && (
        <div className="mb-1 flex items-center gap-2 border-b py-1" style={{ borderColor: "var(--color-rule)" }}>
          <input type="checkbox" checked={allOnPage} onChange={togglePage} aria-label="Select all on page" />
          <span className="kicker" style={{ color: "var(--color-faint)" }}>select page</span>
        </div>
      )}

      {view.slice.map((m) => (
        <div key={m.file} className="flex items-center gap-2 border-b py-1" style={{ borderColor: "var(--color-rule)" }}>
          <input type="checkbox" checked={sel.has(m.file)} onChange={() => toggle(m.file)} aria-label={`Select ${m.file}`} />
          <span className="mono kicker truncate" style={{ flex: 1, minWidth: 0 }} title={m.file}>{m.file}</span>
          <span className="mono kicker" style={{ color: "var(--color-faint)" }}>{fmt(m.bytes)}</span>
          <button
            type="button"
            disabled={busy}
            onClick={() => void deleteFiles([m.file], `Delete ${m.file} (${fmt(m.bytes)})? If it backs a configured model, the next serve restart re-downloads it.`)}
            className="kicker border px-2 py-0.5 transition-opacity hover:opacity-70 disabled:opacity-40"
            style={{ borderColor: "var(--color-brick)", color: "var(--color-brick)" }}
          >
            delete
          </button>
        </div>
      ))}

      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <button
          type="button"
          disabled={busy || sel.size === 0}
          onClick={() => void deleteFiles([...sel], `Delete ${sel.size} cached file(s) totalling ${fmt(selBytes)}? Files backing configured models re-download on the next serve restart.`)}
          className="kicker border px-2 py-0.5 transition-opacity hover:opacity-70 disabled:opacity-40"
          style={{ borderColor: "var(--color-brick)", color: "var(--color-brick)" }}
        >
          Delete selected{sel.size ? ` (${sel.size})` : ""}
        </button>
        {view.pages > 1 && (
          <span className="flex items-center gap-2">
            <button type="button" disabled={!view.hasPrev} onClick={() => setPage((p) => p - 1)} className="kicker px-1 disabled:opacity-30">‹</button>
            <span className="kicker" style={{ color: "var(--color-faint)" }}>{view.page}/{view.pages}</span>
            <button type="button" disabled={!view.hasNext} onClick={() => setPage((p) => p + 1)} className="kicker px-1 disabled:opacity-30">›</button>
          </span>
        )}
      </div>
    </div>
  );
}
