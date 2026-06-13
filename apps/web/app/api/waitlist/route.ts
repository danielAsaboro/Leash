/** `POST /api/waitlist` — append an email to data/waitlist.json (offline-friendly; deduped). */
import { join } from "node:path";
import { readJson, writeJson, invalidateJsonCache, DATA_DIR } from "../../../lib/leash/json-store.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FILE = process.env["LEASH_WAITLIST_FILE"] ?? join(DATA_DIR, "waitlist.json");
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface Entry {
  email: string;
  at: number;
}

export async function POST(req: Request): Promise<Response> {
  const { email } = (await req.json().catch(() => ({}))) as { email?: string };
  const value = (email ?? "").trim().toLowerCase();
  if (!value || !EMAIL_RE.test(value) || value.length > 254) {
    return Response.json({ error: "Enter a valid email address." }, { status: 400 });
  }
  const list = await readJson<Entry[]>(FILE, []);
  if (!list.some((e) => e.email === value)) {
    list.push({ email: value, at: Date.now() });
    await writeJson(FILE, list);
    invalidateJsonCache(FILE);
  }
  return Response.json({ ok: true });
}
