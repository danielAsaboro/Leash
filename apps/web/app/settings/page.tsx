/**
 * `/settings` — device & app settings, tabbed (Storage · Devices · Secrets · Permissions · About).
 * Mirrors /brain's ?tab= pattern. Storage is two-column (model cache + app data, with multi-delete);
 * Devices is one mesh-centric "My meshes" card — each mesh expands to its devices + per-mesh
 * "Invite a device" (QR + sync key) and "Pair over LAN" (PIN); Secrets hosts the connector
 * credentials (moved here from Services).
 */
import { DashShell, DashCard } from "../../components/dash.tsx";
import { aboutInfo } from "../../lib/leash/about.ts";
import { storageUsage } from "../../lib/leash/storage.ts";
import { meshStatus } from "../../lib/leash/hypha.ts";
import { listSecretStatus } from "../../lib/leash/vault.ts";
import { TabNav, type TabDef } from "../../components/TabNav.tsx";
import { ModelCacheCard } from "../../components/ModelCacheCard.tsx";
import { AppDataCard } from "../../components/AppDataCard.tsx";
import { PermissionsCard } from "../../components/PermissionsCard.tsx";
import { MeshMembershipsSection } from "../../components/MeshMembershipsSection.tsx";
import { SecretsCard } from "../../components/SecretsCard.tsx";

export const dynamic = "force-dynamic";

const TABS = ["storage", "devices", "secrets", "permissions", "about"] as const;
type Tab = (typeof TABS)[number];

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b py-1.5" style={{ borderColor: "var(--color-rule)" }}>
      <span className="kicker" style={{ color: "var(--color-faint)" }}>{label}</span>
      <span className="mono" style={{ color: "var(--color-ink)" }}>{value}</span>
    </div>
  );
}

async function StorageTab() {
  const usage = await storageUsage();
  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,320px)]">
      <DashCard title="Storage">
        <ModelCacheCard files={usage.modelFiles} totalBytes={usage.modelBytes} />
      </DashCard>
      <DashCard title="App data">
        <AppDataCard data={usage.data} />
      </DashCard>
    </div>
  );
}

async function DevicesTab() {
  const mesh = await meshStatus();
  return (
    <div className="flex flex-col gap-5">
      <DashCard title="My meshes">
        <MeshMembershipsSection meshes={mesh.meshes} forgotten={mesh.forgotten} borrow={mesh.borrow} />
      </DashCard>
    </div>
  );
}

async function AboutTab() {
  const about = await aboutInfo();
  return (
    <div className="grid gap-5" style={{ gridTemplateColumns: "minmax(0, 520px)" }}>
      <DashCard title="About">
        <p style={{ fontFamily: "var(--font-body)", fontStyle: "italic", color: "var(--color-ink-soft)", marginBottom: "0.75rem" }}>{about.tagline}</p>
        <Row label="App" value={about.name} />
        <Row label="Version" value={about.version} />
        <Row label="Developer" value={about.developer} />
        <Row label="License" value={about.license} />
      </DashCard>
    </div>
  );
}

export default async function SettingsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const raw = Array.isArray(params["tab"]) ? params["tab"][0] : params["tab"];
  const tab: Tab = TABS.includes(raw as Tab) ? (raw as Tab) : "storage";
  const tabDefs: TabDef[] = TABS.map((t) => ({ key: t, label: t[0]!.toUpperCase() + t.slice(1), href: t === "storage" ? "/settings" : `/settings?tab=${t}` }));

  return (
    <DashShell kicker="Device & app" title="Settings" lede="What this app stores, the devices it connects to, and what it can access.">
      <TabNav tabs={tabDefs} active={tab} />

      {tab === "storage" && (await StorageTab())}
      {tab === "devices" && (await DevicesTab())}
      {tab === "secrets" && (
        <div className="flex flex-col gap-5">
          <SecretsCard secrets={listSecretStatus()} />
        </div>
      )}
      {tab === "permissions" && (
        <div className="grid gap-5" style={{ gridTemplateColumns: "minmax(0, 520px)" }}>
          <DashCard title="Permissions">
            <PermissionsCard />
          </DashCard>
        </div>
      )}
      {tab === "about" && (await AboutTab())}
    </DashShell>
  );
}
