"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DeviceBootstrapFile } from "../../lib/leash/device-bootstrap-core.ts";
import { activateAndGo } from "../../lib/device-handshake.ts";
import { readDownloadStatus, type DownloadStatus } from "../../lib/leash/download-poll.ts";
import type { KitRole } from "../../lib/leash/kit.ts";
import { DownloadDisclosure } from "./DownloadDisclosure.tsx";

export type WelcomeStage = "choose" | "review" | "sync" | "prepare";

const INVITE_KEY = "leash:onboarding:invite";
const LABEL_KEY = "leash:onboarding:label";

const focusRing = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2";

function shellButtonStyle(kind: "primary" | "secondary") {
  return {
    borderColor: kind === "primary" ? "var(--color-sage-deep)" : "var(--color-rule-strong)",
    background: kind === "primary" ? "var(--color-sage-deep)" : "var(--color-paper)",
    color: kind === "primary" ? "var(--color-cream)" : "var(--color-ink)",
  } as const;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function WelcomeFlow({
  bootstrap,
  roles,
  modelNames,
  initialStage,
}: {
  bootstrap: DeviceBootstrapFile | null;
  roles: KitRole[];
  modelNames: string[];
  initialStage: WelcomeStage;
}) {
  const [stage, setStage] = useState<WelcomeStage>(initialStage);
  const [invite, setInvite] = useState("");
  const [meshLabel, setMeshLabel] = useState("Mesh");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("Preparing this device");
  const [progress, setProgress] = useState(0);
  const [prepareDone, setPrepareDone] = useState(false);
  const autoJoinRef = useRef(false);
  const autoPrepareRef = useRef(false);

  const totalBytes = useMemo(() => roles.reduce((sum, role) => sum + role.bytes, 0), [roles]);

  useEffect(() => {
    const savedInvite = window.sessionStorage.getItem(INVITE_KEY) ?? "";
    const savedLabel = window.sessionStorage.getItem(LABEL_KEY) ?? "Mesh";
    if (savedInvite && !invite) setInvite(savedInvite);
    if (savedLabel && meshLabel === "Mesh") setMeshLabel(savedLabel);
  }, [invite, meshLabel]);

  const persistJoinDraft = useCallback((nextInvite: string, nextLabel: string) => {
    window.sessionStorage.setItem(INVITE_KEY, nextInvite);
    window.sessionStorage.setItem(LABEL_KEY, nextLabel);
  }, []);

  const clearJoinDraft = useCallback(() => {
    window.sessionStorage.removeItem(INVITE_KEY);
    window.sessionStorage.removeItem(LABEL_KEY);
  }, []);

  const queueKitDownloads = useCallback(async () => {
    if (prepareDone || autoPrepareRef.current) return;
    autoPrepareRef.current = true;
    setBusy(true);
    setError(null);
    setStage("prepare");
    try {
      for (const [index, name] of modelNames.entries()) {
        setStatus(`Downloading ${name}`);
        const start = await fetch("/api/leash/models/download", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name }),
        });
        if (!start.ok && start.status !== 409) {
          const body = (await start.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `Couldn't queue ${name}.`);
        }

        for (;;) {
          const state = await readDownloadStatus(name, { tolerateTransientErrors: true });
          if (state) {
            const pct = state.state === "done" ? 100 : Math.max(0, Math.min(100, state.percentage || 0));
            setProgress(Math.round(((index + pct / 100) / modelNames.length) * 100));
            if (state.state === "done") break;
            if (state.state === "error" || state.state === "cancelled") {
              throw new Error(state.error ?? `${name} did not finish downloading.`);
            }
          }
          await sleep(700);
        }
      }

      setStatus("Finalizing this device");
      setProgress(100);
      const complete = await fetch("/api/leash/bootstrap/complete", { method: "POST" });
      if (!complete.ok) throw new Error("Couldn't finalize device setup.");
      setPrepareDone(true);
      clearJoinDraft();
      window.location.href = "/home";
    } catch (cause) {
      autoPrepareRef.current = false;
      setError((cause as Error)?.message ?? "Setup did not finish.");
    } finally {
      setBusy(false);
    }
  }, [clearJoinDraft, modelNames, prepareDone]);

  const startFresh = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/leash/bootstrap/first-device", { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as { switchTo?: string; error?: string };
      if (!res.ok || !body.switchTo) throw new Error(body.error ?? "Couldn't prepare this device.");
      await activateAndGo(body.switchTo, "/welcome?stage=prepare");
    } catch (cause) {
      setBusy(false);
      setError((cause as Error)?.message ?? "Couldn't prepare this device.");
    }
  }, []);

  const continueJoin = useCallback(async () => {
    const trimmedInvite = invite.trim();
    if (trimmedInvite.length < 16) {
      setError("Paste the full invite from a trusted device.");
      return;
    }

    persistJoinDraft(trimmedInvite, meshLabel.trim() || "Mesh");
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/leash/bootstrap/join", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ invite: trimmedInvite, label: meshLabel.trim() || "Mesh" }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        needsRespawn?: boolean;
        switchTo?: string;
      };
      if (!res.ok) throw new Error(body.error ?? "Couldn't join this device.");
      if (body.needsRespawn && body.switchTo) {
        await activateAndGo(body.switchTo, "/welcome?stage=sync");
        return;
      }
      setStage("prepare");
      autoPrepareRef.current = false;
      await queueKitDownloads();
    } catch (cause) {
      setError((cause as Error)?.message ?? "Couldn't join this device.");
      setBusy(false);
    }
  }, [invite, meshLabel, persistJoinDraft, queueKitDownloads]);

  useEffect(() => {
    if (stage === "prepare" && bootstrap?.mode === "first-device" && !bootstrap.ready && !autoPrepareRef.current) {
      void queueKitDownloads();
    }
  }, [bootstrap?.mode, bootstrap?.ready, queueKitDownloads, stage]);

  useEffect(() => {
    if (
      stage === "sync" &&
      bootstrap?.mode === "sync-existing" &&
      bootstrap?.identity?.userId &&
      invite &&
      !autoJoinRef.current
    ) {
      autoJoinRef.current = true;
      void continueJoin();
    }
  }, [bootstrap?.identity?.userId, bootstrap?.mode, continueJoin, invite, stage]);

  return (
    <main className="relative z-10 min-h-screen px-5 py-10">
      <div className="mx-auto flex w-full max-w-[1080px] flex-col gap-8">
        <header className="space-y-3">
          <p className="kicker kicker-sage">First run</p>
          <h1
            style={{
              fontFamily: "var(--font-display)",
              fontWeight: 900,
              fontSize: "clamp(2.4rem, 6vw, 4.4rem)",
              lineHeight: 0.96,
              maxWidth: "12ch",
            }}
          >
            Set up this device
          </h1>
          <p className="max-w-[64ch]" style={{ color: "var(--color-ink-soft)" }}>
            Choose whether this device starts its own private local workspace or joins one you already trust.
            Leash caches its local runtime once, then keeps working from this device.
          </p>
        </header>

        {error ? (
          <section
            className="rounded-[6px] border p-4"
            style={{ borderColor: "color-mix(in srgb, var(--color-brick) 30%, var(--color-rule))", background: "color-mix(in srgb, var(--color-brick) 5%, var(--color-paper))" }}
          >
            <p className="kicker" style={{ color: "var(--color-brick)" }}>
              Setup paused
            </p>
            <p className="mt-2" style={{ color: "var(--color-ink-soft)" }}>{error}</p>
            <div className="mt-4 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => void (stage === "sync" ? continueJoin() : queueKitDownloads())}
                className={`${focusRing} min-h-10 rounded-[4px] border px-4 py-2`}
                style={shellButtonStyle("primary")}
              >
                Try again
              </button>
              <button
                type="button"
                onClick={() => {
                  setError(null);
                  autoJoinRef.current = false;
                  autoPrepareRef.current = false;
                  setStage("choose");
                }}
                className={`${focusRing} min-h-10 rounded-[4px] border px-4 py-2`}
                style={shellButtonStyle("secondary")}
              >
                Back to setup paths
              </button>
            </div>
          </section>
        ) : null}

        {stage === "choose" && (
          <section className="grid gap-5 lg:grid-cols-2">
            <button
              type="button"
              onClick={() => setStage("review")}
              className={`${focusRing} flex min-h-28 flex-col items-start gap-3 rounded-[6px] border p-5 text-left`}
              style={{ borderColor: "var(--color-rule-strong)", background: "var(--color-paper)", outlineColor: "var(--color-sage-deep)" }}
            >
              <span className="kicker kicker-sage">New workspace</span>
              <span style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "1.45rem" }}>Start on this device</span>
              <span style={{ color: "var(--color-ink-soft)" }}>
                Create a private local workspace here, cache the recommended models, and begin from a clean local setup.
              </span>
            </button>

            <button
              type="button"
              onClick={() => setStage("sync")}
              className={`${focusRing} flex min-h-28 flex-col items-start gap-3 rounded-[6px] border p-5 text-left`}
              style={{ borderColor: "var(--color-rule-strong)", background: "var(--color-paper)", outlineColor: "var(--color-sage-deep)" }}
            >
              <span className="kicker kicker-sage">Existing workspace</span>
              <span style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "1.45rem" }}>Join a device you already use</span>
              <span style={{ color: "var(--color-ink-soft)" }}>
                Use an invite from another Leash device, bring this device into that private mesh, and prepare its local kit here.
              </span>
            </button>
          </section>
        )}

        {stage === "review" && (
          <section className="grid gap-5 lg:grid-cols-[minmax(0,1.2fr)_minmax(300px,0.8fr)]">
            <section
              className="rounded-[6px] border p-5"
              style={{ borderColor: "var(--color-rule)", background: "var(--color-paper)" }}
            >
              <p className="kicker kicker-sage">Recommended local setup</p>
              <h2 style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "1.8rem", lineHeight: 1.05, marginTop: "0.5rem" }}>
                Cache the local assistant kit
              </h2>
              <p className="mt-3 max-w-[60ch]" style={{ color: "var(--color-ink-soft)" }}>
                Leash will fetch the local models this device needs for chat, routing, memory, and multimodal work.
                After setup, those assets live on this device.
              </p>
              <div className="mt-5 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => void startFresh()}
                  disabled={busy}
                  className={`${focusRing} min-h-10 rounded-[4px] border px-4 py-2 disabled:opacity-50`}
                  style={shellButtonStyle("primary")}
                >
                  {busy ? "Preparing…" : "Accept and continue"}
                </button>
                <button
                  type="button"
                  onClick={() => setStage("choose")}
                  disabled={busy}
                  className={`${focusRing} min-h-10 rounded-[4px] border px-4 py-2 disabled:opacity-50`}
                  style={shellButtonStyle("secondary")}
                >
                  Back
                </button>
              </div>
            </section>

            <div className="space-y-5">
              <section
                className="rounded-[6px] border p-5"
                style={{ borderColor: "var(--color-rule)", background: "var(--color-paper)" }}
              >
                <p className="kicker kicker-sage">What happens next</p>
                <ul className="mt-3 space-y-2" style={{ color: "var(--color-ink-soft)" }}>
                  <li>Create this device’s local workspace scope</li>
                  <li>Download the recommended assistant kit</li>
                  <li>Mark this install ready and open Leash directly</li>
                </ul>
              </section>
              <DownloadDisclosure roles={roles} />
              <section
                className="rounded-[6px] border p-5"
                style={{ borderColor: "var(--color-rule)", background: "var(--color-paper)" }}
              >
                <p className="kicker" style={{ color: "var(--color-faint)" }}>
                  Estimated footprint
                </p>
                <p style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "1.5rem" }}>
                  {(totalBytes / 1e9).toFixed(totalBytes >= 10_000_000_000 ? 0 : 1)} GB
                </p>
              </section>
            </div>
          </section>
        )}

        {stage === "sync" && (
          <section className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(320px,0.9fr)]">
            <section
              className="rounded-[6px] border p-5"
              style={{ borderColor: "var(--color-rule)", background: "var(--color-paper)" }}
            >
              <p className="kicker kicker-sage">Join an existing workspace</p>
              <h2 style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "1.8rem", lineHeight: 1.05, marginTop: "0.5rem" }}>
                Bring this device into a trusted mesh
              </h2>
              <p className="mt-3 max-w-[60ch]" style={{ color: "var(--color-ink-soft)" }}>
                Paste the short-lived invite from another Leash device. This device will respawn into its
                own local scope, complete the mesh join there, then fetch the local kit it needs.
              </p>

              <div className="mt-5 grid gap-4">
                <label className="grid gap-2">
                  <span className="kicker">Invite</span>
                  <input
                    value={invite}
                    onChange={(event) => setInvite(event.target.value)}
                    autoComplete="off"
                    className={`${focusRing} min-h-10 rounded-[4px] border px-3 py-2`}
                    style={{ borderColor: "var(--color-rule-strong)", background: "var(--color-cream)", outlineColor: "var(--color-sage-deep)" }}
                  />
                </label>
                <label className="grid gap-2">
                  <span className="kicker">Mesh label</span>
                  <input
                    value={meshLabel}
                    onChange={(event) => setMeshLabel(event.target.value)}
                    autoComplete="off"
                    className={`${focusRing} min-h-10 rounded-[4px] border px-3 py-2`}
                    style={{ borderColor: "var(--color-rule-strong)", background: "var(--color-cream)", outlineColor: "var(--color-sage-deep)" }}
                  />
                </label>
              </div>

              <div className="mt-5 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => void continueJoin()}
                  disabled={busy}
                  className={`${focusRing} min-h-10 rounded-[4px] border px-4 py-2 disabled:opacity-50`}
                  style={shellButtonStyle("primary")}
                >
                  {busy ? "Joining…" : "Continue with this invite"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    clearJoinDraft();
                    autoJoinRef.current = false;
                    setInvite("");
                    setMeshLabel("Mesh");
                    setStage("choose");
                  }}
                  disabled={busy}
                  className={`${focusRing} min-h-10 rounded-[4px] border px-4 py-2 disabled:opacity-50`}
                  style={shellButtonStyle("secondary")}
                >
                  Back
                </button>
              </div>
            </section>

            <DownloadDisclosure roles={roles} />
          </section>
        )}

        {stage === "prepare" && (
          <section
            className="rounded-[6px] border p-5"
            style={{ borderColor: "var(--color-rule)", background: "var(--color-paper)" }}
            aria-busy={busy}
          >
            <div className="flex items-baseline justify-between gap-4">
              <div>
                <p className="kicker kicker-sage">Preparing local edition</p>
                <h2 style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "1.8rem", lineHeight: 1.05, marginTop: "0.5rem" }}>
                  {status}
                </h2>
              </div>
              <span className="kicker">{progress}%</span>
            </div>
            <div className="mt-5 h-2 overflow-hidden rounded-full" style={{ background: "var(--color-rule)" }}>
              <div
                className={busy ? "animate-pulse" : ""}
                style={{
                  height: "100%",
                  width: `${Math.max(8, progress)}%`,
                  background: "var(--color-sage-deep)",
                  transition: "width 240ms ease",
                }}
              />
            </div>
            <p className="mt-4 max-w-[60ch]" style={{ color: "var(--color-ink-soft)" }}>
              Downloads can take a while on first run. Leave this page open while Leash prepares the local kit for this device.
            </p>
          </section>
        )}
      </div>
    </main>
  );
}
