import { app, shell, BrowserWindow, net, ipcMain, Notification } from 'electron'
import { join, resolve } from 'path'
import { existsSync } from 'fs'
import { readInstall, saveInstall, chooseFolder, leashBaseFor } from './install'
import { ensureRuntime, ensureDaemons, watchSystemControls } from './deps'
import { homedir, userInfo } from 'os'
import { spawn, type ChildProcess } from 'child_process'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'

/**
 * Leash desktop = a native window that spawns the SHARED supervisor (`apps/web/server-launch.mjs`)
 * — the exact same single implementation that `npm run dev` / `npm run start` use. There is no
 * desktop-specific scoping logic; the supervisor owns per-user isolation, respawn-on-login, and
 * serve reaping. The Electron main only: picks a base folder, spawns the supervisor, and shows
 * the dashboard. One mode, one code path, web and desktop identical.
 *
 *  · DEV (electron-vite dev): supervisor wraps the repo's `next dev`.
 *  · PACKAGED: supervisor runs the bundled Next standalone (seeded per the env contract below),
 *    via Electron's own Node (ELECTRON_RUN_AS_NODE) — no system Node needed.
 *
 * Inference is NOT bundled: the dashboard fetches `qvac serve` on first use (npx @qvac/cli),
 * cached once in the shared npm cache; weights and QVAC stores live inside each device scope's
 * `data/.qvac` workspace.
*/

const WEB_PORT = Number(process.env.MYCELIUM_DESKTOP_WEB_PORT ?? 6801)
const WEB_URL = process.env.MYCELIUM_DESKTOP_WEB_URL ?? `http://localhost:${WEB_PORT}`
const DASH_URL = `${WEB_URL}/home`

let mainWindow: BrowserWindow | null = null
let supervisor: ChildProcess | null = null
let quitting = false
/** Path to the downloaded qvac CLI entry (set by ensureDeps before the serve starts). */
let runtimeCliPath: string | null = null

function sendStatus(text: string): void {
  mainWindow?.webContents.send('shell-status', text)
}

/** First-run progress for the download page. `pct: null` ⇒ indeterminate (verify/extract/boot). */
function sendProgress(phase: string, pct: number | null): void {
  mainWindow?.webContents.send('shell-progress', { phase, pct })
}

/** A PATH that includes the usual Node install locations — a Finder-launched app inherits only a
 *  minimal PATH, so `npx` (used by the dashboard to fetch the qvac serve) wouldn't be found. */
function runtimePath(): string {
  const extra = ['/opt/homebrew/bin', '/usr/local/bin', join(homedir(), '.nvm/current/bin'), join(homedir(), '.volta/bin'), '/usr/bin', '/bin']
  return [...extra, process.env.PATH ?? ''].filter(Boolean).join(':')
}

function waitForServer(timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolveWait, reject) => {
    const tick = (): void => {
      const req = net.request(WEB_URL)
      req.on('response', () => resolveWait())
      req.on('error', () => {
        if (Date.now() > deadline) reject(new Error(`Leash dashboard never came up on ${WEB_URL}`))
        else setTimeout(tick, 700)
      })
      req.end()
    }
    tick()
  })
}

/** DEV: walk up from the app path to the monorepo root (the dir holding apps/web). */
function findRepoRoot(): string | null {
  if (process.env.MYCELIUM_ROOT) return process.env.MYCELIUM_ROOT
  let dir = app.getAppPath()
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, 'apps', 'web', 'package.json'))) return dir
    const parent = resolve(dir, '..')
    if (parent === dir) break
    dir = parent
  }
  return null
}

/** Spawn the shared supervisor (the single source of truth for per-user scoping). */
function startSupervisor(): void {
  const base = readInstall()?.base ?? 'default'
  // "default" → the passwd home (os.userInfo), NOT os.homedir(): a GUI app can inherit a custom
  // $HOME (e.g. an external volume) that diverges from CLI tools, which would split a user's data
  // across two "default" locations. userInfo().homedir reads the directory service, so the desktop
  // and the CLI (migration, `npm run dev`) agree on where "default" lives.
  const leashBaseDir = base === 'default' ? userInfo().homedir : base // supervisor appends "Leash/"

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: runtimePath(),
    PORT: String(WEB_PORT),
    LEASH_BASE: leashBaseDir,
    // Run the .mjs launcher as Node via Electron's bundled runtime (else the electron binary
    // would try to open it as an app). Inherited by the packaged standalone server.js too.
    ELECTRON_RUN_AS_NODE: '1'
  }

  let launcher: string
  if (is.dev) {
    const root = findRepoRoot()
    if (!root) return sendStatus('Could not locate the Mycelium repo — set MYCELIUM_ROOT.')
    launcher = join(root, 'apps', 'web', 'server-launch.mjs')
    env.LEASH_SERVER_CMD = 'npx next dev' // supervisor wraps the repo dev server
  } else {
    // Packaged: the supervisor rides inside the standalone bundle (staged there at build time).
    launcher = join(process.resourcesPath, 'leash', 'apps', 'web', 'server-launch.mjs')
    env.LEASH_RUNTIME_SRC = join(process.resourcesPath, 'leash') // seeded → <base>/Leash/_runtime
    env.LEASH_QVAC_CONFIG_SRC = join(process.resourcesPath, 'leash-config')
    env.LEASH_DB_TEMPLATE = join(process.resourcesPath, 'newsroom-template.db')
    // The arch-pruned qvac runtime is DOWNLOADED into the base dir after Setup (stub installer),
    // not bundled — the serve runs it via Electron's Node, so the app needs no system Node and the
    // DMG stays small. ensureDeps() populated runtimeCliPath before we got here.
    if (runtimeCliPath) env.LEASH_QVAC_CLI = runtimeCliPath
    env.LEASH_NODE_BIN = process.execPath // Electron binary; ELECTRON_RUN_AS_NODE makes it act as Node
  }
  if (!existsSync(launcher)) return sendStatus('Leash supervisor missing from the app — rebuild required.')

  sendStatus('Starting the Leash dashboard…')
  supervisor = spawn(process.execPath, [launcher], { env, stdio: 'inherit' })
  supervisor.on('exit', (code) => {
    supervisor = null
    if (!quitting && code && code !== 0) sendStatus(`Leash supervisor exited (code ${code}).`)
  })
}

