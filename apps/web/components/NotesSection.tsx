"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Trash2Icon } from "lucide-react";
import { fetchWithTimeout } from "../lib/http.ts";
import { IconButton } from "./IconButton.tsx";
import type { NoteView } from "../lib/leash/memory-admin.ts";

/**
 * Notes the assistant recalls — `.md` files under `data/notes`, embedded by the graph.
 * Deleting a note removes the file (REAL forgetting — the graph re-embeds via its
 * directory fingerprint). The full list lives at /brain/notes; a preview sits on /brain.
 */

function fmtTime(ms: number | string): string {
  return new Date(ms).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
}

export function NotesSection({ notes }: { notes: NoteView[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const forget = async (file: string) => {
    if (!confirm(`Delete the note "${file}"? The assistant will no longer recall it.`)) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetchWithTimeout("/api/leash/memory/forget", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "note", file }) });
      if (!res.ok) setError(`Forget failed (${res.status}).`);
      router.refresh();
    } catch {
      setError("Forget failed — is the app still running?");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      {error && (
        <p className="kicker" style={{ color: "var(--color-brick)" }} role="alert">
          {error}
        </p>
      )}
      {notes.length === 0 ? (
        <p className="kicker py-4" style={{ color: "var(--color-faint)" }}>
          No notes — drop .md files into data/notes and the assistant will recall them.
        </p>
      ) : (
        <ul>
          {notes.map((n) => (
            <li key={n.file} className="flex items-start gap-3 border-b py-3" style={{ borderColor: "var(--color-rule)" }}>
              <div className="min-w-0 flex-1">
                <p style={{ fontFamily: "var(--font-mono)", fontSize: "0.85rem" }}>
                  {n.file} <span className="kicker ml-2" style={{ color: "var(--color-faint)" }}>{n.chunks} chunk(s) · {fmtTime(n.mtimeMs)}</span>
                </p>
                <p className="mt-0.5" style={{ color: "var(--color-muted)", fontSize: "0.85rem", fontFamily: "var(--font-body)" }}>
                  {n.preview}
                </p>
              </div>
              <IconButton title={`Forget ${n.file}`} danger disabled={busy} onClick={() => void forget(n.file)}>
                <Trash2Icon size={15} />
              </IconButton>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
