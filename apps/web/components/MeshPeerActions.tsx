"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Client buttons for mesh membership management in the Hypha card: disconnect one peer, or
 * clear all stale peers. Both POST to /api/leash/hypha/mesh and refresh the page. Errors are
 * shown inline (never silent-caught).
 */

async function post(action: string, extra: Record<string, unknown> = {}): Promise<string | null> {
  try {
    const r = await fetch("/api/leash/hypha/mesh", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, ...extra }) });
    const body = (await r.json().catch(() => ({}))) as { error?: unknown };
    if (!r.ok || body.error) return typeof body.error === "string" ? body.error : `Request failed (${r.status}).`;
    return null;
  } catch {
    return "Request failed — is the daemon running?";
  }
}

export function ForgetPeerButton({ deviceKey, name }: { deviceKey: string; name: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const run = async () => {
    if (!confirm(`Disconnect ${name}? It will be removed from this mesh and can no longer borrow or lend compute until you pair again.`)) return;
    setBusy(true);
    setErr(await post("forget", { deviceKey }));
    setBusy(false);
    router.refresh();
  };
  return (
    <>
      <button type="button" disabled={busy} onClick={() => void run()} className="kicker border px-2 py-0.5 transition-opacity hover:opacity-70" style={{ borderColor: "var(--color-rule-strong)", color: "var(--color-brick)" }}>
        {busy ? "…" : "Disconnect"}
      </button>
      {err && (
        <span className="kicker" style={{ color: "var(--color-brick)", fontFamily: "var(--font-mono)" }} role="alert">
          {err}
        </span>
      )}
    </>
  );
}

export function RestorePeerButton({ deviceKey }: { deviceKey: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setErr(await post("restore", { deviceKey }));
    setBusy(false);
    router.refresh();
  };
  return (
    <>
      <button type="button" disabled={busy} onClick={() => void run()} className="kicker border px-2 py-0.5 transition-opacity hover:opacity-70" style={{ borderColor: "var(--color-rule-strong)", color: "var(--color-sage-deep)" }}>
        {busy ? "…" : "Restore"}
      </button>
      {err && (
        <span className="kicker" style={{ color: "var(--color-brick)", fontFamily: "var(--font-mono)" }} role="alert">
          {err}
        </span>
      )}
    </>
  );
}

export function ClearStaleButton({ count }: { count: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setErr(await post("forget-stale"));
    setBusy(false);
    router.refresh();
  };
  return (
    <>
      <button type="button" disabled={busy} onClick={() => void run()} className="kicker border px-2 py-0.5 transition-opacity hover:opacity-70" style={{ borderColor: "var(--color-rule-strong)", color: "var(--color-muted)" }}>
        {busy ? "clearing…" : `Clear stale (${count})`}
      </button>
      {err && (
        <span className="kicker" style={{ color: "var(--color-brick)", fontFamily: "var(--font-mono)" }} role="alert">
          {err}
        </span>
      )}
    </>
  );
}
