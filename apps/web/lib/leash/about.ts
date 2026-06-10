/**
 * App identity for Settings → About (server-only). Version + license come from the monorepo
 * `package.json` (real, not hand-typed); the developer name is an editable constant below.
 */
import "server-only";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DATA_DIR } from "./json-store.ts";

/** Shown as the maker in Settings → About — edit to your name / team. */
const DEVELOPER = "Mycelium";

export interface AboutInfo {
  name: string;
  version: string;
  license: string;
  developer: string;
  tagline: string;
}

export async function aboutInfo(): Promise<AboutInfo> {
  let version = "0.0.0";
  let license = "Apache-2.0";
  try {
    // DATA_DIR's parent is the repo root (same anchor models.ts uses for qvac.config.base.json).
    const pkg = JSON.parse(await readFile(join(DATA_DIR, "..", "package.json"), "utf8")) as { version?: string; license?: string };
    if (pkg.version) version = pkg.version;
    if (pkg.license) license = pkg.license;
  } catch {
    /* fall back to defaults */
  }
  return {
    name: "Mycelium",
    version,
    license,
    developer: DEVELOPER,
    tagline: "A private, offline, end-to-end-encrypted exocortex across your device mesh.",
  };
}
