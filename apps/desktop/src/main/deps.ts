import { createHash } from 'crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import manifest from './deps-manifest.json'

/**
 * Stub-installer deps: the heavy qvac runtime is NOT in the DMG — it's downloaded into the user's
 * base dir after Setup (and cached there, offline forever after). Same idea as a Chrome stub
 * installer: ship small, fetch the rest on first run. Hosted on a GitHub Release (manifest.baseUrl;
 * override with LEASH_DEPS_URL). The mesh daemons download on-demand later via the same mechanism.
 */

const execFileP = promisify(execFile)

export interface DepProgress {
  phase: 'download' | 'verify' | 'extract' | 'done'
  pct?: number
}

function baseUrl(): string {
  return (process.env.LEASH_DEPS_URL ?? manifest.baseUrl).replace(/\/+$/, '')
}

/** Where system-download status files live, read by the web Tasks → Downloads view. */
export function sysDownloadsDir(leashBase: string): string {
  return join(leashBase, '_deps', 'downloads')
}

/** Write a system download's status (runtime / daemons) so the dashboard can show progress + failures.
 *  Shape mirrors the web DownloadStatus (kind:"system"). Best-effort; never throws. */
function writeSysStatus(
  leashBase: string,
  name: 'runtime' | 'daemons',
  label: string,
  s: { state: 'starting' | 'downloading' | 'done' | 'error' | 'cancelled'; percentage?: number; downloaded?: number; total?: number; error?: string },
): void {
  try {
    const dir = sysDownloadsDir(leashBase)
    mkdirSync(dir, { recursive: true })
    const f = join(dir, `${name}.json`)
    let prev: { startedAt?: number } = {}
    try {
      prev = JSON.parse(readFileSync(f, 'utf8'))
    } catch {
      /* no prior */
    }
    const now = Date.now()
    writeFileSync(
      f,
      JSON.stringify({
        name,
        kind: 'system',
        label,
        state: s.state,
        percentage: s.percentage ?? 0,
        downloaded: s.downloaded ?? 0,
        total: s.total ?? 0,
        ...(s.error ? { error: s.error } : {}),
        pid: process.pid,
        startedAt: s.state === 'starting' ? now : (prev.startedAt ?? now),
        updatedAt: now,
      }),
    )
  } catch {
    /* status is advisory — never let it break a download */
  }
}

/**
 * Ensure the qvac runtime exists under `<leashBase>/_deps`; download + verify (sha256) + extract if
 * missing. Returns the absolute path to the bundled qvac CLI entry (for LEASH_QVAC_CLI). Idempotent
 * via a checksum-stamped marker, so re-launches skip the download.
 */
export async function ensureRuntime(leashBase: string, onProgress: (p: DepProgress) => void): Promise<string> {
  const depsDir = join(leashBase, '_deps')
  const cliPath = join(depsDir, manifest.runtime.cli)
  const marker = join(depsDir, `.runtime-${manifest.runtime.sha256.slice(0, 16)}.ok`)
  if (existsSync(cliPath) && existsSync(marker)) return cliPath // already installed + verified

  mkdirSync(depsDir, { recursive: true })
  const url = `${baseUrl()}/${manifest.runtime.file}`
  const tmp = join(depsDir, `.${manifest.runtime.file}.part`)
  const total = manifest.runtime.bytes
  const ac = new AbortController()
  activeDownloads.set('runtime', ac)
  try {
    onProgress({ phase: 'download', pct: 0 })
    writeSysStatus(leashBase, 'runtime', 'QVAC runtime', { state: 'starting', total })
    await downloadTo(url, tmp, total, (pct) => {
      onProgress({ phase: 'download', pct })
      writeSysStatus(leashBase, 'runtime', 'QVAC runtime', { state: 'downloading', percentage: pct, downloaded: Math.floor((pct / 100) * total), total })
    }, ac.signal)

    onProgress({ phase: 'verify' })
    const sha = await sha256File(tmp)
    if (sha !== manifest.runtime.sha256) {
      rmSync(tmp, { force: true })
      throw new Error(`runtime checksum mismatch (got ${sha.slice(0, 12)}…, expected ${manifest.runtime.sha256.slice(0, 12)}…)`)
    }

    onProgress({ phase: 'extract' })
    rmSync(join(depsDir, manifest.runtime.extractDir), { recursive: true, force: true }) // clear any partial prior extract
    await execFileP('tar', ['-xzf', tmp, '-C', depsDir])
    rmSync(tmp, { force: true })
    if (!existsSync(cliPath)) throw new Error('runtime extracted but the CLI entry is missing')
    writeFileSync(marker, new Date().toISOString())
    onProgress({ phase: 'done' })
    writeSysStatus(leashBase, 'runtime', 'QVAC runtime', { state: 'done', percentage: 100, downloaded: total, total })
    return cliPath
  } catch (err) {
    rmSync(tmp, { force: true })
    if (ac.signal.aborted) markSysCancelled(leashBase, 'runtime') // cancelled → keep a retryable row
    else writeSysStatus(leashBase, 'runtime', 'QVAC runtime', { state: 'error', error: (err as Error).message, total })
    throw err
  } finally {
    activeDownloads.delete('runtime')
  }
}

/**
 * Ensure the on-demand daemon overlay (hypha, watcher, newsroom, …) exists under the runtime tree:
 * `<leashBase>/_deps/qvac-runtime/leash-daemons`. Extracted INTO the runtime so the daemons resolve
 * @qvac/sdk + tsx one dir up and their own deps from the overlay. Idempotent (checksum marker).
 * No-op (returns null) if the manifest has no `daemons` entry or the runtime isn't installed yet.
 */
