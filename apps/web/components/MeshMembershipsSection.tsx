"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { fetchWithTimeout } from "../lib/http.ts";
import type { MeshMembership } from "../lib/leash/hypha.ts";

/**
 * Multi-mesh management in the Hypha card (spec §3): the memberships this device holds, plus the
 * controls to FOUND a new private mesh, mint a blind invite for one (to add a device), and JOIN
 * another mesh by pasting an invite. The LAN PIN "Add a device" flow below stays for the primary
 * mesh; this is the blind-invite path that scales to N meshes. Errors shown inline, never silent.
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

export function MeshMembershipsSection({ meshes }: { meshes: MeshMembership[] }) {
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

  const newMesh = (): void => {
    const label = prompt("Name the new mesh (e.g. Home, Work):", "Mesh");
    if (label == null) return;
    void run(() => meshPost("new", { label: label || "Mesh" }));
  };

  const getInvite = (meshId: string, label: string): void =>
    void run(async () => {
      const res = await meshPost("invite", { meshId });
      if (res.ok && res.invite) setInvite({ label, hex: res.invite });
      return res;
    });

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

  return (
    <div className="mt-4 border-t pt-3" style={{ borderColor: "var(--color-rule)" }}>
      <div className="flex flex-wrap items-center gap-3">
        <span className="kicker" style={kicker("var(--color-faint)")}>
          Meshes{meshes.length > 0 ? ` · ${meshes.length}` : ""}
        </span>
        <span className="h-px flex-1" style={{ background: "var(--color-rule)" }} />
        <button type="button" disabled={busy} onClick={() => setPublicOpen((v) => !v)} className="kicker border px-3 py-1.5 transition-opacity hover:opacity-70" style={{ borderColor: "var(--color-rule-strong)", color: "var(--color-brick)" }}>
          Public cell
        </button>
        <button type="button" disabled={busy} onClick={() => setJoinOpen((v) => !v)} className="kicker border px-3 py-1.5 transition-opacity hover:opacity-70" style={{ borderColor: "var(--color-rule-strong)", color: "var(--color-muted)" }}>
          Join a mesh
        </button>
        <button type="button" disabled={busy} onClick={newMesh} className="kicker px-3 py-1.5 transition-opacity hover:opacity-80" style={{ background: "var(--color-sage-deep)", color: "var(--color-cream)" }}>
          {busy ? "…" : "New mesh"}
        </button>
      </div>

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

      {meshes.length > 0 && (
        <ul className="mt-2 flex flex-col gap-2">
          {meshes.map((m) => (
            <li key={m.meshId} className="flex flex-wrap items-center gap-2.5 border p-3" style={{ borderColor: "var(--color-rule)", background: "var(--color-cream)" }}>
              <span className="kicker kicker-sage">{m.label}</span>
              <span className="kicker" style={kicker("var(--color-faint)")}>
                tier {m.tier} · {m.visibility} · {m.peers} peer{m.peers === 1 ? "" : "s"} · {m.writable ? "writable ✓" : "syncing…"}
              </span>
              <span className="h-px flex-1" style={{ background: "var(--color-rule)" }} />
              <button type="button" disabled={busy} onClick={() => getInvite(m.meshId, m.label)} className="kicker border px-2 py-0.5 transition-opacity hover:opacity-70" style={{ borderColor: "var(--color-rule-strong)", color: "var(--color-sage-deep)" }}>
                Get invite
              </button>
            </li>
          ))}
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
          <div className="mt-1.5 flex gap-2">
            <button type="button" onClick={() => void navigator.clipboard?.writeText(invite.hex)} className="kicker border px-2 py-0.5 transition-opacity hover:opacity-70" style={{ borderColor: "var(--color-rule-strong)", color: "var(--color-muted)" }}>
              Copy
            </button>
            <button type="button" onClick={() => setInvite(null)} className="kicker border px-2 py-0.5 transition-opacity hover:opacity-70" style={{ borderColor: "var(--color-rule-strong)", color: "var(--color-muted)" }}>
              Done
            </button>
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
    </div>
  );
}
