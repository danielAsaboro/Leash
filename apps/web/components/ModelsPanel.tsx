"use client";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  TypeIcon,
  ImageIcon,
  MicIcon,
  BoxesIcon,
  ScanTextIcon,
  LanguagesIcon,
  CircleIcon,
  CircleCheckIcon,
  CircleAlertIcon,
  CircleDotIcon,
  CircleDashedIcon,
  LogOutIcon,
  MinusIcon,
  PlusIcon,
  Trash2Icon,
  DownloadIcon,
  Share2Icon,
  LockIcon,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { fetchWithTimeout, TIMEOUT } from "../lib/http.ts";
import type { ModelsInventory, CatalogModel } from "../lib/leash/models.ts";
import type { FitEstimate } from "../lib/leash/hwfit.ts";
import { buildModelRows, modelState, type ModelKind, type ModelCategory, type ModelState, type TaggedRow } from "../lib/leash/model-rows.ts";
import { FilterChipBar, type FilterChip } from "./FilterChipBar.tsx";
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

/** Device-fit indicator — a green/amber/red dot in a comfortable 24px hover target; the verdict +
 *  GB estimate live in the tooltip (and an sr-only label) so the column stays tight. ("alone" = per-model.) */
function fitBadge(fit: FitEstimate) {
  if (!fit.verdict) return <span className="inline-flex h-6 w-6 items-center justify-center kicker" style={{ color: "var(--color-faint)" }}>—</span>;
  return (
    <span className="inline-flex h-6 w-6 items-center justify-center" title={`${FIT_LABEL[fit.verdict]} · ≈${fit.gb} GB to serve alone · ${fit.deviceGB.toFixed(0)} GB unified memory`}>
      <span aria-hidden className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: FIT_COLOR[fit.verdict] }} />
      <span className="sr-only">{FIT_LABEL[fit.verdict]} ≈{fit.gb}G</span>
    </span>
  );
}

/** Kind → lucide icon + human label. The catalog `addon` is collapsed to a kind in `model-rows.ts`;
 *  here that kind picks the icon shown in the (tight) Kind column. */
const KIND_META: Record<ModelKind, { Icon: LucideIcon; label: string }> = {
  text: { Icon: TypeIcon, label: "Text" },
  image: { Icon: ImageIcon, label: "Image" },
  speech: { Icon: MicIcon, label: "Speech" },
  embedding: { Icon: BoxesIcon, label: "Embedding" },
  ocr: { Icon: ScanTextIcon, label: "OCR" },
  translation: { Icon: LanguagesIcon, label: "Translation" },
  other: { Icon: CircleIcon, label: "Other" },
};

/** Kind column — one icon; the spelled-out `addon · engine · params · quant` lives in the hover
 *  tooltip (and an sr-only label). Mirrors `fitBadge`. */
function kindBadge(r: TaggedRow) {
  const { Icon, label } = KIND_META[r.kind];
  const detail = [r.addon, r.engine && r.engine !== r.addon ? r.engine : null, r.params, r.quantization].filter(Boolean).join(" · ");
  return (
    <span className="inline-flex h-6 w-6 items-center justify-center" title={detail ? `${label} · ${detail}` : label} style={{ color: "var(--color-muted)" }}>
      <Icon size={14} aria-hidden />
      <span className="sr-only">{label}{detail ? ` — ${detail}` : ""}</span>
    </span>
  );
}

/** State → lucide circle-variant icon + color + the full hover sentence. The short label is sr-only. */
const STATE_META: Record<ModelState, { Icon: LucideIcon; color: string; label: string; title: string }> = {
  loaded: { Icon: CircleCheckIcon, color: "var(--color-sage)", label: "Loaded", title: "Loaded on the running serve right now" },
  "not-loaded": { Icon: CircleIcon, color: "var(--color-faint)", label: "Not loaded", title: "Configured with preload — loads on the next serve restart" },
  "no-preload": { Icon: CircleIcon, color: "var(--color-faint)", label: "No preload", title: "Configured without preload — won't auto-load; restart with preload to serve it" },
  "serve-down": { Icon: CircleAlertIcon, color: "var(--color-brick)", label: "Serve down", title: "Configured, but the serve isn't ready — start/restart to load it" },
  cached: { Icon: CircleDotIcon, color: "var(--color-muted)", label: "Cached", title: "On disk but not configured — add it to the config to serve it" },
  "not-downloaded": { Icon: CircleDashedIcon, color: "var(--color-faint)", label: "Not downloaded", title: "In the catalog — not downloaded to this device yet" },
};