export async function ensureDaemons(leashBase: string, onProgress: (p: DepProgress) => void): Promise<string | null> {
  const dm = (manifest as { daemons?: { file: string; sha256: string; bytes: number; extractDir: string } }).daemons
  if (!dm) return null
  const depsDir = join(leashBase, '_deps')
  const runtimeDir = join(depsDir, manifest.runtime.extractDir)
  const overlay = join(runtimeDir, dm.extractDir)
  const entry = join(overlay, 'apps', 'hypha', 'src', 'main.ts')
  const marker = join(runtimeDir, `.daemons-${dm.sha256.slice(0, 16)}.ok`)
  if (existsSync(entry) && existsSync(marker)) return overlay // already installed + verified
  if (!existsSync(runtimeDir)) return null // runtime must be installed first

  const url = `${baseUrl()}/${dm.file}`
  const tmp = join(depsDir, `.${dm.file}.part`)
  const total = dm.bytes
  const ac = new AbortController()
  activeDownloads.set('daemons', ac)
  try {
    onProgress({ phase: 'download', pct: 0 })
    writeSysStatus(leashBase, 'daemons', 'Mesh daemons', { state: 'starting', total })
    await downloadTo(url, tmp, total, (pct) => {
      onProgress({ phase: 'download', pct })
      writeSysStatus(leashBase, 'daemons', 'Mesh daemons', { state: 'downloading', percentage: pct, downloaded: Math.floor((pct / 100) * total), total })
    }, ac.signal)

    onProgress({ phase: 'verify' })
    const sha = await sha256File(tmp)
    if (sha !== dm.sha256) {
      rmSync(tmp, { force: true })
      throw new Error(`daemons checksum mismatch (got ${sha.slice(0, 12)}…, expected ${dm.sha256.slice(0, 12)}…)`)
    }

    onProgress({ phase: 'extract' })
    rmSync(overlay, { recursive: true, force: true }) // clear any partial prior extract
    await execFileP('tar', ['-xzf', tmp, '-C', runtimeDir]) // tarball holds leash-daemons/ → <runtime>/leash-daemons
    rmSync(tmp, { force: true })
    if (!existsSync(entry)) throw new Error('daemons extracted but the hypha entry is missing')
    writeFileSync(marker, new Date().toISOString())
    onProgress({ phase: 'done' })
    writeSysStatus(leashBase, 'daemons', 'Mesh daemons', { state: 'done', percentage: 100, downloaded: total, total })
    return overlay
  } catch (err) {
    rmSync(tmp, { force: true })
    if (ac.signal.aborted) markSysCancelled(leashBase, 'daemons') // cancelled → keep a retryable row
    else writeSysStatus(leashBase, 'daemons', 'Mesh daemons', { state: 'error', error: (err as Error).message, total })
    throw err
  } finally {
    activeDownloads.delete('daemons')
  }
}

/**
 * Watch the system-downloads dir for `<name>.retry` sentinels (written by the dashboard's Downloads
 * "retry" button) and re-run the matching ensure. Returns a stop fn. Polls (fs.watch is flaky on the
 * networked/USB volumes this runs on).
 */
/** In-flight system downloads → their AbortController, so a `.cancel` sentinel can stop them. */
const activeDownloads = new Map<'runtime' | 'daemons', AbortController>()

const SYS_LABEL: Record<'runtime' | 'daemons', string> = { runtime: 'QVAC runtime', daemons: 'Mesh daemons' }

/** Mark a system download CANCELLED but KEEP the row — a cancelled download stays in the dashboard
 *  as a "dropped" task with a retry button, instead of vanishing forever with no way to restart it. */
function markSysCancelled(leashBase: string, name: 'runtime' | 'daemons'): void {
  writeSysStatus(leashBase, name, SYS_LABEL[name], { state: 'cancelled', error: 'cancelled by you' })
}

/**
 * Watch the system-downloads dir for control sentinels from the dashboard:
 *   `<name>.retry`  → re-run the ensure (via onRetry).
 *   `<name>.cancel` → abort an in-flight download + clear its status/partial.
 */
export function watchSystemControls(leashBase: string, onRetry: (name: 'runtime' | 'daemons') => void): () => void {
  const dir = sysDownloadsDir(leashBase)
  const id = setInterval(() => {
    for (const name of ['runtime', 'daemons'] as const) {
      const retry = join(dir, `${name}.retry`)
      if (existsSync(retry)) {
        rmSync(retry, { force: true })
        onRetry(name)
      }
      const cancel = join(dir, `${name}.cancel`)
      if (existsSync(cancel)) {
        rmSync(cancel, { force: true })
        activeDownloads.get(name)?.abort()
        markSysCancelled(leashBase, name)
      }
    }
  }, 3000)
  return () => clearInterval(id)
}

async function downloadTo(url: string, dest: string, expectedBytes: number, onPct: (pct: number) => void, signal?: AbortSignal): Promise<void> {
  const res = await fetch(url, signal ? { signal } : {})
  if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status} for ${url}`)
  const total = Number(res.headers.get('content-length')) || expectedBytes || 0
  const out = createWriteStream(dest)
  const reader = res.body.getReader()
  let got = 0
  let lastPct = -1
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      out.write(Buffer.from(value))
      got += value.length
      if (total) {
        const pct = Math.min(100, Math.floor((got / total) * 100))
        if (pct !== lastPct) {
          lastPct = pct
          onPct(pct)
        }
      }
    }
  } finally {
    await new Promise<void>((resolve, reject) => out.end((e: unknown) => (e ? reject(e) : resolve())))
  }
}

function sha256File(p: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256')
    createReadStream(p)
      .on('data', (d) => h.update(d))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject)
  })
}
