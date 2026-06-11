"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronRightIcon, ChevronDownIcon, GlobeIcon, LogInIcon, PlusIcon, TicketIcon, LockIcon, LayersIcon, UsersIcon, PencilIcon, RefreshCwIcon, Trash2Icon } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { fetchWithTimeout, TIMEOUT } from "../lib/http.ts";
import type { MeshMembership, BorrowCounters } from "../lib/leash/hypha.ts";
import { meshEntryAction, type MeshIntent, type MeshVisibility } from "../lib/leash/mesh-entry.ts";
import { ForgetPeerButton, ClearStaleButton, RestorePeerButton } from "./MeshPeerActions.tsx";
import { IconButton } from "./IconButton.tsx";
import { MeshInvite } from "./mesh/MeshInvite.tsx";
import { MeshLanPairing, type PairStateView } from "./mesh/MeshLanPairing.tsx";

/**
 * The single mesh card (Settings → Devices → "My meshes"). The mesh is the unit — you join a
 * mesh (private or public), not "a node". It owns:
 *   · multi-mesh CRUD — found/join a mesh via two visibility-first forms (New, Join), each
 *     private (name / paste invite) or public (a shared id anyone can compute to meet)
 *   · per-mesh session — expand a mesh to see its DEVICES (compute class · RAM · power ·
 *     inflight · last-seen) + the models each advertises (● warm / ○ cold, P2P pull), plus
 *     "Invite a device" (QR + sync key) and "Pair over LAN" (PIN handshake) scoped to it
 *   · node-level model sharing — the master "share my models with peers" toggle, and the
 *     Disconnected-devices (tombstone) list with Restore
 * Peer/share data polls `/api/leash/hypha/share`; LAN pairing is one daemon-global session,
 * polled here once and passed to each mesh's MeshLanPairing. Errors shown inline, never
 * silent-caught.
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

interface ModelInfo {
  alias: string;
  modelType: string;
  borrowable: boolean;
}
interface SharePeer {
  deviceId: string;
  displayName: string;
  live: boolean;
  shareModels: boolean;
  models: string[];
  modelInfo: ModelInfo[];
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

/** Coerce any error value (string, {message}, or other object) to a renderable string. */
function errStr(e: unknown): string | null {
  if (e == null) return null;
  if (typeof e === "string") return e;
  if (typeof e === "object" && "message" in (e as object)) return String((e as { message: unknown }).message);
  return JSON.stringify(e);
}

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

