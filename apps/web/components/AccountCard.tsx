"use client";

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b py-1.5" style={{ borderColor: "var(--color-rule)" }}>
      <span className="kicker" style={{ color: "var(--color-faint)" }}>{label}</span>
      <span className="mono" style={{ color: "var(--color-ink)" }}>{value}</span>
    </div>
  );
}

export function AccountCard({
  label,
  userId,
  source,
  completedAt,
}: {
  label: string;
  userId: string;
  source: string;
  completedAt: string;
}) {
  return (
    <div>
      <span className="kicker kicker-sage">This device</span>
      <Row label="Identity" value={label} />
      <Row label="Scope ID" value={userId} />
      <Row label="Provisioned by" value={source} />
      <Row label="Ready since" value={completedAt} />

      <div className="mt-5 border-t pt-4" style={{ borderColor: "var(--color-rule)" }}>
        <span className="kicker" style={{ color: "var(--color-faint)" }}>Access model</span>
        <p className="mt-2" style={{ color: "var(--color-ink-soft)" }}>
          Leash now treats this installation as a single local device identity. There is no password,
          account switcher, or separate sign-in screen on this device.
        </p>
      </div>

      <div className="mt-5 border-t pt-4" style={{ borderColor: "var(--color-rule)" }}>
        <span className="kicker" style={{ color: "var(--color-faint)" }}>Reset</span>
        <p className="mt-2" style={{ color: "var(--color-ink-soft)" }}>
          To return this installation to first-run onboarding, use Storage → Danger zone → factory reset.
        </p>
      </div>
    </div>
  );
}
