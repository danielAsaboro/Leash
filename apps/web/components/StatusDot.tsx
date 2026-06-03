/** A status dot + label. Green pulse when RUNNING. */
const TONE: Record<string, string> = {
  RUNNING: "var(--color-sage)",
  IDLE: "var(--color-faint)",
  STOPPED: "var(--color-brick)",
};

export function StatusDot({ status, label, dark = false }: { status: string; label?: string; dark?: boolean }) {
  const color = TONE[status] ?? "var(--color-faint)";
  const running = status === "RUNNING";
  return (
    <span className="inline-flex items-center gap-2">
      <span className="relative inline-flex" style={{ width: 9, height: 9 }}>
        {running && (
          <span
            className="absolute inline-flex h-full w-full rounded-full opacity-60"
            style={{ background: color, animation: "ping 1.8s cubic-bezier(0,0,0.2,1) infinite" }}
          />
        )}
        <span className="relative inline-flex rounded-full" style={{ width: 9, height: 9, background: color }} />
      </span>
      <span
        className="kicker"
        style={dark ? { color: "var(--color-glow)", letterSpacing: "0.2em" } : undefined}
      >
        {label ?? status}
      </span>
      <style>{`@keyframes ping{75%,100%{transform:scale(2.2);opacity:0}}`}</style>
    </span>
  );
}
