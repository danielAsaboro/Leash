"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { PlayIcon, SquareIcon, RotateCcwIcon, RefreshCwIcon, OctagonXIcon, EraserIcon, BoxesIcon, Loader2Icon, ScrollTextIcon } from "lucide-react";
import { fetchWithTimeout, TIMEOUT } from "../lib/http.ts";
import { appConfirm } from "../lib/prompt.ts";
import { IconButton } from "./IconButton.tsx";
import { toast } from "./Toast.tsx";
import type { ServiceStatus } from "../lib/leash/services.ts";

/**
 * One service's control card (client) — state, freshness, start/stop/restart, log
 * tail. The serve keeps its server-side inflight 409 guard; the confirm dialog is the
 * human backstop. Children render below (e.g. the Cron card hosts the Schedules CRUD).
 */

const STATE_COLOR: Record<ServiceStatus["state"], string> = {
  running: "var(--color-sage)",
  ready: "var(--color-sage)",
  external: "var(--color-sage)",
  starting: "var(--color-faint)",
  stopped: "var(--color-brick)",
  unhealthy: "var(--color-brick)",
};

const STATE_LABEL: Record<ServiceStatus["state"], string> = {
  running: "Running",
  ready: "Ready",
  external: "Running (external)",
  starting: "Starting…",
  stopped: "Stopped",
  unhealthy: "Unhealthy",
};

export function ServiceCard({ service, children }: { service: ServiceStatus; children?: React.ReactNode }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showLog, setShowLog] = useState(false);

  const act = async (action: "start" | "stop" | "restart" | "force-stop" | "force-restart" | "reset") => {
    const actionLabel = action.replace("-", " ");
    const danger = service.name === "qvac-serve" && action !== "start";
    if (danger && !(await appConfirm(`${action === "stop" ? "Stop" : "Restart"} the model serve? Make sure no generation is running.`, { confirmLabel: action === "stop" ? "Stop" : "Restart", destructive: true }))) return;
    if (action === "stop" && service.name !== "qvac-serve" && !(await appConfirm(`Stop ${service.label}?`, { confirmLabel: "Stop", destructive: true }))) return;
    if ((action === "force-stop" || action === "force-restart") && !(await appConfirm(`Force ${action === "force-stop" ? "stop" : "restart"} ${service.label}? This kills every copy of it — including any started in a terminal or left orphaned — and ${action === "force-restart" ? "starts a fresh one." : "leaves it stopped."}`, { confirmLabel: action === "force-stop" ? "Force stop" : "Force restart", destructive: true }))) return;
    if (action === "reset" && !(await appConfirm(`Wipe this device's mesh identity and ALL pairings, then restart fresh? Other devices keep their state; you'll need to re-pair.`, { confirmLabel: "Reset mesh", destructive: true }))) return;
    setBusy(true);
    setPending(action);
    setError(null);
    try {
      // Service start/stop can legitimately take a while (graceful drain) → heavy tier.
      const res = await fetchWithTimeout("/api/leash/services", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: service.name, action }) }, TIMEOUT.heavy);
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        const msg = body.error ?? `Request failed (${res.status}).`;
        setError(msg);
        toast.error(msg);
        return;
      }
      toast.success(`${service.label}: ${actionLabel} requested`);
      router.refresh();
    } catch {
      const msg = "Request failed — is the app still running?";
      setError(msg);
      toast.error(msg);
    } finally {
      setBusy(false);
      setPending(null);
    }
  };

  /** The action's icon, swapped for a spinner while that action is in flight. */
  const glyph = (action: string, Icon: typeof PlayIcon) => (pending === action ? <Loader2Icon size={15} className="animate-spin" /> : <Icon size={15} />);

  const running = service.state === "running" || service.state === "ready" || service.state === "starting" || service.state === "unhealthy";

  return (
    <section className="border p-5" style={{ borderColor: "var(--color-rule)", background: "var(--color-paper)" }}>
      <div className="flex flex-wrap items-center gap-3">
        <span aria-hidden className="inline-block h-2 w-2 rounded-full" style={{ background: STATE_COLOR[service.state] }} />
        <span className="kicker kicker-sage">{service.label}</span>
        <span className="kicker" style={{ color: "var(--color-faint)" }}>
          {STATE_LABEL[service.state]}
          {service.pid ? ` · pid ${service.pid}` : ""} · {service.detail}
        </span>
        <span className="h-px flex-1" style={{ background: "var(--color-rule)" }} />
        {service.name === "qvac-serve" && (
          <IconButton title="Manage models" color="var(--color-sage-deep)" onClick={() => router.push("/brain?tab=models")}>
            <BoxesIcon size={16} />
          </IconButton>
        )}
        {!running && service.state !== "external" && (
          <IconButton title={`Start ${service.label}`} color="var(--color-sage-deep)" disabled={busy} onClick={() => void act("start")}>
            {glyph("start", PlayIcon)}
          </IconButton>
        )}
        {(running || service.state === "external") && service.stoppable && (
          <>
            <IconButton title={`Restart ${service.label}`} disabled={busy} onClick={() => void act("restart")}>
              {glyph("restart", RotateCcwIcon)}
            </IconButton>
            <IconButton title={`Stop ${service.label}`} danger disabled={busy} onClick={() => void act("stop")}>
              {glyph("stop", SquareIcon)}
            </IconButton>
          </>
        )}
        {service.state === "external" && !service.stoppable && (
          <span className="kicker" style={{ color: "var(--color-faint)" }}>
            started outside the dashboard
          </span>
        )}
        {service.forceStoppable && (
          <>
            <IconButton title="Force restart — kills every copy (even ones started in a terminal) and starts a fresh one" disabled={busy} onClick={() => void act("force-restart")}>
              {glyph("force-restart", RefreshCwIcon)}
            </IconButton>
            <IconButton title="Force stop — kills every copy of this service" danger disabled={busy} onClick={() => void act("force-stop")}>
              {glyph("force-stop", OctagonXIcon)}
            </IconButton>
          </>
        )}
        {service.resettable && (
          <IconButton title="Reset mesh — force-stop, wipe this device's mesh identity + pairings, restart fresh" danger disabled={busy} onClick={() => void act("reset")}>
            {glyph("reset", EraserIcon)}
          </IconButton>
        )}
      </div>
      <p className="mt-1.5" style={{ color: "var(--color-muted)", fontSize: "0.85rem", fontFamily: "var(--font-body)" }}>
        {service.blurb}
      </p>
      {error && (
        <p className="kicker mt-2" style={{ color: "var(--color-brick)" }} role="alert">
          {error}
        </p>
      )}

      {service.logTail.length > 0 && (
        <div className="mt-3">
          <button type="button" onClick={() => setShowLog((v) => !v)} className="kicker inline-flex items-center gap-1 transition-opacity hover:opacity-60" style={{ color: "var(--color-faint)" }} title={showLog ? "Hide log" : "Show log"}>
            <ScrollTextIcon size={13} /> {showLog ? "hide" : "log"} ({service.logTail.length})
          </button>
          {showLog && (
            <pre className="mt-2 overflow-x-auto border p-3" style={{ borderColor: "var(--color-rule)", background: "var(--color-cream)", fontFamily: "var(--font-mono)", fontSize: "0.68rem", lineHeight: 1.5 }}>
              {service.logTail.join("\n")}
            </pre>
          )}
        </div>
      )}

      {children}
    </section>
  );
}
