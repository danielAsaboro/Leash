"use client";
import { useCallback, useEffect, useState } from "react";
import { fetchWithTimeout } from "../lib/http.ts";
import type { MeshMembership } from "../lib/leash/hypha.ts";

/**
 * "Add a device" — the LAN click-to-pair flow in the Mesh (Hypha) card. Toggles the
 * daemon's pairing mode, polls its state, lists nearby devices, and runs the PIN handshake
 * (type the target's PIN here; show our PIN when someone pairs with us). Errors are shown,
 * never silent-caught.
 */

interface Discovered {
  deviceKey: string;
  name: string;
  computeClass: string;
  ramMB: number;
}
interface PairState {
  mode: boolean;
  meshOnline: boolean;
  expiresInMs: number | null;
  discovered: Discovered[];
  outgoing: { targetName: string; status: "await-pin" | "pairing" | "done"; error?: string } | null;
  incoming: { initiatorName: string; pin: string } | null;
  error: string | null;
}

const kicker = (color: string) => ({ color, fontFamily: "var(--font-mono)" as const });

/** Coerce any error value (string, {message}, or other object) to a renderable string. */
function errStr(e: unknown): string | null {
  if (e == null) return null;
  if (typeof e === "string") return e;
  if (typeof e === "object" && "message" in (e as object)) return String((e as { message: unknown }).message);
  return JSON.stringify(e);
}

