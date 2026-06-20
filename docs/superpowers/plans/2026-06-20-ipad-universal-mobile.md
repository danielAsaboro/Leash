# iPad Universal Mobile Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `apps/mobile` run as a self-contained universal iPhone/iPad app with an iPad tablet shell that mirrors the web layout direction while preserving native QVAC behavior.

**Architecture:** Add a pure tablet layout helper, a persistent tablet rail, and responsive shell wiring in `apps/mobile/App.tsx`. Keep model loading, mesh, prompts, voice, persistence, and all feature screens in the existing mobile app.

**Tech Stack:** Expo 54, React Native 0.81, TypeScript, `@qvac/sdk`, local `tsx` smoke tests.

---

### Task 1: Tablet Layout Helper

**Files:**
- Create: `apps/mobile/layout.ts`
- Create: `apps/mobile/scripts/tablet-layout.test.ts`

- [ ] Write `apps/mobile/scripts/tablet-layout.test.ts` first. It imports `isTabletLayout` and asserts phone widths are false, full iPad widths are true, and narrow split-view widths are false.
- [ ] Run `npx tsx apps/mobile/scripts/tablet-layout.test.ts` and confirm it fails because `apps/mobile/layout.ts` does not exist.
- [ ] Create `apps/mobile/layout.ts` with `TABLET_MIN_WIDTH = 744` and `isTabletLayout(width, height)` returning true only when the shortest edge is at least the breakpoint.
- [ ] Re-run the smoke test and confirm it passes.

### Task 2: Persistent Tablet Rail

**Files:**
- Create: `apps/mobile/TabletRail.tsx`
- Modify: `apps/mobile/NavDrawer.tsx`

- [ ] Export `NAV_ITEMS` from `NavDrawer.tsx` so drawer and rail use one route list.
- [ ] Add `TabletRail.tsx` with a fixed-width left rail, Leash brand tile, nav rows, unread alerts badge, and settings footer.
- [ ] Keep route labels and icons identical to `NavDrawer`.

### Task 3: Responsive App Shell

**Files:**
- Modify: `apps/mobile/App.tsx`

- [ ] Import `useWindowDimensions`, `isTabletLayout`, and `TabletRail`.
- [ ] Compute `isTablet = isTabletLayout(width, height)` in `App`.
- [ ] Wrap the route content in a row shell on tablet and render `TabletRail` persistently.
- [ ] Keep `NavDrawer` mounted only for phone layouts.
- [ ] Pass no-op `onMenu` handlers on tablet so existing screens do not show a functional drawer dependency.

### Task 4: iPad Script Aliases

**Files:**
- Modify: `apps/mobile/package.json`
- Modify: `package.json`

- [ ] Add `ipad` and `ipad:prebuild` scripts in `apps/mobile/package.json`.
- [ ] Add root `ipad:ios` and `ipad:start` scripts that run the mobile app commands from `apps/mobile`.

### Task 5: Verification

**Files:**
- Modify as needed only for compile failures.

- [ ] Run `npx tsx apps/mobile/scripts/tablet-layout.test.ts`.
- [ ] Run `npx tsc --noEmit -p apps/mobile/tsconfig.json`.
- [ ] Run `git diff --check`.
