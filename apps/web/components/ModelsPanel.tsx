"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { fetchWithTimeout, TIMEOUT } from "../lib/http.ts";
import type { ModelsInventory, InventoryRow, CatalogModel } from "../lib/leash/models.ts";
import type { FitEstimate } from "../lib/leash/hwfit.ts";
import { CtxSizeControl } from "./CtxSizeControl.tsx";
import { GpuToggle } from "./GpuToggle.tsx";
import type { ServeStatus } from "../lib/leash/serve-control.ts";

const FIT_COLOR: Record<NonNullable<FitEstimate["verdict"]>, string> = {
  fits: "var(--color-sage)",
  tight: "#b8860b",
  "too-big": "var(--color-brick)",
};
const FIT_LABEL: Record<NonNullable<FitEstimate["verdict"]>, string> = {
  fits: "Fits",
  tight: "Tight",
  "too-big": "Won't fit",
};

/** Device-fit indicator — a single green/amber/red dot; the verdict + GB estimate live in the
 *  hover tooltip (and an sr-only label) so the column stays tight. ("alone" = per-model.) */
function fitBadge(fit: FitEstimate) {
  if (!fit.verdict) return <span className="kicker" style={{ color: "var(--color-faint)" }}>—</span>;
  return (
    <span className="inline-flex items-center" title={`${FIT_LABEL[fit.verdict]} · ≈${fit.gb} GB to serve alone · ${fit.deviceGB.toFixed(0)} GB unified memory`}>
      <span aria-hidden className="inline-block h-2 w-2 rounded-full" style={{ background: FIT_COLOR[fit.verdict] }} />
      <span className="sr-only">{FIT_LABEL[fit.verdict]} ≈{fit.gb}G</span>
    </span>
  );
}

/**
 * The model lifecycle surface (client) — Brain → Models.
 *
 *   · serve control: start / stop / restart with the inflight 409 guard server-side
 *     and a confirm dialog as the human backstop (a `next dev` restart resets the
 *     counter while the serve may still be decoding)
 *   · inventory: catalog + qvac.config.base.json + disk cache + live serve, merged
 *   · download: detached child with a polled status file (survives dev restarts)
 *   · honest lifecycle: UNLOAD is instant (live `DELETE /v1/models`); LOAD = config
 *     entry + serve restart (the serve has no HTTP load endpoint)
 */

interface DownloadStatus {
  name: string;
  state: "starting" | "downloading" | "done" | "error";
  percentage: number;
  downloaded: number;
  total: number;
  error?: string;
}

