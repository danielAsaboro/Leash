"use client";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronRightIcon, ChevronDownIcon, GlobeIcon, LogInIcon, PlusIcon, TicketIcon, CopyIcon, CheckIcon, LockIcon, LayersIcon, UsersIcon, PencilIcon, RefreshCwIcon, Trash2Icon } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { fetchWithTimeout, TIMEOUT } from "../lib/http.ts";
import type { MeshMembership, BorrowCounters } from "../lib/leash/hypha.ts";
import { ForgetPeerButton, ClearStaleButton, RestorePeerButton } from "./MeshPeerActions.tsx";
import { IconButton } from "./IconButton.tsx";

/**
 * The single mesh + peer browser (Settings → Devices → My meshes). It owns:
 *   · multi-mesh CRUD — FOUND a private mesh, mint a blind invite, JOIN by invite, join a public cell
 *   · per-mesh peers — click a mesh to expand its NODES (compute class · RAM · power · inflight ·
 *     last-seen) and the models each advertises (● warm / ○ cold), with a P2P Pull for any you
 *     don't have, and Disconnect per peer
 *   · node-level model sharing — the master "share my models with peers" toggle, and the
 *     Disconnected-devices (tombstone) list with Restore
 * Peer/share data polls `/api/leash/hypha/share` (reads the daemon `/peers`); mesh/forgotten/borrow
 * come from the server (refreshed on action). Errors shown inline, never silent-caught.
 */

const kicker = (color: string) => ({ color, fontFamily: "var(--font-mono)" as const });

interface MeshActionResult {
  ok: boolean;
  error?: string;
  invite?: string;
  meshId?: string;
}

async function meshPost(action: string, extra: Record<string, unknown> = {}): Promise<MeshActionResult> {
  try {
    const r = await fetchWithTimeout("/api/leash/hypha/mesh", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, ...extra }) });
    const body = (await r.json().catch(() => ({}))) as MeshActionResult;
    if (!r.ok || body.error) return { ok: false, error: body.error ?? `Request failed (${r.status}).` };
    return { ...body, ok: true };
  } catch {
    return { ok: false, error: "Request failed — is the daemon running?" };
  }
}

interface SharePeer {
  deviceId: string;
  displayName: string;
  live: boolean;
  shareModels: boolean;
  models: string[];
  warmModels: string[];
  computeClass: string;
  ramMB: number;
  powerState: string;
  inflight: number;
  lastSeen: string;
  meshId?: string;
}
interface ShareState { shareModels: boolean; peers: SharePeer[]; aliasToName: Record<string, string>; myModels: string[] }
interface DlStatus { name: string; state: string; percentage: number }

/** A compact classification badge — icon + (optional) value, with the full label in the hover title. */
function metaBadge(Icon: LucideIcon, title: string, value?: string | number, color = "var(--color-faint)") {
  return (
    <span className="inline-flex items-center gap-1" title={title} style={{ color }}>
      <Icon size={13} aria-hidden />
      {value != null && <span className="kicker">{value}</span>}
      <span className="sr-only">{title}</span>
    </span>
  );
}

