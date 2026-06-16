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
  const INVITE_TTL_S = 60; // a minted invite is single-use + short-lived; auto-dismiss the QR after this.
  const [invite, setInvite] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);

  useEffect(() => {
    if (!invite) {
      setQr(null);
      return;
    }
    let alive = true;
    QRCode.toDataURL(invite, { margin: 1, width: 320 })
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

  // Auto-dismiss the QR at the TTL (a fresh invite is single-use; a stale QR on screen is misleading).
  useEffect(() => {
    if (!invite) return;
    const id = setTimeout(() => {
      setInvite(null);
      setCopied(false);
    }, INVITE_TTL_S * 1000);
    return () => clearTimeout(id);
  }, [invite]);

  // Visible countdown (a 1s tick) that drives the timer label + bar.
  useEffect(() => {
    if (!invite) {
      setSecondsLeft(0);
      return;
    }
    setSecondsLeft(INVITE_TTL_S);
    const id = setInterval(() => setSecondsLeft((s) => (s > 0 ? s - 1 : 0)), 1000);
    return () => clearInterval(id);
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
        <div className="mt-2 flex flex-col items-center gap-3 border p-5" style={{ borderColor: "var(--color-rule)", background: "var(--color-cream)" }}>
          {qr && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={qr} alt={`Invite QR for ${label}`} width={240} height={240} style={{ imageRendering: "pixelated" }} />
          )}
          <p className="kicker max-w-[320px] text-center" style={kicker("var(--color-faint)")}>
            Scan from the Leash phone app — Mesh tab → &ldquo;Scan mesh invite QR&rdquo;. Single-use ·{" "}
            <span style={{ color: secondsLeft <= 10 ? "var(--color-brick)" : "var(--color-muted)" }}>
              expires in {secondsLeft}s
            </span>
          </p>
          {/* timer bar — drains over the TTL, then the QR auto-dismisses */}
          <div className="h-0.5 w-full max-w-[240px] overflow-hidden" style={{ background: "var(--color-rule)" }}>
            <div
              style={{
                height: "100%",
                width: `${(secondsLeft / INVITE_TTL_S) * 100}%`,
                background: secondsLeft <= 10 ? "var(--color-brick)" : "var(--color-sage-deep)",
                transition: "width 1s linear",
              }}
            />
          </div>
          <div className="flex items-center gap-2">
            <code
              title={invite}
              className="px-2.5 py-1 text-xs"
              style={{ fontFamily: "var(--font-mono)", background: "var(--color-paper)", border: "1px solid var(--color-rule)", color: "var(--color-muted)" }}
            >
              {invite.slice(0, 10)}…{invite.slice(-6)}
            </code>
            <button
              type="button"
              onClick={() => void copy()}
              className="kicker border px-3 py-1 transition-opacity hover:opacity-80"
              style={{
                background: copied ? "var(--color-sage-deep)" : "transparent",
                color: copied ? "var(--color-cream)" : "var(--color-ink)",
                borderColor: copied ? "var(--color-sage-deep)" : "var(--color-ink)",
              }}
            >
              {copied ? "✓ copied" : "copy key"}
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
