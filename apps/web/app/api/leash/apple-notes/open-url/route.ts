import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const execFileAsync = promisify(execFile);
const SQLITE3 = "/usr/bin/sqlite3";

function notesDbPath(): string | null {
  const homes = [process.env["HOME"], homedir(), "/Users/MAC"].filter((v): v is string => !!v);
  for (const home of [...new Set(homes)]) {
    const path = join(home, "Library/Group Containers/group.com.apple.notes/NoteStore.sqlite");
    if (existsSync(path)) return path;
  }
  return null;
}

function coreDataPrimaryKey(id: string): number | null {
  const match = id.match(/\/p(\d+)$/);
  if (!match) return null;
  const pk = Number(match[1]);
  return Number.isSafeInteger(pk) && pk > 0 ? pk : null;
}

export async function GET(req: Request): Promise<Response> {
  const id = new URL(req.url).searchParams.get("id") ?? "";
  const pk = coreDataPrimaryKey(id);
  if (!pk) return Response.json({ error: "invalid_note_id" }, { status: 400 });
  const db = notesDbPath();
  if (!db) return Response.json({ error: "notes_db_missing" }, { status: 404 });
  try {
    const { stdout } = await execFileAsync(SQLITE3, [db, `SELECT ZIDENTIFIER FROM ZICCLOUDSYNCINGOBJECT WHERE Z_PK = ${pk} LIMIT 1;`], { timeout: 1_000 });
    const identifier = stdout.trim().toUpperCase();
    if (!/^[0-9A-F-]{36}$/.test(identifier)) return Response.json({ error: "note_identifier_missing" }, { status: 404 });
    return Response.json({ identifier, openUrl: `applenotes://showNote?identifier=${encodeURIComponent(identifier)}` });
  } catch (err) {
    return Response.json({ error: "lookup_failed", message: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