function ago(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return "—";
  const m = Math.floor(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

export function MeshMembershipsSection({ meshes, forgotten, borrow }: { meshes: MeshMembership[]; forgotten: string[]; borrow: BorrowCounters | null }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [invite, setInvite] = useState<{ label: string; hex: string } | null>(null);
  const [joinOpen, setJoinOpen] = useState(false);
  const [joinInvite, setJoinInvite] = useState("");
  const [joinLabel, setJoinLabel] = useState("");
  const [publicOpen, setPublicOpen] = useState(false);
  const [cellId, setCellId] = useState("");
  const [cellLabel, setCellLabel] = useState("");
  const [newOpen, setNewOpen] = useState(false);
  const [newLabel, setNewLabel] = useState("");
  // Live peer view + node-level sharing.
  const [share, setShare] = useState<ShareState | null>(null);
  const [shareErr, setShareErr] = useState<string | null>(null);
  const [shareBusy, setShareBusy] = useState(false);
  const [dls, setDls] = useState<Record<string, DlStatus>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const run = async (fn: () => Promise<MeshActionResult>, after?: () => void): Promise<void> => {
    setBusy(true);
    setErr(null);
    const res = await fn();
    setBusy(false);
    if (!res.ok) {
      setErr(res.error ?? "Failed.");
      return;
    }
    after?.();
    router.refresh();
  };

  const createMesh = (): void =>
    void run(
      () => meshPost("new", { label: newLabel.trim() || "Mesh" }),
      () => {
        setNewLabel("");
        setNewOpen(false);
      },
    );

  const getInvite = (meshId: string, label: string): void =>
    void run(async () => {
      const res = await meshPost("invite", { meshId });
      if (res.ok && res.invite) setInvite({ label, hex: res.invite });
      return res;
    });

  const deleteMesh = (meshId: string, label: string): void => {
    if (!confirm(`Delete the mesh "${label}"? This device stops serving it and drops the membership. This can't be undone.`)) return;
    void run(() => meshPost("delete", { meshId }));
  };

  const joinMesh = (): void => {
    if (!joinInvite.trim()) {
      setErr("Paste an invite first.");
      return;
    }
    void run(
      () => meshPost("join", { invite: joinInvite.trim(), label: joinLabel || "Mesh" }),
      () => {
        setJoinInvite("");
        setJoinLabel("");
        setJoinOpen(false);
      },
    );
  };

  const joinPublic = (): void => {
    if (!cellId.trim()) {
      setErr("Enter a cell id (any agreed name — devices computing the same id meet, no pairing).");
      return;
    }
    void run(
      () => meshPost("public-join", { cellId: cellId.trim(), label: cellLabel || "Public cell" }),
      () => {
        setCellId("");
        setCellLabel("");
        setPublicOpen(false);
      },
    );
  };

  // Peer + share state — polled (the detail is live: liveness, inflight, pull progress).
  const loadShare = useCallback(async () => {
    try {
      const r = await fetchWithTimeout("/api/leash/hypha/share", { cache: "no-store" }, TIMEOUT.probe);
      const d = (await r.json()) as ShareState & { ok?: boolean; error?: string };
      if (!r.ok || d.ok === false) throw new Error(d.error ?? "couldn't load mesh peers");
      setShare({ shareModels: d.shareModels, peers: d.peers ?? [], aliasToName: d.aliasToName ?? {}, myModels: d.myModels ?? [] });
      setShareErr(null);
    } catch (e) {
      setShareErr(e instanceof Error ? e.message : String(e));
    }
  }, []);
  const pollDownloads = useCallback(async () => {
    try {
      const r = await fetchWithTimeout("/api/leash/models/download", { cache: "no-store" }, TIMEOUT.probe);
      const d = (await r.json()) as { downloads?: DlStatus[] };
      const map: Record<string, DlStatus> = {};
      for (const x of d.downloads ?? []) map[x.name] = x;
      setDls(map);
    } catch {
      /* status poll is best-effort */
    }
  }, []);
  useEffect(() => {
    void loadShare();
    const a = setInterval(() => void loadShare(), 6000);
    const b = setInterval(() => void pollDownloads(), 2500);
    return () => {
      clearInterval(a);
      clearInterval(b);
    };
  }, [loadShare, pollDownloads]);

  const toggleNodeShare = async (on: boolean): Promise<void> => {
    setShareBusy(true);
    try {
      const r = await fetchWithTimeout("/api/leash/hypha/share", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ on }) }, TIMEOUT.crud);
      if (!r.ok) throw new Error("toggle failed");
      setShare((p) => (p ? { ...p, shareModels: on } : p));
    } catch (e) {
      setShareErr(e instanceof Error ? e.message : String(e));
    } finally {
      setShareBusy(false);
    }
  };
  const pull = async (alias: string): Promise<void> => {
    const name = share?.aliasToName[alias];
    if (!name) {
      setShareErr(`can't resolve "${alias}" to a registry model to pull`);
      return;
    }
    try {
      await fetchWithTimeout("/api/leash/models/download", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) }, TIMEOUT.heavy);
      void pollDownloads();
    } catch (e) {
      setShareErr(e instanceof Error ? e.message : String(e));
    }
  };
  const toggleExpand = (meshId: string): void =>
    setExpanded((prev) => {
      const n = new Set(prev);
      if (n.has(meshId)) n.delete(meshId);
      else n.add(meshId);
      return n;
    });

  const have = new Set(share?.myModels ?? []);
  const peersOf = (meshId: string): SharePeer[] => (share?.peers ?? []).filter((p) => p.meshId === meshId);
  const staleCount = (share?.peers ?? []).filter((p) => !p.live).length;

  /** One advertised-model chip: ● warm / ○ cold on the peer, plus my local status (✓ cached / % pulling / ↓ pull). */
  const modelChip = (alias: string, warm: boolean, peerShares: boolean) => {
    const mine = have.has(alias);
    const name = share?.aliasToName[alias];
    const dl = name ? dls[name] : undefined;
    const pulling = dl && (dl.state === "downloading" || dl.state === "starting");
    return (
      <span
        key={alias}
        className="kicker inline-flex items-center gap-1 px-2 py-0.5"
        title={warm ? "warm — pre-loaded on the peer, ready for instant overflow" : "advertised — not yet pre-warmed on the peer"}
        style={warm ? { background: "var(--color-sage-deep)", color: "var(--color-cream)" } : { border: "1px solid var(--color-rule-strong)", color: "var(--color-muted)" }}
      >
        {warm ? "● " : "○ "}
        {alias}
        {mine ? (
          <span title="cached on this device">✓</span>
        ) : pulling ? (
          <span>{Math.floor(dl!.percentage)}%</span>
        ) : dl?.state === "done" ? (
          <span>✓</span>
        ) : peerShares ? (
          <button type="button" onClick={() => void pull(alias)} style={{ color: warm ? "var(--color-cream)" : "var(--color-glow)", background: "none", border: "none", padding: 0, cursor: "pointer", font: "inherit" }}>
            ↓ pull
          </button>
        ) : null}
      </span>
    );
  };

  return (
    <div className="mt-4 border-t pt-3" style={{ borderColor: "var(--color-rule)" }}>
      <div className="flex flex-wrap items-center gap-3">
        <span className="kicker" style={kicker("var(--color-faint)")}>
          Meshes{meshes.length > 0 ? ` · ${meshes.length}` : ""}
        </span>
        {share && (
          <button
            type="button"
            disabled={shareBusy}
            onClick={() => void toggleNodeShare(!share.shareModels)}
            title="Share this device's cached models with mesh peers (they can discover + pull them over P2P)"
            className="inline-flex items-center gap-1.5"
            style={{ fontFamily: "var(--font-mono)", fontSize: "0.66rem", letterSpacing: "0.06em", textTransform: "uppercase", color: share.shareModels ? "var(--color-sage-deep)" : "var(--color-faint)", background: "none", border: "1px solid var(--color-rule)", borderRadius: 999, padding: "2px 9px", cursor: "pointer" }}
          >
            <span aria-hidden className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: share.shareModels ? "var(--color-sage)" : "var(--color-faint)" }} />
            {share.shareModels ? "sharing models" : "models private"}
          </button>
        )}
        {staleCount > 0 && <ClearStaleButton count={staleCount} />}
        <span className="h-px flex-1" style={{ background: "var(--color-rule)" }} />
        {borrow && (
          <span className="kicker" style={kicker("var(--color-faint)")}>
            borrowed: {borrow.shed} shed · {borrow.availabilityRouted} routed{borrow.overflowFailures > 0 ? ` · ${borrow.overflowFailures} fell back` : ""}
          </span>
        )}
        <IconButton title="Join a public cell (no pairing — same cell id meets)" color="var(--color-brick)" disabled={busy} onClick={() => setPublicOpen((v) => !v)}>
          <GlobeIcon size={15} aria-hidden />
        </IconButton>
        <IconButton title="Join a mesh by pasting an invite" disabled={busy} onClick={() => setJoinOpen((v) => !v)}>
          <LogInIcon size={15} aria-hidden />
        </IconButton>
        <IconButton title="New mesh — found a private mesh" color="var(--color-sage-deep)" disabled={busy} onClick={() => setNewOpen((v) => !v)}>
          <PlusIcon size={15} aria-hidden />
        </IconButton>
      </div>

      {newOpen && (
        <div className="mt-3 border p-3" style={{ borderColor: "var(--color-sage-deep)", background: "var(--color-cream)" }}>
          <p className="kicker" style={kicker("var(--color-muted)")}>
            Found a new private mesh — your own allow-listed devices. Name it, then invite devices with “Get invite”.
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <input
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") createMesh();
              }}
              placeholder="mesh name (e.g. Home, Work)"
              autoFocus
              className="border px-2 py-1"
              style={{ fontFamily: "var(--font-mono)", width: "14rem", borderColor: "var(--color-rule-strong)", background: "var(--color-paper)" }}
            />
            <button type="button" disabled={busy} onClick={createMesh} className="kicker px-3 py-1.5 transition-opacity hover:opacity-80" style={{ background: "var(--color-sage-deep)", color: "var(--color-cream)" }}>
              {busy ? "creating…" : "Create mesh"}
            </button>
          </div>
        </div>
      )}

      {publicOpen && (
        <div className="mt-3 border p-3" style={{ borderColor: "var(--color-brick)", background: "var(--color-cream)" }}>
          <p className="kicker" style={kicker("var(--color-muted)")}>
            Join a public cell — no pairing. Every device that enters the same cell id auto-discovers each other over the network and gossips (broadcast-only). (A geofenced cell id is Phase 3.)
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <input value={cellId} onChange={(e) => setCellId(e.target.value)} placeholder="cell id (e.g. my-block-42)" className="border px-2 py-1" style={{ fontFamily: "var(--font-mono)", width: "14rem", borderColor: "var(--color-rule-strong)", background: "var(--color-paper)" }} />
            <input value={cellLabel} onChange={(e) => setCellLabel(e.target.value)} placeholder="label (optional)" className="border px-2 py-1" style={{ fontFamily: "var(--font-mono)", width: "10rem", borderColor: "var(--color-rule-strong)", background: "var(--color-paper)" }} />
            <button type="button" disabled={busy || !cellId.trim()} onClick={joinPublic} className="kicker px-3 py-1.5 transition-opacity hover:opacity-80" style={{ background: "var(--color-brick)", color: "var(--color-cream)" }}>
              {busy ? "joining…" : "Join cell"}
            </button>
          </div>
        </div>
      )}

      {err && (
        <p className="kicker mt-2" style={kicker("var(--color-brick)")} role="alert">
          {err}
        </p>
      )}
      {shareErr && (
        <p className="kicker mt-2" style={kicker("var(--color-brick)")} role="alert">
          {shareErr}
        </p>
      )}

      {meshes.length > 0 && (
        <ul className="mt-2 flex flex-col gap-2">
          {meshes.map((m) => {
            const open = expanded.has(m.meshId);
            const gp = peersOf(m.meshId);
            return (
              <li key={m.meshId} className="border" style={{ borderColor: "var(--color-rule)", background: "var(--color-cream)" }}>
                <div className="flex flex-wrap items-center gap-2.5 p-3">
                  <button type="button" onClick={() => toggleExpand(m.meshId)} aria-expanded={open} className="inline-flex items-center gap-2 transition-opacity hover:opacity-70" style={{ background: "none", border: "none", padding: 0, cursor: "pointer", color: "var(--color-muted)" }}>
                    {open ? <ChevronDownIcon size={14} aria-hidden /> : <ChevronRightIcon size={14} aria-hidden />}
                    <span className="kicker kicker-sage">{m.label}</span>
                  </button>
                  <span className="inline-flex flex-wrap items-center gap-2.5">
                    {m.visibility === "public"
                      ? metaBadge(GlobeIcon, "Public cell — open, discoverable", undefined, "var(--color-brick)")
                      : metaBadge(LockIcon, "Private mesh — your allow-listed devices", undefined, "var(--color-muted)")}
                    {metaBadge(LayersIcon, `Tier ${m.tier} — routing priority`, m.tier)}
                    {metaBadge(UsersIcon, `${m.peers} peer${m.peers === 1 ? "" : "s"} in this mesh`, m.peers)}
                    {m.writable
                      ? metaBadge(PencilIcon, "Writable — you can manage this mesh", undefined, "var(--color-sage-deep)")
                      : metaBadge(RefreshCwIcon, "Syncing — read-only until write access syncs", undefined, "var(--color-faint)")}
                  </span>
                  <span className="h-px flex-1" style={{ background: "var(--color-rule)" }} />
                  <IconButton title={`Get an invite for "${m.label}"`} color="var(--color-sage-deep)" disabled={busy} onClick={() => getInvite(m.meshId, m.label)}>
                    <TicketIcon size={15} aria-hidden />
                  </IconButton>
                  {m.creator && (
                    <IconButton title={`Delete "${m.label}" — you created this mesh`} danger disabled={busy} onClick={() => deleteMesh(m.meshId, m.label)}>
                      <Trash2Icon size={15} aria-hidden />
                    </IconButton>
                  )}
                </div>
                {open && (
                  <div className="border-t px-3 py-2.5" style={{ borderColor: "var(--color-rule)" }}>
                    {!share ? (
                      <p className="kicker" style={kicker("var(--color-faint)")}>Loading peers…</p>
                    ) : gp.length === 0 ? (
                      <p className="italic" style={{ color: "var(--color-faint)", fontFamily: "var(--font-body)", fontSize: "0.85rem" }}>No peer nodes in this mesh yet — pair a device, or wait for one to come online.</p>
                    ) : (
                      <ul className="flex flex-col gap-2">
                        {gp.map((p) => (
                          <li key={p.deviceId || p.displayName}>
                            <div className="flex flex-wrap items-center gap-2.5">
                              <span aria-hidden className="inline-block h-2 w-2 rounded-full" title={p.live ? "live (heartbeat fresh)" : "stale"} style={{ background: p.live ? "var(--color-sage)" : "var(--color-faint)" }} />
                              <span className="kicker kicker-sage">{p.displayName}</span>
                              <span className="kicker" style={kicker("var(--color-faint)")}>
                                {p.computeClass} · {Math.round(p.ramMB / 1024)}GB · {p.powerState}
                                {p.inflight > 0 ? ` · ${p.inflight} in flight` : ""}
                                {p.lastSeen ? ` · seen ${ago(p.lastSeen)}` : ""}
                                {!p.live ? " · stale" : ""}
                              </span>
                              <span className="h-px flex-1" style={{ background: "var(--color-rule)" }} />
                              {p.deviceId && <ForgetPeerButton deviceKey={p.deviceId} name={p.displayName} />}
                            </div>
                            <div className="mt-1.5 flex flex-wrap gap-1.5">
                              {p.models.length === 0 ? (
                                <span className="kicker" style={kicker("var(--color-faint)")}>no chat models advertised</span>
                              ) : (
                                p.models.map((alias) => modelChip(alias, p.warmModels.includes(alias), p.shareModels))
                              )}
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {invite && (
        <div className="mt-3 border p-3" style={{ borderColor: "var(--color-sage-deep)", background: "var(--color-cream)" }}>
          <p className="kicker" style={kicker("var(--color-muted)")}>
            Invite for &ldquo;{invite.label}&rdquo; — paste it into &ldquo;Join a mesh&rdquo; on the other device (one-time):
          </p>
          <textarea
            readOnly
            value={invite.hex}
            onFocus={(e) => e.currentTarget.select()}
            rows={2}
            className="mt-1.5 w-full border px-2 py-1"
            style={{ fontFamily: "var(--font-mono)", fontSize: "0.72rem", wordBreak: "break-all", borderColor: "var(--color-rule-strong)", background: "var(--color-paper)", color: "var(--color-ink)" }}
          />
          <div className="mt-1.5 flex gap-1">
            <IconButton title="Copy invite" onClick={() => void navigator.clipboard?.writeText(invite.hex)}>
              <CopyIcon size={15} aria-hidden />
            </IconButton>
            <IconButton title="Done" color="var(--color-sage-deep)" onClick={() => setInvite(null)}>
              <CheckIcon size={15} aria-hidden />
            </IconButton>
          </div>
        </div>
      )}

      {joinOpen && (
        <div className="mt-3 border p-3" style={{ borderColor: "var(--color-rule-strong)", background: "var(--color-cream)" }}>
          <p className="kicker" style={kicker("var(--color-muted)")}>
            Paste an invite minted on another device (its &ldquo;Get invite&rdquo;):
          </p>
          <textarea
            value={joinInvite}
            onChange={(e) => setJoinInvite(e.target.value.trim())}
            rows={2}
            placeholder="invite hex…"
            className="mt-1.5 w-full border px-2 py-1"
            style={{ fontFamily: "var(--font-mono)", fontSize: "0.72rem", wordBreak: "break-all", borderColor: "var(--color-rule-strong)", background: "var(--color-paper)", color: "var(--color-ink)" }}
          />
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <input
              value={joinLabel}
              onChange={(e) => setJoinLabel(e.target.value)}
              placeholder="label (e.g. Work)"
              className="border px-2 py-1"
              style={{ fontFamily: "var(--font-mono)", width: "10rem", borderColor: "var(--color-rule-strong)", background: "var(--color-paper)" }}
            />
            <button type="button" disabled={busy || !joinInvite.trim()} onClick={joinMesh} className="kicker px-3 py-1.5 transition-opacity hover:opacity-80" style={{ background: "var(--color-sage-deep)", color: "var(--color-cream)" }}>
              {busy ? "joining…" : "Join"}
            </button>
          </div>
        </div>
      )}

      {forgotten.length > 0 && (
        <div className="mt-4 border-t pt-3" style={{ borderColor: "var(--color-rule)" }}>
          <span className="kicker" style={kicker("var(--color-faint)")}>Disconnected devices</span>
          <ul className="mt-2 flex flex-col gap-2">
            {forgotten.map((key) => (
              <li key={key} className="flex flex-wrap items-center gap-2.5 border p-3" style={{ borderColor: "var(--color-rule)", background: "var(--color-cream)" }}>
                <span aria-hidden className="inline-block h-2 w-2 rounded-full" title="disconnected (tombstoned on this device)" style={{ background: "var(--color-brick)" }} />
                <span className="kicker" style={{ fontFamily: "var(--font-mono)" }} title={key}>
                  {key.slice(0, 16)}…
                </span>
                <span className="h-px flex-1" style={{ background: "var(--color-rule)" }} />
                <RestorePeerButton deviceKey={key} />
              </li>
            ))}
          </ul>
          <p className="mt-1.5" style={{ color: "var(--color-faint)", fontSize: "0.78rem", fontFamily: "var(--font-body)" }}>
            Restore un-hides the device on this end; for full two-way reconnection, re-pair via &ldquo;Connect a device&rdquo;.
          </p>
        </div>
      )}
    </div>
  );
}