/** Download the qvac runtime into the base dir if it isn't there yet (packaged stub installer). */
async function ensureDeps(): Promise<void> {
  if (is.dev) return // dev runs the serve via the repo's LOCAL patched @qvac/cli (see serve-control.ts)
  const cfg = readInstall()
  if (!cfg) return
  runtimeCliPath = await ensureRuntime(leashBaseFor(cfg.base), (p) => {
    if (p.phase === 'download') {
      sendStatus(`Downloading runtime… ${p.pct ?? 0}%`)
      sendProgress('download', p.pct ?? 0)
    } else if (p.phase === 'verify') {
      sendStatus('Verifying runtime…')
      sendProgress('verify', null)
    } else if (p.phase === 'extract') {
      sendStatus('Installing runtime…')
      sendProgress('extract', null)
    }
  })
}

async function bringUpDashboard(): Promise<void> {
  try {
    sendStatus('Connecting to Leash…')
    await waitForServer(2_000).catch(async () => {
      await ensureDeps() // first run: fetch the runtime into the base dir, with progress
      sendStatus('Starting the Leash dashboard…')
      sendProgress('boot', null)
      startSupervisor()
      return waitForServer()
    })
    sendStatus('Loading…')
    sendProgress('boot', null)
    await mainWindow?.loadURL(DASH_URL)
    void fetchDaemonsInBackground() // non-blocking: dashboard is up; services become startable once it lands
  } catch (err) {
    sendStatus(`${(err as Error).message}`)
  }
}

let retryWatcherStarted = false

/** Fetch the on-demand daemon overlay (hypha, watcher, …) after the dashboard is up — non-blocking,
 *  so first run stays fast. The Services tab reports "preparing" until the overlay is extracted.
 *  Also starts the retry watcher so the dashboard's Downloads "retry" can re-trigger a failed fetch. */
async function fetchDaemonsInBackground(): Promise<void> {
  if (is.dev) return
  const cfg = readInstall()
  if (!cfg) return
  const leashBase = leashBaseFor(cfg.base)

  if (!retryWatcherStarted) {
    retryWatcherStarted = true
    watchSystemControls(leashBase, (name) => {
      void (name === 'runtime'
        ? ensureRuntime(leashBase, () => {})
        : ensureDaemons(leashBase, () => {})
      ).catch((err) => console.error(`[deps] retry of ${name} failed:`, (err as Error).message))
    })
  }

  try {
    await ensureDaemons(leashBase, () => {})
  } catch (err) {
    console.error('[daemons] background fetch failed:', (err as Error).message)
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    show: false,
    title: 'Leash',
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())
  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
  mainWindow.webContents.once('did-finish-load', () => {
    if (!is.dev && !readInstall()) mainWindow?.webContents.send('shell-route', 'setup')
    else void bringUpDashboard()
  })
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.mycelium.desktop')
  app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))
  // Proactive OS notifications: the dashboard rail forwards genuinely-new heartbeat alerts here.
  // Clicking the toast focuses the window and routes to the feed. Fire-and-forget (renderer dedups).
  ipcMain.on('notify:show', (_e, n: { title: string; body: string; tag?: string }) => {
    if (!Notification.isSupported() || !n?.title) return
    const toast = new Notification({ title: String(n.title).slice(0, 120), body: String(n.body ?? '').slice(0, 240) })
    toast.on('click', () => {
      if (!mainWindow) return
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
      void mainWindow.webContents.loadURL(`${WEB_URL}/notifications`)
    })
    toast.show()
  })
  ipcMain.handle('install:get', () => readInstall()?.base ?? null)
  ipcMain.handle('install:choose', () => chooseFolder())
  ipcMain.handle('install:resolved', (_e, base: string) => ({ leashBase: leashBaseFor(base) }))
  ipcMain.handle('install:save', (_e, base: string) => {
    saveInstall(base)
    // Leave the Setup screen for the splash so the runtime-download progress (`shell-status`,
    // "Downloading runtime… 93%") is actually visible — otherwise first-run sits on a dead
    // "Starting…" button for the whole ~170 MB fetch and looks frozen.
    mainWindow?.webContents.send('shell-route', 'splash')
    void bringUpDashboard()
  })
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  quitting = true
  if (supervisor) {
    supervisor.kill('SIGTERM') // the supervisor reaps its child server + the qvac serve
    supervisor = null
  }
})
