# Single-user lock (auth) — design (Phase 2)

**Date:** 2026-06-13
**App:** `apps/web` (the Leash dashboard) — applies wherever it runs (desktop app + `web:dev`)
**Status:** approved design → implementation plan next
**Depends on:** Phase 1 (`LEASH_DATA_DIR` env-gated data dir) — the credential file lives there.

---

## 1. Problem

The Leash dashboard is currently wide open: anyone who can reach the running app
sees chats, mesh state, settings, and other sensitive data. We add a **single-user
lock** — one owner sets a password, the whole dashboard sits behind it, sign in
unlocks, sign out re-locks. Local-only (no cloud, no OS keychain).

## 2. Decisions (locked)

- **Single owner**, one password (no multi-user/roles).
- **Always-on everywhere** the dashboard runs (desktop + browser `web:dev`).
  A dev escape hatch: `LEASH_AUTH=0` disables the gate.
- **Session lasts until sign out** (long-lived signed cookie; no idle timeout).
- **Credential stored locally** as a hash under `LEASH_DATA_DIR`.

## 3. Non-goals (v1)

- Multi-user, roles, guest mode.
- Password reset/recovery flow (recovery = delete `auth.json` from the data dir to
  start over; documented, not a UI).
- 2FA, rate-limited lockout, password strength meter (note a minimum length only).
- Encrypting data at rest (the lock gates access, it does not encrypt the DB).

## 4. Architecture

A **single middleware chokepoint** gates every request — pages and API routes —
so there is no per-route check to forget. The credential + a session-signing secret
live in one file under the Phase-1 data dir. The middleware needs to read that file
(fs) and hash/verify (crypto), which requires Next's **Node.js middleware runtime**.

```
<LEASH_DATA_DIR>/auth.json = { version:1, salt, passwordHash(scrypt), sessionSecret }

request ─► middleware.ts (nodejs runtime)
            ├─ LEASH_AUTH=0? ───────────────► pass (dev)
            ├─ static asset / auth page/API? ► pass
            ├─ no auth.json? ───────────────► redirect /setup-password
            ├─ no valid leash_session cookie?► redirect /login
            └─ valid cookie ────────────────► pass
```

**Node-middleware risk + fallback:** if `experimental.nodeMiddleware` does not work
on the installed Next (15.5.19), fall back to: a **root-layout server gate**
(`app/layout.tsx` reads the cookie + `auth.json` in a Node server component and
`redirect()`s) **plus a `requireAuth()` wrapper** applied to the sensitive API
routes. Same `auth.ts` core; only the enforcement point changes. The plan verifies
nodeMiddleware as its first step and picks the path.

## 5. Components

### 5.1 Credential store — `apps/web/lib/leash/auth.ts` (`import "server-only"`)
Pure Node `crypto`, no deps. File at `join(DATA_DIR, "auth.json")` (DATA_DIR from
Phase 1). Interfaces:

```ts
isConfigured(): boolean                       // auth.json exists + valid
setPassword(pw: string): void                 // first run: write salt+hash+new sessionSecret
verifyPassword(pw: string): boolean           // scryptSync timing-safe compare
signSession(): string                         // "<iat>.<hmac>"  (HMAC-SHA256 over iat w/ sessionSecret)
verifySession(token: string | undefined): boolean
rotateSecret(): void                          // logout: new sessionSecret → invalidates old cookies
authEnabled(): boolean                         // process.env.LEASH_AUTH !== "0"
```

- `scryptSync(pw, salt, 64)`, 16-byte random salt, hex-encoded; `timingSafeEqual`.
- `sessionSecret` = 32 random bytes (hex); cookie value `${iat}.${hmacHex}`;
  `verifySession` recomputes HMAC, `timingSafeEqual`, sanity-checks `iat` (reject if
  malformed or absurdly future-dated). No expiry (until sign out).
- Minimum password length: 6 (reject shorter in `setPassword`).

### 5.2 Middleware — `apps/web/middleware.ts`
- `export const config = { runtime: "nodejs", matcher: [...] }`; `next.config.mjs`
  gets `experimental: { nodeMiddleware: true }`.
- Early-out when `!authEnabled()`.
- Allowlist (always pass): `/_next/*`, `/favicon*`, `/icon-*`, `/apple-touch-*`,
  static files, `/login`, `/setup-password`, `/api/leash/auth/*`.
