/**
 * Pure-logic smoke for the Settings → Devices "My meshes" New/Join forms
 * (apps/web/lib/leash/mesh-entry.ts). Proves the visibility-first mapping:
 * new+private → /mesh/new, new/join+public → /mesh/public-join (creating a public
 * mesh == entering its shared id), join+private → /mesh/join; trimming, default
 * labels, and required-field errors.
 *   npm run smoke:mesh-entry
 */
import assert from "node:assert/strict";
import { meshEntryAction, type MeshEntryResult } from "../apps/web/lib/leash/mesh-entry.ts";

const ok = (r: MeshEntryResult) => {
  assert.ok(!("error" in r), `expected an action, got error: ${"error" in r ? r.error : ""}`);
  return r as Exclude<MeshEntryResult, { error: string }>;
};
const err = (r: MeshEntryResult) => {
  assert.ok("error" in r, "expected an error result");
  assert.equal(typeof (r as { error: string }).error, "string");
  assert.ok((r as { error: string }).error.length > 0, "error must be a non-empty message");
};

// new + private → /mesh/new with the given name
let r = ok(meshEntryAction({ intent: "new", visibility: "private", label: "Home" }));
assert.equal(r.action, "new");
assert.deepEqual(r.payload, { label: "Home" });

// new + private, blank name → default "Mesh" (no empty label sent)
r = ok(meshEntryAction({ intent: "new", visibility: "private", label: "   " }));
assert.deepEqual(r.payload, { label: "Mesh" });

// new + public → /mesh/public-join (create == enter the shared id), label kept
r = ok(meshEntryAction({ intent: "new", visibility: "public", sharedId: "my-block-42", label: "Block" }));
assert.equal(r.action, "public-join");
assert.deepEqual(r.payload, { cellId: "my-block-42", label: "Block" });

// public, blank label → default "Public mesh"
r = ok(meshEntryAction({ intent: "new", visibility: "public", sharedId: "my-block-42" }));
assert.deepEqual(r.payload, { cellId: "my-block-42", label: "Public mesh" });

// public requires a shared id
err(meshEntryAction({ intent: "new", visibility: "public", sharedId: "  " }));
err(meshEntryAction({ intent: "join", visibility: "public", sharedId: "" }));

// join + private → /mesh/join; invite trimmed, label kept
r = ok(meshEntryAction({ intent: "join", visibility: "private", invite: "  abc123  ", label: "Work" }));
assert.equal(r.action, "join");
assert.deepEqual(r.payload, { invite: "abc123", label: "Work" });

// join + private, blank label → default "Mesh"
r = ok(meshEntryAction({ intent: "join", visibility: "private", invite: "abc123" }));
assert.deepEqual(r.payload, { invite: "abc123", label: "Mesh" });

// join + private requires an invite
err(meshEntryAction({ intent: "join", visibility: "private", invite: "   " }));

// join + public → same /mesh/public-join as new+public (id trimmed)
r = ok(meshEntryAction({ intent: "join", visibility: "public", sharedId: "  my-block-42 " }));
assert.equal(r.action, "public-join");
assert.deepEqual(r.payload, { cellId: "my-block-42", label: "Public mesh" });

console.log("✅ mesh-entry — new/join × private/public mapping · trim · default labels · required-field errors — GO");