/** Private | public segmented toggle for the New / Join forms. */
function VisToggle({ value, onChange }: { value: MeshVisibility; onChange: (v: MeshVisibility) => void }) {
  const opt = (v: MeshVisibility, Icon: LucideIcon, text: string) => {
    const on = value === v;
    return (
      <button
        type="button"
        onClick={() => onChange(v)}
        className="inline-flex items-center gap-1.5 px-2.5 py-1"
        style={{ fontFamily: "var(--font-mono)", fontSize: "0.66rem", letterSpacing: "0.06em", textTransform: "uppercase", border: "1px solid var(--color-rule-strong)", background: on ? "var(--color-ink)" : "transparent", color: on ? "var(--color-cream)" : "var(--color-muted)" }}
      >
        <Icon size={12} aria-hidden />
        {text}
      </button>
    );
  };
  return (
    <span className="inline-flex">
      {opt("private", LockIcon, "private")}
      {opt("public", GlobeIcon, "public")}
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
  // New / Join forms (each visibility-first).
  const [newOpen, setNewOpen] = useState(false);
  const [newVis, setNewVis] = useState<MeshVisibility>("private");
  const [newLabel, setNewLabel] = useState("");
  const [newSharedId, setNewSharedId] = useState("");
  const [joinOpen, setJoinOpen] = useState(false);
  const [joinVis, setJoinVis] = useState<MeshVisibility>("private");
  const [joinInvite, setJoinInvite] = useState("");
  const [joinLabel, setJoinLabel] = useState("");
  const [joinSharedId, setJoinSharedId] = useState("");
  // Live peer view + node-level sharing.
  const [share, setShare] = useState<ShareState | null>(null);
  const [shareErr, setShareErr] = useState<string | null>(null);
  const [shareBusy, setShareBusy] = useState(false);
  const [dls, setDls] = useState<Record<string, DlStatus>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // LAN pairing — one daemon-global session, polled here; pairingMeshId attributes it to a mesh.
  const [pairState, setPairState] = useState<PairStateView | null>(null);
  const [pairBusy, setPairBusy] = useState(false);
  const [pairErr, setPairErr] = useState<string | null>(null);
  const [pairingMeshId, setPairingMeshId] = useState<string | null>(null);
  const prevOutStatus = useRef<string | null>(null);

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

  /** Map a visibility-first form choice to a mesh action and run it. */
  const submitEntry = (intent: MeshIntent, visibility: MeshVisibility, fields: { label?: string; invite?: string; sharedId?: string }, after?: () => void): void => {
    const res = meshEntryAction({ intent, visibility, ...fields });
    if ("error" in res) {
      setErr(res.error);
      return;
    }
    void run(() => meshPost(res.action, res.payload), after);
  };

  const createMesh = (): void =>
    submitEntry("new", newVis, { label: newLabel, sharedId: newSharedId }, () => {
      setNewLabel("");
      setNewSharedId("");
      setNewOpen(false);
    });

  const joinMesh = (): void =>
    submitEntry("join", joinVis, { invite: joinInvite, label: joinLabel, sharedId: joinSharedId }, () => {
      setJoinInvite("");
      setJoinLabel("");
      setJoinSharedId("");
      setJoinOpen(false);
    });

  const deleteMesh = (meshId: string, label: string): void => {
    if (!confirm(`Delete the mesh "${label}"? This device stops serving it and drops the membership. This can't be undone.`)) return;
    void run(() => meshPost("delete", { meshId }));
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

  // LAN pairing poll — fast while a session is active, slow otherwise. Normalized defensively
  // (a stale daemon can return an unexpected shape). Clears the mesh attribution when mode ends.
  const refreshPair = useCallback(async () => {
    try {
      const r = await fetchWithTimeout("/api/leash/hypha/pair", { cache: "no-store" }, TIMEOUT.probe);
      const d = (await r.json()) as Record<string, unknown>;
      const mode = Boolean(d["mode"]);
      const outgoing = d["outgoing"] ? ({ ...(d["outgoing"] as PairStateView["outgoing"]), error: errStr((d["outgoing"] as { error?: unknown }).error) ?? undefined } as PairStateView["outgoing"]) : null;
      setPairState({
        mode,
        meshOnline: Boolean(d["meshOnline"]),
        expiresInMs: typeof d["expiresInMs"] === "number" ? (d["expiresInMs"] as number) : null,
        discovered: Array.isArray(d["discovered"]) ? (d["discovered"] as PairStateView["discovered"]) : [],
        outgoing,
        incoming: (d["incoming"] as PairStateView["incoming"]) ?? null,
        error: errStr(d["error"]) ?? (typeof d["mode"] === "boolean" ? null : "Hypha daemon needs a restart to enable pairing (Services → Mesh → Restart)."),
      });
      if (!mode) setPairingMeshId(null);
      // A completed pair adds a device (and possibly founds the primary mesh) — pull the
      // server-rendered membership/peer list forward once on the done transition.
      const outStatus = outgoing?.status ?? null;
      if (outStatus === "done" && prevOutStatus.current !== "done") router.refresh();
      prevOutStatus.current = outStatus;
    } catch {
      setPairErr("Couldn't reach the dashboard API.");
    }
  }, [router]);
  const pairAct = useCallback(
    async (action: string, extra: Record<string, unknown> = {}) => {
      setPairBusy(true);
      setPairErr(null);
      try {
        const r = await fetchWithTimeout("/api/leash/hypha/pair", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, ...extra }) });
        const body = (await r.json().catch(() => ({}))) as { error?: unknown };
        if (!r.ok || body.error) setPairErr(errStr(body.error) ?? `Request failed (${r.status}).`);
      } catch {
        setPairErr("Request failed — is the daemon running?");
      } finally {
        setPairBusy(false);
        await refreshPair();
      }
    },
    [refreshPair],
  );
  const startPair = (meshId: string): void => {
    setPairingMeshId(meshId);
    void pairAct("mode", { on: true, target: { meshId } });
  };
  useEffect(() => {
    void refreshPair();
    const ms = pairState?.mode ? 1500 : 5000;
    const t = setInterval(() => void refreshPair(), ms);
    return () => clearInterval(t);
  }, [refreshPair, pairState?.mode]);

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
  const ensureExpanded = (meshId: string): void =>
    setExpanded((prev) => (prev.has(meshId) ? prev : new Set(prev).add(meshId)));

  const have = new Set(share?.myModels ?? []);
  const peersOf = (meshId: string): SharePeer[] => (share?.peers ?? []).filter((p) => p.meshId === meshId);
  const staleCount = (share?.peers ?? []).filter((p) => !p.live).length;

  /** One advertised-model chip. Borrowable (chat/vision): ● warm / ○ cold + my local status
   * (✓ cached / % pulling / ↓ pull). Non-borrowable (embed/stt/tts): a dashed "· <modality> · local-only"
   * chip — advertised + pullable, but the SDK can't delegate it over the mesh (Phase-0 gate). */
  const modelChip = (m: ModelInfo, warm: boolean, peerShares: boolean) => {
    const { alias, modelType: mt, borrowable } = m;
    if (!borrowable) {
      return (
        <span
          key={alias}
          className="kicker inline-flex items-center gap-1 px-2 py-0.5"
          title={`${mt} — shared on this device, but not borrowable over the mesh (the SDK delegates chat & vision only)`}
          style={{ border: "1px dashed var(--color-rule-strong)", color: "var(--color-faint)" }}
        >
          {alias}
          <span style={{ opacity: 0.75 }}>· {mt} · local-only</span>
        </span>
      );
    }
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
        {mt !== "chat" && <span style={{ opacity: 0.8 }}>· {mt}</span>}
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
        <IconButton title="Join a mesh — private (paste an invite) or public (by shared id)" disabled={busy} onClick={() => setJoinOpen((v) => !v)}>
          <LogInIcon size={15} aria-hidden />
        </IconButton>
        <IconButton title="New mesh — found a private mesh or a public one" color="var(--color-sage-deep)" disabled={busy} onClick={() => setNewOpen((v) => !v)}>
          <PlusIcon size={15} aria-hidden />
        </IconButton>
      </div>

      {newOpen && (
        <div className="mt-3 border p-3" style={{ borderColor: "var(--color-sage-deep)", background: "var(--color-cream)" }}>
          <div className="flex flex-wrap items-center gap-2">
            <VisToggle value={newVis} onChange={setNewVis} />
            <span className="h-px flex-1" style={{ background: "var(--color-rule)" }} />
          </div>
          {newVis === "private" ? (
            <>
              <p className="kicker mt-2" style={kicker("var(--color-muted)")}>Found a private mesh — your own allow-listed devices. Name it, then invite devices from its session.</p>
              <div className="mt-1.5 flex flex-wrap items-center gap-2">
                <input value={newLabel} onChange={(e) => setNewLabel(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") createMesh(); }} placeholder="mesh name (e.g. Home, Work)" autoFocus className="border px-2 py-1" style={{ fontFamily: "var(--font-mono)", width: "14rem", borderColor: "var(--color-rule-strong)", background: "var(--color-paper)" }} />
                <button type="button" disabled={busy} onClick={createMesh} className="kicker px-3 py-1.5 transition-opacity hover:opacity-80" style={{ background: "var(--color-sage-deep)", color: "var(--color-cream)" }}>
                  {busy ? "creating…" : "Create mesh"}
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="kicker mt-2" style={kicker("var(--color-muted)")}>Public mesh — no pairing, broadcast-only. Every device that enters the same shared id auto-discovers the others and gossips. Anyone with the id can join.</p>
              <div className="mt-1.5 flex flex-wrap items-center gap-2">
                <input value={newSharedId} onChange={(e) => setNewSharedId(e.target.value)} placeholder="shared id (e.g. my-block-42)" className="border px-2 py-1" style={{ fontFamily: "var(--font-mono)", width: "14rem", borderColor: "var(--color-rule-strong)", background: "var(--color-paper)" }} />
                <input value={newLabel} onChange={(e) => setNewLabel(e.target.value)} placeholder="label (optional)" className="border px-2 py-1" style={{ fontFamily: "var(--font-mono)", width: "10rem", borderColor: "var(--color-rule-strong)", background: "var(--color-paper)" }} />
                <button type="button" disabled={busy || !newSharedId.trim()} onClick={createMesh} className="kicker px-3 py-1.5 transition-opacity hover:opacity-80" style={{ background: "var(--color-brick)", color: "var(--color-cream)" }}>
                  {busy ? "joining…" : "Create / join public"}
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {joinOpen && (
        <div className="mt-3 border p-3" style={{ borderColor: "var(--color-rule-strong)", background: "var(--color-cream)" }}>
          <div className="flex flex-wrap items-center gap-2">
            <VisToggle value={joinVis} onChange={setJoinVis} />
            <span className="h-px flex-1" style={{ background: "var(--color-rule)" }} />
          </div>
          {joinVis === "private" ? (
            <>
              <p className="kicker mt-2" style={kicker("var(--color-muted)")}>Paste an invite minted on another device (its session&rsquo;s &ldquo;Invite a device&rdquo;):</p>
              <textarea value={joinInvite} onChange={(e) => setJoinInvite(e.target.value.trim())} rows={2} placeholder="invite hex…" className="mt-1.5 w-full border px-2 py-1" style={{ fontFamily: "var(--font-mono)", fontSize: "0.72rem", wordBreak: "break-all", borderColor: "var(--color-rule-strong)", background: "var(--color-paper)", color: "var(--color-ink)" }} />
              <div className="mt-1.5 flex flex-wrap items-center gap-2">
                <input value={joinLabel} onChange={(e) => setJoinLabel(e.target.value)} placeholder="label (e.g. Work)" className="border px-2 py-1" style={{ fontFamily: "var(--font-mono)", width: "10rem", borderColor: "var(--color-rule-strong)", background: "var(--color-paper)" }} />
                <button type="button" disabled={busy || !joinInvite.trim()} onClick={joinMesh} className="kicker px-3 py-1.5 transition-opacity hover:opacity-80" style={{ background: "var(--color-sage-deep)", color: "var(--color-cream)" }}>
                  {busy ? "joining…" : "Join"}
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="kicker mt-2" style={kicker("var(--color-muted)")}>Join a public mesh — enter its shared id (any agreed name; devices computing the same id meet, no pairing).</p>
              <div className="mt-1.5 flex flex-wrap items-center gap-2">
                <input value={joinSharedId} onChange={(e) => setJoinSharedId(e.target.value)} placeholder="shared id (e.g. my-block-42)" className="border px-2 py-1" style={{ fontFamily: "var(--font-mono)", width: "14rem", borderColor: "var(--color-rule-strong)", background: "var(--color-paper)" }} />
                <input value={joinLabel} onChange={(e) => setJoinLabel(e.target.value)} placeholder="label (optional)" className="border px-2 py-1" style={{ fontFamily: "var(--font-mono)", width: "10rem", borderColor: "var(--color-rule-strong)", background: "var(--color-paper)" }} />
                <button type="button" disabled={busy || !joinSharedId.trim()} onClick={joinMesh} className="kicker px-3 py-1.5 transition-opacity hover:opacity-80" style={{ background: "var(--color-brick)", color: "var(--color-cream)" }}>
                  {busy ? "joining…" : "Join public"}
                </button>
              </div>
            </>
          )}
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
      {pairErr && (
        <p className="kicker mt-2" style={kicker("var(--color-brick)")} role="alert">
          {pairErr}
        </p>
      )}

      {meshes.length === 0 && (
        <div className="mt-3 border p-3" style={{ borderColor: "var(--color-rule)", background: "var(--color-cream)" }}>
          <p className="italic" style={{ color: "var(--color-faint)", fontFamily: "var(--font-body)", fontSize: "0.85rem" }}>
            No meshes yet — create one or join one above. You can also pair a nearby device to start your first mesh.
          </p>
          <div className="mt-2.5">
            <MeshLanPairing
              meshId=""
              pairState={pairState}
              busy={pairBusy}
              active={Boolean(pairState?.mode)}
              elsewhere={false}
              onStart={() => {
                setPairingMeshId(null);
                void pairAct("mode", { on: true });
              }}
              onAct={pairAct}
            />
          </div>
        </div>
      )}

      {meshes.length > 0 && (
        <ul className="mt-2 flex flex-col gap-2">
          {meshes.map((m) => {
            const open = expanded.has(m.meshId);
            const gp = peersOf(m.meshId);
            const pairingHere = Boolean(pairState?.mode) && (pairingMeshId === m.meshId || pairingMeshId === null);
            const pairingElsewhere = Boolean(pairState?.mode) && pairingMeshId !== null && pairingMeshId !== m.meshId;
            return (
              <li key={m.meshId} className="border" style={{ borderColor: "var(--color-rule)", background: "var(--color-cream)" }}>
                <div className="flex flex-wrap items-center gap-2.5 p-3">
                  <button type="button" onClick={() => toggleExpand(m.meshId)} aria-expanded={open} className="inline-flex items-center gap-2 transition-opacity hover:opacity-70" style={{ background: "none", border: "none", padding: 0, cursor: "pointer", color: "var(--color-muted)" }}>
                    {open ? <ChevronDownIcon size={14} aria-hidden /> : <ChevronRightIcon size={14} aria-hidden />}
                    <span className="kicker kicker-sage">{m.label}</span>
                  </button>
                  <span className="inline-flex flex-wrap items-center gap-2.5">
                    {m.visibility === "public"
                      ? metaBadge(GlobeIcon, "Public mesh — open, discoverable", undefined, "var(--color-brick)")
                      : metaBadge(LockIcon, "Private mesh — your allow-listed devices", undefined, "var(--color-muted)")}
                    {metaBadge(LayersIcon, `Tier ${m.tier} — routing priority`, m.tier)}
                    {metaBadge(UsersIcon, `${m.peers} device${m.peers === 1 ? "" : "s"} in this mesh`, m.peers)}
                    {m.writable
                      ? metaBadge(PencilIcon, "Writable — you can manage this mesh", undefined, "var(--color-sage-deep)")
                      : metaBadge(RefreshCwIcon, "Syncing — read-only until write access syncs", undefined, "var(--color-faint)")}
                  </span>
                  <span className="h-px flex-1" style={{ background: "var(--color-rule)" }} />
                  <IconButton title={`Invite a device to "${m.label}"`} color="var(--color-sage-deep)" disabled={busy} onClick={() => ensureExpanded(m.meshId)}>
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
                      <p className="kicker" style={kicker("var(--color-faint)")}>Loading devices…</p>
                    ) : gp.length === 0 ? (
                      <p className="italic" style={{ color: "var(--color-faint)", fontFamily: "var(--font-body)", fontSize: "0.85rem" }}>No devices in this mesh yet — invite one below, or wait for one to come online.</p>
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
                              {p.modelInfo.length === 0 ? (
                                <span className="kicker" style={kicker("var(--color-faint)")}>no models advertised</span>
                              ) : (
                                p.modelInfo.map((m) => modelChip(m, p.warmModels.includes(m.alias), p.shareModels))
                              )}
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                    <div className="mt-3 flex flex-col gap-3 border-t pt-3" style={{ borderColor: "var(--color-rule)" }}>
                      <MeshInvite meshId={m.meshId} label={m.label} />
                      <MeshLanPairing
                        meshId={m.meshId}
                        pairState={pairState}
                        busy={pairBusy}
                        active={pairingHere}
                        elsewhere={pairingElsewhere}
                        onStart={() => startPair(m.meshId)}
                        onAct={pairAct}
                      />
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
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
            Restore un-hides the device on this end; for full two-way reconnection, re-pair via a mesh&rsquo;s &ldquo;Pair over LAN&rdquo;.
          </p>
        </div>
      )}
    </div>
  );
}
