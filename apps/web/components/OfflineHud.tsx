"use client";

/**
 * OfflineHud — the live "is anything leaving this device?" instrument. Polls
 * `/api/leash/netmon` every 5s and shows a single honest badge:
 *
 *   ✈️ 0 cloud connections   (sage, pulsing)  — the stack is talking only to itself + the mesh
 *   ⚠️ N cloud               (brick)          — N established sockets to non-private hosts (expand for host:port)
 *   monitor unavailable      (muted)          — lsof couldn't run; we will NOT claim a fake 0
 *
 * P2P mesh peers are LAN, not cloud — shown separately and labeled. The HUD is the live
 * continuous indicator; the recorded airplane-mode acceptance test is the hard proof.
 */
import { useEffect, useRef, useState } from "react";
import { toast } from "./Toast.tsx";

interface NetSocket {
  command: string;
  pid: string;
  remote: string;
}
interface NetMon {
  ok: boolean;
  error?: string;
  sampledAt: string;
  monitored: string[];
  loopback: number;
  lan: NetSocket[];
  cloud: NetSocket[];
}

const POLL_MS = 5000;

export function OfflineHud() {
  const [data, setData] = useState<NetMon | null>(null);
  const [open, setOpen] = useState(false);
  const prevCloud = useRef<number | null>(null);
  const prevUnavailable = useRef<boolean | null>(null);

  useEffect(() => {
    let alive = true;
    const tick = async (): Promise<void> => {
      try {
        const r = await fetch("/api/leash/netmon", { cache: "no-store" });
        const j = (await r.json()) as NetMon;
        if (alive) {
          setData(j);
          const cloud = j.cloud?.length ?? 0;
          const unavailable = !j.ok;
          if (prevCloud.current !== null && prevCloud.current === 0 && cloud > 0) toast.error(`${cloud} cloud connection${cloud === 1 ? "" : "s"} detected`);
          if (prevUnavailable.current !== null && !prevUnavailable.current && unavailable) toast.error("Connection monitor unavailable");
          prevCloud.current = cloud;
          prevUnavailable.current = unavailable;
        }
      } catch {
        if (alive) {
          setData({ ok: false, error: "monitor unreachable", sampledAt: new Date().toISOString(), monitored: [], loopback: 0, lan: [], cloud: [] });
          if (prevUnavailable.current === false) toast.error("Connection monitor unreachable");
          prevCloud.current = 0;
          prevUnavailable.current = true;
        }
      }
    };
    void tick();
    const id = setInterval(() => void tick(), POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const unavailable = !data || !data.ok;
  const cloudCount = data?.cloud.length ?? 0;
  const lanCount = data?.lan.length ?? 0;
  const alert = !unavailable && cloudCount > 0;

  const accent = unavailable ? "var(--color-faint)" : alert ? "var(--color-brick)" : "var(--color-glow)";
  const label = unavailable ? "monitor unavailable" : alert ? `${cloudCount} cloud connection${cloudCount === 1 ? "" : "s"}` : "0 cloud connections";
  const glyph = unavailable ? "—" : alert ? "⚠️" : "✈️";

  return (
    <div style={{ position: "fixed", right: 16, bottom: 16, zIndex: 60, fontFamily: "var(--font-mono)" }}>
      {open && data && (
        <div
          style={{
            marginBottom: 8,
            width: 320,
            maxHeight: 320,
            overflowY: "auto",
            background: "var(--color-control)",
            border: `1px solid var(--color-control-line)`,
            borderRadius: 10,
            padding: "12px 14px",
            color: "var(--color-cream)",
            boxShadow: "0 8px 28px rgba(0,0,0,0.32)",
            fontSize: 11,
            lineHeight: 1.5,
          }}
        >
          <div style={{ letterSpacing: "0.16em", textTransform: "uppercase", color: "var(--color-faint)", fontSize: 9, marginBottom: 8 }}>
            connection monitor
          </div>

          {alert ? (
            <Section title={`cloud — ${cloudCount}`} color="var(--color-brick)" rows={data.cloud} />
          ) : (
            <div style={{ color: "var(--color-glow)", marginBottom: 8 }}>No cloud sockets in the QVAC stack.</div>
          )}

          <Section title={`mesh / lan — ${lanCount}`} color="var(--color-glow)" rows={data.lan} />

          <div style={{ color: "var(--color-faint)", marginTop: 6 }}>loopback (same device): {data.loopback}</div>

          <div style={{ marginTop: 10, paddingTop: 8, borderTop: `1px solid var(--color-control-line)`, color: "var(--color-faint)" }}>
            Watches established TCP from {data.monitored.length ? data.monitored.slice(0, 6).join(", ") : "node/tsx/bun/qvac/next"} processes, sampled every {POLL_MS / 1000}s. Mesh peers are LAN, not cloud.
            {data.error ? <div style={{ color: "var(--color-brick)", marginTop: 4 }}>{data.error}</div> : null}
          </div>
        </div>
      )}

      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Connection monitor — what's leaving this device"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          background: "var(--color-control)",
          border: `1px solid var(--color-control-line)`,
          borderRadius: 999,
          padding: "7px 13px",
          color: "var(--color-cream)",
          fontSize: 11,
          letterSpacing: "0.04em",
          cursor: "pointer",
        }}
      >
        <span
          aria-hidden
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: accent,
            boxShadow: `0 0 0 0 ${accent}`,
            animation: unavailable ? undefined : "ping 1.8s cubic-bezier(0,0,0.2,1) infinite alternate",
          }}
        />
        <span aria-hidden>{glyph}</span>
        <span>{label}</span>
        {!unavailable && lanCount > 0 ? <span style={{ color: "var(--color-faint)" }}>· {lanCount} mesh</span> : null}
      </button>
    </div>
  );
}

function Section({ title, color, rows }: { title: string; color: string; rows: NetSocket[] }) {
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ color, letterSpacing: "0.1em", textTransform: "uppercase", fontSize: 9, marginBottom: 3 }}>{title}</div>
      {rows.length === 0 ? (
        <div style={{ color: "var(--color-faint)" }}>none</div>
      ) : (
        rows.slice(0, 10).map((s, i) => (
          <div key={`${s.pid}-${s.remote}-${i}`} style={{ color: "var(--color-cream)", opacity: 0.9 }}>
            {s.remote} <span style={{ color: "var(--color-faint)" }}>· {s.command}</span>
          </div>
        ))
      )}
    </div>
  );
}
