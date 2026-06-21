import { useState } from 'react'

export function Setup(): React.JSX.Element {
  const [base, setBase] = useState<string | null>(null)
  const [paths, setPaths] = useState<{ leashBase: string } | null>(null)
  const [busy, setBusy] = useState(false)

  async function pick(): Promise<void> {
    const chosen = await window.install.chooseFolder()
    if (!chosen) return
    setBase(chosen)
    setPaths(await window.install.resolved(chosen))
  }
  async function useDefault(): Promise<void> {
    setBase('default')
    setPaths(await window.install.resolved('default'))
  }
  async function start(): Promise<void> {
    if (!base) return
    setBusy(true)
    await window.install.save(base) // main saves + boots the dashboard
  }

  return (
    <div className="flex h-screen flex-col items-center justify-center gap-6 bg-cream px-10 text-ink">
      <h1 className="font-display text-4xl font-semibold">Prepare this computer</h1>
      <p className="max-w-md text-center font-body text-sm text-muted">
        Choose where Leash should keep this computer&rsquo;s local workspace, runtime, and model cache.
        After that, you&rsquo;ll choose whether this computer starts fresh or joins a device you already trust.
      </p>
      <div className="flex gap-3">
        <button
          className="rounded-lg border border-rule-strong bg-paper px-4 py-2 font-mono text-xs uppercase tracking-label disabled:opacity-40"
          onClick={useDefault}
          disabled={busy}
        >
          Use default
        </button>
        <button
          className="rounded-lg bg-sage-deep px-4 py-2 font-mono text-xs uppercase tracking-label text-cream disabled:opacity-40"
          onClick={pick}
          disabled={busy}
        >
          Choose folder…
        </button>
      </div>
      {paths && (
        <div className="mt-2 max-w-lg rounded-lg border border-rule bg-paper p-4 font-mono text-[11px] text-muted">
          <div>Leash: {paths.leashBase}</div>
          <div>local scope: {paths.leashBase}/&lt;device-scope&gt;/…</div>
          <div className="mt-1 text-[10px]">Leash creates one local scope for this installation and prepares the rest from the dashboard onboarding flow.</div>
        </div>
      )}
      <button
        className="rounded-lg bg-sage-deep px-6 py-2 font-mono text-xs uppercase tracking-label text-cream disabled:opacity-40"
        disabled={!base || busy}
        onClick={start}
      >
        {busy ? 'Starting…' : 'Continue'}
      </button>
    </div>
  )
}
