/**
 * `GET /api/search?q=…` — backs the ⌘K command palette. Searches PUBLISHED articles
 * by headline / dek / body and returns up to a dozen hits with a short snippet. Runs
 * on the Node runtime (Prisma) and is never cached (the paper changes live).
 */
import { NextResponse } from "next/server";
import { searchArticles } from "../../../lib/queries.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const q = new URL(request.url).searchParams.get("q") ?? "";
  const hits = await searchArticles(q);
  return NextResponse.json({ hits });
}