- Gate the rest per the diagram (§4).

### 5.3 Auth pages (broadsheet-styled, client components posting to the API)
- `app/setup-password/page.tsx` — password + confirm (min 6, must match). First run
  only; if already configured, redirect to `/login`.
- `app/login/page.tsx` — password field; on success the API sets the cookie and the
  page navigates to `/`.

### 5.4 Auth API — Node runtime (`export const runtime = "nodejs"`)
- `POST /api/leash/auth/setup` — body `{ password }`; 409 if already configured;
  else `setPassword` + set cookie (`signSession`). Returns `{ ok }`.
- `POST /api/leash/auth/login` — body `{ password }`; `verifyPassword` → set cookie or
  401. (No server-side attempt counter in v1; note as a future hardening.)
- `POST /api/leash/auth/logout` — clear cookie + `rotateSecret()`. Returns `{ ok }`.
- Cookie: name `leash_session`, value `signSession()`, `httpOnly`, `sameSite:"lax"`,
  `path:"/"`, `secure:false` (localhost http), `maxAge: 60*60*24*365`.

### 5.5 Sign-out control
A **Sign out** action in the dashboard chrome (the Leash left rail / Settings —
plan locates the exact component). Calls `POST /api/leash/auth/logout` then
`window.location.href = "/login"`.

### 5.6 Env flag
`LEASH_AUTH` — **default on** (any value except `"0"` → enabled; unset → enabled).
`LEASH_AUTH=0` disables. The desktop shell leaves it unset (on). Dev sets `=0`.

## 6. Data flow
1. First launch (after Phase-1 location step) → middleware sees no `auth.json` →
   `/setup-password` → user creates password → setup API writes `auth.json`, sets
   cookie → redirect `/` → dashboard.
2. Later launch → middleware sees `auth.json`, no cookie → `/login` → enter password →
   cookie set → `/`. Stays in across restarts (long-lived cookie).
3. Sign out → cookie cleared + secret rotated → `/login`.
4. `web:dev` with `LEASH_AUTH=0` → middleware passes everything (open dev).

## 7. Security notes / threat model
- Protects against casual access to a running app on the device/LAN; it is **not**
  full-disk encryption (data on disk is readable to someone with file access — noted).
- `scrypt` for the password hash; HMAC-SHA256 session tokens; `timingSafeEqual`
  comparisons; `httpOnly` cookie (JS can't read it). Logout rotates the secret so a
  copied cookie dies.
- `auth.json` written `0600` where supported.

## 8. Error handling
- Corrupt/partial `auth.json` → `isConfigured()` false → treated as first run
  (`/setup-password`); never 500.
- Wrong password → 401, the login page shows an inline error, no redirect.
- Cookie present but secret rotated (post-logout) → `verifySession` false → `/login`.

## 9. Testing
- **Unit (`tsx`):** `setPassword`→`verifyPassword` (right/wrong), `signSession`→
  `verifySession` (valid/tampered/empty), `rotateSecret` invalidates a prior token,
  `isConfigured` (absent/corrupt/valid), `authEnabled` honors `LEASH_AUTH=0`.
- **Integration:** with auth on, unauthenticated `GET /` → redirect `/login` (or
  `/setup-password` when unconfigured); `POST login` wrong → 401, right → cookie +
  `GET /` 200; `POST logout` → next `GET /` redirects. With `LEASH_AUTH=0` → `GET /`
  200 unauthenticated.
- **Backward compat:** `web:dev` without the flag now requires login — expected
  (always-on). Document the `LEASH_AUTH=0` dev override prominently.

## 10. Files
- New: `apps/web/lib/leash/auth.ts`, `apps/web/middleware.ts`,
  `apps/web/app/login/page.tsx`, `apps/web/app/setup-password/page.tsx`,
  `apps/web/app/api/leash/auth/{setup,login,logout}/route.ts`,
  `apps/web/scripts/verify-auth.ts` (unit checks).
- Modify: `apps/web/next.config.mjs` (`experimental.nodeMiddleware`), the dashboard
  chrome component for the Sign-out control (plan locates it).
- Reference (unchanged): `apps/web/lib/leash/json-store.ts` (`DATA_DIR` source).
