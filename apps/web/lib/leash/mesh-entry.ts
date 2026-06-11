/**
 * Pure mapping for the Settings → Devices "My meshes" New/Join forms. Turns a
 * visibility-first form choice into the `/api/leash/hypha/mesh` action + payload, or a
 * required-field error. No `server-only`, no Node — the card runs this in the browser.
 *
 * Mesh model: a mesh is PRIVATE (allow-listed; invite to join) or PUBLIC (broadcast-only;
 * anyone computing the same shared id meets — so "create" and "join" are the same op).
 * Unit-tested by scripts/smoke-mesh-entry.ts.
 */
export type MeshIntent = "new" | "join";
export type MeshVisibility = "private" | "public";

export interface MeshEntryInput {
  intent: MeshIntent;
  visibility: MeshVisibility;
  /** Mesh name (new+private) or membership label (everything else). */
  label?: string;
  /** Private join only — the pasted invite hex. */
  invite?: string;
  /** Public only — the agreed shared id two devices compute to meet. */
  sharedId?: string;
}

export type MeshEntryResult =
  | { action: "new"; payload: { label: string } }
  | { action: "join"; payload: { invite: string; label: string } }
  | { action: "public-join"; payload: { cellId: string; label: string } }
  | { error: string };

export function meshEntryAction(input: MeshEntryInput): MeshEntryResult {
  const label = (input.label ?? "").trim();

  if (input.visibility === "public") {
    const cellId = (input.sharedId ?? "").trim();
    if (!cellId) return { error: "Enter a shared id (any agreed name — devices computing the same id meet)." };
    return { action: "public-join", payload: { cellId, label: label || "Public mesh" } };
  }

  // private
  if (input.intent === "new") {
    return { action: "new", payload: { label: label || "Mesh" } };
  }
  const invite = (input.invite ?? "").trim();
  if (!invite) return { error: "Paste an invite first." };
  return { action: "join", payload: { invite, label: label || "Mesh" } };
}