function fmtBytes(bytes: number | null): string {
  if (bytes === null) return "—";
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(bytes >= 1e10 ? 0 : 1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${Math.round(bytes / 1e3)} KB`;
}

const btn = (danger?: boolean): React.CSSProperties => ({
  borderColor: "var(--color-rule-strong)",
  color: danger ? "var(--color-brick)" : "var(--color-muted)",
});

/** A borderless ghost icon action button — accessible label + hover tooltip. Sits flush in a
 *  single non-wrapping row in the Actions cell (the bordered boxes wrapped to two lines and read
 *  heavy in a 10-column table). */
function IconButton({ title, danger, disabled, onClick, children }: { title: string; danger?: boolean; disabled?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      className="inline-flex h-6 w-6 items-center justify-center rounded opacity-70 transition-opacity hover:opacity-100 disabled:opacity-25"
      style={{ color: danger ? "var(--color-brick)" : "var(--color-muted)" }}
    >
      {children}
    </button>
  );
}

const ICON = { w: 13, h: 13, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.9, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
/** Eject/unload — model out of memory. */
const UnloadIcon = () => (
  <svg {...ICON} aria-hidden>
    <path d="M12 4 6 11h12z" />
    <line x1="5" y1="18" x2="19" y2="18" />
  </svg>
);
/** Add to config — plus in a box. */
const AddIcon = () => (
  <svg {...ICON} aria-hidden>
    <rect x="4" y="4" width="16" height="16" rx="2" />
    <line x1="12" y1="8.5" x2="12" y2="15.5" />
    <line x1="8.5" y1="12" x2="15.5" y2="12" />
  </svg>
);
/** Remove from config — minus in a box. */
const RemoveIcon = () => (
  <svg {...ICON} aria-hidden>
    <rect x="4" y="4" width="16" height="16" rx="2" />
    <line x1="8.5" y1="12" x2="15.5" y2="12" />
  </svg>
);
/** Delete file — trash can. */
const TrashIcon = () => (
  <svg {...ICON} aria-hidden>
    <polyline points="3 6 5 6 21 6" />
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
  </svg>
);

export function ModelsPanel({ inventory, serve, catalog, downloads: initialDownloads }: { inventory: ModelsInventory; serve: ServeStatus; catalog: CatalogModel[]; downloads: DownloadStatus[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [downloads, setDownloads] = useState<DownloadStatus[]>(initialDownloads);
  const [unshared, setUnshared] = useState<Set<string>>(new Set());
  const [nodeSharing, setNodeSharing] = useState(true);

  // Poll download progress while any download is active (status-file polling beats
  // SSE here: the detached child survives dev restarts, the file is the truth).
  const active = downloads.some((d) => d.state === "downloading" || d.state === "starting");
  useEffect(() => {
    if (!active) return;
    const t = setInterval(async () => {
      try {
        const res = await fetchWithTimeout("/api/leash/models/download", {}, TIMEOUT.probe);
        if (res.ok) {
          const body = (await res.json()) as { downloads: DownloadStatus[] };
          setDownloads(body.downloads);
          if (!body.downloads.some((d) => d.state === "downloading" || d.state === "starting")) router.refresh();
        }
      } catch {
        /* transient poll failure — next tick retries */
      }
    }, 2000);
    return () => clearInterval(t);
  }, [active, router]);

  const call = async (fn: () => Promise<Response>, confirmMsg?: string): Promise<void> => {
    if (confirmMsg && !confirm(confirmMsg)) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fn();
      const body = (await res.json().catch(() => ({}))) as { error?: string; appliesOn?: string };
      if (!res.ok) setError(body.error ?? `Request failed (${res.status}).`);
      else if (body.appliesOn) setNotice(`Saved — applies on ${body.appliesOn}.`);
      router.refresh();
    } catch {
      setError("Request failed — is the app still running?");
    } finally {
      setBusy(false);
    }
  };

  const serveAction = (action: "start" | "stop" | "restart") =>
    void call(
      () => fetchWithTimeout("/api/leash/serve", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action }) }, TIMEOUT.heavy),
      action === "start"
        ? undefined
        : `${action === "stop" ? "Stop" : "Restart"} the model serve? Make sure no generation is running (a chat/voice turn mid-decode would wedge the GPU).`,
    );

  const startDownload = (rawName: string) => {
    const name = rawName.trim().toUpperCase();
    if (!name) return;
    void call(() => fetchWithTimeout("/api/leash/models/download", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) }, TIMEOUT.heavy)).then(() => {
      setDownloads((d) => [...d.filter((x) => x.name !== name), { name, state: "starting", percentage: 0, downloaded: 0, total: 0 }]);
    });
  };

  // Per-alias mesh sharing — load the daemon's deny-set once, then toggle optimistically (revert on fail).
  useEffect(() => {
    let alive = true;
    fetchWithTimeout("/api/leash/hypha/share", { cache: "no-store" }, TIMEOUT.probe)
      .then((r) => r.json())
      .then((d: { shareModels?: boolean; unshared?: string[] }) => {
        if (!alive) return;
        setUnshared(new Set(d.unshared ?? []));
        setNodeSharing(d.shareModels !== false);
      })
      .catch(() => {
        /* daemon down — sharing column shows defaults; toggling will surface the error */
      });
    return () => {
      alive = false;
    };
  }, []);
  const toggleShare = async (alias: string) => {
    const nextShared = unshared.has(alias); // currently denied → turning sharing ON
    setUnshared((prev) => {
      const n = new Set(prev);
      if (nextShared) n.delete(alias);
      else n.add(alias);
      return n;
    });
    try {
      await fetchWithTimeout("/api/leash/hypha/share", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ alias, on: nextShared }) }, TIMEOUT.crud);
    } catch {
      setUnshared((prev) => {
        const n = new Set(prev);
        if (nextShared) n.add(alias);
        else n.delete(alias);
        return n;
      });
    }
  };

  // Catalog the user can pull, minus the noisy families (gpt-oss / bitnet); plus a set of
  // already-cached registry names so a row greys out instead of re-downloading.
  const downloadable = catalog.filter((c) => !/gpt|bitnet/i.test(c.name));
  const downloadedNames = new Set<string>([...inventory.configured, ...inventory.onDiskOnly].filter((r) => r.onDiskBytes != null).map((r) => r.name));

  const stateLabel: Record<ServeStatus["state"], string> = { stopped: "Stopped", starting: "Starting (preloading)…", ready: "Ready", unhealthy: "Unhealthy" };
  const stateColor: Record<ServeStatus["state"], string> = { stopped: "var(--color-brick)", starting: "var(--color-faint)", ready: "var(--color-sage)", unhealthy: "var(--color-brick)" };

  const Cell = ({ children, mono }: { children: React.ReactNode; mono?: boolean }) => (
    <td className="border-b px-2 py-2 align-top" style={{ borderColor: "var(--color-rule)", fontFamily: mono ? "var(--font-mono)" : "var(--font-body)", fontSize: mono ? "0.75rem" : "0.85rem" }}>
      {children}
    </td>
  );
  const Head = ({ children }: { children: React.ReactNode }) => (
    <th className="border-b-2 px-2 py-1.5 text-left" style={{ borderColor: "var(--color-ink)" }}>
      <span className="kicker" style={{ color: "var(--color-faint)" }}>{children}</span>
    </th>
  );

  const row = (r: InventoryRow) => (
    <tr key={`${r.alias ?? ""}:${r.name}:${r.cacheFile ?? ""}`}>
      <Cell mono>
        {r.alias ?? <span style={{ color: "var(--color-faint)" }}>—</span>}
        {r.isDefault && <span className="kicker ml-1" style={{ color: "var(--color-sage-deep)" }}>default</span>}
      </Cell>
      <Cell mono>{r.name}</Cell>
      <Cell mono>{[r.addon, r.engine && r.engine !== r.addon ? r.engine : null, r.params, r.quantization].filter(Boolean).join(" · ") || "—"}</Cell>
      <Cell mono>
        {r.ctxSize !== null && r.inConfig && r.alias ? (
          <CtxSizeControl
            row={r}
            busy={busy}
            onSave={(ctx) =>
              void call(() =>
                fetchWithTimeout("/api/leash/models/config", {
                  method: "PUT",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ action: "config", alias: r.alias, patch: { ctx_size: ctx } }),
                }),
              )
            }
          />
        ) : r.ctxSize !== null ? (
          r.ctxSize.toLocaleString()
        ) : (
          "—"
        )}
      </Cell>
      <Cell>
        {r.inConfig && r.alias ? (
          <GpuToggle
            useGpu={r.useGpu}
            busy={busy}
            onSave={(useGpu) =>
              void call(() =>
                fetchWithTimeout("/api/leash/models/config", {
                  method: "PUT",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ action: "config", alias: r.alias, patch: { use_gpu: useGpu } }),
                }),
              )
            }
          />
        ) : (
          "—"
        )}
      </Cell>
      <Cell mono>{r.tokPerSec !== null ? `${r.tokPerSec.toFixed(1)} tok/s` : "—"}</Cell>
      <Cell>{fitBadge(r.fit)}</Cell>
      <Cell mono>{r.onDiskBytes !== null ? fmtBytes(r.onDiskBytes) : r.expectedSize !== null ? `${fmtBytes(r.expectedSize)} (not cached)` : "—"}</Cell>
      <Cell>
        {r.loaded ? (
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: "var(--color-sage)" }} />
            <span className="kicker">Loaded</span>
          </span>
        ) : (
          <span className="kicker" style={{ color: "var(--color-faint)" }}>
            {r.inConfig ? (serve.state === "ready" ? (r.preload ? "Not loaded" : "No preload") : "Serve " + serve.state) : "Cached only"}
          </span>
        )}
      </Cell>
      <Cell>
        {r.inConfig && r.alias ? (
          (() => {
            const shared = !unshared.has(r.alias);
            return (
              <button
                type="button"
                onClick={() => void toggleShare(r.alias as string)}
                title={nodeSharing ? "Whether this model is advertised to mesh peers" : "Node sharing is off (Mesh model sharing card) — turn it on to advertise"}
                className="inline-flex items-center gap-1.5 transition-opacity hover:opacity-80"
                style={{ fontFamily: "var(--font-mono)", fontSize: "0.66rem", border: "1px solid var(--color-rule)", borderRadius: 999, padding: "1px 7px", background: "none", cursor: "pointer", color: shared && nodeSharing ? "var(--color-sage-deep)" : "var(--color-faint)" }}
              >
                <span aria-hidden className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: shared && nodeSharing ? "var(--color-sage)" : "var(--color-faint)" }} />
                {shared ? "shared" : "private"}
              </button>
            );
          })()
        ) : (
          <span className="kicker" style={{ color: "var(--color-faint)" }}>—</span>
        )}
      </Cell>
      <Cell>
        <span className="inline-flex items-center gap-0.5">
          {r.loaded && r.alias && (
            <IconButton title="Unload from the running serve (comes back on restart)" danger disabled={busy} onClick={() => void call(() => fetchWithTimeout(`/api/leash/models/loaded/${encodeURIComponent(r.alias as string)}`, { method: "DELETE" }), `Unload "${r.alias}" from the running serve? It comes back on the next restart.`)}>
              <UnloadIcon />
            </IconButton>
          )}
          {r.inConfig && r.alias && (
            <IconButton title="Remove from qvac.config.base.json (won't load next restart)" disabled={busy} onClick={() => void call(() => fetchWithTimeout("/api/leash/models/config", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "remove", alias: r.alias }) }), `Remove "${r.alias}" from qvac.config.base.json? It won't load on the next serve restart.`)}>
              <RemoveIcon />
            </IconButton>
          )}
          {!r.inConfig && r.name !== r.cacheFile && (
            <IconButton
              title="Add to config (loads on next restart)"
              disabled={busy}
              onClick={() => {
                const alias = prompt(`Config alias for ${r.name}?`, r.name.toLowerCase().replace(/_/g, "-").slice(0, 24));
                if (!alias) return;
                void call(() => fetchWithTimeout("/api/leash/models/config", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "add", alias: alias.trim(), model: r.name }) }));
              }}
            >
              <AddIcon />
            </IconButton>
          )}
          {r.onDiskBytes !== null && r.cacheFile && (
            <IconButton title="Delete the cached file from disk" danger disabled={busy} onClick={() => void call(() => fetchWithTimeout(`/api/leash/models/file/${encodeURIComponent(r.cacheFile as string)}${r.inConfig ? "?force=1" : ""}`, { method: "DELETE" }), `Delete ${r.cacheFile} (${fmtBytes(r.onDiskBytes)}) from the model cache?${r.inConfig ? " It is referenced by the config — the next restart will re-download it." : ""}`)}>
              <TrashIcon />
            </IconButton>
          )}
        </span>
      </Cell>
    </tr>
  );

  return (
    <div className="flex flex-col gap-6">
      {error && (
        <p className="kicker" style={{ color: "var(--color-brick)" }} role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="kicker" style={{ color: "var(--color-sage-deep)" }}>
          {notice}
        </p>
      )}

      {/* Serve control */}
      <section className="border p-4" style={{ borderColor: "var(--color-rule)", background: "var(--color-paper)" }}>
        <div className="flex flex-wrap items-center gap-4">
          <span className="inline-flex items-center gap-2">
            <span aria-hidden className="inline-block h-2 w-2 rounded-full" style={{ background: stateColor[serve.state] }} />
            <span className="kicker" style={{ color: "var(--color-ink-soft)" }}>
              qvac serve · {stateLabel[serve.state]}
              {serve.pid ? ` · pid ${serve.pid}${serve.ours ? "" : " (external)"}` : ""} · :{serve.port}
            </span>
          </span>
          <span className="h-px flex-1" style={{ background: "var(--color-rule)" }} />
          {serve.state === "stopped" ? (
            <button type="button" disabled={busy} onClick={() => serveAction("start")} className="kicker px-3 py-1.5 transition-opacity hover:opacity-80" style={{ background: "var(--color-sage-deep)", color: "var(--color-cream)" }}>
              Start serve
            </button>
          ) : (
            <>
              <button type="button" disabled={busy} onClick={() => serveAction("restart")} className="kicker border px-3 py-1.5 transition-opacity hover:opacity-70" style={btn()}>
                Restart
              </button>
              <button type="button" disabled={busy} onClick={() => serveAction("stop")} className="kicker border px-3 py-1.5 transition-opacity hover:opacity-70" style={btn(true)}>
                Stop
              </button>
            </>
          )}
        </div>
        {serve.inflight > 0 && (
          <p className="kicker mt-2" style={{ color: "var(--color-brick)" }}>
            {serve.inflight} generation(s) in flight — stop/restart is blocked until the assistant is idle.
          </p>
        )}
        <p className="kicker mt-2" style={{ color: "var(--color-faint)" }}>
          Unload is instant. Loading a model = add it to the config below, then Restart. The serve opens its port only after every preload finishes.
        </p>
      </section>

      <p className="kicker" style={{ color: "var(--color-faint)" }}>
        Disk cache {fmtBytes(inventory.totalDiskBytes)} · catalog {inventory.catalogCount} models
      </p>

      <section>
        <div className="mb-2 flex items-center gap-3">
          <span className="kicker kicker-sage">Configured (qvac.config.base.json)</span>
          <span className="h-px flex-1" style={{ background: "var(--color-rule)" }} />
        </div>
        <table className="w-full border-collapse">
          <thead>
            <tr>
              <Head>Alias</Head>
              <Head>Model</Head>
              <Head>Kind</Head>
              <Head>Ctx</Head>
              <Head>Compute</Head>
              <Head>Speed</Head>
              <Head>Fit</Head>
              <Head>Size</Head>
              <Head>State</Head>
              <Head>Share</Head>
              <Head>Actions</Head>
            </tr>
          </thead>
          <tbody>{inventory.configured.map(row)}</tbody>
        </table>
      </section>

      {inventory.onDiskOnly.length > 0 && (
        <section>
          <div className="mb-2 flex items-center gap-3">
            <span className="kicker kicker-sage">On disk, not configured</span>
            <span className="h-px flex-1" style={{ background: "var(--color-rule)" }} />
          </div>
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <Head>Alias</Head>
                <Head>Model</Head>
                <Head>Kind</Head>
                <Head>Ctx</Head>
                <Head>Compute</Head>
                <Head>Speed</Head>
                <Head>Fit</Head>
                <Head>Size</Head>
                <Head>State</Head>
                <Head>Share</Head>
                <Head>Actions</Head>
              </tr>
            </thead>
            <tbody>{inventory.onDiskOnly.map(row)}</tbody>
          </table>
        </section>
      )}

      {/* Available to download — the SDK catalog (minus gpt-oss/bitnet noise); a row greys out once
          its file is cached. Replaces the old type-a-constant card. */}
      <section>
        <div className="mb-2 flex items-center gap-3">
          <span className="kicker kicker-sage">Available to download</span>
          <span className="h-px flex-1" style={{ background: "var(--color-rule)" }} />
        </div>
        <div className="flex flex-col" style={{ maxHeight: 360, overflowY: "auto" }}>
          {downloadable.length === 0 && <span className="kicker" style={{ color: "var(--color-faint)" }}>no catalog models</span>}
          {downloadable.map((c) => {
            const onDisk = downloadedNames.has(c.name);
            const dl = downloads.find((d) => d.name === c.name);
            const downloading = dl?.state === "downloading" || dl?.state === "starting";
            return (
              <div key={c.name} className="flex flex-wrap items-center gap-2 border-b py-1.5" style={{ borderColor: "var(--color-rule)" }}>
                <span className="mono kicker truncate" style={{ flex: 1, minWidth: 0 }} title={c.name}>{c.name}</span>
                <span className="mono kicker" style={{ color: "var(--color-faint)" }}>{[c.addon, c.params, c.expectedSize ? fmtBytes(c.expectedSize) : null].filter(Boolean).join(" · ") || "—"}</span>
                {c.fit?.verdict && fitBadge(c.fit)}
                {onDisk ? (
                  <span className="kicker" style={{ color: "var(--color-sage-deep)" }}>✓ on disk</span>
                ) : downloading ? (
                  <span className="kicker" style={{ color: "var(--color-sage-deep)" }}>{dl?.state === "downloading" ? `${dl.percentage.toFixed(0)}%` : "starting…"}</span>
                ) : (
                  <button type="button" disabled={busy} onClick={() => startDownload(c.name)} className="kicker border px-2 py-0.5 transition-opacity hover:opacity-70 disabled:opacity-40" style={{ borderColor: "var(--color-sage-deep)", color: "var(--color-sage-deep)" }}>
                    Download
                  </button>
                )}
              </div>
            );
          })}
        </div>
        {downloads.some((d) => d.state === "error") && (
          <ul className="mt-2">
            {downloads.filter((d) => d.state === "error").map((d) => (
              <li key={d.name} className="kicker" style={{ color: "var(--color-brick)" }}>
                {d.name} — {d.error ?? "download error"}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
