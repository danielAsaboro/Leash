"use client";
/**
 * Settings → Devices → "Connect a device". Mints a single-use blind-pairing invite for a chosen
 * mesh (shown as a QR + copyable sync key), and joins another device's mesh from a pasted key.
 * Uses the EXISTING mesh proxy (POST /api/leash/hypha/mesh {action:"invite"|"join"}). Fresh-device
 * onboarding — re-pairing a broken member still needs the LAN PIN flow ("Pair over LAN" card).
 * Errors are surfaced, never silent-caught.
 */
import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { useRouter } from "next/navigation";
import { fetchWithTimeout } from "../lib/http.ts";
import type { MeshMembership } from "../lib/leash/hypha.ts";

export function DeviceConnectCard({ meshes }: { meshes: MeshMembership[] }) {
  const router = useRouter();
  const [meshId, setMeshId] = useState(meshes[0]?.meshId ?? "");
  const [invite, setInvite] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [joinKey, setJoinKey] = useState("");
  const [joinLabel, setJoinLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [joined, setJoined] = useState<string | null>(null);

  useEffect(() => {
    if (!invite) {
      setQr(null);
      return;
    }
    let alive = true;
    QRCode.toDataURL(invite, { margin: 1, width: 220 })
      .then((d) => {
        if (alive) setQr(d);
      })
      .catch(() => {
        if (alive) setQr(null);
      });
    return () => {
      alive = false;
    };
  }, [invite]);

  const mint = async () => {
    setBusy(true);
    setError(null);
    setInvite(null);
    setCopied(false);
    try {
      const r = await fetchWithTimeout("/api/leash/hypha/mesh", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "invite", meshId }) });
      const body = (await r.json().catch(() => ({}))) as { invite?: string; error?: string };
      if (!r.ok || body.error || !body.invite) setError(body.error ?? `Couldn't mint an invite (${r.status}).`);
      else setInvite(body.invite);
    } catch {
      setError("Request failed — is the Hypha daemon running? (Services → Mesh)");
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!invite) return;
    try {
      await navigator.clipboard.writeText(invite);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — the textarea is selectable */
    }
  };

  const join = async () => {
    const key = joinKey.trim();
    if (!key) return;
    setBusy(true);
    setError(null);
    setJoined(null);
    try {
      const r = await fetchWithTimeout("/api/leash/hypha/mesh", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "join", invite: key, label: joinLabel || "Mesh" }) });
      const body = (await r.json().catch(() => ({}))) as { meshId?: string; error?: string };
      if (!r.ok || body.error || !body.meshId) setError(body.error ?? `Join failed (${r.status}).`);
      else {
        setJoined(body.meshId);
        setJoinKey("");
        router.refresh();
      }
    } catch {
      setError("Request failed — is the Hypha daemon running?");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <div>
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <span className="kicker kicker-sage">Invite a device to a mesh</span>
          <span className="h-px flex-1" style={{ background: "var(--color-rule)" }} />
          {meshes.length > 0 && (
            <select value={meshId} onChange={(e) => setMeshId(e.target.value)} className="kicker border px-2 py-1.5" style={{ borderColor: "var(--color-rule-strong)", background: "var(--color-paper)", color: "var(--color-ink)" }}>
              {meshes.map((m) => (
                <option key={m.meshId} value={m.meshId}>
                  {m.label}
                </option>
              ))}
            </select>
          )}
          <button type="button" disabled={busy} onClick={() => void mint()} className="kicker px-3 py-1.5 transition-opacity hover:opacity-80 disabled:opacity-40" style={{ background: "var(--color-sage-deep)", color: "var(--color-cream)" }}>
            {invite ? "New invite" : "Show invite"}
          </button>
        </div>
        {invite && (
          <div className="flex flex-wrap items-start gap-4 border p-3" style={{ borderColor: "var(--color-rule)", background: "var(--color-cream)" }}>
            {qr && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={qr} alt="Pairing QR" width={180} height={180} style={{ imageRendering: "pixelated" }} />
            )}
            <div className="min-w-0 flex-1">
              <p className="kicker" style={{ color: "var(--color-faint)" }}>Sync key — paste on the other device’s “Join with a key”. Single-use; expires shortly.</p>
              <textarea readOnly value={invite} onFocus={(e) => e.currentTarget.select()} rows={3} className="mt-1 w-full border bg-transparent p-2" style={{ fontFamily: "var(--font-mono)", fontSize: "0.7rem", wordBreak: "break-all", borderColor: "var(--color-rule-strong)" }} />
              <button type="button" onClick={() => void copy()} className="kicker mt-1 border px-2 py-0.5 transition-opacity hover:opacity-70" style={{ borderColor: "var(--color-ink)" }}>
                {copied ? "copied" : "copy key"}
              </button>
            </div>
          </div>
        )}
      </div>

      <div>
        <div className="mb-2 flex items-center gap-2">
          <span className="kicker kicker-sage">Join with a key</span>
          <span className="h-px flex-1" style={{ background: "var(--color-rule)" }} />
        </div>
        <textarea value={joinKey} onChange={(e) => setJoinKey(e.target.value)} placeholder="Paste a sync key from another device…" rows={3} className="w-full border bg-transparent p-2" style={{ fontFamily: "var(--font-mono)", fontSize: "0.72rem", wordBreak: "break-all", borderColor: "var(--color-rule-strong)" }} />
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <input value={joinLabel} onChange={(e) => setJoinLabel(e.target.value)} placeholder="Label (e.g. Home)" className="border bg-transparent px-2 py-1.5" style={{ borderColor: "var(--color-rule-strong)", fontFamily: "var(--font-body)" }} />
          <button type="button" disabled={busy || !joinKey.trim()} onClick={() => void join()} className="kicker px-3 py-1.5 transition-opacity hover:opacity-80 disabled:opacity-40" style={{ background: "var(--color-sage-deep)", color: "var(--color-cream)" }}>
            Join
          </button>
          <span className="kicker" style={{ color: "var(--color-faint)" }}>Fresh devices only — re-pair a broken member via the LAN PIN card below.</span>
        </div>
        {joined && <p className="kicker mt-2" style={{ color: "var(--color-sage-deep)" }}>✓ Joined mesh {joined.slice(0, 8)}.</p>}
      </div>

      {error && (
        <p className="kicker" style={{ color: "var(--color-brick)" }} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
