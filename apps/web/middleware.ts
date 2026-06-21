import { NextResponse, type NextRequest } from "next/server";
import { bootstrapNeedsWelcome, routeNeedsWelcome } from "./lib/leash/device-bootstrap-core.ts";
import { readDeviceBootstrap } from "./lib/leash/device-bootstrap.ts";

export const config = {
  runtime: "nodejs",
  matcher: ["/((?!_next/static|_next/image|favicon|icon-|apple-touch|.*\\.(?:png|svg|ico|jpg|jpeg|webp|woff2?)$).*)"],
};

// Public marketing surface — NEVER gated. The landing page ("/") is the public
// useleash.xyz front page (served locally too); only the dashboard ("/home",
// "/chat", "/brain", …) sits behind the lock. "/" must be an EXACT match (a
// startsWith("/") would open everything).
const PUBLIC_EXACT = ["/"];
const PUBLIC_PREFIX = ["/api/leash/bootstrap/", "/api/waitlist", "/landing/"];

// Server-to-server internal routes (cron / leash-watch → web): authorized by a shared token, NEVER a
// browser session. The launcher seeds LEASH_INTERNAL_TOKEN into the web env and writes the same value
// to <data>/.leash-internal-token, which cron reads and sends as the `x-leash-internal` header.
const INTERNAL_ROUTES = ["/api/leash/heartbeat"];

// Routes reachable by EITHER a browser session (the dashboard) OR the shared internal token
// (a server-to-server caller like the leash-tools-mcp "Scheduler" group). A matching token wins
// immediately; a present-but-wrong token is rejected; NO token header falls through to session
// auth. This lets the assistant schedule its own actions via the same store the dashboard uses,
// without opening these routes to the public.
const INTERNAL_OR_SESSION_PREFIX = ["/api/leash/schedules"];

function isPublic(pathname: string): boolean {
  return PUBLIC_EXACT.includes(pathname) || PUBLIC_PREFIX.some((p) => pathname === p || pathname.startsWith(p));
}

export function middleware(req: NextRequest): NextResponse {
  const { pathname } = req.nextUrl;
  // Internal routes: authorize by the shared token before any session logic. When a token is
  // configured (always, in a launched app) a missing/mismatched header is rejected; with no token
  // configured (bare dev) we fall through to normal handling below.
  if (INTERNAL_ROUTES.includes(pathname)) {
    const tok = process.env["LEASH_INTERNAL_TOKEN"];
    if (tok) return req.headers.get("x-leash-internal") === tok ? NextResponse.next() : new NextResponse("forbidden", { status: 403 });
  }
  // Dual-auth routes: a valid internal token authorizes immediately; a wrong one is rejected; no
  // token header falls through to the normal session checks below (so the dashboard still works).
  if (INTERNAL_OR_SESSION_PREFIX.some((p) => pathname === p || pathname.startsWith(p))) {
    const tok = process.env["LEASH_INTERNAL_TOKEN"];
    const hdr = req.headers.get("x-leash-internal");
    if (tok && hdr) return hdr === tok ? NextResponse.next() : new NextResponse("forbidden", { status: 403 });
  }
  if (isPublic(pathname)) return NextResponse.next();
  const ready = !bootstrapNeedsWelcome(readDeviceBootstrap());
  if (routeNeedsWelcome(pathname, ready)) return NextResponse.redirect(new URL("/welcome", req.url));
  return NextResponse.next();
}
