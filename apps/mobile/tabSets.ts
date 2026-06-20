export type BrainTab = "memory" | "skills" | "plugins" | "agents" | "mcp" | "prompts" | "models" | "growth" | "forage" | "proactivity";
export type SettingsTab = "account" | "storage" | "devices" | "secrets" | "permissions" | "about";
export type ActivityTab = "mine" | "newsroom" | "runs";

export const BRAIN_TABS: { key: BrainTab; label: string }[] = [
  { key: "memory", label: "Memory" },
  { key: "skills", label: "Skills" },
  { key: "plugins", label: "Plugins" },
  { key: "agents", label: "Agents" },
  { key: "mcp", label: "MCP" },
  { key: "prompts", label: "Prompts" },
  { key: "models", label: "Models" },
  { key: "growth", label: "Growth" },
  { key: "forage", label: "Forage" },
  { key: "proactivity", label: "Proactivity" },
];

export const SETTINGS_TABS: { key: SettingsTab; label: string }[] = [
  { key: "account", label: "Account" },
  { key: "storage", label: "Storage" },
  { key: "devices", label: "Devices" },
  { key: "secrets", label: "Secrets" },
  { key: "permissions", label: "Permissions" },
  { key: "about", label: "About" },
];

export const ACTIVITY_TABS: { key: ActivityTab; label: string }[] = [
  { key: "mine", label: "TODOs" },
  { key: "newsroom", label: "Newsroom" },
  { key: "runs", label: "Runs" },
];
