"use client";

/**
 * MeshCanvas — the living-mesh visualization for ONE mesh. This device sits at the hub; every
 * peer in `meshId` orbits it. Two real feeds drive it:
 *   • `/api/leash/hypha/peers` (polled) → topology + each node's status (compute, models, inflight),
 *     scoped to this mesh by the peer's `meshId`.
 *   • `/api/leash/hypha/events` (SSE)   → live delegation routing — lights the exact wire + node a
 *     request flows through, then settles on completion/fault.
 * Nodes are draggable (positions are preserved across live updates); a quiet mesh shows a quiet
 * graph. Nothing here is synthetic. Daemon-down is surfaced, not faked.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Edge,
  type Node,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { DeviceNode } from "./DeviceNode.tsx";
import { SelfNode } from "./SelfNode.tsx";
import { MeshWire } from "./MeshWire.tsx";
import { ActivityTicker } from "./ActivityTicker.tsx";
import type { MeshEvent, NodeStatus, PeerView, PeersResponse } from "./types.ts";

const POLL_MS = 4000;
const TICKER_CAP = 40;
/** How long a node/wire stays lit after the last event of each class. */
const HOLD = { active: 6000, done: 2200, failed: 3500 } as const;

const nodeTypes = { device: DeviceNode, self: SelfNode };
const edgeTypes = { wire: MeshWire };

interface Activity {
  state: "active" | "done" | "failed";
  alias?: string;
  tokens?: number;
  ms?: number;
  error?: string;
  until: number;
}

function statusFor(peer: PeerView, act: Activity | undefined, now: number): NodeStatus {
  if (!peer.live) return "offline";
  if (act && act.until > now) {
    if (act.state === "failed") return "failed";
    if (act.state === "active") return "running";
  }
  if (peer.inflight > 0) return "running";
  if (peer.warm) return "warm";
  return "idle";
}

