"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { PlusIcon, UploadIcon, PencilIcon, Trash2Icon, RotateCcwIcon } from "lucide-react";
import { fetchWithTimeout, TIMEOUT } from "../lib/http.ts";
import { appConfirm } from "../lib/prompt.ts";
import { Switch } from "./Switch.tsx";
import { IconButton } from "./IconButton.tsx";
import { VisibilityFilter, type Visibility } from "./VisibilityFilter.tsx";
import { toast } from "./Toast.tsx";
import type { Skill } from "../lib/leash/skills-store.ts";

/**
 * Skills editor (client) — create / edit / enable / delete / IMPORT skill folders
 * (`<slug>/SKILL.md` + optional nested attachments per the agentskills.io layout:
 * references/, scripts/, assets/). Enabled skills are advertised in the chat system
 * prompt; the model loads the body via `read_skill`, attachments via `read_skill_file`,
 * and runs `scripts/*` via `run_skill_script`. Imported skills always land DISABLED —
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

type ImportMode = "zip" | "github" | "folder";

/** Attachment manager for one existing skill (list · load-to-edit · save · delete). */
function AttachmentsEditor({ slug, files, busy, onChanged, onError }: { slug: string; files: string[]; busy: boolean; onChanged: () => void; onError: (e: string) => void }) {
  const [fileName, setFileName] = useState("");
  const [fileBody, setFileBody] = useState("");
  const [saving, setSaving] = useState(false);

  const load = async (f: string) => {
    try {
      const res = await fetchWithTimeout(fileUrl(slug, f));
      const body = (await res.json()) as { text?: string; error?: string };
      if (!res.ok) {
        const msg = body.error ?? `Couldn't read ${f}.`;
        onError(msg);
        toast.error(msg);
        return;
      }
      setFileName(f);
      setFileBody(body.text ?? "");
    } catch {
      const msg = "Request failed — is the app still running?";
      onError(msg);
      toast.error(msg);
    }
  };

  const save = async () => {
    if (!fileName.trim()) return;
    setSaving(true);
    try {
      const res = await fetchWithTimeout(fileUrl(slug, fileName.trim()), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: fileBody }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        const msg = body.error ?? `Save failed (${res.status}).`;
        onError(msg);
        toast.error(msg);
      } else {
        setFileName("");
        setFileBody("");
        toast.success("Attachment saved");
        onChanged();
      }
    } catch {
      const msg = "Request failed — is the app still running?";
      onError(msg);
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  };

  const del = async (f: string) => {
    if (!(await appConfirm(`Delete the attachment "${f}"?`, { confirmLabel: "Delete", destructive: true }))) return;
    try {
      const res = await fetchWithTimeout(fileUrl(slug, f), { method: "DELETE" });
      if (!res.ok) {
        const msg = `Delete failed (${res.status}).`;
        onError(msg);
        toast.error(msg);
        return;
      }
      toast.success("Attachment deleted");
      onChanged();
    } catch {
      const msg = "Request failed — is the app still running?";
      onError(msg);
      toast.error(msg);
    }
  };

  return (
    <div className="mt-4 border-t pt-3" style={{ borderColor: "var(--color-rule)" }}>
      <span className="kicker" style={{ color: "var(--color-faint)" }}>
        Attachments — files the instructions can reference; the model loads them with read_skill_file
      </span>
      {files.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-2">
          {files.map((f) => (
            <li key={f} className="flex items-center gap-1 border py-0.5 pl-2 pr-0.5" style={{ borderColor: "var(--color-rule-strong)" }}>
              <button type="button" onClick={() => void load(f)} className="kicker transition-opacity hover:opacity-60" style={{ color: "var(--color-ink-soft)" }}>
                {f}
              </button>
              <IconButton title={`Delete ${f}`} danger disabled={busy || saving} onClick={() => void del(f)}>
                <Trash2Icon size={13} />
              </IconButton>
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

  // Import panel state
  const [importMode, setImportMode] = useState<ImportMode | null>(null);
  const [importInput, setImportInput] = useState("");

  // Source filter — "built-in" = shipped with the app; "custom" = user-created or imported.
  const [filter, setFilter] = useState<Visibility>("all");
  const menuSkills = skills.filter((s) => s.userInvocable !== false);
  const counts: Record<Visibility, number> = {
    all: menuSkills.length,
    builtin: menuSkills.filter((s) => s.builtin).length,
    custom: menuSkills.filter((s) => !s.builtin).length,
  };
  const visible = menuSkills.filter((s) => (filter === "all" ? true : filter === "builtin" ? s.builtin : !s.builtin));

  // VS Code open-editor state: which skill is open in VS Code, or showing its path
  const [vsCodeNotice, setVsCodeNotice] = useState<{ slug: string; path: string } | null>(null);
  // Path notice when VS Code CLI is not found (shown above the inline editor)
  const [pathNotice, setPathNotice] = useState<string | null>(null);

  const call = async (fn: () => Promise<Response>, success?: string): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      const res = await fn();
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        const msg = body.error ?? `Request failed (${res.status}).`;
        setError(msg);
        toast.error(msg);
        return false;
      }
      if (success) toast.success(success);
      router.refresh();
      return true;
    } catch {
      const msg = "Request failed — is the app still running?";
      setError(msg);
      toast.error(msg);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const startEdit = (s: Skill) => {
    setEditing(s.slug);
    setDraft({ name: s.name, description: s.description, body: s.body });
  };

  const openEditor = async (s: Skill) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetchWithTimeout(`/api/leash/skills/${s.slug}/open-editor`, { method: "POST" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        const msg = body.error ?? `Request failed (${res.status}).`;
        setError(msg);
        toast.error(msg);
        return;
      }
      const body = (await res.json()) as { opened: boolean; path: string };
      if (body.opened) {
        setVsCodeNotice({ slug: s.slug, path: body.path });
        toast.success("Opened in VS Code");
      } else {
        // VS Code CLI not found — fall back to textarea editor, show path
        setPathNotice(body.path);
        startEdit(s);
        toast.info("VS Code CLI not found — editing in browser");
      }
    } catch {
      const msg = "Request failed — is the app still running?";
      setError(msg);
      toast.error(msg);
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!draft.name.trim()) return;
    const ok =
      editing === "new"
        ? await call(() => fetchWithTimeout("/api/leash/skills", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(draft) }), "Skill created")
        : await call(() => fetchWithTimeout(`/api/leash/skills/${editing}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(draft) }), "Skill saved");
    if (ok) {
      setEditing(null);
      setDraft(EMPTY);
      setPathNotice(null);
    }
  };

  const toggle = (s: Skill) =>
    void call(() => fetchWithTimeout(`/api/leash/skills/${s.slug}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: !s.enabled }) }), `Skill ${s.enabled ? "disabled" : "enabled"}`);

  const del = async (s: Skill) => {
    if (!(await appConfirm(`Delete the skill "${s.name}"?`, { confirmLabel: "Delete", destructive: true }))) return;
    void call(() => fetchWithTimeout(`/api/leash/skills/${s.slug}`, { method: "DELETE" }), "Skill deleted");
  };

  const importZip = (file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    toast.info("Importing skill…");
    void call(() => fetchWithTimeout("/api/leash/skills/import", { method: "POST", body: fd }, TIMEOUT.heavy), "Skill imported");
  };

  const importFromInput = () => {
    const input = importInput.trim();
    if (!input) return;
    const url = importMode === "github" ? "/api/leash/skills/import-github" : "/api/leash/skills/import-folder";
    const body = importMode === "github" ? { url: input } : { path: input };
    toast.info("Importing skill…");
    void call(() => fetchWithTimeout(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, TIMEOUT.heavy), "Skill imported");
  };

  const editor = (
    <section className="border p-4" style={{ borderColor: "var(--color-rule-strong)", background: "var(--color-paper)" }}>
      <span className="kicker kicker-sage">{editing === "new" ? "New skill" : `Editing · ${editing}`}</span>
      {pathNotice && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className="kicker" style={{ color: "var(--color-faint)" }}>VS Code CLI not found · editing in browser</span>
          <code style={{ fontSize: "0.78rem", fontFamily: "var(--font-mono)", color: "var(--color-ink-soft)" }}>{pathNotice}</code>
          <button
            type="button"
            onClick={() =>
              void navigator.clipboard
                .writeText(pathNotice)
                .then(() => toast.success("Path copied"))
                .catch(() => toast.error("Couldn't copy path"))
            }
            className="kicker border px-2 py-0.5 transition-opacity hover:opacity-70"
            style={{ borderColor: "var(--color-rule)", color: "var(--color-muted)" }}
          >
            Copy path
          </button>
        </div>
      )}
      <div className="mt-3 flex flex-col gap-2">
        <input
          value={draft.name}
          onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
          placeholder="Skill package name (e.g. trip-planning)"
          aria-label="Skill package name"
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
        <button type="button" disabled={busy} onClick={() => { setEditing(null); setDraft(EMPTY); setPathNotice(null); }} className="kicker border px-3 py-1.5 transition-opacity hover:opacity-70" style={{ borderColor: "var(--color-rule-strong)", color: "var(--color-muted)" }}>
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
        <div className="flex flex-col gap-2">
          {/* Primary action row */}
          <div className="flex items-center gap-3">
            <span className="kicker kicker-sage">Skills</span>
            <span className="h-px flex-1" style={{ background: "var(--color-rule)" }} />
            {importMode === null && (
              <span className="kicker" style={{ color: "var(--color-faint)" }}>
                imports land disabled
              </span>
            )}
            <VisibilityFilter value={filter} onChange={setFilter} counts={counts} />
            <IconButton title="Import skill (.zip / GitHub / folder)" disabled={busy} onClick={() => setImportMode((m) => (m === null ? "zip" : null))}>
              <UploadIcon size={16} />
            </IconButton>
            <IconButton title="New skill" color="var(--color-sage-deep)" onClick={() => { setEditing("new"); setDraft(EMPTY); setImportMode(null); }}>
              <PlusIcon size={16} />
            </IconButton>
          </div>

          {/* Expanded import row */}
          {importMode !== null && (
            <div className="flex flex-wrap items-center gap-2 border-l-2 pl-3" style={{ borderColor: "var(--color-rule-strong)" }}>
              {/* Mode tabs */}
              {(["zip", "github", "folder"] as ImportMode[]).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => { setImportMode(mode); setImportInput(""); }}
                  className="kicker border px-2.5 py-1 transition-opacity hover:opacity-80"
                  style={{
                    borderColor: importMode === mode ? "var(--color-sage-deep)" : "var(--color-rule-strong)",
                    color: importMode === mode ? "var(--color-sage-deep)" : "var(--color-muted)",
                  }}
                >
                  {mode === "zip" ? ".zip" : mode === "github" ? "GitHub URL" : "Folder"}
                </button>
              ))}

              {/* Input + action for github/folder modes */}
              {importMode !== "zip" ? (
                <>
                  <input
                    value={importInput}
                    onChange={(e) => setImportInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter" && importInput.trim()) importFromInput(); }}
                    placeholder={importMode === "github" ? "https://github.com/owner/repo" : "/path/to/skill-dir"}
                    aria-label={importMode === "github" ? "GitHub repository URL" : "Local folder path"}
                    className="flex-1 border bg-transparent px-3 py-1.5"
                    style={{ borderColor: "var(--color-rule)", fontFamily: "var(--font-mono)", fontSize: "0.78rem", minWidth: "14rem" }}
                    disabled={busy}
                  />
                  <button
                    type="button"
                    disabled={busy || !importInput.trim()}
                    onClick={importFromInput}
                    className="kicker border px-3 py-1.5 transition-opacity hover:opacity-70 disabled:opacity-40"
                    style={{ borderColor: "var(--color-rule-strong)", color: "var(--color-muted)" }}
                  >
                    Import
                  </button>
                </>
              ) : (
                <label className="kicker cursor-pointer border px-3 py-1.5 transition-opacity hover:opacity-70" style={{ borderColor: "var(--color-rule-strong)", color: "var(--color-muted)" }}>
                  Browse…
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
              )}

              <span className="kicker" style={{ color: "var(--color-faint)" }}>
                imports land disabled — review, then enable
              </span>
            </div>
          )}
        </div>
      )}

      {skills.length === 0 && editing === null ? (
        <p className="kicker py-6 text-center" style={{ color: "var(--color-faint)" }}>
          No skills yet — write one and the assistant will follow it whenever a request matches its description.
        </p>
      ) : visible.length === 0 && editing === null ? (
        <p className="kicker py-6 text-center" style={{ color: "var(--color-faint)" }}>
          No {filter === "builtin" ? "built-in" : "custom"} skills.
        </p>
      ) : (
        <ul>
          {visible.map((s) => (
            <li key={s.slug} className="flex flex-wrap items-center gap-3 border-b py-3" style={{ borderColor: "var(--color-rule)", opacity: s.enabled ? 1 : 0.6 }}>
              <Switch on={s.enabled} disabled={busy} onChange={() => toggle(s)} label={`${s.enabled ? "Disable" : "Enable"} ${s.name}`} />
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
              {vsCodeNotice?.slug === s.slug ? (
                <span className="kicker flex items-center gap-1">
                  <span style={{ color: "var(--color-sage-deep)" }}>Opened in VS Code</span>
                  <IconButton title="Reload after editing" onClick={() => { setVsCodeNotice(null); router.refresh(); }}>
                    <RotateCcwIcon size={14} />
                  </IconButton>
                </span>
              ) : (
                <>
                  <IconButton title={`Edit ${s.name}`} disabled={busy} onClick={() => void openEditor(s)}>
                    <PencilIcon size={15} />
                  </IconButton>
                  <IconButton title={`Delete ${s.name}`} danger disabled={busy} onClick={() => void del(s)}>
                    <Trash2Icon size={15} />
                  </IconButton>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