function stateBadge(state: ModelState) {
  const { Icon, color, label, title } = STATE_META[state];
  return (
    <span className="inline-flex h-6 w-6 items-center justify-center" title={title} style={{ color }}>
      <Icon size={14} aria-hidden />
      <span className="sr-only">{label}</span>
    </span>
  );
}

/**
 * The model lifecycle surface (client) — Brain → Models. (Serve start/stop/restart lives under
 * Services; here `serve.state` only drives each row's State icon.)
 *
 *   · inventory: catalog + qvac.config.base.json + disk cache + live serve, merged into ONE
 *     filterable list (status × kind facets + name search) by `model-rows.ts buildModelRows`
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

/** Middle-ellipsis a long model name — keep the leading family + the trailing quant/size suffix,
 *  drop the middle (`QWEN3_VL_30B_A3B…_Q4_K_M`). Mono font ⇒ char budget maps to a stable width;
 *  the full name lives in the cell's hover `title`. */
function middleEllipsis(s: string, head = 16, tail = 9): string {
  return s.length <= head + tail + 1 ? s : `${s.slice(0, head)}…${s.slice(-tail)}`;
}

/** A borderless ghost icon action button — accessible label + hover tooltip. Sits flush in a
 *  single non-wrapping row in the Actions cell. `color` overrides the default muted/brick tone
 *  (used for the sage Download action). */
function IconButton({ title, danger, color, disabled, onClick, children }: { title: string; danger?: boolean; color?: string; disabled?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      className="inline-flex h-6 w-6 items-center justify-center rounded opacity-70 transition-opacity hover:opacity-100 disabled:opacity-25"
      style={{ color: color ?? (danger ? "var(--color-brick)" : "var(--color-muted)") }}
    >
      {children}
    </button>
  );
}

const STATUS_CHIPS: FilterChip[] = [
  { key: "all", label: "All" },
  { key: "configured", label: "Configured" },
  { key: "downloaded", label: "Downloaded" },
  { key: "available", label: "Available" },
];

const KIND_CHIPS: FilterChip[] = [
  { key: "all", label: "All" },
  { key: "text", label: "Text", Icon: TypeIcon },
  { key: "image", label: "Image", Icon: ImageIcon },
  { key: "speech", label: "Speech", Icon: MicIcon },
  { key: "embedding", label: "Embedding", Icon: BoxesIcon },
  { key: "ocr", label: "OCR", Icon: ScanTextIcon },
  { key: "translation", label: "Translation", Icon: LanguagesIcon },
];