function MeshCanvasInner({ meshId, meshLabel }: { meshId?: string; meshLabel?: string }) {
  const [resp, setResp] = useState<PeersResponse | null>(null);
  const [down, setDown] = useState<string | null>(null);
  const [events, setEvents] = useState<MeshEvent[]>([]);
  const [connected, setConnected] = useState(false);
  // peerId(16) → latest activity; mutated via ref, surfaced through `tick` re-renders.
  const activity = useRef<Map<string, Activity>>(new Map());
  const [tick, setTick] = useState(0);
  // Stable layout: remember each peer's slot so the ring doesn't reshuffle on every poll.
  const layout = useRef<{ sig: string; pos: Map<string, { x: number; y: number }> }>({ sig: "", pos: new Map() });

  const rf = useReactFlow();
  const [rfNodes, setRfNodes, onNodesChange] = useNodesState<Node>([]);
  const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const didFit = useRef(false);

  // ── topology poll ──────────────────────────────────────────────────────────────────────
  useEffect(() => {
    let alive = true;
    const run = async (): Promise<void> => {
      try {
        const r = await fetch("/api/leash/hypha/peers", { cache: "no-store" });
        const j = (await r.json()) as PeersResponse;
        if (!alive) return;
        if (j.ok === false || !r.ok) setDown(j.error ?? "Hypha daemon not running.");
        else {
          setDown(null);
          setResp(j);
        }
      } catch {
        if (alive) setDown("Couldn't reach the Hypha daemon.");
      }
    };
    void run();
    const id = setInterval(() => void run(), POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  // ── live routing SSE ───────────────────────────────────────────────────────────────────
  useEffect(() => {
    const es = new EventSource("/api/leash/hypha/events");
    es.addEventListener("ready", () => setConnected(true));
    es.addEventListener("down", () => setConnected(false));
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (m) => {
      let e: MeshEvent;
      try {
        e = JSON.parse(m.data) as MeshEvent;
      } catch {
        return;
      }
      if (!e || !e.kind) return;
      setConnected(true);
      setEvents((prev) => [e, ...prev].slice(0, TICKER_CAP));
      if (e.peer) {
        const state = e.kind === "failed" ? "failed" : e.kind === "done" ? "done" : "active";
        activity.current.set(e.peer, { state, alias: e.alias, tokens: e.tokens, ms: e.ms, error: e.error, until: Date.now() + HOLD[state] });
        setTick((t) => t + 1);
      }
    };
    return () => es.close();
  }, []);

  // ── expiry ticker — re-derive while anything is still lit ────────────────────────────────
  useEffect(() => {
    const id = setInterval(() => {
      const now = Date.now();
      let changed = false;
      for (const [k, a] of activity.current) {
        if (a.until <= now) {
          activity.current.delete(k);
          changed = true;
        }
      }
      if (changed || [...activity.current.values()].some((a) => a.until > now)) setTick((t) => t + 1);
    }, 700);
    return () => clearInterval(id);
  }, []);

  // Peers scoped to this mesh (peers carry their meshId from the router).
  const peers = useMemo(
    () => (resp?.peers ?? []).filter((p) => !meshId || p.meshId === meshId),
    [resp, meshId],
  );
  const peerIds = useMemo(() => new Set(peers.map((p) => p.peerId).filter(Boolean) as string[]), [peers]);
  const now = Date.now();

  // Recompute ring slots only when the membership set changes.
  const positions = useMemo(() => {
    const ids = peers.map((p) => p.peerId ?? p.deviceId).sort();
    const sig = ids.join("|");
    if (sig !== layout.current.sig) {
      const pos = new Map<string, { x: number; y: number }>();
      const n = Math.max(peers.length, 1);
      const R = 300 + Math.min(n, 10) * 26;
      peers.forEach((p, i) => {
        const key = p.peerId ?? p.deviceId;
        const angle = -Math.PI / 2 + (i / n) * Math.PI * 2;
        pos.set(key, { x: Math.cos(angle) * R - 105, y: Math.sin(angle) * R - 46 });
      });
      layout.current = { sig, pos };
    }
    return layout.current.pos;
  }, [peers]);

  const totalInflight = peers.reduce((s, p) => s + (p.inflight || 0), 0);
  const liveCount = peers.filter((p) => p.live).length;
  const anyRunning = totalInflight > 0 || [...activity.current.values()].some((a) => a.state === "active" && a.until > now);

  // ── derived graph ────────────────────────────────────────────────────────────────────────
  const derivedNodes: Node[] = useMemo(() => {
    const list: Node[] = [
      {
        id: "self",
        type: "self",
        position: { x: -72, y: -48 },
        data: {
          meshId: meshId ?? resp?.meshId ?? null,
          meshLabel: meshLabel ?? resp?.meshes?.[0]?.label ?? "My mesh",
          peerCount: peers.length,
          liveCount,
          totalInflight,
          wallet: resp?.self?.wallet ?? null,
          busy: anyRunning,
        },
      },
    ];
    for (const p of peers) {
      const key = p.peerId ?? p.deviceId;
      const act = p.peerId ? activity.current.get(p.peerId) : undefined;
      const status = statusFor(p, act, now);
      list.push({
        id: key,
        type: "device",
        position: positions.get(key) ?? { x: 0, y: 0 },
        data: { peer: p, status, lastEvent: act ? { kind: act.state, alias: act.alias, tokens: act.tokens, ms: act.ms, error: act.error } : undefined },
      });
    }
    return list;
    // tick drives activity-derived status/data; positions is the stable layout.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [peers, positions, totalInflight, liveCount, anyRunning, meshId, meshLabel, resp, tick]);

  const derivedEdges: Edge[] = useMemo(() => {
    return peers.map((p) => {
      const key = p.peerId ?? p.deviceId;
      const act = p.peerId ? activity.current.get(p.peerId) : undefined;
      const lit = act && act.until > now;
      const state = lit ? act!.state : "idle";
      const note = lit
        ? act!.state === "failed"
          ? "failed"
          : [act!.alias, act!.tokens != null ? `${act!.tokens} tok` : null, act!.ms != null ? `${act!.ms} ms` : null].filter(Boolean).join(" · ")
        : undefined;
      return { id: `self-${key}`, source: "self", target: key, type: "wire", data: { state, note } };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [peers, tick]);

  // ── sync derived → React Flow state, preserving any user-dragged positions ───────────────
  useEffect(() => {
    setRfNodes((prev) => {
      const byId = new Map(prev.map((n) => [n.id, n]));
      return derivedNodes.map((d) => {
        const ex = byId.get(d.id);
        return ex ? { ...d, position: ex.position } : d;
      });
    });
  }, [derivedNodes, setRfNodes]);

  useEffect(() => {
    setRfEdges(derivedEdges);
  }, [derivedEdges, setRfEdges]);

  // Frame the graph once nodes first arrive.
  useEffect(() => {
    if (rfNodes.length > 1 && !didFit.current) {
      didFit.current = true;
      const t = setTimeout(() => rf.fitView({ padding: 0.28, duration: 400 }), 80);
      return () => clearTimeout(t);
    }
    return;
  }, [rfNodes.length, rf]);

  // Ticker scoped to this mesh: events touching one of its peers, or stamped with its meshId.
  const meshEvents = useMemo(
    () => (meshId ? events.filter((e) => (e.meshId ? e.meshId === meshId : e.peer ? peerIds.has(e.peer) : false)) : events),
    [events, meshId, peerIds],
  );

  const empty = !down && peers.length === 0;

  return (
    <div className="mesh-canvas">
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView
        fitViewOptions={{ padding: 0.28 }}
        minZoom={0.3}
        maxZoom={1.6}
        nodesConnectable={false}
        elementsSelectable={false}
        proOptions={{ hideAttribution: true }}
        colorMode="light"
      >
        <Background variant={BackgroundVariant.Dots} gap={26} size={1.4} color="var(--mesh-grid)" />
        <Controls showInteractive={false} position="bottom-right" />
      </ReactFlow>

      <ActivityTicker events={meshEvents} connected={connected} />

      {down && (
        <div className="mesh-overlay">
          <div className="mesh-overlay-card">
            <span className="mesh-dot" style={{ background: "var(--mesh-brick)" }} />
            <p className="mesh-overlay-title">Mesh daemon offline</p>
            <p className="mesh-overlay-body">{down}</p>
            <p className="mesh-overlay-hint">Start Hypha on the Services page, then this view fills in.</p>
          </div>
        </div>
      )}
      {empty && (
        <div className="mesh-overlay mesh-overlay-soft">
          <div className="mesh-overlay-card">
            <p className="mesh-overlay-title">No peers in this mesh</p>
            <p className="mesh-overlay-body">This device is the only node here. Pair another Mac into this mesh in Settings → Devices and it appears.</p>
          </div>
        </div>
      )}
    </div>
  );
}

export function MeshCanvas({ meshId, meshLabel }: { meshId?: string; meshLabel?: string; visibility?: string }) {
  // Provider so floating edges + fitView can read internal node geometry.
  return (
    <ReactFlowProvider>
      <MeshCanvasInner meshId={meshId} meshLabel={meshLabel} />
    </ReactFlowProvider>
  );
}
