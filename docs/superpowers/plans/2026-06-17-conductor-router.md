# Conductor Router Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a capability-first, cost-aware request router ("Conductor") that classifies each non-trivial turn with a small LLM, discovers what every reachable device/peer can do via MCP tools, hard-gates by sensitivity, ranks the survivors, and executes the pick locally or on a specific mesh peer.

**Architecture:** Pure routing policy (`tagsForAlias`, `rankRoutes`) lives in `packages/leash-core/src/routing` so both the MCP daemon and the web app import one source of truth. A net-new `router` MCP tool-group (in the existing `leash-tools-mcp` daemon) exposes discovery + ranking tools, sourcing live peer data from hypha's `GET /peers`. The Conductor is a small-LLM classifier in the web app, gated by the existing `classifyEffort` fast-path, that produces a capability bar; `rankRoutes` turns the bar + discovered options into a pick; the pick is executed by setting `sensitivity` + `meshId` + a new `peerKey` pin on the completion request, which the broker forwards and the hypha shim already honors (extended here for the peer pin).

**Tech Stack:** TypeScript (ESM, `tsx`), Zod (MCP input schemas), Vercel AI SDK (`generateText`, `embed`), `@modelcontextprotocol/sdk`, `node:assert` tsx assertion scripts (repo test idiom: `npx tsx <file>.test.ts`, exit 0 = pass).

## Global Constraints

