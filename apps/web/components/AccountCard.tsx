"use client";
/**
 * Settings → Account. The home for everything tied to the signed-in identity: who you are,
 * changing your password, signing out, and the per-account "reset this account" danger action
 * (moved here from Storage — factory reset stays under Storage as a device-wide action).
 */
import { useState } from "react";
import { fetchWithTimeout } from "../lib/http.ts";
import { activateAndGo } from "../lib/auth-handshake.ts";
import { appAlert, appConfirm } from "../lib/prompt.ts";
import { toast } from "./Toast.tsx";

async function signOut(): Promise<void> {
  try {
    const res = await fetch("/api/leash/auth/logout", { method: "POST" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    toast.success("Signed out");
  } catch {
    toast.error("Sign out failed");
    return;
  }
  // logout drops the supervisor back to BOOTSTRAP (no active user); wait for that respawn
  // before landing on /login so we don't race a connection-refused.
  await activateAndGo(null, "/login");
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b py-1.5" style={{ borderColor: "var(--color-rule)" }}>
      <span className="kicker" style={{ color: "var(--color-faint)" }}>{label}</span>
      <span className="mono" style={{ color: "var(--color-ink)" }}>{value}</span>
    </div>
  );
}

export function AccountCard({ username, userId }: { username: string; userId: string }) {
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const closeForm = () => {
    setOpen(false);
    setCurrent("");
    setNext("");
    setConfirm("");
    setMsg(null);
  };

  const submitPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setMsg(null);
    if (next !== confirm) {
      const text = "New passwords don't match.";
      setMsg({ kind: "err", text });
      toast.error(text);
      return;
    }
    if (next.length < 6) {
      const text = "New password must be at least 6 characters.";
      setMsg({ kind: "err", text });
      toast.error(text);
      return;
    }
    setBusy(true);
    try {
      const r = await fetchWithTimeout("/api/leash/account/password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ currentPassword: current, newPassword: next }),
      });
      if (!r.ok) {
        const text = (await r.json().catch(() => ({})))?.error ?? "Couldn't change password.";
        setMsg({ kind: "err", text });
        toast.error(text);
        return;
      }
      closeForm();
      setMsg({ kind: "ok", text: "Password changed. Other devices have been signed out." });
      toast.success("Password changed");
    } catch {
      const text = "Couldn't change password.";
      setMsg({ kind: "err", text });
      toast.error(text);
    } finally {
      setBusy(false);
    }
  };

  const resetAccount = async () => {
    if (
      !(await appConfirm(
        "Reset THIS account? Permanently deletes your data, database, model cache and settings, then signs you out. Other accounts are untouched.",
        { confirmLabel: "Reset account", destructive: true },
      ))
    )
      return;
    setBusy(true);
    try {
      const r = await fetchWithTimeout("/api/leash/data/reset", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scope: "user" }),
      });
      if (!r.ok) {
        const msg = (await r.json().catch(() => ({})))?.error ?? "Reset failed.";
        toast.error(msg);
        await appAlert(msg, { tone: "error" });
        setBusy(false);
        return;
      }
      toast.success("Account reset started");
      await activateAndGo(null, "/login"); // supervisor wipes + respawns to bootstrap
    } catch {
      setBusy(false);
      toast.error("Reset failed");
    }
  };

  const inputStyle = {
    border: "1px solid var(--color-rule-strong)",
    background: "transparent",
    color: "var(--color-ink)",
    padding: "0.4rem 0.6rem",
    width: "100%",
  } as const;

  return (
    <div>
      <span className="kicker kicker-sage">Signed in as</span>
      <Row label="Username" value={username} />
      <Row label="Account ID" value={userId} />

      <div className="mt-5 border-t pt-4" style={{ borderColor: "var(--color-rule)" }}>
        <span className="kicker" style={{ color: "var(--color-faint)" }}>Password</span>
        {!open ? (
          <div className="mt-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => { setMsg(null); setOpen(true); }}
              className="kicker border px-3 py-1 transition-opacity hover:opacity-70 disabled:opacity-40"
              style={{ borderColor: "var(--color-ink)" }}
            >
              change password
            </button>
            {msg && msg.kind === "ok" && (
              <p className="kicker" style={{ color: "var(--color-sage)", marginTop: "0.5rem" }}>{msg.text}</p>
            )}
          </div>
        ) : (
          <form onSubmit={submitPassword} className="mt-2 flex flex-col gap-2" style={{ maxWidth: 360 }}>
            <input
              type="password"
              autoComplete="current-password"
              placeholder="Current password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              disabled={busy}
              required
              autoFocus
              style={inputStyle}
            />
            <input
              type="password"
              autoComplete="new-password"
              placeholder="New password (min 6)"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              disabled={busy}
              required
              style={inputStyle}
            />
            <input
              type="password"
              autoComplete="new-password"
              placeholder="Confirm new password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              disabled={busy}
              required
              style={inputStyle}
            />
            {msg && (
              <p className="kicker" style={{ color: msg.kind === "ok" ? "var(--color-sage)" : "var(--color-brick)" }}>
                {msg.text}
              </p>
            )}
            <div className="flex gap-2">
              <button
                type="submit"
                disabled={busy || !current || !next || !confirm}
                className="kicker border px-3 py-1 transition-opacity hover:opacity-70 disabled:opacity-40"
                style={{ borderColor: "var(--color-ink)" }}
              >
                update password
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={closeForm}
                className="kicker border px-3 py-1 transition-opacity hover:opacity-70 disabled:opacity-40"
                style={{ borderColor: "var(--color-rule-strong)", color: "var(--color-muted)" }}
              >
                cancel
              </button>
            </div>
          </form>
        )}
      </div>

      <div className="mt-5 border-t pt-4" style={{ borderColor: "var(--color-rule)" }}>
        <span className="kicker" style={{ color: "var(--color-faint)" }}>Session</span>
        <div className="mt-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => void signOut()}
            className="kicker border px-3 py-1 transition-opacity hover:opacity-70 disabled:opacity-40"
            style={{ borderColor: "var(--color-ink)" }}
          >
            sign out
          </button>
        </div>
      </div>

      <div className="mt-5 border-t pt-3" style={{ borderColor: "var(--color-rule)" }}>
        <span className="kicker" style={{ color: "var(--color-brick)" }}>Danger zone</span>
        <div className="mt-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => void resetAccount()}
            className="kicker border px-2 py-0.5 transition-opacity hover:opacity-70 disabled:opacity-40"
            style={{ borderColor: "var(--color-brick)", color: "var(--color-brick)" }}
          >
            reset this account
          </button>
        </div>
        <p className="kicker" style={{ color: "var(--color-faint)", marginTop: "0.4rem" }}>
          Reset wipes this account&rsquo;s data, models &amp; settings and signs you out. To wipe every account on
          this device, use factory reset under Storage.
        </p>
      </div>
    </div>
  );
}
