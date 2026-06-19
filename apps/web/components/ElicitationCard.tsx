"use client";
import { useMemo, useState } from "react";
import { fetchWithTimeout } from "../lib/http.ts";
import { toast } from "./Toast.tsx";
import type { ElicitationView } from "../lib/leash/types.ts";

/**
 * MCP elicitation form (client) — an MCP server asked the USER for input mid-tool-call
 * (`elicitation/create`). Renders a form from the request's flat JSON schema
 * (string/number/boolean/enum → input/number/checkbox/select, `required` honored) and
 * answers via POST /api/leash/elicitations/[id] (accept + content | decline | cancel).
 * Visually kin to the tool-approval card (shared tool-card styles); unanswered forms
 * time out server-side to `cancel`, so abandoning one never hangs the tool.
 */

interface FieldDef {
  type?: string;
  title?: string;
  description?: string;
  enum?: unknown[];
  enumNames?: string[];
  default?: unknown;
}

interface FlatSchema {
  type?: string;
  properties?: Record<string, FieldDef>;
  required?: string[];
}

export function ElicitationCard({ elicitation, onDone }: { elicitation: ElicitationView; onDone: (id: string) => void }) {
  const schema = (elicitation.requestedSchema ?? {}) as FlatSchema;
  const fields = useMemo(() => Object.entries(schema.properties ?? {}), [schema]);
  const required = useMemo(() => new Set(schema.required ?? []), [schema]);
  const [values, setValues] = useState<Record<string, unknown>>(() => {
    const init: Record<string, unknown> = {};
    for (const [name, def] of Object.entries(schema.properties ?? {})) if (def.default !== undefined) init[name] = def.default;
    return init;
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const missingRequired = [...required].some((name) => {
    const v = values[name];
    return v === undefined || v === null || v === "";
  });

  const respond = async (action: "accept" | "decline" | "cancel") => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetchWithTimeout(`/api/leash/elicitations/${elicitation.id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(action === "accept" ? { action, content: values } : { action }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        const msg = body.error ?? `Failed (${res.status}).`;
        setError(msg);
        toast.error(msg);
        if (res.status === 404) {
          toast.info("That request already timed out");
          onDone(elicitation.id); // already timed out — drop the stale card
        }
        return;
      }
      toast.success(action === "accept" ? "Response sent" : action === "decline" ? "Request declined" : "Request cancelled");
      onDone(elicitation.id);
    } catch {
      const msg = "Request failed — is the app still running?";
      setError(msg);
      toast.error(msg);
    } finally {
      setBusy(false);
    }
  };

  const set = (name: string, v: unknown) => setValues((prev) => ({ ...prev, [name]: v }));

  return (
    <div className="tool-card tool-approval-card">
      <span className="tool-card-kicker kicker kicker-sage">📝 {elicitation.serverName} asks</span>
      <p style={{ fontFamily: "var(--font-body)", fontSize: "0.92rem", marginBottom: "0.6rem" }}>{elicitation.message}</p>
      {error && (
        <p className="kicker" style={{ color: "var(--color-brick)" }} role="alert">
          {error}
        </p>
      )}
      <div className="elicit-fields">
        {fields.map(([name, def]) => {
          const label = def.title ?? name;
          const req = required.has(name);
          if (def.type === "boolean") {
            return (
              <label key={name} className="elicit-field elicit-field-bool">
                <input type="checkbox" checked={Boolean(values[name])} onChange={(e) => set(name, e.target.checked)} disabled={busy} />
                <span>
                  {label}
                  {req ? " *" : ""}
                </span>
              </label>
            );
          }
          if (Array.isArray(def.enum) && def.enum.length > 0) {
            return (
              <label key={name} className="elicit-field">
                <span className="kicker">
                  {label}
                  {req ? " *" : ""}
                </span>
                <select value={String(values[name] ?? "")} onChange={(e) => set(name, e.target.value)} disabled={busy}>
                  <option value="" disabled>
                    choose…
                  </option>
                  {def.enum.map((opt, i) => (
                    <option key={String(opt)} value={String(opt)}>
                      {def.enumNames?.[i] ?? String(opt)}
                    </option>
                  ))}
                </select>
                {def.description && <span className="elicit-hint">{def.description}</span>}
              </label>
            );
          }
          const numeric = def.type === "number" || def.type === "integer";
          return (
            <label key={name} className="elicit-field">
              <span className="kicker">
                {label}
                {req ? " *" : ""}
              </span>
              <input
                type={numeric ? "number" : "text"}
                value={String(values[name] ?? "")}
                onChange={(e) => set(name, numeric ? (e.target.value === "" ? "" : Number(e.target.value)) : e.target.value)}
                disabled={busy}
                placeholder={def.description ?? ""}
              />
              {def.description && <span className="elicit-hint">{def.description}</span>}
            </label>
          );
        })}
      </div>
      <div className="tool-approval-actions">
        <button type="button" className="tool-approve" disabled={busy || missingRequired} onClick={() => void respond("accept")}>
          Submit
        </button>
        <button type="button" className="tool-deny" disabled={busy} onClick={() => void respond("decline")}>
          Decline
        </button>
        <button type="button" className="tool-deny" disabled={busy} onClick={() => void respond("cancel")}>
          Cancel
        </button>
      </div>
    </div>
  );
}