export function ModelsPanel({ inventory, serve, catalog, downloads: initialDownloads }: { inventory: ModelsInventory; serve: ServeStatus; catalog: CatalogModel[]; downloads: DownloadStatus[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [downloads, setDownloads] = useState<DownloadStatus[]>(initialDownloads);
  const [unshared, setUnshared] = useState<Set<string>>(new Set());
  const [nodeSharing, setNodeSharing] = useState(true);
  // Browser filters: default status=configured so the first paint is the small, useful set;
  // Available (700+ catalog models) is opt-in, navigated via the kind chips + name search.
  const [status, setStatus] = useState<"all" | ModelCategory>("configured");
  const [kind, setKind] = useState<"all" | ModelKind>("all");
  const [q, setQ] = useState("");

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

  // ── One merged, filterable list ────────────────────────────────────────────────
  // gpt-oss / bitnet are too noisy to browse — hide them, but only among the (huge) catalog
  // residual ("available"); a configured/on-disk gpt model the user already chose still shows.
  const allRows = useMemo(
    () => buildModelRows(inventory, catalog).filter((r) => !(r.category === "available" && /gpt|bitnet/i.test(r.name))),
    [inventory, catalog],
  );
  const searched = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return allRows;
    return allRows.filter((r) => r.name.toLowerCase().includes(needle) || (r.alias?.toLowerCase().includes(needle) ?? false));
  }, [allRows, q]);
  // Facet counts each reflect the OTHER facet + search, so a chip's number is what you'd see if you clicked it.
  const statusCounts = useMemo(() => {
    const base = kind === "all" ? searched : searched.filter((r) => r.kind === kind);
    const c: Record<string, number> = { all: base.length, configured: 0, downloaded: 0, available: 0 };
    for (const r of base) c[r.category] = (c[r.category] ?? 0) + 1;
    return c;
  }, [searched, kind]);
  const kindCounts = useMemo(() => {
    const base = status === "all" ? searched : searched.filter((r) => r.category === status);
    const c: Record<string, number> = { all: base.length, text: 0, image: 0, speech: 0, embedding: 0, ocr: 0, translation: 0, other: 0 };
    for (const r of base) c[r.kind] = (c[r.kind] ?? 0) + 1;
    return c;
  }, [searched, status]);
  const visible = useMemo(
    () => searched.filter((r) => (status === "all" || r.category === status) && (kind === "all" || r.kind === kind)),
    [searched, status, kind],
  );

  const Cell = ({ children, mono }: { children: React.ReactNode; mono?: boolean }) => (
    <td className="border-b px-2 py-2 align-top" style={{ borderColor: "var(--color-rule)", fontFamily: mono ? "var(--font-mono)" : "var(--font-body)", fontSize: mono ? "0.75rem" : "0.85rem" }}>
      {children}
    </td>
  );
  const Head = ({ children }: { children: React.ReactNode }) => (
    <th className="border-b-2 px-2 py-1.5 text-left" style={{ borderColor: "var(--color-ink)", position: "sticky", top: 0, background: "var(--color-cream)", zIndex: 1, whiteSpace: "nowrap" }}>
      <span className="kicker" style={{ color: "var(--color-faint)" }}>{children}</span>
    </th>
  );

  const row = (r: TaggedRow) => (
    <tr key={`${r.category}:${r.alias ?? ""}:${r.name}:${r.cacheFile ?? ""}`}>
      <Cell mono>
        {r.alias ?? <span style={{ color: "var(--color-faint)" }}>—</span>}
        {r.isDefault && <span className="kicker ml-1" style={{ color: "var(--color-sage-deep)" }}>default</span>}
      </Cell>
      <Cell mono>
        <span className="whitespace-nowrap" title={r.name}>{middleEllipsis(r.name)}</span>
      </Cell>
      <Cell>{kindBadge(r)}</Cell>
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
      <Cell mono>{r.tokPerSec !== null ? r.tokPerSec.toFixed(1) : "—"}</Cell>
      <Cell>{fitBadge(r.fit)}</Cell>
      <Cell mono>
        {r.onDiskBytes !== null ? (
          <span className="whitespace-nowrap">{fmtBytes(r.onDiskBytes)}</span>
        ) : r.expectedSize !== null ? (
          <>
            <span className="whitespace-nowrap">{fmtBytes(r.expectedSize)}</span> <span style={{ color: "var(--color-faint)" }}>(not cached)</span>
          </>
        ) : (
          "—"
        )}
      </Cell>
      <Cell>{stateBadge(modelState(r, serve.state))}</Cell>
      <Cell>
        {r.inConfig && r.alias ? (
          (() => {
            const shared = !unshared.has(r.alias);
            const on = shared && nodeSharing;
            return (
              <IconButton
                title={nodeSharing ? (shared ? "Shared with mesh peers — click to make private" : "Private — click to share with mesh peers") : "Node sharing is off (Settings → Devices → Mesh model sharing) — turn it on to advertise"}
                color={on ? "var(--color-sage-deep)" : "var(--color-faint)"}
                onClick={() => void toggleShare(r.alias as string)}
              >
                {shared ? <Share2Icon size={14} aria-hidden /> : <LockIcon size={14} aria-hidden />}
              </IconButton>
            );
          })()
        ) : (
          <span className="inline-flex h-6 w-6 items-center justify-center kicker" style={{ color: "var(--color-faint)" }}>—</span>
        )}
      </Cell>
      <Cell>
        {(() => {
          // Every row shows the SAME ordered action set (download · add · remove · unload · delete);
          // the ones that don't apply to this row are disabled (greyed) so the column stays orderly.
          const dl = downloads.find((d) => d.name === r.name);
          const downloading = r.category === "available" && (dl?.state === "downloading" || dl?.state === "starting");
          const canDownload = r.category === "available" && !downloading;
          const canAdd = r.category === "downloaded" && r.name !== r.cacheFile;
          const canRemove = r.inConfig && !!r.alias;
          const canUnload = r.loaded && !!r.alias;
          const canDelete = r.onDiskBytes !== null && !!r.cacheFile;
          return (
            <span className="inline-flex items-center gap-0.5">
              {downloading ? (
                <span className="inline-flex h-6 w-6 items-center justify-center" style={{ color: "var(--color-sage-deep)", fontFamily: "var(--font-mono)", fontSize: "0.6rem" }} title={dl?.state === "downloading" ? `Downloading ${dl.percentage.toFixed(0)}%` : "Starting download…"}>
                  {dl?.state === "downloading" ? `${dl.percentage.toFixed(0)}%` : "…"}
                </span>
              ) : (
                <IconButton title={canDownload ? `Download ${r.name}` : "Download — already on disk"} color="var(--color-sage-deep)" disabled={busy || !canDownload} onClick={() => startDownload(r.name)}>
                  <DownloadIcon size={14} aria-hidden />
                </IconButton>
              )}
              <IconButton
                title={canAdd ? "Add to config (loads on next restart)" : "Add to config — download it first"}
                disabled={busy || !canAdd}
                onClick={() => {
                  const alias = prompt(`Config alias for ${r.name}?`, r.name.toLowerCase().replace(/_/g, "-").slice(0, 24));
                  if (!alias) return;
                  void call(() => fetchWithTimeout("/api/leash/models/config", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "add", alias: alias.trim(), model: r.name }) }));
                }}
              >
                <PlusIcon size={14} aria-hidden />
              </IconButton>
              <IconButton
                title={canRemove ? "Remove from qvac.config.base.json (won't load next restart)" : "Remove from config — not configured"}
                disabled={busy || !canRemove}
                onClick={() => void call(() => fetchWithTimeout("/api/leash/models/config", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "remove", alias: r.alias }) }), `Remove "${r.alias}" from qvac.config.base.json? It won't load on the next serve restart.`)}
              >
                <MinusIcon size={14} aria-hidden />
              </IconButton>
              <IconButton
                title={canUnload ? "Unload from the running serve (comes back on restart)" : "Unload — not currently loaded"}
                danger
                disabled={busy || !canUnload}
                onClick={() => void call(() => fetchWithTimeout(`/api/leash/models/loaded/${encodeURIComponent(r.alias as string)}`, { method: "DELETE" }), `Unload "${r.alias}" from the running serve? It comes back on the next restart.`)}
              >
                <LogOutIcon size={14} aria-hidden />
              </IconButton>
              <IconButton
                title={canDelete ? "Delete the cached file from disk" : "Delete file — not on disk"}
                danger
                disabled={busy || !canDelete}
                onClick={() => void call(() => fetchWithTimeout(`/api/leash/models/file/${encodeURIComponent(r.cacheFile as string)}${r.inConfig ? "?force=1" : ""}`, { method: "DELETE" }), `Delete ${r.cacheFile} (${fmtBytes(r.onDiskBytes)}) from the model cache?${r.inConfig ? " It is referenced by the config — the next restart will re-download it." : ""}`)}
              >
                <Trash2Icon size={14} aria-hidden />
              </IconButton>
            </span>
          );
        })()}
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

      <p className="kicker" style={{ color: "var(--color-faint)" }}>
        Disk cache {fmtBytes(inventory.totalDiskBytes)} · catalog {inventory.catalogCount} models · serve control lives under Services
      </p>

      {/* One filterable browser: status × kind facets + name search over the merged list. */}
      <section className="flex flex-col gap-3">
        <FilterChipBar chips={STATUS_CHIPS} active={status} onChange={(k) => setStatus(k as "all" | ModelCategory)} counts={statusCounts} />
        <FilterChipBar chips={KIND_CHIPS} active={kind} onChange={(k) => setKind(k as "all" | ModelKind)} counts={kindCounts} />
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search models by name…"
          aria-label="Search models by name"
          className="kicker border px-3 py-1.5"
          style={{ borderColor: "var(--color-rule-strong)", background: "var(--color-paper)", color: "var(--color-ink)", maxWidth: 320, fontFamily: "var(--font-mono)" }}
        />
        {/* Flows into the page — no inset scroll box; the sticky header rides the page scroll. */}
        <table className="w-full border-collapse">
          <thead>
            <tr>
              <Head>Alias</Head>
              <Head>Model</Head>
              <Head>Kind</Head>
              <Head>Ctx</Head>
              <Head>Compute</Head>
              <Head>tok/s</Head>
              <Head>Fit</Head>
              <Head>Size</Head>
              <Head>State</Head>
              <Head>Share</Head>
              <Head>Actions</Head>
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 ? (
              <tr>
                <td colSpan={11} className="px-2 py-6 text-center">
                  <span className="kicker" style={{ color: "var(--color-faint)" }}>no models match these filters</span>
                </td>
              </tr>
            ) : (
              visible.map(row)
            )}
          </tbody>
        </table>
        {downloads.some((d) => d.state === "error") && (
          <ul>
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
