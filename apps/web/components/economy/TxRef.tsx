"use client";
import { useState } from "react";
import { toast } from "../Toast.tsx";

/**
 * On-chain tx reference. The local anvil fork has no block explorer, so the honest default is a
 * click-to-copy hash chip (full hash on hover); when the server passes an `explorerBase` (a real
 * deployment), it becomes a real outbound link instead of faking a dead one.
 */
export function TxRef({ hash, explorerBase }: { hash: string; explorerBase?: string }) {
  const [copied, setCopied] = useState(false);
  if (!hash) return <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.72rem", color: "var(--color-faint)" }}>—</span>;
  const short = `${hash.slice(0, 8)}…${hash.slice(-4)}`;

  if (explorerBase) {
    return (
      <a
        href={`${explorerBase}${hash}`}
        target="_blank"
        rel="noreferrer"
        title={hash}
        style={{ fontFamily: "var(--font-mono)", fontSize: "0.72rem", color: "var(--color-sage-deep)", textDecoration: "none" }}
      >
        {short} ↗
      </a>
    );
  }

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(hash);
      setCopied(true);
      toast.success("Transaction hash copied");
      setTimeout(() => setCopied(false), 1200);
    } catch {
      toast.error("Couldn't copy transaction hash");
    }
  };
  return (
    <button
      type="button"
      onClick={copy}
      title={`${hash} — click to copy`}
      style={{ fontFamily: "var(--font-mono)", fontSize: "0.72rem", color: copied ? "var(--color-sage-deep)" : "var(--color-ink-soft)", background: "none", border: "none", padding: 0, cursor: "pointer" }}
    >
      {copied ? "copied ✓" : short}
    </button>
  );
}
