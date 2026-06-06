"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import type { Skill } from "../lib/leash/skills-store.ts";

/**
 * Skills editor (client) — create / edit / enable / delete / IMPORT skill folders
 * (`<slug>/SKILL.md` + optional nested attachments per the agentskills.io layout:
 * references/, scripts/, assets/). Enabled skills are advertised in the chat system
 * prompt; the model loads the body via `read_skill`, attachments via `read_skill_file`,
 * and runs `scripts/*` via `run_skill_script`. Imported zips always land DISABLED —
 * review, then enable.
 */

/** Nested attachment paths need each segment encoded (not the slashes). */
const fileUrl = (slug: string, f: string): string => `/api/leash/skills/${slug}/files/${f.split("/").map(encodeURIComponent).join("/")}`;

interface Draft {
  name: string;
  description: string;
  body: string;
}

const EMPTY: Draft = { name: "", description: "", body: "" };

/** Attachment manager for one existing skill (list · load-to-edit · save · delete). */
function AttachmentsEditor({ slug, files, busy, onChanged, onError }: { slug: string; files: string[]; busy: boolean; onChanged: () => void; onError: (e: string) => void }) {
  const [fileName, setFileName] = useState("");
  const [fileBody, setFileBody] = useState("");
  const [saving, setSaving] = useState(false);

  const load = async (f: string) => {
    try {
      const res = await fetch(fileUrl(slug, f));
      const body = (await res.json()) as { text?: string; error?: string };
      if (!res.ok) return onError(body.error ?? `Couldn't read ${f}.`);
      setFileName(f);
      setFileBody(body.text ?? "");
    } catch {
      onError("Request failed — is the app still running?");
    }
  };

  const save = async () => {
    if (!fileName.trim()) return;
    setSaving(true);
    try {
      const res = await fetch(fileUrl(slug, fileName.trim()), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: fileBody }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        onError(body.error ?? `Save failed (${res.status}).`);
      } else {
        setFileName("");
        setFileBody("");
        onChanged();
      }
    } catch {
      onError("Request failed — is the app still running?");
    } finally {
      setSaving(false);
    }
  };

  const del = async (f: string) => {
    if (!confirm(`Delete the attachment "${f}"?`)) return;
    await fetch(fileUrl(slug, f), { method: "DELETE" });
    onChanged();
  };

  return (
    <div className="mt-4 border-t pt-3" style={{ borderColor: "var(--color-rule)" }}>
      <span className="kicker" style={{ color: "var(--color-faint)" }}>
        Attachments — files the instructions can reference; the model loads them with read_skill_file
      </span>
      {files.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-2">
          {files.map((f) => (
            <li key={f} className="flex items-center gap-1 border px-2 py-1" style={{ borderColor: "var(--color-rule-strong)" }}>
              <button type="button" onClick={() => void load(f)} className="kicker transition-opacity hover:opacity-60" style={{ color: "var(--color-ink-soft)" }}>
                {f}
              </button>
              <button type="button" onClick={() => void del(f)} disabled={busy || saving} aria-label={`Delete ${f}`} className="px-1 transition-opacity hover:opacity-60" style={{ color: "var(--color-brick)" }}>
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-2 flex flex-col gap-2">
        <input
          value={fileName}
          onChange={(e) => setFileName(e.target.value)}
          placeholder="filename.md — nested paths ok (references/x.md, scripts/run.sh)"
          aria-label="Attachment filename"
          className="border bg-transparent px-3 py-2"
          style={{ borderColor: "var(--color-rule)", fontFamily: "var(--font-mono)", fontSize: "0.78rem" }}
        />
        <textarea
          value={fileBody}
          onChange={(e) => setFileBody(e.target.value)}
          placeholder="File contents…"
          rows={5}
          aria-label="Attachment contents"
          className="border bg-transparent p-3"
          style={{ borderColor: "var(--color-rule)", fontFamily: "var(--font-mono)", fontSize: "0.78rem", lineHeight: 1.5 }}
        />
        <button type="button" disabled={busy || saving || !fileName.trim()} onClick={() => void save()} className="kicker self-start border px-3 py-1.5 transition-opacity hover:opacity-70 disabled:opacity-40" style={{ borderColor: "var(--color-rule-strong)", color: "var(--color-muted)" }}>
          Save attachment
        </button>
      </div>
    </div>
  );
}

export function SkillsPanel({ skills }: { skills: Skill[] }) {
  const router = useRouter();
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const call = async (fn: () => Promise<Response>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      const res = await fn();
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? `Request failed (${res.status}).`);
        return false;
      }
      router.refresh();
      return true;
    } catch {
      setError("Request failed — is the app still running?");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const startEdit = (s: Skill) => {
    setEditing(s.slug);
    setDraft({ name: s.name, description: s.description, body: s.body });
  };

  const save = async () => {
    if (!draft.name.trim()) return;
    const ok =
      editing === "new"
        ? await call(() => fetch("/api/leash/skills", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(draft) }))
        : await call(() => fetch(`/api/leash/skills/${editing}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(draft) }));
    if (ok) {
      setEditing(null);
      setDraft(EMPTY);
    }
  };

  const toggle = (s: Skill) =>
    void call(() => fetch(`/api/leash/skills/${s.slug}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: !s.enabled }) }));

  const del = (s: Skill) => {
    if (!confirm(`Delete the skill "${s.name}"?`)) return;
    void call(() => fetch(`/api/leash/skills/${s.slug}`, { method: "DELETE" }));
  };

  const importZip = (file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    void call(() => fetch("/api/leash/skills/import", { method: "POST", body: fd }));
  };

  const editor = (
    <section className="border p-4" style={{ borderColor: "var(--color-rule-strong)", background: "var(--color-paper)" }}>
      <span className="kicker kicker-sage">{editing === "new" ? "New skill" : `Editing · ${editing}`}</span>
      <div className="mt-3 flex flex-col gap-2">
        <input
          value={draft.name}
          onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
          placeholder="Skill name (e.g. Trip planning)"
          aria-label="Skill name"
          className="border bg-transparent px-3 py-2"
          style={{ borderColor: "var(--color-rule-strong)", fontFamily: "var(--font-body)" }}
        />
        <input
          value={draft.description}
          onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
          placeholder="When should the assistant use this? (it sees this line on every turn)"
          aria-label="Skill description"
          className="border bg-transparent px-3 py-2"
          style={{ borderColor: "var(--color-rule)", fontFamily: "var(--font-body)", fontSize: "0.9rem" }}
        />
        <textarea
          value={draft.body}
          onChange={(e) => setDraft((d) => ({ ...d, body: e.target.value }))}
          placeholder={"Markdown instructions the assistant follows after calling read_skill…"}
          rows={10}
          aria-label="Skill instructions"
          className="border bg-transparent p-3"
          style={{ borderColor: "var(--color-rule)", fontFamily: "var(--font-mono)", fontSize: "0.78rem", lineHeight: 1.5 }}
        />
      </div>
      <div className="mt-3 flex gap-2">
        <button type="button" disabled={busy || !draft.name.trim()} onClick={() => void save()} className="kicker px-3 py-1.5 transition-opacity hover:opacity-80 disabled:opacity-40" style={{ background: "var(--color-sage-deep)", color: "var(--color-cream)" }}>
          Save skill
        </button>
        <button type="button" disabled={busy} onClick={() => { setEditing(null); setDraft(EMPTY); }} className="kicker border px-3 py-1.5 transition-opacity hover:opacity-70" style={{ borderColor: "var(--color-rule-strong)", color: "var(--color-muted)" }}>
          Cancel
        </button>
      </div>
      {editing !== null && editing !== "new" && (
        <AttachmentsEditor slug={editing} files={skills.find((s) => s.slug === editing)?.files ?? []} busy={busy} onChanged={() => router.refresh()} onError={setError} />
      )}
    </section>
  );

  return (
    <div className="flex flex-col gap-4">
      {error && (
        <p className="kicker" style={{ color: "var(--color-brick)" }} role="alert">
          {error}
        </p>
      )}

      {editing !== null ? (
        editor
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => {
              setEditing("new");
              setDraft(EMPTY);
            }}
            className="kicker px-3 py-2 transition-opacity hover:opacity-80"
            style={{ background: "var(--color-sage-deep)", color: "var(--color-cream)" }}
          >
            ＋ New skill
          </button>
          <label className="kicker cursor-pointer border px-3 py-2 transition-opacity hover:opacity-70" style={{ borderColor: "var(--color-rule-strong)", color: "var(--color-muted)" }}>
            Import skill (.zip)
            <input
              type="file"
              accept=".zip,application/zip"
              className="hidden"
              disabled={busy}
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = ""; // allow re-selecting the same file
                if (f) importZip(f);
              }}
            />
          </label>
          <span className="kicker" style={{ color: "var(--color-faint)" }}>
            imports land disabled — review, then enable
          </span>
        </div>
      )}

      {skills.length === 0 && editing === null ? (
        <p className="kicker py-6 text-center" style={{ color: "var(--color-faint)" }}>
          No skills yet — write one and the assistant will follow it whenever a request matches its description.
        </p>
      ) : (
        <ul>
          {skills.map((s) => (
            <li key={s.slug} className="flex flex-wrap items-center gap-3 border-b py-3" style={{ borderColor: "var(--color-rule)", opacity: s.enabled ? 1 : 0.55 }}>
              <label className="flex cursor-pointer items-center gap-2">
                <input type="checkbox" checked={s.enabled} onChange={() => toggle(s)} disabled={busy} aria-label={`Enable ${s.name}`} />
              </label>
              <div className="min-w-0 flex-1">
                <p style={{ fontFamily: "var(--font-body)", fontSize: "1rem" }}>
                  {s.name} <span className="kicker ml-1" style={{ color: "var(--color-faint)" }}>{s.slug}</span>
                  {s.files.length > 0 && (
                    <span className="kicker ml-2" style={{ color: "var(--color-sage-deep)" }}>
                      {s.files.length} file{s.files.length > 1 ? "s" : ""}
                    </span>
                  )}
                </p>
                <p style={{ color: "var(--color-muted)", fontSize: "0.85rem", fontFamily: "var(--font-body)" }}>{s.description || "(no description — the assistant won't know when to use it)"}</p>
              </div>
              <button type="button" onClick={() => startEdit(s)} disabled={busy} className="kicker border px-2.5 py-1 transition-opacity hover:opacity-70" style={{ borderColor: "var(--color-rule-strong)", color: "var(--color-muted)" }}>
                Edit
              </button>
              <button type="button" onClick={() => del(s)} disabled={busy} title="Delete skill" aria-label={`Delete ${s.name}`} className="px-2 transition-opacity hover:opacity-60" style={{ color: "var(--color-faint)" }}>
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
