"use client";
/**
 * Settings → Permissions. The browser-mediated device capabilities the app can use: microphone
 * (voice), camera (photos/video), and screen share (screenshots / computer-use). Shows each one's
 * live permission state (via `navigator.permissions.query` where supported) and a Request button
 * that triggers the browser's own prompt (`getUserMedia` / `getDisplayMedia`). Client-only —
 * permission grants live in the browser, not on the device.
 */
import { useCallback, useEffect, useState } from "react";
import { toast } from "./Toast.tsx";

type State = "granted" | "denied" | "prompt" | "unknown" | "unsupported";

interface Cap {
  key: string;
  label: string;
  desc: string;
  queryName?: string; // navigator.permissions.query name; absent → request-only (e.g. screen share)
  request: () => Promise<MediaStream>;
}

const CAPS: Cap[] = [
  { key: "microphone", label: "Microphone", desc: "Voice input", queryName: "microphone", request: () => navigator.mediaDevices.getUserMedia({ audio: true }) },
  { key: "camera", label: "Camera", desc: "Photos & video", queryName: "camera", request: () => navigator.mediaDevices.getUserMedia({ video: true }) },
  { key: "screen", label: "Screen share", desc: "Screenshots & computer use", request: () => navigator.mediaDevices.getDisplayMedia({ video: true }) },
];

const STATE_COLOR: Record<State, string> = {
  granted: "var(--color-sage)",
  denied: "var(--color-brick)",
  prompt: "var(--color-faint)",
  unknown: "var(--color-faint)",
  unsupported: "var(--color-faint)",
};
const STATE_LABEL: Record<State, string> = {
  granted: "Granted",
  denied: "Denied",
  prompt: "Not yet asked",
  unknown: "Tap to check",
  unsupported: "Unsupported",
};

export function PermissionsCard() {
  const [state, setState] = useState<Record<string, State>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const next: Record<string, State> = {};
    for (const c of CAPS) {
      if (!c.queryName || typeof navigator === "undefined" || !navigator.permissions?.query) {
        next[c.key] = c.queryName ? "unsupported" : "unknown";
        continue;
      }
      try {
        const p = await navigator.permissions.query({ name: c.queryName as PermissionName });
        next[c.key] = p.state as State;
      } catch {
        next[c.key] = "unknown";
      }
    }
    setState(next);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const request = async (c: Cap) => {
    if (typeof navigator === "undefined" || !navigator.mediaDevices) return;
    setBusy(c.key);
    try {
      const stream = await c.request();
      stream.getTracks().forEach((t) => t.stop()); // we only wanted the grant, not the capture
      toast.success(`${c.label} permission granted`);
    } catch {
      toast.error(`${c.label} permission was not granted`);
      /* denied or cancelled — refresh reflects it */
    } finally {
      setBusy(null);
      void refresh();
    }
  };

  return (
    <div className="flex flex-col gap-1">
      {CAPS.map((c) => {
        const s = state[c.key] ?? "unknown";
        return (
          <div key={c.key} className="flex items-center gap-3 border-b py-2" style={{ borderColor: "var(--color-rule)" }}>
            <div className="flex flex-col" style={{ flex: 1 }}>
              <span className="kicker" style={{ color: "var(--color-ink)" }}>{c.label}</span>
              <span className="kicker" style={{ color: "var(--color-faint)" }}>{c.desc}</span>
            </div>
            <span className="inline-flex items-center gap-1.5">
              <span aria-hidden className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: STATE_COLOR[s] }} />
              <span className="kicker" style={{ color: "var(--color-ink-soft)" }}>{STATE_LABEL[s]}</span>
            </span>
            <button
              type="button"
              disabled={busy === c.key || s === "granted"}
              onClick={() => void request(c)}
              className="kicker border px-2 py-0.5 transition-opacity hover:opacity-70 disabled:opacity-40"
              style={{ borderColor: "var(--color-ink)" }}
            >
              {s === "granted" ? "ok" : "request"}
            </button>
          </div>
        );
      })}
      <p className="kicker" style={{ color: "var(--color-faint)", marginTop: "0.5rem" }}>
        These are browser permissions on this device — nothing leaves it.
      </p>
    </div>
  );
}
