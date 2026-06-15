import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

/**
 * Minimal bridge for the splash screen only. The real dashboard (loaded from
 * http://localhost:6801) runs its own client code and does not use this API.
 * contextIsolation stays on, nodeIntegration off.
 */
const shellAPI = {
  /** Subscribe to startup status text from the main process. Returns an unsubscribe fn. */
  onStatus: (cb: (text: string) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, text: string): void => cb(text)
    ipcRenderer.on('shell-status', listener)
    return () => ipcRenderer.removeListener('shell-status', listener)
  },
  onRoute: (cb: (route: string) => void): (() => void) => {
    const l = (_e: Electron.IpcRendererEvent, r: string): void => cb(r)
    ipcRenderer.on('shell-route', l)
    return () => ipcRenderer.removeListener('shell-route', l)
  },
  /** Structured first-run progress: phase + percent (null ⇒ indeterminate). Drives the download bar. */
  onProgress: (cb: (p: { phase: string; pct: number | null }) => void): (() => void) => {
    const l = (_e: Electron.IpcRendererEvent, p: { phase: string; pct: number | null }): void => cb(p)
    ipcRenderer.on('shell-progress', l)
    return () => ipcRenderer.removeListener('shell-progress', l)
  },
  /** Show a native OS notification for a proactive alert (fire-and-forget). The dashboard's rail
   *  calls this for genuinely-new heartbeat notifications; clicking the toast focuses the window. */
  notify: (n: { title: string; body: string; tag?: string }): void => ipcRenderer.send('notify:show', n)
}

export type ShellAPI = typeof shellAPI

const installAPI = {
  /** Returns the saved base ("default"|path) or null if not configured yet. */
  get: (): Promise<string | null> => ipcRenderer.invoke('install:get'),
  /** Native folder picker → chosen path or null. */
  chooseFolder: (): Promise<string | null> => ipcRenderer.invoke('install:choose'),
  /** Resolve the Leash base dir for a chosen base, for the confirm screen. Per-user dirs
   *  (<leashBase>/<userId>/…) are created after the user signs in. */
  resolved: (base: string): Promise<{ leashBase: string }> => ipcRenderer.invoke('install:resolved', base),
  /** Persist the choice and proceed to boot. */
  save: (base: string): Promise<void> => ipcRenderer.invoke('install:save', base)
}
export type InstallAPI = typeof installAPI

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('shell', shellAPI)
    contextBridge.exposeInMainWorld('install', installAPI)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.shell = shellAPI
  // @ts-ignore (define in dts)
  window.install = installAPI
}
