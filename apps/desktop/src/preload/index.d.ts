import { ElectronAPI } from '@electron-toolkit/preload'
import type { ShellAPI, InstallAPI } from './index'

declare global {
  interface Window {
    electron: ElectronAPI
    shell: ShellAPI
    install: InstallAPI
  }
}
