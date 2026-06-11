/**
 * A pill on/off switch — the house affordance for a boolean that's heavier than a checkbox:
 * starting/stopping a daemon, enabling a connection. Sage track when on, a sliding knob, a
 * `busy` pulse while the change is in flight (the mesh-tools toggle awaits the daemon's
 * health, so the click can take a beat). Shares the IconButton discipline: real ARIA, the
 * human label in `title` + `aria-label`.
 */
export function Switch({ on, busy, disabled, onChange, label }: { on: boolean; busy?: boolean; disabled?: boolean; onChange: () => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      title={label}
      disabled={disabled || busy}
      onClick={onChange}
      className="relative inline-flex h-[20px] w-[34px] shrink-0 items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50"
      style={{ background: on ? "var(--color-sage-deep)" : "var(--color-rule-strong)" }}
    >
      <span
        className="inline-block h-[14px] w-[14px] rounded-full transition-transform"
        style={{ background: "var(--color-cream)", transform: on ? "translateX(17px)" : "translateX(3px)", opacity: busy ? 0.55 : 1 }}
      />
    </button>
  );
}
