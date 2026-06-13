# Single-User Lock (Auth) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Gate the entire Leash dashboard behind a single local password (set on first run, sign in/out), always-on with a `LEASH_AUTH=0` dev override.

**Architecture:** A Node-runtime Next middleware is the single chokepoint that redirects unauthenticated requests to `/login` (or `/setup-password` when unconfigured). The credential (scrypt hash) + an HMAC session secret live in `<LEASH_DATA_DIR>/auth.json`. Pure crypto logic is isolated in `auth-core.ts` (testable) behind the `server-only` `auth.ts`.

**Tech Stack:** Next.js 15.5 (app router, Node middleware), Node `crypto` (scrypt/HMAC), `tsx` verifications. No external deps.

**Spec:** `docs/superpowers/specs/2026-06-13-desktop-auth-design.md`

**Repo realities (read first):**
- **No git** — "Checkpoint" replaces "commit"; do not run git.
- **No test runner** — verify with `npx tsx`.
- **Never `npm install` in the background.**
- `server-only` THROWS when imported under plain `tsx`, so all unit-testable logic lives in `auth-core.ts` (no `server-only`, no fs); `auth.ts` is the thin server glue.
- `DATA_DIR` (from Phase 1) is `apps/web/lib/leash/json-store.ts` and honors `LEASH_DATA_DIR`.

---

## File Structure
- **Create** `apps/web/lib/leash/auth-core.ts` — pure: types + `makeAuthFile`, `verifyPassword`, `signSession`, `verifySession`, `rotate`. No fs / no server-only.
- **Create** `apps/web/lib/leash/auth.ts` — `server-only`; read/write `auth.json`, cookie constants, `authEnabled`/`isConfigured` + thin wrappers over auth-core.
- **Create** `apps/web/scripts/verify-auth.ts` — `tsx` checks for auth-core.
- **Create** `apps/web/app/api/leash/auth/{setup,login,logout}/route.ts`.
- **Create** `apps/web/app/setup-password/page.tsx`, `apps/web/app/login/page.tsx`.
- **Create** `apps/web/middleware.ts` (+ `experimental.nodeMiddleware` in `next.config.mjs`). Fallback (only if nodeMiddleware fails): gate in `app/layout.tsx` + a `requireAuth()` wrapper.
- **Modify** `apps/web/components/LeashRail.tsx` — add Sign out.

---

## Task 1: Credential core + store

**Files:**
- Create: `apps/web/lib/leash/auth-core.ts`
- Create: `apps/web/lib/leash/auth.ts`
- Test: `apps/web/scripts/verify-auth.ts`

- [ ] **Step 1: Write the failing verification**

Create `apps/web/scripts/verify-auth.ts`:

```ts
import assert from "node:assert";
import { makeAuthFile, verifyPassword, signSession, verifySession, rotate } from "../lib/leash/auth-core.ts";

const f = makeAuthFile("hunter2");
assert.equal(verifyPassword(f, "hunter2"), true, "correct pw");
assert.equal(verifyPassword(f, "wrong"), false, "wrong pw");
assert.throws(() => makeAuthFile("123"), /too short/, "min length");

const now = 1_000_000;
const tok = signSession(f, now);
assert.equal(verifySession(f, tok, now + 5_000), true, "valid token");
assert.equal(verifySession(f, undefined, now), false, "no token");
assert.equal(verifySession(f, "garbage", now), false, "garbage token");
assert.equal(verifySession(f, tok.slice(0, -2) + "00", now), false, "tampered sig");
assert.equal(verifySession(f, `${now + 10_000_000}.deadbeef`, now), false, "future iat rejected");

const r = rotate(f);
assert.equal(verifySession(r, tok, now + 5_000), false, "old token dead after rotate");
assert.equal(verifyPassword(r, "hunter2"), true, "rotate keeps password");
console.log("OK verify-auth");
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx tsx apps/web/scripts/verify-auth.ts`
Expected: FAIL — `Cannot find module '../lib/leash/auth-core.ts'`.

- [ ] **Step 3: Implement the pure core**

Create `apps/web/lib/leash/auth-core.ts`:

