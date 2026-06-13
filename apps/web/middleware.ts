import { NextResponse, type NextRequest } from "next/server";
import { authEnabled, isConfigured, verifySession, SESSION_COOKIE } from "./lib/leash/auth.ts";

export const config = {
  runtime: "nodejs",
  matcher: ["/((?!_next/static|_next/image|favicon|icon-|apple-touch|.*\\.(?:png|svg|ico|jpg|jpeg|webp|woff2?)$).*)"],
};

// Public marketing surface — NEVER gated. The landing page ("/") is the public
// useleash.xyz front page (served locally too); only the dashboard ("/home",
// "/chat", "/brain", …) sits behind the lock. "/" must be an EXACT match (a
// startsWith("/") would open everything).
const PUBLIC_EXACT = ["/"];
const PUBLIC_PREFIX = ["/login", "/setup-password", "/api/leash/auth/", "/api/waitlist", "/landing/"];

function isPublic(pathname: string): boolean {
  return PUBLIC_EXACT.includes(pathname) || PUBLIC_PREFIX.some((p) => pathname === p || pathname.startsWith(p));
}

export function middleware(req: NextRequest): NextResponse {
  if (!authEnabled()) return NextResponse.next();
  const { pathname } = req.nextUrl;
  if (isPublic(pathname)) return NextResponse.next();
  if (!isConfigured()) return NextResponse.redirect(new URL("/setup-password", req.url));
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const userId = verifySession(token);
  if (!userId) return NextResponse.redirect(new URL("/login", req.url));
  // The server process is always scoped (by the supervisor) to ONE active user. A cookie for a
  // different user (stale after a switch) — or no active user (a bootstrap/pre-login process) —
  // must re-authenticate, which re-activates the right scope.
  const active = process.env["LEASH_ACTIVE_USER"];
  if (!active || userId !== active) return NextResponse.redirect(new URL("/login", req.url));
  return NextResponse.next();
}
