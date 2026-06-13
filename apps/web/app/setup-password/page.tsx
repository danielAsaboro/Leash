"use client";
import { useState } from "react";
import { activateAndGo } from "../../lib/auth-handshake.ts";

export default function SetupPassword(): React.JSX.Element {
  const [username, setUsername] = useState("");
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setErr("");
    if (!username.trim()) return setErr("Choose a username.");
    if (pw.length < 6) return setErr("Password must be at least 6 characters.");
    if (pw !== confirm) return setErr("Passwords don't match.");
    setBusy(true);
    const r = await fetch("/api/leash/auth/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: username.trim(), password: pw }) });
    if (r.ok) {
      const j = (await r.json()) as { switchTo: string };
      await activateAndGo(j.switchTo);
    } else {
      setErr((await r.json().catch(() => ({})))?.error ?? "Setup failed.");
      setBusy(false);
    }
  }

  return (
    <div className="flex h-screen flex-col items-center justify-center gap-5 bg-cream px-10 text-ink">
      <h1 className="font-display text-3xl font-semibold">Create your Leash account</h1>
      <p className="max-w-sm text-center font-body text-sm text-muted">Your username and password unlock your own private, isolated workspace on this device. Keep them safe — there is no recovery.</p>
      <form className="flex w-72 flex-col gap-3" onSubmit={submit}>
        <input className="rounded-lg border border-rule-strong bg-paper px-3 py-2 font-body text-sm" type="text" autoComplete="username" placeholder="Username" value={username} onChange={(e) => setUsername(e.target.value)} autoFocus />
        <input className="rounded-lg border border-rule-strong bg-paper px-3 py-2 font-body text-sm" type="password" autoComplete="new-password" placeholder="Password" value={pw} onChange={(e) => setPw(e.target.value)} />
        <input className="rounded-lg border border-rule-strong bg-paper px-3 py-2 font-body text-sm" type="password" autoComplete="new-password" placeholder="Confirm password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        {err && <p className="font-mono text-[11px] text-brick">{err}</p>}
        <button className="rounded-lg bg-sage-deep px-4 py-2 font-mono text-xs uppercase tracking-label text-cream disabled:opacity-40" disabled={busy}>{busy ? "Creating…" : "Create account"}</button>
      </form>
    </div>
  );
}
