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
      <h1 className="font-display text-4xl font-semibold">Where should Leash live?</h1>
      <p className="max-w-md text-center font-body text-sm text-muted">
        Pick one folder for Leash&rsquo;s data and the AI model cache (several GB, downloaded on
        first use). You can move this folder to another machine later.
      </p>
      <div className="flex gap-3">
        <button
          className="rounded-lg border border-rule-strong bg-paper px-4 py-2 font-mono text-xs uppercase tracking-label"
          onClick={useDefault}
        >
          Use default
        </button>
        <button
          className="rounded-lg bg-sage-deep px-4 py-2 font-mono text-xs uppercase tracking-label text-cream"
          onClick={pick}
        >
          Choose folder…
        </button>
      </div>
      {paths && (
        <div className="mt-2 max-w-lg rounded-lg border border-rule bg-paper p-4 font-mono text-[11px] text-muted">
          <div>Leash: {paths.leashBase}</div>
          <div>per user: {paths.leashBase}/&lt;username&gt;/…</div>
          <div className="mt-1 text-[10px]">Each account gets its own isolated data, database & model cache here.</div>
        </div>
      )}
      <button
        className="rounded-lg bg-sage-deep px-6 py-2 font-mono text-xs uppercase tracking-label text-cream disabled:opacity-40"
        disabled={!base || busy}
        onClick={start}
      >
        {busy ? 'Starting…' : 'Start Leash'}
      </button>
    </div>
  )
}