```ts
import { randomBytes, scryptSync, createHmac, timingSafeEqual } from "node:crypto";

export interface AuthFile {
  version: 1;
  salt: string;
  passwordHash: string;
  sessionSecret: string;
}

const hash = (pw: string, salt: string): Buffer => scryptSync(pw, salt, 64);
const hmac = (payload: string, secret: string): string =>
  createHmac("sha256", secret).update(payload).digest("hex");

export function makeAuthFile(pw: string): AuthFile {
  if (pw.length < 6) throw new Error("password too short (min 6)");
  const salt = randomBytes(16).toString("hex");
  return {
    version: 1,
    salt,
    passwordHash: hash(pw, salt).toString("hex"),
    sessionSecret: randomBytes(32).toString("hex"),
  };
}

export function verifyPassword(f: AuthFile, pw: string): boolean {
  const got = hash(pw, f.salt);
  const want = Buffer.from(f.passwordHash, "hex");
  return got.length === want.length && timingSafeEqual(got, want);
}

export function rotate(f: AuthFile): AuthFile {
  return { ...f, sessionSecret: randomBytes(32).toString("hex") };
}

export function signSession(f: AuthFile, nowMs: number): string {
  const iat = String(nowMs);
  return `${iat}.${hmac(iat, f.sessionSecret)}`;
}

export function verifySession(f: AuthFile, token: string | undefined, nowMs: number): boolean {
  if (!token) return false;
  const dot = token.indexOf(".");
  if (dot < 0) return false;
  const iat = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!/^\d+$/.test(iat)) return false;
  if (Number(iat) > nowMs + 60_000) return false; // reject absurdly future-dated
  const want = hmac(iat, f.sessionSecret);
  let sb: Buffer, wb: Buffer;
  try {
    sb = Buffer.from(sig, "hex");
    wb = Buffer.from(want, "hex");
  } catch {
    return false;
  }
  return sb.length === wb.length && timingSafeEqual(sb, wb);
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx tsx apps/web/scripts/verify-auth.ts`
Expected: `OK verify-auth`.

- [ ] **Step 5: Implement the server glue**

Create `apps/web/lib/leash/auth.ts`:

```ts
import "server-only";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./json-store.ts";
import { makeAuthFile, verifyPassword as vp, signSession as sign, verifySession as vs, rotate, type AuthFile } from "./auth-core.ts";

const AUTH_FILE = join(DATA_DIR, "auth.json");
export const SESSION_COOKIE = "leash_session";
export const SESSION_MAX_AGE = 60 * 60 * 24 * 365;

function read(): AuthFile | null {
  try {
    const a = JSON.parse(readFileSync(AUTH_FILE, "utf8"));
    if (a?.version === 1 && typeof a.salt === "string" && typeof a.passwordHash === "string" && typeof a.sessionSecret === "string") return a as AuthFile;
    return null;
  } catch {
    return null;
  }
}
function write(a: AuthFile): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(AUTH_FILE, JSON.stringify(a), { mode: 0o600 });
}

export function authEnabled(): boolean {
  return process.env.LEASH_AUTH !== "0";
}
export function isConfigured(): boolean {
  return read() !== null;
}
export function setPassword(pw: string): void {
  write(makeAuthFile(pw));
}
export function verifyPassword(pw: string): boolean {
  const a = read();
  return a ? vp(a, pw) : false;
}
export function rotateSecret(): void {
  const a = read();
  if (a) write(rotate(a));
}
export function signSession(): string {
  const a = read();
  if (!a) throw new Error("auth not configured");
  return sign(a, Date.now());
}
export function verifySession(token: string | undefined): boolean {
  const a = read();
  return a ? vs(a, token, Date.now()) : false;
}
```

- [ ] **Step 6: Type-check the package**

Run: `cd apps/web && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "auth" || echo "no auth errors"`
Expected: `no auth errors`.

- [ ] **Step 7: Checkpoint** — `OK verify-auth` + no auth type errors.

---

## Task 2: Auth API routes

**Files:**
- Create: `apps/web/app/api/leash/auth/setup/route.ts`
- Create: `apps/web/app/api/leash/auth/login/route.ts`
- Create: `apps/web/app/api/leash/auth/logout/route.ts`

- [ ] **Step 1: Implement setup route**

Create `apps/web/app/api/leash/auth/setup/route.ts`:

```ts
import { NextResponse } from "next/server";
import { isConfigured, setPassword, signSession, SESSION_COOKIE, SESSION_MAX_AGE } from "@/lib/leash/auth";

export const runtime = "nodejs";

export async function POST(req: Request): Promise<NextResponse> {
  if (isConfigured()) return NextResponse.json({ error: "already configured" }, { status: 409 });
  const { password } = await req.json().catch(() => ({ password: "" }));
  if (typeof password !== "string" || password.length < 6)
    return NextResponse.json({ error: "password must be at least 6 characters" }, { status: 400 });
  setPassword(password);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, signSession(), { httpOnly: true, sameSite: "lax", path: "/", maxAge: SESSION_MAX_AGE });
  return res;
}
```
(NOTE: confirm the `@/` import alias resolves in this app — check an existing route's imports. If the app uses relative imports instead, use `../../../../../lib/leash/auth` to match.)

- [ ] **Step 2: Implement login route**

Create `apps/web/app/api/leash/auth/login/route.ts`:

```ts
import { NextResponse } from "next/server";
import { verifyPassword, signSession, SESSION_COOKIE, SESSION_MAX_AGE } from "@/lib/leash/auth";

export const runtime = "nodejs";

export async function POST(req: Request): Promise<NextResponse> {
  const { password } = await req.json().catch(() => ({ password: "" }));
  if (typeof password !== "string" || !verifyPassword(password))
    return NextResponse.json({ error: "incorrect password" }, { status: 401 });
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, signSession(), { httpOnly: true, sameSite: "lax", path: "/", maxAge: SESSION_MAX_AGE });
  return res;
}
```

- [ ] **Step 3: Implement logout route**

Create `apps/web/app/api/leash/auth/logout/route.ts`:

```ts
import { NextResponse } from "next/server";
import { rotateSecret, SESSION_COOKIE } from "@/lib/leash/auth";

export const runtime = "nodejs";

export async function POST(): Promise<NextResponse> {
  rotateSecret();
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, "", { httpOnly: true, sameSite: "lax", path: "/", maxAge: 0 });
  return res;
}
```

- [ ] **Step 4: Type-check**

Run: `cd apps/web && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "api/leash/auth" || echo "no auth-route errors"`
Expected: `no auth-route errors`. (If the `@/` alias errored, switch the three imports to the correct relative path and re-run.)

- [ ] **Step 5: Checkpoint** — three routes compile.

---

## Task 3: Auth pages

**Files:**
- Create: `apps/web/app/setup-password/page.tsx`
- Create: `apps/web/app/login/page.tsx`

- [ ] **Step 1: Setup-password page**

Create `apps/web/app/setup-password/page.tsx`:

```tsx
"use client";
import { useState } from "react";

export default function SetupPassword(): React.JSX.Element {
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (pw.length < 6) return setErr("Password must be at least 6 characters.");
    if (pw !== confirm) return setErr("Passwords don't match.");
    setBusy(true);
    const r = await fetch("/api/leash/auth/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: pw }) });
    if (r.ok) window.location.href = "/";
    else { setErr((await r.json().catch(() => ({})))?.error ?? "Setup failed."); setBusy(false); }
  }

  return (
    <div className="flex h-screen flex-col items-center justify-center gap-5 bg-cream px-10 text-ink">
      <h1 className="font-display text-3xl font-semibold">Set a password for Leash</h1>
      <p className="max-w-sm text-center font-body text-sm text-muted">This locks your private dashboard on this device. Keep it safe — there is no recovery.</p>
      <form className="flex w-72 flex-col gap-3" onSubmit={submit}>
        <input className="rounded-lg border border-rule-strong bg-paper px-3 py-2 font-body text-sm" type="password" placeholder="Password" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus />
        <input className="rounded-lg border border-rule-strong bg-paper px-3 py-2 font-body text-sm" type="password" placeholder="Confirm password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        {err && <p className="font-mono text-[11px] text-brick">{err}</p>}
        <button className="rounded-lg bg-sage-deep px-4 py-2 font-mono text-xs uppercase tracking-label text-cream disabled:opacity-40" disabled={busy}>{busy ? "Setting…" : "Set password"}</button>
      </form>
    </div>
  );
}
```

- [ ] **Step 2: Login page**

Create `apps/web/app/login/page.tsx`:

```tsx
"use client";
import { useState } from "react";

export default function Login(): React.JSX.Element {
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    const r = await fetch("/api/leash/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: pw }) });
    if (r.ok) window.location.href = "/";
    else { setErr("Incorrect password."); setBusy(false); }
  }

  return (
    <div className="flex h-screen flex-col items-center justify-center gap-5 bg-cream px-10 text-ink">
      <h1 className="font-display text-4xl font-semibold tracking-tight">Leash</h1>
      <form className="flex w-72 flex-col gap-3" onSubmit={submit}>
        <input className="rounded-lg border border-rule-strong bg-paper px-3 py-2 font-body text-sm" type="password" placeholder="Password" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus />
        {err && <p className="font-mono text-[11px] text-brick">{err}</p>}
        <button className="rounded-lg bg-sage-deep px-4 py-2 font-mono text-xs uppercase tracking-label text-cream disabled:opacity-40" disabled={busy}>{busy ? "Unlocking…" : "Sign in"}</button>
      </form>
    </div>
  );
}
```

- [ ] **Step 3: Type-check**

Run: `cd apps/web && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "setup-password|app/login" || echo "no auth-page errors"`
Expected: `no auth-page errors`.

- [ ] **Step 4: Checkpoint** — both pages compile.

---

## Task 4: Enforcement — Node middleware (with fallback)

**Files:**
- Modify: `apps/web/next.config.mjs`
- Create: `apps/web/middleware.ts`

- [ ] **Step 1: Spike — verify Node middleware runs on Next 15.5.19**

Add to `apps/web/next.config.mjs` inside `nextConfig` (top level): `experimental: { nodeMiddleware: true },`.
Create a temporary `apps/web/middleware.ts`:
```ts
import { readFileSync } from "node:fs";
export const config = { runtime: "nodejs", matcher: ["/__mw_probe"] };
export function middleware(): Response | undefined {
  void readFileSync; // proves Node API is usable in this runtime
  return undefined;
}
```
Run: `cd apps/web && (npx next build 2>&1 | grep -iE "nodeMiddleware|middleware|node runtime|error" | head) ; echo "exit:$?"`
Expected: the build does NOT error on the Node API import in middleware (it compiles `middleware.ts` under the Node runtime). If the build errors specifically because `nodeMiddleware`/Node-runtime middleware is unsupported, STOP and use the FALLBACK in the note at the end of this task instead of Steps 2-3.

- [ ] **Step 2: Implement the real middleware**

Replace `apps/web/middleware.ts` with:
```ts
import { NextResponse, type NextRequest } from "next/server";
import { authEnabled, isConfigured, verifySession, SESSION_COOKIE } from "@/lib/leash/auth";

export const config = {
  runtime: "nodejs",
  // Run on everything except Next internals + common static assets.
  matcher: ["/((?!_next/static|_next/image|favicon|icon-|apple-touch|.*\\.(?:png|svg|ico|jpg|jpeg|webp|woff2?)$).*)"],
};

const PUBLIC = ["/login", "/setup-password", "/api/leash/auth/"];

export function middleware(req: NextRequest): NextResponse {
  if (!authEnabled()) return NextResponse.next();
  const { pathname } = req.nextUrl;
  if (PUBLIC.some((p) => pathname === p || pathname.startsWith(p))) return NextResponse.next();

  if (!isConfigured()) return NextResponse.redirect(new URL("/setup-password", req.url));
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (!verifySession(token)) return NextResponse.redirect(new URL("/login", req.url));
  return NextResponse.next();
}
```
(Use the same import path style — `@/lib/leash/auth` or relative — that worked in Task 2.)

- [ ] **Step 3: Verify the gate works (build + runtime probe)**

```bash
cd apps/web
rm -rf "$PWD/_auth_test_data"; LEASH_DATA_DIR="$PWD/_auth_test_data" npx next build >/dev/null 2>&1 && echo "build ok"
# runtime probe against dev server:
LEASH_DATA_DIR="$PWD/_auth_test_data" npx next dev -p 6802 >/tmp/auth-dev.out 2>&1 &
sleep 8
echo "unconfigured → should redirect to /setup-password:"
curl -s -o /dev/null -w "%{http_code} %{redirect_url}\n" http://localhost:6802/
echo "auth disabled → should be 200:"
LEASH_AUTH=0 curl -s -o /dev/null -w "(note: flag is server-side; see Step 4 for the real disabled check)\n" http://localhost:6802/ >/dev/null
pkill -f "next dev -p 6802"; rm -rf "$PWD/_auth_test_data"
```
Expected: the first curl returns `307` with a `redirect_url` ending `/setup-password`.

- [ ] **Step 4: Checkpoint** — Node middleware compiles and redirects unauthenticated requests.

**FALLBACK (only if Step 1 shows nodeMiddleware unsupported):** delete `middleware.ts` and the `experimental.nodeMiddleware` flag. Instead: in `apps/web/app/layout.tsx` (a server component), before rendering children, call a new server helper that reads the `leash_session` cookie via `cookies()` from `next/headers` and `auth`'s `isConfigured`/`verifySession`; `redirect("/login")` or `redirect("/setup-password")` when unauthenticated (skip when `!authEnabled()` or the current path is an auth page — pass the pathname via `headers()`). Add a `requireAuth()` guard (same checks, returns 401) at the top of each sensitive `app/api/leash/*` route. Document that this gates pages centrally and APIs per-route. Keep `auth.ts`/pages/API from Tasks 1-3 unchanged.

---

## Task 5: Sign-out control in the rail

**Files:**
- Modify: `apps/web/components/LeashRail.tsx`

- [ ] **Step 1: Add a Sign out action**

Read `apps/web/components/LeashRail.tsx` to match its icon-button pattern (it uses lucide icons + the shared IconButton/hover-label convention). Add a **Sign out** control at the bottom of the rail that calls:
```ts
async function signOut(): Promise<void> {
  await fetch("/api/leash/auth/logout", { method: "POST" });
  window.location.href = "/login";
}
```
Render it as an icon button (lucide `LogOut`) with a hover-label "Sign out", matching the rail's existing items. If the rail is a server component, put the button + handler in a tiny `"use client"` child component and import it.

- [ ] **Step 2: Type-check + build**

Run: `cd apps/web && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "LeashRail" || echo "no rail errors"`
Expected: `no rail errors`.

- [ ] **Step 3: Checkpoint** — Sign out renders in the rail.

---

## Task 6: Integration verification

**Files:** none (verification only)

- [ ] **Step 1: Full auth lifecycle against a dev server**

```bash
cd apps/web
D="$PWD/_auth_int"; rm -rf "$D"
LEASH_DATA_DIR="$D" npx next dev -p 6803 >/tmp/auth-int.out 2>&1 &
sleep 8
J=/tmp/auth.cookies
echo "1) unconfigured GET / → 307 /setup-password:"
curl -s -o /dev/null -w "%{http_code} %{redirect_url}\n" http://localhost:6803/
echo "2) setup creates password + sets cookie:"
curl -s -c "$J" -X POST http://localhost:6803/api/leash/auth/setup -H 'content-type: application/json' -d '{"password":"hunter2"}' -w " (%{http_code})\n"
echo "3) authed GET / → 200:"
curl -s -b "$J" -o /dev/null -w "%{http_code}\n" http://localhost:6803/
echo "4) logout:"
curl -s -b "$J" -c "$J" -X POST http://localhost:6803/api/leash/auth/logout -w " (%{http_code})\n"
echo "5) after logout GET / → 307 /login:"
curl -s -b "$J" -o /dev/null -w "%{http_code} %{redirect_url}\n" http://localhost:6803/
echo "6) wrong login → 401:"
curl -s -X POST http://localhost:6803/api/leash/auth/login -H 'content-type: application/json' -d '{"password":"nope"}' -o /dev/null -w "%{http_code}\n"
echo "7) right login → 200 set-cookie, then GET / 200:"
curl -s -c "$J" -X POST http://localhost:6803/api/leash/auth/login -H 'content-type: application/json' -d '{"password":"hunter2"}' -o /dev/null -w "%{http_code}\n"
curl -s -b "$J" -o /dev/null -w "%{http_code}\n" http://localhost:6803/
pkill -f "next dev -p 6803"
```
Expected: (1) `307 …/setup-password` · (2) `200` · (3) `200` · (4) `200` · (5) `307 …/login` · (6) `401` · (7) `200` then `200`.

- [ ] **Step 2: Dev escape hatch**

```bash
cd apps/web
D="$PWD/_auth_off"; rm -rf "$D"
LEASH_AUTH=0 LEASH_DATA_DIR="$D" npx next dev -p 6804 >/tmp/auth-off.out 2>&1 &
sleep 8
echo "LEASH_AUTH=0 → GET / 200 unauthenticated:"
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:6804/
pkill -f "next dev -p 6804"; rm -rf "$D" "$PWD/_auth_int"
```
Expected: `200`.

- [ ] **Step 3: Checkpoint** — full lifecycle + escape hatch verified. (The desktop shell needs NO change: it spawns the server without `LEASH_AUTH`, so the lock is on by default; `auth.json` lands under the install base's data dir via Phase 1.)

---

## Self-review notes
- **Spec coverage:** credential store (Task 1), API setup/login/logout (Task 2), pages (Task 3), middleware chokepoint + documented fallback (Task 4), sign-out (Task 5), env flag + lifecycle/escape-hatch verification (Task 6). Spec §5.1-§5.6 all mapped.
- **Naming consistency:** `auth-core.ts` exports (`makeAuthFile/verifyPassword/signSession/verifySession/rotate`) wrapped by `auth.ts` (`setPassword/verifyPassword/signSession/verifySession/rotateSecret/isConfigured/authEnabled`); `SESSION_COOKIE = "leash_session"` used in API + middleware.
- **Import alias caveat** flagged in Task 2 (resolve `@/` vs relative once, reuse).
- **No-git:** Checkpoints, not commits.
