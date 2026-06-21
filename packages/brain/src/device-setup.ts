import type { DeviceModelProfileId } from "./model-profiles.ts";

export type RuntimeSurface = "mobile" | "desktop" | "web";
export type DeviceFormFactor = "phone" | "tablet" | "desktop" | "browser" | "unknown";
export type SetupExecutionTarget = "local" | "paired-hub";
export type DeviceSetupClass = "compact" | "balanced" | "full";

export type DeviceSetupFacts = {
  surface: RuntimeSurface;
  formFactor?: DeviceFormFactor | null;
  totalMemoryBytes?: number | null;
  availableDiskBytes?: number | null;
  deviceYearClass?: number | null;
  supportedCpuArchitectures?: string[] | null;
};

export type DeviceSetupSignal = {
  label: string;
  value: string;
};

export type DeviceSetupDecision = {
  surface: RuntimeSurface;
  profileId: DeviceModelProfileId;
  executionTarget: SetupExecutionTarget;
  setupClass: DeviceSetupClass;
  recommendedChatAlias: string;
  title: string;
  summary: string;
  reasons: string[];
  signals: DeviceSetupSignal[];
};

const GB = 1024 ** 3;

function roundGb(bytes: number | null | undefined): number | null {
  if (!bytes || !Number.isFinite(bytes) || bytes <= 0) return null;
  return Math.round((bytes / GB) * 10) / 10;
}

function titleCase(value: string): string {
  return value
    .split(/[\s-]+/)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

function compactReason(text: string): string {
  return text.endsWith(".") ? text : `${text}.`;
}

function signalsForFacts(facts: DeviceSetupFacts, executionTarget: SetupExecutionTarget): DeviceSetupSignal[] {
  const signals: DeviceSetupSignal[] = [
    { label: "Surface", value: titleCase(facts.surface) },
    { label: "Runtime", value: executionTarget === "local" ? "Runs on this device" : "Uses your paired desktop hub" },
  ];
  if (facts.formFactor && facts.formFactor !== "unknown") signals.push({ label: "Form factor", value: titleCase(facts.formFactor) });
  const memoryGb = roundGb(facts.totalMemoryBytes);
  if (memoryGb != null) signals.push({ label: "Memory", value: `${memoryGb} GB` });
  const storageGb = roundGb(facts.availableDiskBytes);
  if (storageGb != null) signals.push({ label: "Free space", value: `${storageGb} GB` });
  if (facts.deviceYearClass != null) signals.push({ label: "Device class", value: String(facts.deviceYearClass) });
  return signals;
}

function decideMobileSetup(facts: DeviceSetupFacts): Omit<DeviceSetupDecision, "surface" | "signals"> {
  const memoryGb = roundGb(facts.totalMemoryBytes);
  const storageGb = roundGb(facts.availableDiskBytes);
  const formFactor = facts.formFactor ?? "unknown";
  const year = facts.deviceYearClass ?? null;

  const constrained = (memoryGb != null && memoryGb < 4) || (storageGb != null && storageGb < 8) || (year != null && year <= 2020);
  const roomyTablet =
    formFactor === "tablet" &&
    ((memoryGb != null && memoryGb >= 6) || year != null && year >= 2023) &&
    (storageGb == null || storageGb >= 10);
  const roomyPhone = formFactor === "phone" && (memoryGb != null && memoryGb >= 8) && (storageGb == null || storageGb >= 12);

  if (constrained) {
    return {
      profileId: "phone",
      executionTarget: "local",
      setupClass: "compact",
      recommendedChatAlias: "chat-compact",
      title: "Compact local setup",
      summary: "This device should start with the lightest local chat model so setup stays reliable and fast.",
      reasons: [
        compactReason("The device reported a tighter local memory or storage budget"),
        compactReason("The compact setup keeps first-run downloads and live memory pressure under control"),
      ],
    };
  }

  if (roomyTablet || roomyPhone) {
    return {
      profileId: "phone",
      executionTarget: "local",
      setupClass: "full",
      recommendedChatAlias: "chat-large",
      title: "Full local setup",
      summary: "This device has enough local headroom for the stronger on-device chat model, so Leash can start with the best offline experience.",
      reasons: [
        compactReason(formFactor === "tablet" ? "Tablet-class hardware is available for local setup" : "The device reported enough headroom for the strongest mobile local model"),
        compactReason("Memory and free-space signals look strong enough for the 4B local chat model"),
      ],
    };
  }

  return {
    profileId: "phone",
    executionTarget: "local",
    setupClass: "balanced",
    recommendedChatAlias: "chat",
    title: "Balanced local setup",
    summary: "This device should start with the balanced mobile model so chat stays local without overcommitting the first-run footprint.",
    reasons: [
      compactReason("The device has enough headroom for a solid local model"),
      compactReason("The balanced setup preserves offline quality without pushing the hardware too hard"),
    ],
  };
}

export function decideDeviceSetup(facts: DeviceSetupFacts): DeviceSetupDecision {
  if (facts.surface === "desktop") {
    return {
      surface: facts.surface,
      profileId: "desktop",
      executionTarget: "local",
      setupClass: "full",
      recommendedChatAlias: "chat",
      title: "Desktop local setup",
      summary: "Desktop installs should load the full local kit so chat, tools, and heavier workloads stay on the machine.",
      reasons: [
        compactReason("Desktop surfaces are the main local runtime for the full Brain kit"),
        compactReason("The desktop path is where the heavier local models and tools belong"),
      ],
      signals: signalsForFacts(facts, "local"),
    };
  }

  if (facts.surface === "web") {
    return {
      surface: facts.surface,
      profileId: "desktop",
      executionTarget: "paired-hub",
      setupClass: "full",
      recommendedChatAlias: "chat",
      title: "Paired desktop setup",
      summary: "The browser should use the full desktop kit, but the runtime belongs on the paired machine rather than inside the tab.",
      reasons: [
        compactReason("The browser surface is a control plane, not the primary local runtime"),
        compactReason("Web should target the desktop hub profile for heavier chat and tool workloads"),
      ],
      signals: signalsForFacts(facts, "paired-hub"),
    };
  }

  const mobile = decideMobileSetup(facts);
  return {
    surface: facts.surface,
    ...mobile,
    signals: signalsForFacts(facts, mobile.executionTarget),
  };
}
