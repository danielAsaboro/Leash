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

  useEffect(() => window.shell.onStatus(setStatus), [])
  useEffect(() => window.shell.onRoute((r) => setRoute(r === 'setup' ? 'setup' : 'splash')), [])

  if (route === 'setup') return <Setup />

  return (
    <div className="flex h-screen flex-col items-center justify-center bg-cream text-ink">
      <h1 className="font-display text-5xl font-semibold tracking-tight">Leash</h1>
      <p className="mt-3 font-mono text-[11px] uppercase tracking-label text-faint">
        your mind · on your own devices
      </p>
      <div className="mt-10 flex items-center gap-2 font-mono text-xs text-muted">
        <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-sage" />
        <span>{status}</span>
      </div>
    </div>
  )
}

export default App
