"use client";
import { useState } from "react";
import { toast } from "../Toast.tsx";

/** Waitlist email capture → POST /api/waitlist. Inline success; Toast on error. */
export function WaitlistForm() {
  const [email, setEmail] = useState("");
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const value = email.trim();
    if (!value || busy) return;
    setBusy(true);
    try {
      const res = await fetch("/api/waitlist", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: value }) });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error || "Couldn't join the waitlist.");
      setDone(true);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't join the waitlist — try again.");
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <p className="landing-waitlist-done" role="status">
        ✓ You’re on the list. We’ll be in touch.
      </p>
    );
  }

  return (
    <form className="landing-waitlist-form" onSubmit={submit}>
      <input
        type="email"
        required
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="you@example.com"
        aria-label="Email address"
        className="landing-waitlist-input"
        disabled={busy}
      />
      <button type="submit" className="landing-waitlist-btn" disabled={busy}>
        {busy ? "Joining…" : "Join the waitlist"}
      </button>
    </form>
  );
}