export function AddDeviceSection({ meshes }: { meshes: MeshMembership[] }) {
  const [state, setState] = useState<PairState | null>(null);
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  // Which mesh THIS device offers if another device pairs into it (per-mesh PIN — spec §3).
  const [selMesh, setSelMesh] = useState<string>(meshes[0]?.meshId ?? "");

  const refresh = useCallback(async () => {
    try {
      const r = await fetchWithTimeout("/api/leash/hypha/pair", { cache: "no-store" });
      const d = (await r.json()) as Record<string, unknown>;
      // Normalize defensively — a stale daemon (pre-Part-B) can return an unexpected shape.
      setState({
        mode: Boolean(d["mode"]),
        meshOnline: Boolean(d["meshOnline"]),
        expiresInMs: typeof d["expiresInMs"] === "number" ? (d["expiresInMs"] as number) : null,
        discovered: Array.isArray(d["discovered"]) ? (d["discovered"] as Discovered[]) : [],
        outgoing: d["outgoing"] ? { ...(d["outgoing"] as PairState["outgoing"]), error: errStr((d["outgoing"] as { error?: unknown }).error) ?? undefined } as PairState["outgoing"] : null,
        incoming: (d["incoming"] as PairState["incoming"]) ?? null,
        error: errStr(d["error"]) ?? (typeof d["mode"] === "boolean" ? null : "Hypha daemon needs a restart to enable pairing (Services → Mesh → Restart)."),
      });
    } catch {
      setActionError("Couldn't reach the dashboard API.");
    }
  }, []);

  const act = useCallback(
    async (action: string, extra: Record<string, unknown> = {}) => {
      setBusy(true);
      setActionError(null);
      try {
        const r = await fetchWithTimeout("/api/leash/hypha/pair", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, ...extra }) });
        const body = (await r.json().catch(() => ({}))) as { error?: unknown };
        if (!r.ok || body.error) setActionError(errStr(body.error) ?? `Request failed (${r.status}).`);
      } catch {
        setActionError("Request failed — is the daemon running?");
      } finally {
        setBusy(false);
        await refresh();
      }
    },
    [refresh],
  );

  // Enter pairing mode offering the selected mesh (or a new one). A fresh device with no meshes
  // yet offers nothing → the daemon defaults to founding/serving the primary mesh.
  const startAdd = async (): Promise<void> => {
    const sel = selMesh || meshes[0]?.meshId || "";
    let target: { meshId?: string; newMeshLabel?: string } | undefined;
    if (sel === "__new") {
      const label = prompt("Name the new mesh (e.g. Home, Work):", "Mesh");
      if (label == null) return;
      target = { newMeshLabel: label || "Mesh" };
    } else if (sel) {
      target = { meshId: sel };
    }
    await act("mode", { on: true, ...(target ? { target } : {}) });
  };

  // Poll fast while pairing mode is active, slow otherwise.
  useEffect(() => {
    void refresh();
    const ms = state?.mode ? 1500 : 5000;
    const t = setInterval(() => void refresh(), ms);
    return () => clearInterval(t);
  }, [refresh, state?.mode]);

  if (!state) return null;
  const { mode, expiresInMs, discovered, outgoing, incoming, error } = state;
  const secs = expiresInMs != null ? Math.ceil(expiresInMs / 1000) : null;

  return (
    <div className="mt-4 border-t pt-3" style={{ borderColor: "var(--color-rule)" }}>
      <div className="flex flex-wrap items-center gap-3">
        <span className="kicker" style={kicker("var(--color-faint)")}>
          Add a device
        </span>
        <span className="h-px flex-1" style={{ background: "var(--color-rule)" }} />
        {!mode ? (
          <div className="flex flex-wrap items-center gap-2">
            {meshes.length > 0 && (
              <select
                value={selMesh || meshes[0]?.meshId || ""}
                onChange={(e) => setSelMesh(e.target.value)}
                title="which mesh a device pairing into you will join"
                className="kicker border px-2 py-1.5"
                style={{ borderColor: "var(--color-rule-strong)", background: "var(--color-paper)", color: "var(--color-ink)" }}
              >
                {meshes.map((m) => (
                  <option key={m.meshId} value={m.meshId}>
                    {m.label} ({m.visibility})
                  </option>
                ))}
                <option value="__new">+ New mesh…</option>
              </select>
            )}
            <button type="button" disabled={busy} onClick={() => void startAdd()} className="kicker px-3 py-1.5 transition-opacity hover:opacity-80" style={{ background: "var(--color-sage-deep)", color: "var(--color-cream)" }}>
              Add a device
            </button>
          </div>
        ) : (
          <>
            <span className="kicker" style={kicker("var(--color-sage-deep)")}>
              discoverable{secs != null ? ` · ${secs}s` : ""}
            </span>
            <button type="button" disabled={busy} onClick={() => void act("cancel")} className="kicker border px-3 py-1.5 transition-opacity hover:opacity-70" style={{ borderColor: "var(--color-rule-strong)", color: "var(--color-muted)" }}>
              Stop
            </button>
          </>
        )}
      </div>

      {(error || actionError) && (
        <p className="kicker mt-2" style={kicker("var(--color-brick)")} role="alert">
          {actionError ?? error}
        </p>
      )}

      {mode && incoming && (
        <div className="mt-3 border p-3" style={{ borderColor: "var(--color-sage-deep)", background: "var(--color-cream)" }}>
          <p className="kicker" style={kicker("var(--color-muted)")}>
            {incoming.initiatorName} wants to pair — type this PIN on that device:
          </p>
          <p style={{ fontFamily: "var(--font-mono)", fontSize: "1.8rem", letterSpacing: "0.3em", color: "var(--color-sage-deep)" }}>{incoming.pin}</p>
        </div>
      )}

      {mode && outgoing && (
        <div className="mt-3 border p-3" style={{ borderColor: "var(--color-rule-strong)", background: "var(--color-cream)" }}>
          {outgoing.status === "done" ? (
            <p className="kicker" style={kicker("var(--color-sage-deep)")}>
              ✓ Paired with {outgoing.targetName}.
            </p>
          ) : outgoing.status === "pairing" ? (
            <p className="kicker" style={kicker("var(--color-muted)")}>
              Pairing with {outgoing.targetName}…
            </p>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <span className="kicker" style={kicker("var(--color-muted)")}>
                Enter the PIN shown on {outgoing.targetName}:
              </span>
              <input
                value={pin}
                onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
                inputMode="numeric"
                placeholder="######"
                className="border px-2 py-1"
                style={{ fontFamily: "var(--font-mono)", letterSpacing: "0.2em", width: "7rem", borderColor: "var(--color-rule-strong)", background: "var(--color-paper)" }}
              />
              <button type="button" disabled={busy || pin.length < 6} onClick={() => void act("submit-pin", { pin })} className="kicker px-3 py-1.5 transition-opacity hover:opacity-80" style={{ background: "var(--color-sage-deep)", color: "var(--color-cream)" }}>
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

      {mode && !outgoing && !incoming && (
        <ul className="mt-3 flex flex-col gap-1.5">
          {discovered.length === 0 && (
            <li className="kicker" style={kicker("var(--color-faint)")}>
              Searching for nearby devices… (open "Add a device" on the other one too)
            </li>
          )}
          {discovered.map((d) => (
            <li key={d.deviceKey} className="flex flex-wrap items-center gap-2 border p-2" style={{ borderColor: "var(--color-rule)", background: "var(--color-cream)" }}>
              <span className="kicker kicker-sage">{d.name}</span>
              <span className="kicker" style={kicker("var(--color-faint)")}>
                {d.computeClass} · {Math.round(d.ramMB / 1024)}GB
              </span>
              <span className="h-px flex-1" style={{ background: "var(--color-rule)" }} />
              <button type="button" disabled={busy} onClick={() => void act("start", { deviceKey: d.deviceKey })} className="kicker px-3 py-1 transition-opacity hover:opacity-80" style={{ background: "var(--color-sage-deep)", color: "var(--color-cream)" }}>
                Pair
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
