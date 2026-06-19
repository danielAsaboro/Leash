"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { UnplugIcon, RotateCcwIcon, EraserIcon } from "lucide-react";
import { fetchWithTimeout } from "../lib/http.ts";
import { appConfirm } from "../lib/prompt.ts";
import { IconButton } from "./IconButton.tsx";

/**
 * Client icon-buttons (icon + label-on-hover) for mesh membership management in the Devices →
 * My-meshes peer view: disconnect one peer, restore a tombstoned one, or clear all stale peers.
 * Each POSTs to /api/leash/hypha/mesh and refreshes. Errors are shown inline (never silent-caught).
 */

async function post(action: string, extra: Record<string, unknown> = {}): Promise<string | null> {
  try {
    const r = await fetchWithTimeout("/api/leash/hypha/mesh", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, ...extra }) });
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
    if (!(await appConfirm(`Disconnect ${name}? It will be removed from this mesh and can no longer borrow or lend compute until you pair again.`, { confirmLabel: "Disconnect", destructive: true }))) return;
    setBusy(true);
    setErr(await post("forget", { deviceKey }));
    setBusy(false);
    router.refresh();
  };
  return (
    <>
      <IconButton title={`Disconnect ${name}`} danger disabled={busy} onClick={() => void run()}>
        <UnplugIcon size={15} aria-hidden />
      </IconButton>
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
      <IconButton title="Restore (un-hide on this device)" color="var(--color-sage-deep)" disabled={busy} onClick={() => void run()}>
        <RotateCcwIcon size={15} aria-hidden />
      </IconButton>
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
      <IconButton title={`Clear ${count} stale peer${count === 1 ? "" : "s"}`} disabled={busy} onClick={() => void run()}>
        <EraserIcon size={15} aria-hidden />
      </IconButton>
      {err && (
        <span className="kicker" style={{ color: "var(--color-brick)", fontFamily: "var(--font-mono)" }} role="alert">
          {err}
        </span>
      )}
    </>
  );
}
