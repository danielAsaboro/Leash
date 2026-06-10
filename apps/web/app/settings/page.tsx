/**
 * `/settings` — device & app settings. About (version · developer · license), and — added in the
 * Storage and Permissions features — what this device stores and what the browser can access.
 */
import { DashShell, DashCard } from "../../components/dash.tsx";
import { aboutInfo } from "../../lib/leash/about.ts";
import { storageUsage } from "../../lib/leash/storage.ts";
import { StorageCard } from "../../components/StorageCard.tsx";
import { PermissionsCard } from "../../components/PermissionsCard.tsx";

export const dynamic = "force-dynamic";

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b py-1.5" style={{ borderColor: "var(--color-rule)" }}>
      <span className="kicker" style={{ color: "var(--color-faint)" }}>{label}</span>
      <span className="mono" style={{ color: "var(--color-ink)" }}>{value}</span>
    </div>
  );
}

export default async function SettingsPage() {
  const [about, usage] = await Promise.all([aboutInfo(), storageUsage()]);
  return (
    <DashShell kicker="Device & app" title="Settings" lede="What this app is, what it stores, and what it can access.">
      <div className="grid gap-5" style={{ gridTemplateColumns: "minmax(0, 520px)" }}>
        <DashCard title="About">
          <p style={{ fontFamily: "var(--font-body)", fontStyle: "italic", color: "var(--color-ink-soft)", marginBottom: "0.75rem" }}>
            {about.tagline}
          </p>
          <Row label="App" value={about.name} />
          <Row label="Version" value={about.version} />
          <Row label="Developer" value={about.developer} />
          <Row label="License" value={about.license} />
        </DashCard>
        <DashCard title="Storage">
          <StorageCard usage={usage} />
        </DashCard>
        <DashCard title="Permissions">
          <PermissionsCard />
        </DashCard>
      </div>
    </DashShell>
  );
}
