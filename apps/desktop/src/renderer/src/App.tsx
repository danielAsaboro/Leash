import { useEffect, useState } from 'react'
import { Setup } from './Setup'

/**
 * Splash shown while the Leash dashboard server boots. Once the main process has
 * the dashboard ready it navigates the window away to http://localhost:6801, so
 * this component only ever renders during startup.
 */
function App(): React.JSX.Element {
  const [status, setStatus] = useState('Starting Leash…')
  const [route, setRoute] = useState<'splash' | 'setup'>('splash')
  const [progress, setProgress] = useState<{ phase: string; pct: number | null } | null>(null)

  useEffect(() => window.shell.onStatus(setStatus), [])
  useEffect(() => window.shell.onRoute((r) => setRoute(r === 'setup' ? 'setup' : 'splash')), [])
  useEffect(() => window.shell.onProgress(setProgress), [])

  if (route === 'setup') return <Setup />

  // Determinate while the runtime tarball downloads (we know the %); indeterminate for
  // verify/extract/boot (a full bar that pulses) so the page never looks frozen.
  const determinate = progress?.pct != null
  const pct = progress?.pct ?? 0

  return (
    <div className="flex h-screen flex-col items-center justify-center bg-cream text-ink">
      <h1 className="font-display text-5xl font-semibold tracking-tight">Leash</h1>
      <p className="mt-3 font-mono text-[11px] uppercase tracking-label text-faint">
        your mind · on your own devices
      </p>
      <div className="mt-12 w-80">
        <div className="mb-2 flex items-baseline justify-between font-mono text-[11px] text-muted">
          <span>{status}</span>
          {determinate && <span className="tabular-nums text-ink">{pct}%</span>}
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-rule">
          <div
            className={`h-full rounded-full bg-sage-deep transition-all duration-300 ${determinate ? '' : 'animate-pulse'}`}
            style={{ width: determinate ? `${pct}%` : '100%' }}
          />
        </div>
        <p className="mt-3 text-center font-body text-[11px] text-faint">
          First run downloads the local runtime once, then hands off to device setup.
        </p>
      </div>
    </div>
  )
}

export default App
