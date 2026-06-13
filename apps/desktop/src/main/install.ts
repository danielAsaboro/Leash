import { app, dialog } from 'electron'
import { join } from 'path'
import { userInfo } from 'os'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'

/**
 * The desktop's ONLY job here: persist which base folder the user picked. All per-user scoping
 * lives in the shared supervisor (apps/web/server-launch.mjs + lib/leash/scope.mjs) — the desktop
 * just hands it `LEASH_BASE`. `<base>/Leash/<userId>/…` is created by the supervisor.
 */

export interface InstallConfig {
  version: 1
  base: string
}

const installFile = (): string => join(app.getPath('userData'), 'install.json')

/** Accept only a well-formed config; anything else → null (re-show setup). */
function validate(raw: unknown): InstallConfig | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (o.version !== 1) return null
  if (typeof o.base !== 'string' || o.base.length === 0) return null
  return { version: 1, base: o.base }
}

export function readInstall(): InstallConfig | null {
  try {
    return validate(JSON.parse(readFileSync(installFile(), 'utf8')))
  } catch {
    return null
  }
}

export function saveInstall(base: string): InstallConfig {
  const cfg: InstallConfig = { version: 1, base }
  mkdirSync(app.getPath('userData'), { recursive: true })
  writeFileSync(installFile(), JSON.stringify(cfg, null, 2))
  return cfg
}

/** The Leash base dir the supervisor will use (for the Setup confirm screen). */
export function leashBaseFor(base: string): string {
  return join(base === 'default' ? userInfo().homedir : base, 'Leash')
}

/** Native folder picker; returns the chosen absolute path or null if cancelled. */
export async function chooseFolder(): Promise<string | null> {
  const r = await dialog.showOpenDialog({
    title: 'Choose a folder for Leash data & models',
    properties: ['openDirectory', 'createDirectory']
  })
  return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0]
}
