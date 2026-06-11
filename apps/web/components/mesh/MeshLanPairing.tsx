"use client";
/**
 * "Pair over LAN" — lives inside a single mesh's expanded session (Settings → Devices → My
 * meshes). Click-to-pair over the local network with a PIN handshake; a device that pairs in
 * joins THIS mesh (target is fixed by prop — no selector). The LAN pairing session is a single
 * daemon-global, so the parent (MeshMembershipsSection) owns the poll and passes the state +
 * actions down, and renders the live handshake only under the mesh that started it. Errors are
 * surfaced, never silent-caught.
 */
import { useState } from "react";
import { WifiIcon } from "lucide-react";

const kicker = (color: string) => ({ color, fontFamily: "var(--font-mono)" as const });

export interface Discovered {
  deviceKey: string;
  name: string;
  computeClass: string;
  ramMB: number;
}
export interface PairStateView {
  mode: boolean;
  meshOnline: boolean;
  expiresInMs: number | null;
  discovered: Discovered[];
  outgoing: { targetName: string; status: "await-pin" | "pairing" | "done"; error?: string } | null;
  incoming: { initiatorName: string; pin: string } | null;
  error: string | null;
}

export function MeshLanPairing({
  pairState,
  busy,
  active,
  elsewhere,
  onStart,
  onAct,
}: {
  /** The mesh a paired-in device will join (target is set by the parent's onStart). */
  meshId: string;
  /** Lifted, normalized daemon pairing state (null while the first poll is in flight). */
  pairState: PairStateView | null;
  busy: boolean;
  /** Pairing mode is on AND was started for THIS mesh. */
  active: boolean;
  /** Pairing mode is on for a DIFFERENT mesh — this one can't start until it ends. */
  elsewhere: boolean;
  /** Enter pairing mode targeting this mesh. */
  onStart: () => void;
  /** POST a pairing action (start/submit-pin/cancel) and refresh. */
  onAct: (action: string, extra?: Record<string, unknown>) => void;
}) {
  const [pin, setPin] = useState("");
  if (!pairState) return null;
  const { expiresInMs, discovered, outgoing, incoming, error } = pairState;
  const secs = expiresInMs != null ? Math.ceil(expiresInMs / 1000) : null;

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1.5">
          <WifiIcon size={13} aria-hidden style={{ color: "var(--color-muted)" }} />
          <span className="kicker" style={kicker("var(--color-faint)")}>Pair over LAN</span>
        </span>
        <span className="h-px flex-1" style={{ background: "var(--color-rule)" }} />
        {active ? (
          <>
            <span className="kicker" style={kicker("var(--color-sage-deep)")}>discoverable{secs != null ? ` · ${secs}s` : ""}</span>
            <button type="button" disabled={busy} onClick={() => onAct("cancel")} className="kicker border px-3 py-1 transition-opacity hover:opacity-70" style={{ borderColor: "var(--color-rule-strong)", color: "var(--color-muted)" }}>
              Stop
            </button>
          </>
        ) : elsewhere ? (
          <span className="kicker" style={kicker("var(--color-faint)")} title="Pairing is active in another mesh — stop it there first.">pairing active elsewhere…</span>
        ) : (
          <button type="button" disabled={busy} onClick={onStart} className="kicker px-3 py-1 transition-opacity hover:opacity-80 disabled:opacity-40" style={{ background: "var(--color-sage-deep)", color: "var(--color-cream)" }}>
            Add a device
          </button>
        )}
      </div>

      {active && error && (
        <p className="kicker mt-1.5" style={kicker("var(--color-brick)")} role="alert">
          {error}
        </p>
      )}

      {active && incoming && (
        <div className="mt-2 border p-3" style={{ borderColor: "var(--color-sage-deep)", background: "var(--color-cream)" }}>
          <p className="kicker" style={kicker("var(--color-muted)")}>
            {incoming.initiatorName} wants to pair — type this PIN on that device:
          </p>
          <p style={{ fontFamily: "var(--font-mono)", fontSize: "1.8rem", letterSpacing: "0.3em", color: "var(--color-sage-deep)" }}>{incoming.pin}</p>
        </div>
      )}

      {active && outgoing && (
        <div className="mt-2 border p-3" style={{ borderColor: "var(--color-rule-strong)", background: "var(--color-cream)" }}>
          {outgoing.status === "done" ? (
            <p className="kicker" style={kicker("var(--color-sage-deep)")}>✓ Paired with {outgoing.targetName}.</p>
          ) : outgoing.status === "pairing" ? (
            <p className="kicker" style={kicker("var(--color-muted)")}>Pairing with {outgoing.targetName}…</p>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <span className="kicker" style={kicker("var(--color-muted)")}>Enter the PIN shown on {outgoing.targetName}:</span>
              <input
                value={pin}
                onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
                inputMode="numeric"
                placeholder="######"
                className="border px-2 py-1"
                style={{ fontFamily: "var(--font-mono)", letterSpacing: "0.2em", width: "7rem", borderColor: "var(--color-rule-strong)", background: "var(--color-paper)" }}
              />
              <button type="button" disabled={busy || pin.length < 6} onClick={() => { onAct("submit-pin", { pin }); setPin(""); }} className="kicker px-3 py-1.5 transition-opacity hover:opacity-80" style={{ background: "var(--color-sage-deep)", color: "var(--color-cream)" }}>
                Pair
              </button>
            </div>
          )}
          {outgoing.error && (
            <p className="kicker mt-1" style={kicker("var(--color-brick)")} role="alert">
              {outgoing.error}
            </p>
          )}
        </div>
      )}

      {active && !outgoing && !incoming && (
        <ul className="mt-2 flex flex-col gap-1.5">
          {discovered.length === 0 && (
            <li className="kicker" style={kicker("var(--color-faint)")}>Searching for nearby devices… (open &ldquo;Add a device&rdquo; on the other one too)</li>
          )}
          {discovered.map((d) => (
            <li key={d.deviceKey} className="flex flex-wrap items-center gap-2 border p-2" style={{ borderColor: "var(--color-rule)", background: "var(--color-cream)" }}>
              <span className="kicker kicker-sage">{d.name}</span>
              <span className="kicker" style={kicker("var(--color-faint)")}>{d.computeClass} · {Math.round(d.ramMB / 1024)}GB</span>
              <span className="h-px flex-1" style={{ background: "var(--color-rule)" }} />
              <button type="button" disabled={busy} onClick={() => onAct("start", { deviceKey: d.deviceKey })} className="kicker px-3 py-1 transition-opacity hover:opacity-80" style={{ background: "var(--color-sage-deep)", color: "var(--color-cream)" }}>
                Pair
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
