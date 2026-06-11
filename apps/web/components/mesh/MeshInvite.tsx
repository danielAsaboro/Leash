"use client";
/**
 * "Invite a device" — lives inside a single mesh's expanded session (Settings → Devices → My
 * meshes). Mints a single-use blind-pairing invite FOR THIS MESH and shows it as a QR + a
 * copyable sync key. The mesh is fixed by prop (no selector) — you're already inside it.
 * Fresh-device onboarding; re-pairing a broken member still needs the LAN PIN flow below.
 * Uses the existing mesh proxy (POST /api/leash/hypha/mesh {action:"invite", meshId}).
 * Errors are surfaced, never silent-caught.
 */
import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { TicketIcon } from "lucide-react";
import { fetchWithTimeout } from "../../lib/http.ts";

const kicker = (color: string) => ({ color, fontFamily: "var(--font-mono)" as const });

export function MeshInvite({ meshId, label }: { meshId: string; label: string }) {
  const [invite, setInvite] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  const mint = async (): Promise<void> => {
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

  const copy = async (): Promise<void> => {
    if (!invite) return;
    try {
      await navigator.clipboard.writeText(invite);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — the textarea is selectable */
    }
  };

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1.5">
          <TicketIcon size={13} aria-hidden style={{ color: "var(--color-sage-deep)" }} />
          <span className="kicker" style={kicker("var(--color-faint)")}>Invite a device</span>
        </span>
        <span className="h-px flex-1" style={{ background: "var(--color-rule)" }} />
        <button type="button" disabled={busy} onClick={() => void mint()} className="kicker px-3 py-1 transition-opacity hover:opacity-80 disabled:opacity-40" style={{ background: "var(--color-sage-deep)", color: "var(--color-cream)" }}>
          {busy ? "minting…" : invite ? "New invite" : "Show invite"}
        </button>
      </div>

      {invite && (
        <div className="mt-2 flex flex-wrap items-start gap-4 border p-3" style={{ borderColor: "var(--color-rule)", background: "var(--color-cream)" }}>
          {qr && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={qr} alt={`Invite QR for ${label}`} width={160} height={160} style={{ imageRendering: "pixelated" }} />
          )}
          <div className="min-w-0 flex-1">
            <p className="kicker" style={kicker("var(--color-faint)")}>
              Sync key for &ldquo;{label}&rdquo; — paste on the other device&rsquo;s &ldquo;Join a mesh&rdquo;. Single-use; expires shortly.
            </p>
            <textarea readOnly value={invite} onFocus={(e) => e.currentTarget.select()} rows={3} className="mt-1 w-full border bg-transparent p-2" style={{ fontFamily: "var(--font-mono)", fontSize: "0.7rem", wordBreak: "break-all", borderColor: "var(--color-rule-strong)" }} />
            <button type="button" onClick={() => void copy()} className="kicker mt-1 border px-2 py-0.5 transition-opacity hover:opacity-70" style={{ borderColor: "var(--color-ink)" }}>
              {copied ? "copied" : "copy key"}
            </button>
          </div>
        </div>
      )}

      {error && (
        <p className="kicker mt-1.5" style={kicker("var(--color-brick)")} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
