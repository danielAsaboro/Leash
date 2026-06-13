"use client";

/**
 * ActivityTicker — the live delegation feed, mirroring the `/events` SSE the graph animates from.
 * Newest first, capped. Each line is a real routing event: a request fanning out, a completion
 * with tokens/latency, or a fault. This is the "what just moved through the mesh" readout beside
 * the topology — the same stream that lights the wires, in words.
 */
import type { MeshEvent } from "./types.ts";

function label(e: MeshEvent): { verb: string; cls: string } {
  if (e.kind === "failed") return { verb: "failed", cls: "fail" };
  if (e.kind === "done") return { verb: e.tokens != null ? "completed" : "returned", cls: "done" };
  return { verb: "routed", cls: "route" };
}

function detail(e: MeshEvent): string {
  const bits: string[] = [];
  if (e.alias) bits.push(e.alias);
  else if (e.endpoint) bits.push(e.endpoint.replace(/^\/v1\//, ""));
  if (e.tokens != null) bits.push(`${e.tokens} tok`);
  if (e.bytes != null) bits.push(`${(e.bytes / 1024).toFixed(1)} KB`);
  if (e.ms != null) bits.push(`${e.ms} ms`);
  if (e.peers != null && e.kind === "route") bits.push(`${e.peers} target${e.peers === 1 ? "" : "s"}`);
  return bits.join(" · ");
}

function clock(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

export function ActivityTicker({ events, connected }: { events: MeshEvent[]; connected: boolean }) {
  return (
    <div className="mesh-ticker">
      <header className="mesh-ticker-head">
        <span className={`mesh-dot ${connected ? "is-pulse" : ""}`} style={{ background: connected ? "var(--mesh-glow)" : "var(--mesh-faint)" }} />
        <span>live activity</span>
        <span className="mesh-ticker-conn">{connected ? "streaming" : "waiting"}</span>
      </header>
      <ul className="mesh-ticker-list">
        {events.length === 0 && <li className="mesh-ticker-empty">No delegations yet. Run a chat that borrows a peer's model and it lights up here.</li>}
        {events.map((e, i) => {
          const { verb, cls } = label(e);
          return (
            <li key={`${e.ts}-${i}`} className={`mesh-ticker-row is-${cls}`}>
              <span className="mesh-ticker-time">{clock(e.ts)}</span>
              <span className={`mesh-ticker-verb is-${cls}`}>{verb}</span>
              <span className="mesh-ticker-peer">{e.peer ? `${e.peer.slice(0, 8)}…` : "mesh"}</span>
              <span className="mesh-ticker-detail">{detail(e)}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