- **All inference goes through `@qvac/sdk` only** — no cloud AI APIs. The Conductor uses `classifierModel()` (the kit's 1.7B) and `embeddingModel()` (gte-large) from `apps/web/lib/leash/provider.ts`; both are QVAC-backed. (CLAUDE.md Hard Rule 1.)
- **License Apache-2.0**; new files carry no other license header (match neighbors — no header).
- **Offline-capable**: every new code path must degrade gracefully with no network. The Conductor, discovery tools, and `rankRoutes` MUST fall back to a local route on any failure (dead serve, hypha unreachable, empty mesh).
- **No mocks/stubs in shipped code.** Test *fixtures* (sample `DeviceCapability` rows, prompt→bar fixtures) are fine; fake behavior is not.
- **ESM + `.ts` import specifiers** (the repo imports with explicit `.ts` extensions — see `groups/index.ts`).
- **Sensitivity union is `"private" | "shareable"`** (matches `apps/hypha/src/mesh-router.ts` and `body.sensitivity` in `shim.ts:717,795`). "private" = keep in-mesh (sensitive); "shareable" = may use public tier.
- **Public mesh is NOT built this round** — leave the documented extension seam (a `"public"` tier value the gate already excludes, and a `tagsForAlias` advertised-tags fallback). Do not implement `list_public_mesh_models`.
- Audit records use the canonical `AuditRecord` shape in `packages/shared/src/index.ts` (event `"delegation"` for a peer route, `"note"` for routing decisions); emit one JSONL line per decision.

---

## File Structure

**Create:**
- `packages/leash-core/src/routing/types.ts` — routing types (`Modality`, `ParamClass`, `Specialist`, `Sensitivity`, `Tier`, `CapabilityTags`, `CapabilityBar`, `RouteOption`, `RankedRoute`).
- `packages/leash-core/src/routing/tags.ts` — `ALIAS_TAGS` table + `tagsForAlias()`.
- `packages/leash-core/src/routing/rank.ts` — `rankRoutes()` pure policy (sensitivity gate + capability filter + cost ranking).
- `packages/leash-core/src/routing/index.ts` — barrel re-export.
- `packages/leash-core/scripts/routing-tags.test.ts` — tsx assertion test for `tagsForAlias`.
- `packages/leash-core/scripts/routing-rank.test.ts` — tsx assertion test for `rankRoutes`.
- `packages/leash-core/src/groups/router.ts` — the `router` MCP tool-group (`get_device_capability`, `list_private_mesh_models`, `rank_routes`).
- `apps/web/lib/leash/conductor.ts` — the Conductor classifier (fast-path gate + small-LLM bar + deterministic fallback).
- `apps/web/scripts/conductor.test.ts` — tsx assertion test for the deterministic fallback path (no live model needed).

**Modify:**
- `packages/leash-core/src/groups/index.ts` — register `routerGroup`.
- `apps/hypha/src/mesh-router.ts` — add optional `peerKey` pin to `ChatRouteReq` + `route()`/`forwardTargetsForAlias()`.
- `apps/hypha/src/shim.ts` — read `body.peerKey` and pass it into the router calls (lines ~795–818).
- `apps/web/lib/leash/provider.ts` — add a `routedQvac(opts)` helper that sets `sensitivity`/`meshId`/`peerKey` on the request body.
- `apps/web/app/api/leash/chat/route.ts` — invoke the Conductor before assembling the main agent; use the routed model + record the decision.

---

## Task 1: Routing types + `tagsForAlias`

**Files:**
- Create: `packages/leash-core/src/routing/types.ts`
- Create: `packages/leash-core/src/routing/tags.ts`
- Create: `packages/leash-core/src/routing/index.ts`
- Test: `packages/leash-core/scripts/routing-tags.test.ts`

**Interfaces:**
- Produces:
  - Types: `Modality = "text"|"vision"|"audio"`, `ParamClass = "tiny"|"small"|"mid"|"large"|"unknown"`, `Specialist = "general"|"health"|"vision"|"computer"`, `Sensitivity = "private"|"shareable"`, `Tier = "device"|"private"|"public"`.
  - `CapabilityTags { modality: Modality; paramClass: ParamClass; specialist: Specialist; contextWindow?: number }`
  - `tagsForAlias(alias: string, advertised?: Partial<CapabilityTags>): CapabilityTags`

- [ ] **Step 1: Write the failing test**

```ts
// packages/leash-core/scripts/routing-tags.test.ts
/**
 * tsx assertion script (repo idiom). Verifies tagsForAlias: known aliases resolve
 * from the table; advertised tags win for unknown aliases; unknown+no-advert falls
 * back to a general text last-resort. Run: npx tsx packages/leash-core/scripts/routing-tags.test.ts
 */
import assert from "node:assert";
import { tagsForAlias } from "../src/routing/tags.ts";

function main() {
  // 1. Known specialist alias resolves from the table.
  assert.equal(tagsForAlias("qwen3vl").modality, "vision", "qwen3vl should be vision");
  assert.equal(tagsForAlias("medpsy").specialist, "health", "medpsy should be health");
  assert.equal(tagsForAlias("qwen3-4b").paramClass, "small", "qwen3-4b should be small");

  // 2. Unknown alias with advertised tags prefers the advertised values (public-mesh seam).
  const adv = tagsForAlias("stranger-model", { modality: "vision", paramClass: "large" });
  assert.equal(adv.modality, "vision", "advertised modality should win for unknown alias");
  assert.equal(adv.paramClass, "large", "advertised paramClass should win for unknown alias");

  // 3. Unknown alias, no advertised tags → general text last-resort.
  const fb = tagsForAlias("who-knows");
  assert.deepEqual(
    { m: fb.modality, p: fb.paramClass, s: fb.specialist },
    { m: "text", p: "unknown", s: "general" },
    "unknown alias should fall back to general/text/unknown",
  );
  console.log("routing-tags: PASS");
}
main();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx packages/leash-core/scripts/routing-tags.test.ts`
Expected: FAIL — `Cannot find module '../src/routing/tags.ts'`.

- [ ] **Step 3: Write the types**

```ts
// packages/leash-core/src/routing/types.ts
/**
 * Routing types — the shared vocabulary for the Conductor router. One source of truth
 * imported by the MCP discovery group (leash-tools-mcp daemon) AND the web chat route.
 */
export type Modality = "text" | "vision" | "audio";
export type ParamClass = "tiny" | "small" | "mid" | "large" | "unknown";
export type Specialist = "general" | "health" | "vision" | "computer";
/** Matches apps/hypha mesh-router: "private" = keep in-mesh (sensitive); "shareable" = public OK. */
export type Sensitivity = "private" | "shareable";
/** "public" is the documented extension seam — the sensitivity gate excludes it; not built this round. */
export type Tier = "device" | "private" | "public";

export interface CapabilityTags {
  modality: Modality;
  paramClass: ParamClass;
  specialist: Specialist;
  contextWindow?: number;
}

/** What a turn REQUIRES. A route clears the bar when its tags satisfy every field. */
export interface CapabilityBar {
  modality: Modality;
  /** Route paramClass must be >= this (unknown is treated as below tiny). */
  minParamClass: Exclude<ParamClass, "unknown">;
  /** When set and not "general", the route's specialist must equal it. */
  specialist?: Specialist;
}

/** A reachable place a turn could run, with execution coordinates + cost/load signals. */
export interface RouteOption {
  tier: Tier;
  alias: string;
  tags: CapabilityTags;
  /** undefined ⇒ this device (local). Set ⇒ delegate to this mesh peer. */
  peerKey?: string;
  /** Mesh the peer belongs to (the shared-autobase id the shim expects as `meshId`). */
  meshId?: string;
  /** Delegable SDK src for a peer route (DeviceCapability.models[].modelSrc). */
  modelSrc?: string;
  /** µ per kilo-token. 0 for local. */
  pricePerKiloToken: number;
  /** Live in-flight generations on the host. */
  inflight: number;
  latencyHint?: number;
}

export interface RankedRoute extends RouteOption {
  score: number;
  reason: string;
}
```

- [ ] **Step 4: Write `tags.ts`**

```ts
// packages/leash-core/src/routing/tags.ts
/**
 * Capability tags per served alias. PRIVATE MESH: every device is owned, so we resolve
 * tags locally from this table by the advertised alias string. PUBLIC MESH (extension
 * seam): a peer advertises its own tags for models we don't know — `advertised` wins then.
 * An alias with neither resolves to a general text last-resort (used only if nothing else
 * clears the bar).
 */
import type { CapabilityTags } from "./types.ts";

const ALIAS_TAGS: Record<string, CapabilityTags> = {
  "qwen3-4b": { modality: "text", paramClass: "small", specialist: "general" },
  "qwen3-1.7b": { modality: "text", paramClass: "tiny", specialist: "general" },
  "qwen3vl": { modality: "vision", paramClass: "mid", specialist: "vision" },
  medpsy: { modality: "text", paramClass: "small", specialist: "health" },
  "gte-large": { modality: "text", paramClass: "tiny", specialist: "general" },
};

const FALLBACK: CapabilityTags = { modality: "text", paramClass: "unknown", specialist: "general" };

/** Resolve an alias to capability tags. Advertised tags (public-mesh seam) win over the
 *  local table for aliases we don't know; known aliases use the table. */
export function tagsForAlias(alias: string, advertised?: Partial<CapabilityTags>): CapabilityTags {
  const known = ALIAS_TAGS[alias.toLowerCase()];
  if (known) return known;
  if (advertised && (advertised.modality || advertised.paramClass || advertised.specialist)) {
    return { ...FALLBACK, ...advertised };
  }
  return FALLBACK;
}
```

- [ ] **Step 5: Write the barrel**

```ts
// packages/leash-core/src/routing/index.ts
export * from "./types.ts";
export * from "./tags.ts";
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx tsx packages/leash-core/scripts/routing-tags.test.ts`
Expected: prints `routing-tags: PASS`, exit 0.

- [ ] **Step 7: Commit**

```bash
git add packages/leash-core/src/routing/types.ts packages/leash-core/src/routing/tags.ts packages/leash-core/src/routing/index.ts packages/leash-core/scripts/routing-tags.test.ts
git commit -m "feat(router): routing types + tagsForAlias capability resolver"
```

---

## Task 2: `rankRoutes` pure policy

**Files:**
- Create: `packages/leash-core/src/routing/rank.ts`
- Modify: `packages/leash-core/src/routing/index.ts` (add `export * from "./rank.ts";`)
- Test: `packages/leash-core/scripts/routing-rank.test.ts`

**Interfaces:**
- Consumes: `RouteOption`, `CapabilityBar`, `Sensitivity`, `RankedRoute`, `ParamClass` (Task 1).
- Produces:
  - `rankRoutes(input: { bar: CapabilityBar; sensitivity: Sensitivity; options: RouteOption[] }): RankedRoute[]` — gated, capability-filtered, cost-ranked. Best route is index 0. Returns `[]` when nothing clears the bar.
  - `PARAM_ORDER: Record<ParamClass, number>` (exported for tests/tuning).

**Design notes (encode exactly):**
- Tier gate FIRST (privacy before cost): `sensitivity === "private"` ⇒ drop every `tier === "public"` option. `"shareable"` ⇒ keep all. (Public never appears this round, but the gate must be correct for the seam.)
- Capability filter: keep an option iff `option.tags.modality === bar.modality` AND `PARAM_ORDER[option.tags.paramClass] >= PARAM_ORDER[bar.minParamClass]` AND (`!bar.specialist || bar.specialist === "general" || option.tags.specialist === bar.specialist`).
- Score (lower = better): `score = pricePerKiloToken + inflight * INFLIGHT_PENALTY + TIER_BIAS[tier]`. `INFLIGHT_PENALTY = 400` (≈ one paid request, so a saturated local can lose to a free peer). `TIER_BIAS = { device: 0, private: 50, public: 150 }` (break near-ties toward privacy/local). Sort ascending by score; stable.

- [ ] **Step 1: Write the failing test**

```ts
// packages/leash-core/scripts/routing-rank.test.ts
/**
 * tsx assertion script (repo idiom). Verifies rankRoutes: privacy gate drops public for
 * sensitive turns; capability filter drops under-powered local; cheapest-that-clears wins;
 * a saturated local loses to a free peer; empty-after-filter returns [].
 * Run: npx tsx packages/leash-core/scripts/routing-rank.test.ts
 */
import assert from "node:assert";
import { rankRoutes } from "../src/routing/rank.ts";
import type { RouteOption, CapabilityBar } from "../src/routing/types.ts";

const local4b: RouteOption = { tier: "device", alias: "qwen3-4b", tags: { modality: "text", paramClass: "small", specialist: "general" }, pricePerKiloToken: 0, inflight: 0 };
const peerBig: RouteOption = { tier: "private", alias: "qwen3-32b", peerKey: "PK_PRO", meshId: "primary", modelSrc: "src://big", tags: { modality: "text", paramClass: "large", specialist: "general" }, pricePerKiloToken: 500, inflight: 0 };
const publicBig: RouteOption = { tier: "public", alias: "qwen3-32b", peerKey: "PK_PUB", meshId: "open", tags: { modality: "text", paramClass: "large", specialist: "general" }, pricePerKiloToken: 10, inflight: 0 };

function main() {
  const easyBar: CapabilityBar = { modality: "text", minParamClass: "small" };
  const hardBar: CapabilityBar = { modality: "text", minParamClass: "large" };

  // 1. Easy bar, idle local clears it → local (price 0) wins over a paid peer.
  let r = rankRoutes({ bar: easyBar, sensitivity: "private", options: [local4b, peerBig] });
  assert.equal(r[0]?.alias, "qwen3-4b", "idle local should win an easy turn");

  // 2. Hard bar → local 'small' is filtered out; the 'large' peer wins.
  r = rankRoutes({ bar: hardBar, sensitivity: "private", options: [local4b, peerBig] });
  assert.equal(r.length, 1, "only the large peer should clear a hard bar");
  assert.equal(r[0]?.peerKey, "PK_PRO", "hard turn should route to the large peer");

  // 3. Privacy gate: sensitive ('private') hard turn must NEVER pick the cheaper public peer.
  r = rankRoutes({ bar: hardBar, sensitivity: "private", options: [peerBig, publicBig] });
  assert.ok(r.every((x) => x.tier !== "public"), "private sensitivity must exclude public tier");
  assert.equal(r[0]?.peerKey, "PK_PRO", "sensitive hard turn → private peer, not cheaper public");

  // 4. Shareable hard turn MAY use the cheaper public peer.
  r = rankRoutes({ bar: hardBar, sensitivity: "shareable", options: [peerBig, publicBig] });
  assert.equal(r[0]?.peerKey, "PK_PUB", "shareable turn should take the cheaper public peer");

  // 5. Saturated local loses to a free peer on an easy turn (load offload).
  const busyLocal = { ...local4b, inflight: 3 };
  const freePeerSmall: RouteOption = { tier: "private", alias: "qwen3-4b", peerKey: "PK_FREE", meshId: "primary", modelSrc: "src://s", tags: { modality: "text", paramClass: "small", specialist: "general" }, pricePerKiloToken: 100, inflight: 0 };
  r = rankRoutes({ bar: easyBar, sensitivity: "private", options: [busyLocal, freePeerSmall] });
  assert.equal(r[0]?.peerKey, "PK_FREE", "saturated local should offload to a free peer");

  // 6. Nothing clears the bar → [].
  r = rankRoutes({ bar: { modality: "vision", minParamClass: "small" }, sensitivity: "private", options: [local4b] });
  assert.deepEqual(r, [], "no vision route → empty (caller falls back to local)");

  console.log("routing-rank: PASS");
}
main();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx packages/leash-core/scripts/routing-rank.test.ts`
Expected: FAIL — `Cannot find module '../src/routing/rank.ts'`.

- [ ] **Step 3: Write `rank.ts`**

```ts
// packages/leash-core/src/routing/rank.ts
/**
 * Deterministic routing policy — the auditable heart of the Conductor. The LLM produces a
 * capability bar; THIS picks the route. Order: (1) sensitivity tier gate (privacy before
 * cost — a sensitive turn can never reach the public tier no matter how cheap), (2) capability
 * filter (modality + paramClass headroom + specialist), (3) cost+load+privacy ranking.
 */
import type { CapabilityBar, ParamClass, RankedRoute, RouteOption, Sensitivity } from "./types.ts";

export const PARAM_ORDER: Record<ParamClass, number> = { unknown: -1, tiny: 0, small: 1, mid: 2, large: 3 };

const INFLIGHT_PENALTY = 400; // ≈ one paid request — lets a saturated local lose to a free peer
const TIER_BIAS: Record<RouteOption["tier"], number> = { device: 0, private: 50, public: 150 };

function clearsBar(o: RouteOption, bar: CapabilityBar): boolean {
  if (o.tags.modality !== bar.modality) return false;
  if (PARAM_ORDER[o.tags.paramClass] < PARAM_ORDER[bar.minParamClass]) return false;
  if (bar.specialist && bar.specialist !== "general" && o.tags.specialist !== bar.specialist) return false;
  return true;
}

export function rankRoutes(input: { bar: CapabilityBar; sensitivity: Sensitivity; options: RouteOption[] }): RankedRoute[] {
  const { bar, sensitivity, options } = input;
  // (1) Privacy gate FIRST — non-overridable by cost.
  const gated = options.filter((o) => (sensitivity === "private" ? o.tier !== "public" : true));
  // (2) Capability filter.
  const eligible = gated.filter((o) => clearsBar(o, bar));
  // (3) Rank by cost + load + privacy bias.
  return eligible
    .map((o) => {
      const score = o.pricePerKiloToken + o.inflight * INFLIGHT_PENALTY + TIER_BIAS[o.tier];
      const where = o.peerKey ? `peer ${o.alias}@${o.tier}` : `local ${o.alias}`;
      const reason = `${where} · ${o.pricePerKiloToken}µ/ktok · inflight ${o.inflight} · score ${score}`;
      return { ...o, score, reason };
    })
    .sort((a, b) => a.score - b.score);
}
```

- [ ] **Step 4: Add the barrel export**

In `packages/leash-core/src/routing/index.ts`, append:

```ts
export * from "./rank.ts";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx tsx packages/leash-core/scripts/routing-rank.test.ts`
Expected: prints `routing-rank: PASS`, exit 0.

- [ ] **Step 6: Commit**

```bash
git add packages/leash-core/src/routing/rank.ts packages/leash-core/src/routing/index.ts packages/leash-core/scripts/routing-rank.test.ts
git commit -m "feat(router): rankRoutes deterministic policy (privacy gate + capability filter + cost ranking)"
```

---

## Task 3: Capability-discovery MCP tool-group

**Files:**
- Create: `packages/leash-core/src/groups/router.ts`
- Modify: `packages/leash-core/src/groups/index.ts`

**Interfaces:**
- Consumes: `tagsForAlias`, `rankRoutes`, routing types (Tasks 1–2); `defineTool`, `ToolGroup` from `./types.ts`; `DeviceCapability` from `@mycelium/shared`.
- Produces: `routerGroup: ToolGroup` (id `"router"`) with tools `get_device_capability`, `list_private_mesh_models`, `rank_routes`.
- Data source: hypha `GET /peers` (documented in `apps/hypha/src/shim.ts:7`) at `process.env.LEASH_BROKER_HYPHA_URL ?? "http://127.0.0.1:11437"`. `get_device_capability` reads this device's own row from the same `/peers` (or `/health`) view.

- [ ] **Step 1: Confirm the `/peers` response shape**

Run: `grep -n "\"/peers\"\|peersView\|warm-pool view\|function.*[Pp]eers" apps/hypha/src/shim.ts`
Then read the handler that serves `/peers` and note the JSON it returns (array of peer rows with `peerKey`, served `models[]`/aliases, `inflight`, `meshId`, `price`, and a flag marking the local device). Use those exact field names in Step 2. If a field is absent (e.g. `price`), default it in code (`pricePerKiloToken: row.price?.perKiloToken ?? 0`) and note it.

- [ ] **Step 2: Write the group**

```ts
// packages/leash-core/src/groups/router.ts
/**
 * Router tool-group — capability discovery + deterministic ranking for the Conductor.
 * Sources live mesh data from hypha's GET /peers (the warm-pool view). PRIVATE MESH only
 * this round; list_public_mesh_models is the extension seam (not implemented).
 */
import { z } from "zod";
import { tagsForAlias } from "../routing/tags.ts";
import { rankRoutes } from "../routing/rank.ts";
import type { RouteOption, Sensitivity, CapabilityBar, Modality, ParamClass, Specialist } from "../routing/types.ts";
import { defineTool, type ToolGroup } from "./types.ts";

const HYPHA_URL = process.env["LEASH_BROKER_HYPHA_URL"] ?? "http://127.0.0.1:11437";
const NO_SOURCES: never[] = [];

/** One row of hypha's /peers view. Field names MUST match Step 1's confirmed shape. */
interface PeerRow {
  peerKey: string;
  isLocal?: boolean;
  displayName?: string;
  meshId?: string;
  ramMB?: number;
  computeClass?: string;
  inflight?: number;
  models?: { alias: string; modelSrc?: string }[];
  price?: { perKiloToken?: number };
}

async function fetchPeers(): Promise<PeerRow[]> {
  try {
    const res = await fetch(`${HYPHA_URL}/peers`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return [];
    const data = (await res.json()) as { peers?: PeerRow[] } | PeerRow[];
    return Array.isArray(data) ? data : (data.peers ?? []);
  } catch {
    return []; // offline / hypha down → caller treats as "no peers", routes local
  }
}

/** Expand a peer's served aliases into RouteOptions (one per alias). */
function rowToOptions(row: PeerRow, tier: RouteOption["tier"]): RouteOption[] {
  const models = row.models ?? [];
  return models.map((m) => ({
    tier,
    alias: m.alias,
    tags: tagsForAlias(m.alias),
    ...(tier === "device" ? {} : { peerKey: row.peerKey, meshId: row.meshId, modelSrc: m.modelSrc }),
    pricePerKiloToken: tier === "device" ? 0 : (row.price?.perKiloToken ?? 0),
    inflight: row.inflight ?? 0,
  }));
}

export const routerGroup: ToolGroup = {
  id: "router",
  label: "Router",
  description: "Discover what this device and private-mesh peers can do, and rank routes for a request.",
  tools: [
    defineTool({
      name: "get_device_capability",
      description: "Capabilities of THIS device: RAM, compute class, in-flight load, and the model aliases it serves locally with their capability tags. Call before deciding whether the local device can handle a turn.",
      inputSchema: {},
      handler: async () => {
        const peers = await fetchPeers();
        const me = peers.find((p) => p.isLocal) ?? null;
        if (!me) return { text: "Local device capability unavailable (hypha not reachable). Treat as: serves the default chat model only.", sources: NO_SOURCES };
        const opts = rowToOptions(me, "device");
        const lines = opts.map((o) => `${o.alias} [${o.tags.modality}/${o.tags.paramClass}/${o.tags.specialist}] inflight ${o.inflight}`);
        return { text: `Device ${me.displayName ?? "this device"} · RAM ${me.ramMB ?? "?"}MB · ${me.computeClass ?? "?"} · inflight ${me.inflight ?? 0}\nLocal models:\n${lines.join("\n") || "(none)"}`, sources: NO_SOURCES };
      },
    }),
    defineTool({
      name: "list_private_mesh_models",
      description: "Models served by peers on the private mesh, with their capability tags, price (µ/kilo-token), and live in-flight load. Use to find a more capable or less-loaded peer to delegate to.",
      inputSchema: {},
      handler: async () => {
        const peers = (await fetchPeers()).filter((p) => !p.isLocal);
        const opts = peers.flatMap((p) => rowToOptions(p, "private"));
        if (opts.length === 0) return { text: "No private-mesh peers reachable. All routing stays local.", sources: NO_SOURCES };
        const lines = opts.map((o) => `${o.alias} [${o.tags.modality}/${o.tags.paramClass}/${o.tags.specialist}] @${o.peerKey?.slice(0, 8)} · ${o.pricePerKiloToken}µ/ktok · inflight ${o.inflight}`);
        return { text: `Private-mesh models (${opts.length}):\n${lines.join("\n")}`, sources: NO_SOURCES };
      },
    }),
    defineTool({
      name: "rank_routes",
      description: "Given a capability bar (modality, minimum size, optional specialist) and sensitivity, return the ranked routes (best first) across this device + private-mesh peers. Sensitive turns are hard-gated away from the public tier before cost is considered.",
      inputSchema: {
        modality: z.enum(["text", "vision", "audio"]).describe("Required modality for the turn."),
        minParamClass: z.enum(["tiny", "small", "mid", "large"]).describe("Smallest model size that can do the turn well."),
        specialist: z.enum(["general", "health", "vision", "computer"]).optional().describe("Required specialist, if any."),
        sensitivity: z.enum(["private", "shareable"]).describe("'private' keeps the turn off the public tier."),
      },
      handler: async ({ modality, minParamClass, specialist, sensitivity }) => {
        const peers = await fetchPeers();
        const options: RouteOption[] = peers.flatMap((p) => rowToOptions(p, p.isLocal ? "device" : "private"));
        const bar: CapabilityBar = { modality: modality as Modality, minParamClass: minParamClass as Exclude<ParamClass, "unknown">, ...(specialist ? { specialist: specialist as Specialist } : {}) };
        const ranked = rankRoutes({ bar, sensitivity: sensitivity as Sensitivity, options });
        if (ranked.length === 0) return { text: "ROUTE: local-fallback (no route cleared the bar)", sources: NO_SOURCES, route: { tier: "device", alias: "", peerKey: null } };
        const top = ranked[0]!;
        const text = `ROUTE: ${top.peerKey ? `peer ${top.alias}` : `local ${top.alias}`} (${top.reason})\nAlternatives: ${ranked.slice(1, 4).map((r) => r.reason).join(" | ") || "none"}`;
        // `route` rides structuredContent → the chat route lifts it to drive execution.
        return { text, sources: NO_SOURCES, route: { tier: top.tier, alias: top.alias, peerKey: top.peerKey ?? null, meshId: top.meshId ?? null, modelSrc: top.modelSrc ?? null }, alternatives: ranked.slice(1, 4) };
      },
    }),
  ],
};
```

- [ ] **Step 3: Register the group**

In `packages/leash-core/src/groups/index.ts`: add the import and append to `TOOL_GROUPS`.

```ts
import { routerGroup } from "./router.ts";
// ...
export const TOOL_GROUPS: ToolGroup[] = [homeAssistantGroup, feedGroup, memoryGroup, tasksGroup, contextGroup, photosGroup, imageGroup, researchGroup, skillsGroup, computerGroup, filesGroup, mcpAdminGroup, schedulerGroup, routerGroup];
```

- [ ] **Step 4: Verify the daemon mounts it**

Run: `npx tsx apps/leash-tools-mcp/src/main.ts &` then `sleep 1 && curl -s http://127.0.0.1:11440/health | grep -o '"router"'` then `kill %1`.
Expected: prints `"router"` (the group is in the catalog). If `LEASH_TOOLS_MCP_PORT` differs, read `apps/leash-tools-mcp/src/config.ts` for the port.

- [ ] **Step 5: Commit**

```bash
git add packages/leash-core/src/groups/router.ts packages/leash-core/src/groups/index.ts
git commit -m "feat(router): capability-discovery MCP group (device + private-mesh + rank_routes)"
```

---

## Task 4: Peer-pin in the mesh router + shim

**Files:**
- Modify: `apps/hypha/src/mesh-router.ts`
- Modify: `apps/hypha/src/shim.ts`

**Interfaces:**
- Consumes (existing): `ChatRouteReq { alias; sensitivity?; pinMeshId? }`, `route()`, `forwardTargetsForAlias()` — confirmed at `mesh-router.ts:35,63,101` and called from `shim.ts:803,818`.
- Produces: `ChatRouteReq` gains optional `pinPeerKey?: string`; `route()` and `forwardTargetsForAlias()` prefer the pinned peer when present and reachable, else fall back to the existing tier walk.

- [ ] **Step 1: Read the current signatures**

Run: `sed -n '35,120p' apps/hypha/src/mesh-router.ts` — note the exact `ChatRouteReq` fields, the body of `route()`, and `forwardTargetsForAlias()`.

- [ ] **Step 2: Add `pinPeerKey` to the request type + honor it**

In `ChatRouteReq` (mesh-router.ts:35), add:

```ts
  /** Conductor's exact peer pick. When set and the peer is reachable for `alias`, it is preferred
   *  over the tier walk; otherwise routing falls back to the normal ladder (advisory-with-fallback). */
  pinPeerKey?: string;
```

In `forwardTargetsForAlias()` (after computing `out`), reorder so a reachable pin comes first:

```ts
    if (req.pinPeerKey && out.includes(req.pinPeerKey)) {
      return [req.pinPeerKey, ...out.filter((k) => k !== req.pinPeerKey)];
    }
    return out;
```

In `route()`, when `req.pinPeerKey` is set, prefer the warm entry whose `peerKey === req.pinPeerKey` if one exists for `alias`; else keep the existing selection. (Match the existing warm-selection code you read in Step 1 — filter its candidate list for the pin before its current "lowest latency" pick.)

- [ ] **Step 3: Thread `peerKey` from the request body in the shim**

In `apps/hypha/src/shim.ts`, the body is already parsed with `sensitivity` and `meshId` (lines ~767, 795). Add `peerKey?: string` to that body type, then pass it into both router calls (lines ~803 and ~818):

```ts
const peerKey = typeof body.peerKey === "string" ? body.peerKey : undefined;
// line ~803:
const peers = router.forwardTargetsForAlias({ alias, sensitivity, ...(body.meshId ? { pinMeshId: body.meshId } : {}), ...(peerKey ? { pinPeerKey: peerKey } : {}) });
// line ~818:
const warm = router.route({ alias, sensitivity, ...(body.meshId ? { pinMeshId: body.meshId } : {}), ...(peerKey ? { pinPeerKey: peerKey } : {}) });
```

Do the same for the forward-path body at lines ~709–718 (`fbody`) so vision/forward turns honor the pin too.

- [ ] **Step 4: Type-check hypha**

Run: `npm run -w apps/hypha typecheck 2>/dev/null || npx tsc -p apps/hypha --noEmit`
Expected: no new type errors. (If the workspace has no `typecheck` script, the `tsc` form is the fallback.)

- [ ] **Step 5: Smoke-test the pin is inert without a peer**

Run: `grep -n "pinPeerKey" apps/hypha/src/mesh-router.ts apps/hypha/src/shim.ts`
Expected: the field appears in `ChatRouteReq`, both `route()`/`forwardTargetsForAlias()`, and the shim body parse + both call sites. (A pin to an unreachable peer falls through to the existing ladder — no behavior change when unset.)

- [ ] **Step 6: Commit**

```bash
git add apps/hypha/src/mesh-router.ts apps/hypha/src/shim.ts
git commit -m "feat(router): advisory per-peer pin (pinPeerKey) through mesh-router + shim"
```

---

## Task 5: Conductor classifier (fast-path gate + small-LLM bar + fallback)

**Files:**
- Create: `apps/web/lib/leash/conductor.ts`
- Test: `apps/web/scripts/conductor.test.ts`

**Interfaces:**
- Consumes: `classifyEffort` + `EffortTier` (`./effort.ts`, `./types.ts`), `classifierModel` (`./provider.ts`), `generateText` (`ai`), routing types + `tagsForAlias`/`rankRoutes` (`@mycelium/leash-core/routing`).
- Produces:
  - `interface RouteDecision { modality: Modality; sensitivity: Sensitivity; bar: CapabilityBar; route: { tier: Tier; alias: string; peerKey?: string; meshId?: string; modelSrc?: string }; reason: string; viaFastPath: boolean }`
  - `conduct(input: { text: string; isImageTurn: boolean; options: RouteOption[]; defaultAlias: string }): Promise<RouteDecision>`
- Design: trivial turns (`classifyEffort === "quick"` AND not an image turn) skip the LLM and route to the cheapest local general route. Otherwise the LLM grades `{ modality, difficulty, sensitivity, specialist }` → a `CapabilityBar`; `rankRoutes(bar, sensitivity, options)` picks. Any LLM/serve failure ⇒ a deterministic fallback bar from `classifyEffort` (quick/standard→small, deep→mid) + intent regex (image→vision, health-words→health). Never throws.

- [ ] **Step 1: Write the failing test (deterministic fallback only — no live model)**

```ts
// apps/web/scripts/conductor.test.ts
/**
 * tsx assertion script (repo idiom). Verifies the Conductor's DETERMINISTIC paths only
 * (no live model): the fast-path picks the cheapest local general route for a greeting,
 * and barFromFallback maps effort+intent to a bar. Run: npx tsx apps/web/scripts/conductor.test.ts
 */
import assert from "node:assert";
import { barFromFallback, pickLocalGeneral } from "../lib/leash/conductor.ts";
import type { RouteOption } from "@mycelium/leash-core/routing";

const local4b: RouteOption = { tier: "device", alias: "qwen3-4b", tags: { modality: "text", paramClass: "small", specialist: "general" }, pricePerKiloToken: 0, inflight: 0 };

function main() {
  // 1. Fallback bar: a deep text turn needs at least 'mid'.
  assert.equal(barFromFallback({ tier: "deep", isImageTurn: false, text: "analyze the tradeoffs" }).minParamClass, "mid", "deep turn → mid bar");
  // 2. Fallback bar: an image turn requires vision modality + specialist.
  const vb = barFromFallback({ tier: "standard", isImageTurn: true, text: "what's in this photo" });
  assert.equal(vb.modality, "vision", "image turn → vision bar");
  assert.equal(vb.specialist, "vision", "image turn → vision specialist");
  // 3. Fallback bar: health wording → health specialist.
  assert.equal(barFromFallback({ tier: "standard", isImageTurn: false, text: "what are my symptoms of anxiety" }).specialist, "health", "health words → health bar");
  // 4. pickLocalGeneral returns the cheapest local general route.
  assert.equal(pickLocalGeneral([local4b], "qwen3-4b").alias, "qwen3-4b", "fast-path picks local general");
  console.log("conductor: PASS");
}
main();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx apps/web/scripts/conductor.test.ts`
Expected: FAIL — `Cannot find module '../lib/leash/conductor.ts'`.

- [ ] **Step 3: Write `conductor.ts`**

```ts
// apps/web/lib/leash/conductor.ts
/**
 * Conductor — capability-first router. A fast-path gate short-circuits obviously-trivial
 * turns to the cheapest local general model; everything else is graded by the warm 1.7B
 * classifier into a capability bar, and rankRoutes picks the route. Never throws: any
 * failure falls back to a deterministic bar from classifyEffort + intent regex, then local.
 */
import "server-only";
import { generateText } from "ai";
import { classifierModel } from "./provider.ts";
import { classifyEffort } from "./effort.ts";
import type { EffortTier } from "./types.ts";
import {
  rankRoutes, tagsForAlias,
  type CapabilityBar, type Modality, type RouteOption, type Sensitivity, type Tier,
} from "@mycelium/leash-core/routing";

export interface RouteDecision {
  modality: Modality;
  sensitivity: Sensitivity;
  bar: CapabilityBar;
  route: { tier: Tier; alias: string; peerKey?: string; meshId?: string; modelSrc?: string };
  reason: string;
  viaFastPath: boolean;
}

const HEALTH = /\b(symptom|diagnos|therapy|anxiety|depress|medication|dosage|blood pressure|clinical|patient)\b/i;

/** Deterministic bar from effort tier + intent regex (the no-LLM fallback). */
export function barFromFallback(i: { tier: EffortTier; isImageTurn: boolean; text: string }): CapabilityBar {
  if (i.isImageTurn) return { modality: "vision", minParamClass: "small", specialist: "vision" };
  if (HEALTH.test(i.text)) return { modality: "text", minParamClass: "small", specialist: "health" };
  const minParamClass = i.tier === "deep" ? "mid" : "small";
  return { modality: "text", minParamClass };
}

/** Cheapest local general text route; synthesizes one for `defaultAlias` if none discovered. */
export function pickLocalGeneral(options: RouteOption[], defaultAlias: string): RouteOption {
  const locals = options.filter((o) => o.tier === "device" && o.tags.modality === "text" && o.tags.specialist === "general").sort((a, b) => a.inflight - b.inflight);
  return locals[0] ?? { tier: "device", alias: defaultAlias, tags: tagsForAlias(defaultAlias), pricePerKiloToken: 0, inflight: 0 };
}

const RUBRIC =
  "You are a request router. Classify the user's turn for placement. Reply with ONLY compact JSON " +
  '{"modality":"text|vision|audio","difficulty":"low|medium|high","sensitivity":"private|shareable","specialist":"general|health|vision|computer"}. ' +
  "sensitivity=private for anything personal/health/financial/confidential; shareable only for generic public-knowledge questions. " +
  "difficulty=high for multi-step reasoning, analysis, planning, or coding; low for greetings/lookups. Output JSON only.";

interface Grade { modality: Modality; difficulty: "low" | "medium" | "high"; sensitivity: Sensitivity; specialist: CapabilityBar["specialist"] }

function parseGrade(raw: string): Grade | null {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]) as Partial<Grade>;
    if (!o.modality || !o.difficulty || !o.sensitivity) return null;
    return { modality: o.modality, difficulty: o.difficulty, sensitivity: o.sensitivity, specialist: o.specialist ?? "general" };
  } catch { return null; }
}

function barFromGrade(g: Grade): CapabilityBar {
  const minParamClass = g.difficulty === "high" ? "mid" : "small";
  return { modality: g.modality, minParamClass, ...(g.specialist && g.specialist !== "general" ? { specialist: g.specialist } : {}) };
}

function decide(bar: CapabilityBar, sensitivity: Sensitivity, options: RouteOption[], defaultAlias: string, viaFastPath: boolean): RouteDecision {
  const ranked = rankRoutes({ bar, sensitivity, options });
  const top = ranked[0];
  if (top) {
    return { modality: bar.modality, sensitivity, bar, route: { tier: top.tier, alias: top.alias, ...(top.peerKey ? { peerKey: top.peerKey } : {}), ...(top.meshId ? { meshId: top.meshId } : {}), ...(top.modelSrc ? { modelSrc: top.modelSrc } : {}) }, reason: top.reason, viaFastPath };
  }
  const local = pickLocalGeneral(options, defaultAlias);
  return { modality: bar.modality, sensitivity, bar, route: { tier: "device", alias: local.alias }, reason: "no route cleared the bar → local fallback", viaFastPath };
}

export async function conduct(input: { text: string; isImageTurn: boolean; options: RouteOption[]; defaultAlias: string }): Promise<RouteDecision> {
  const tier = await classifyEffort(input.text);
  // Fast-path: obviously-trivial text turn → cheapest local general, no LLM.
  if (tier === "quick" && !input.isImageTurn) {
    const local = pickLocalGeneral(input.options, input.defaultAlias);
    return { modality: "text", sensitivity: "private", bar: { modality: "text", minParamClass: "small" }, route: { tier: "device", alias: local.alias }, reason: "fast-path: trivial turn → local", viaFastPath: true };
  }
  try {
    const { text } = await generateText({ model: classifierModel(), system: RUBRIC, prompt: input.text.slice(0, 2000), temperature: 0, maxOutputTokens: 80, maxRetries: 0 });
    const grade = parseGrade(text);
    if (grade) return decide(barFromGrade(grade), grade.sensitivity, input.options, input.defaultAlias, false);
  } catch { /* fall through to deterministic fallback */ }
  // Deterministic fallback (serve down / unparseable): effort+intent bar, sensitivity defaults private.
  return decide(barFromFallback({ tier, isImageTurn: input.isImageTurn, text: input.text }), "private", input.options, input.defaultAlias, false);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx apps/web/scripts/conductor.test.ts`
Expected: prints `conductor: PASS`, exit 0. (If `@mycelium/leash-core/routing` does not resolve, add the subpath to `packages/leash-core/package.json` `exports` — see Step 5.)

- [ ] **Step 5: Ensure the `routing` subpath is exported**

Run: `grep -n "exports\|\"./routing\"\|\"./groups\"" packages/leash-core/package.json`
If `./routing` is missing from `exports`, add it next to `./groups` pointing at `./src/routing/index.ts` (match the existing `./groups` entry's shape).

- [ ] **Step 6: Commit**

```bash
git add apps/web/lib/leash/conductor.ts apps/web/scripts/conductor.test.ts packages/leash-core/package.json
git commit -m "feat(router): Conductor classifier with fast-path gate + deterministic fallback"
```

---

## Task 6: Wire the Conductor into the chat route + execute the pick

**Files:**
- Modify: `apps/web/lib/leash/provider.ts`
- Modify: `apps/web/app/api/leash/chat/route.ts`

**Interfaces:**
- Consumes: `conduct` + `RouteDecision` (Task 5); existing `chatModel`, `qvac`, `QVAC_OPENAI_URL`, `resolvedChatAlias` (provider.ts); the discovery data (Task 3) — the route builds `RouteOption[]` by calling the same hypha `/peers` view OR by reading the `rank_routes` MCP tool result. Use the direct `/peers` fetch for the route's pre-pass (the MCP tools remain the agent-facing surface).
- Produces: the main chat completion now targets `decision.route.alias` and, for a peer route, carries `sensitivity` + `meshId` + `peerKey` on the request body so the shim (Task 4) places it.

- [ ] **Step 1: Add a routed-body helper in `provider.ts`**

The provider currently hard-codes `createQvac({ baseURL, headers })`. Add a helper that returns a model bound to a routing directive. Read how `chatModel`/`qvac` build the model (provider.ts:77,113) first, then add:

```ts
import type { Sensitivity } from "@mycelium/leash-core/routing";

/** A chat model whose requests carry the Conductor's routing directive in the body, so the
 *  broker forwards it and the hypha shim places the turn (sensitivity gate + mesh/peer pin).
 *  When `peerKey` is unset the turn runs locally / by the default overflow ladder. */
export function routedChatModel(opts: { alias: string; sensitivity: Sensitivity; meshId?: string; peerKey?: string }): LanguageModel {
  const provider = createQvac({
    baseURL: QVAC_OPENAI_URL,
    apiKey: "qvac",
    fetch: patientFetch,
    headers: { "x-leash-priority": "interactive" },
    // The qvac provider forwards unknown body fields verbatim; the shim reads body.sensitivity /
    // body.meshId / body.peerKey. If createQvac drops unknown fields, pass them via
    // `providerOptions` instead (confirm against the @qvac provider in Step 2).
    extraBody: { sensitivity: opts.sensitivity, ...(opts.meshId ? { meshId: opts.meshId } : {}), ...(opts.peerKey ? { peerKey: opts.peerKey } : {}) },
  } as Parameters<typeof createQvac>[0]);
  return provider(opts.alias);
}
```

- [ ] **Step 2: Confirm the body-field mechanism**

Run: `grep -rn "extraBody\|providerOptions\|body\b\|createQvac\|defaultObjectGenerationMode" node_modules/@qvac/sdk/dist/*.d.ts 2>/dev/null | head` (or wherever `createQvac` is defined — `grep -rn "export.*createQvac" node_modules`).
Determine how to attach custom top-level body fields (`sensitivity`/`meshId`/`peerKey`). If `extraBody` is not supported, the AI SDK standard is `providerOptions: { qvac: { ... } }` consumed in the provider, OR set the fields as a custom `fetch` wrapper that merges them into the JSON body. Implement whichever the provider supports; the **invariant** is: those three fields appear at the top level of the POSTed `/v1/chat/completions` body (that is what `shim.ts` reads). Verify with `probe`:
Run: `grep -rn "probe-provider" apps/web/scripts` and reuse that harness to dump the outgoing body if available.

- [ ] **Step 3: Build the route option list in the chat route**

In `apps/web/app/api/leash/chat/route.ts`, near the model-selection block (lines ~217–232), add a helper that fetches `/peers` and maps to `RouteOption[]` (reuse the `rowToOptions` logic — extract it to `@mycelium/leash-core/routing` as `peerRowsToOptions(rows)` so the route and the MCP group share it, OR import the MCP group's exported helper). Then:

```ts
import { conduct } from "../../../../lib/leash/conductor.ts";
import { routedChatModel } from "../../../../lib/leash/provider.ts";
// ... after computing imageTurn/health/computer intent and `chosenModel`:
const defaultAlias = chosenModel ?? resolvedChatAlias();
const routeOptions = await fetchRouteOptions(); // /peers → RouteOption[]; [] on failure
const decision = await conduct({ text: lastUserText(validated), isImageTurn: imageTurn, options: routeOptions, defaultAlias });
const activeModel = imageTurn ? VISION_MODEL : decision.route.alias || defaultAlias; // keep vision hard-rule as a floor
```

- [ ] **Step 4: Execute via the routed model**

Where the agent's model is bound (the `chatModel(...)`/`buildLeashAgent` call), switch to the routed model when the decision picked a peer:

```ts
const model = decision.route.peerKey
  ? routedChatModel({ alias: activeModel, sensitivity: decision.sensitivity, ...(decision.route.meshId ? { meshId: decision.route.meshId } : {}), peerKey: decision.route.peerKey })
  : chatModel("chat", activeModel);
```

Pass `model` into the existing agent builder in place of the prior `chatModel(...)` argument. Leave every other intent rule (computer/files) intact as today — the Conductor only overrides the generalist model choice.

- [ ] **Step 5: Manual end-to-end check (single device, no peer)**

Run the web app and send "hi" then "analyze the tradeoffs between X and Y in depth".
Expected: the first answers immediately (fast-path, local); the second still answers locally (no peer reachable → `rankRoutes` returns local) — confirming the fallback never blocks. Check the server log shows a Conductor decision line for the second turn.

- [ ] **Step 6: Commit**

```bash
git add apps/web/lib/leash/provider.ts apps/web/app/api/leash/chat/route.ts packages/leash-core/src/routing/index.ts
git commit -m "feat(router): wire Conductor into chat route + execute pick via routed body directive"
```

---

## Task 7: Decision UI step + audit record

**Files:**
- Modify: `apps/web/app/api/leash/chat/route.ts` (emit the decision as a UI step + audit line)
- Modify/Confirm: the chat audit writer (locate in Step 1)

**Interfaces:**
- Consumes: `RouteDecision` (Task 5), `AuditRecord` shape (`@mycelium/shared`).
- Produces: one JSONL `AuditRecord` per non-fast-path decision (`event: "delegation"` when `route.peerKey` set, else `event: "note"`), and a visible decision step in the streamed UI.

- [ ] **Step 1: Locate the audit writer**

Run: `grep -rn "AuditRecord\|appendAudit\|audit-log\|\.jsonl" apps/web/lib --include=*.ts | head`
Note the existing append function (signature + file path). If the web app has none, write the line with `fs.appendFile` to `process.env.LEASH_AUDIT_PATH ?? "logs/leash-audit.jsonl"` using the `AuditRecord` shape. Use whichever exists; do not invent a second audit path if one is already there.

- [ ] **Step 2: Emit the audit record after `conduct(...)`**

```ts
import type { AuditRecord } from "@mycelium/shared";
// after `decision` is computed (Task 6 Step 3), skip when viaFastPath to avoid noise:
if (!decision.viaFastPath) {
  const rec: AuditRecord = {
    ts: new Date().toISOString(),
    source: "conductor",
    event: decision.route.peerKey ? "delegation" : "note",
    modelId: decision.route.alias,
    ...(decision.route.modelSrc ? { modelSrc: decision.route.modelSrc } : {}),
    extra: { tier: decision.route.tier, peerKey: decision.route.peerKey ?? null, sensitivity: decision.sensitivity, bar: decision.bar, reason: decision.reason },
  };
  await appendAudit(rec); // the function/path confirmed in Step 1
}
```

- [ ] **Step 3: Stream the decision as a visible UI step**

The chat route streams UIMessages (the same machinery `agent-runner.ts` uses to surface a subagent step). Emit a single data/step part before the main answer carrying `{ kind: "route-decision", route, reason, alternatives, viaFastPath }`. Match the existing step-emission pattern in the route (grep for how `submit_plan`/agent steps write a UI part) and reuse it — do not invent a new transport.

Run: `grep -n "writer.write\|toUIMessageStream\|data-\|part: \|type: \"data" apps/web/app/api/leash/chat/route.ts | head`
Use the discovered helper to push the decision part.

- [ ] **Step 4: Render the step (web UI)**

Run: `grep -rn "route-decision\|tool-\|data-part\|renderPart\|MessagePart" apps/web/components apps/web/app --include=*.tsx | head`
Add a small renderer for the `route-decision` part: show `local <alias>` or `→ peer <alias> (<tier>)`, the `reason`, and a collapsible list of `alternatives`. Match the existing part-renderer component structure (props + switch on part type). Keep it ~30 lines, one component file or one case in the existing switch.

- [ ] **Step 5: Manual verification**

Send a high-difficulty turn with a peer reachable on the private mesh (mini ↔ Pro). Expected: the UI shows a "→ peer …" decision step, the answer streams from the peer, and `logs/leash-audit.jsonl` (or the confirmed path) gains one `"delegation"` record. With no peer: the step shows "local …" and the record event is `"note"`.

- [ ] **Step 6: Commit**

```bash
git add apps/web/app/api/leash/chat/route.ts apps/web/components
git commit -m "feat(router): surface Conductor decision as a UI step + audit record"
```

---

## Self-Review

**Spec coverage:**
- Capability-first cost-aware ranking → Task 2 (`rankRoutes`). ✓
- Small-LLM classifier (true agent) + fast-path hybrid → Task 5 (`conduct`, fast-path gate, RUBRIC) + Task 3 (`rank_routes` MCP tool the agent can call). ✓
- Full scheduler scope (modality + difficulty + sensitivity; local specialists + peers) → Tasks 2,5 (bar carries modality+specialist; options span device+private). ✓
- Hard sensitivity gate before cost → Task 2 (`rankRoutes` gate step 1) + test case 3. ✓
- Approach-A execution plumbing (one routing directive) → Tasks 4 (peer pin) + 6 (routed body). ✓
- MCP-hosted discovery tools → Task 3 (`routerGroup`). ✓
- Private mesh now, public mesh seam → Task 1 (`tagsForAlias` advertised fallback) + Task 2 (`"public"` tier excluded by gate) + Task 3 (no `list_public_mesh_models`). ✓
- Deterministic fallback / offline-capable → Task 5 (fallback bar, never throws) + Task 3 (`fetchPeers` returns `[]` offline). ✓
- Audit + UI evidence → Task 7. ✓

**Placeholder scan:** No "TBD"/"add error handling". Two steps (Task 3 Step 1, Task 6 Step 2, Task 7 Step 1) deliberately read existing code to confirm an exact field/mechanism before writing against it — each states the invariant to satisfy and the exact grep, not a vague "figure it out". These are verification steps for existing external contracts (hypha `/peers` JSON, the `@qvac` provider body mechanism, the web audit writer), not unwritten core logic.

**Type consistency:** `RouteOption`/`CapabilityBar`/`RankedRoute`/`Sensitivity`/`Tier` defined in Task 1 are used identically in Tasks 2,3,5. `tagsForAlias`, `rankRoutes`, `PARAM_ORDER` signatures match across tasks. `RouteDecision.route` shape (`{tier,alias,peerKey?,meshId?,modelSrc?}`) is consistent between Task 5 (produced), Task 6 (consumed for execution), Task 7 (consumed for audit/UI). `pinPeerKey` (Task 4) ↔ `peerKey` body field (Task 6) ↔ `route.peerKey` (Task 5) are wired consistently: web body `peerKey` → shim reads `body.peerKey` → passes `pinPeerKey` to the router.

**Known external-contract dependencies (resolved at implementation time, by design):**
1. hypha `/peers` JSON field names — Task 3 Step 1.
2. `@qvac` provider custom-body mechanism (`extraBody` vs `providerOptions` vs fetch-merge) — Task 6 Step 2.
3. web audit-append function/path + UI part-emission helper — Task 7 Steps 1,3,4.
These are reads against code that already exists; the plan states the invariant each must satisfy.
