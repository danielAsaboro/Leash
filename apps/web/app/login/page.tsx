"use client";
import { useState } from "react";
import { activateAndGo } from "../../lib/auth-handshake.ts";
import { toast } from "../../components/Toast.tsx";

export default function Login(): React.JSX.Element {
  const [mode, setMode] = useState<"signin" | "create">("signin");
  const [username, setUsername] = useState("");
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const creating = mode === "create";

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setErr("");
    if (!username.trim()) {
      setErr("Enter a username.");
      toast.error("Enter a username");
      return;
    }
    if (pw.length < 6) {
      setErr("Password must be at least 6 characters.");
      toast.error("Password must be at least 6 characters");
      return;
    }
    if (creating && pw !== confirm) {
      setErr("Passwords don't match.");
      toast.error("Passwords don't match");
      return;
    }
    setBusy(true);
    const url = creating ? "/api/leash/auth/setup" : "/api/leash/auth/login";
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: username.trim(), password: pw }) });
      if (r.ok) {
        const j = (await r.json()) as { switchTo: string };
        setErr(""); // entering "Switching…" — keep busy
        toast.success(creating ? "Account created" : "Signed in");
        await activateAndGo(j.switchTo);
      } else {
        const msg = (await r.json().catch(() => ({})))?.error ?? (creating ? "Could not create account." : "Incorrect username or password.");
        setErr(msg);
        toast.error(msg);
        setBusy(false);
      }
    } catch {
      const msg = creating ? "Could not create account." : "Could not sign in.";
      setErr(msg);
      toast.error(msg);
      setBusy(false);
    }
  }

  return (
    <div className="flex h-screen flex-col items-center justify-center gap-5 bg-cream px-10 text-ink">
      <h1 className="font-display text-4xl font-semibold tracking-tight">Leash</h1>
      <form className="flex w-72 flex-col gap-3" onSubmit={submit}>
        <input className="rounded-lg border border-rule-strong bg-paper px-3 py-2 font-body text-sm" type="text" autoComplete="username" placeholder="Username" value={username} onChange={(e) => setUsername(e.target.value)} autoFocus />
        <input className="rounded-lg border border-rule-strong bg-paper px-3 py-2 font-body text-sm" type="password" autoComplete={creating ? "new-password" : "current-password"} placeholder="Password" value={pw} onChange={(e) => setPw(e.target.value)} />
        {creating && (
          <input className="rounded-lg border border-rule-strong bg-paper px-3 py-2 font-body text-sm" type="password" autoComplete="new-password" placeholder="Confirm password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        )}
        {err && <p className="font-mono text-[11px] text-brick">{err}</p>}
        <button className="rounded-lg bg-sage-deep px-4 py-2 font-mono text-xs uppercase tracking-label text-cream disabled:opacity-40" disabled={busy}>
          {busy ? "Switching…" : creating ? "Create account" : "Sign in"}
        </button>
      </form>
      <button
        type="button"
        className="font-mono text-[11px] uppercase tracking-label text-muted underline-offset-2 hover:underline disabled:opacity-40"
        disabled={busy}
        onClick={() => { setErr(""); setMode(creating ? "signin" : "create"); }}
      >
        {creating ? "Have an account? Sign in" : "Create a new account"}
      </button>
    </div>
  );
}
