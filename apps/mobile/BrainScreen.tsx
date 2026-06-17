import React, { useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { C } from "./theme";
import { ScreenHeader } from "./ScreenHeader";
import { TabBar } from "./TabBar";
import { DesktopNote } from "./DesktopNote";
import { Brain } from "./icons";
import { MemoryPanel } from "./brain/MemoryPanel";
import { PromptsPanel } from "./brain/PromptsPanel";
import { ModelsPanel } from "./brain/ModelsPanel";
import { ProactivityPanel } from "./brain/ProactivityPanel";

/**
 * BRAIN — 1:1 with the desktop /brain tab set (9 tabs, same order): Memory · Skills · Tools · MCP ·
 * Prompts · Models · Growth · Forage · Proactivity. Memory, Prompts, Models, and Proactivity are
 * real on-device features (and Memory/Prompts/Proactivity edits feed the live chat via onChanged).
 * Skills / Tools / MCP / Growth / Forage need a tool-execution / LoRA / MCP runtime the phone
 * doesn't have, so they show the honest DesktopNote (Rule 4).
 */
type Tab = "memory" | "skills" | "tools" | "mcp" | "prompts" | "models" | "growth" | "forage" | "proactivity";
const TABS: { key: Tab; label: string }[] = [
  { key: "memory", label: "Memory" },
  { key: "skills", label: "Skills" },
  { key: "tools", label: "Tools" },
  { key: "mcp", label: "MCP" },
  { key: "prompts", label: "Prompts" },
  { key: "models", label: "Models" },
  { key: "growth", label: "Growth" },
  { key: "forage", label: "Forage" },
  { key: "proactivity", label: "Proactivity" },
];

const DESKTOP_COPY: Partial<Record<Tab, { title: string; line: string }>> = {
  skills: {
    title: "Skills run on your desktop.",
    line: "Skills are runnable procedures your desktop Leash executes with its tools. The phone has no tool-execution runtime — pair a device to browse and run them.",
  },
  tools: {
    title: "Tools run on your desktop.",
    line: "Tool calling (filesystem, shell, connectors) is wired into the desktop Leash agent loop. Pair a device to manage and grant tools.",
  },
  mcp: {
    title: "MCP runs on your desktop.",
    line: "MCP servers are connected and brokered by your desktop Leash. The phone has no MCP host — pair a device to configure servers.",
  },
  growth: {
    title: "Growth runs on your desktop.",
    line: "Growth — LoRA fine-tunes via QVAC Fabric — trains on your desktop Leash. Pair a device to review and apply adapters.",
  },
  forage: {
    title: "Forage runs on your desktop.",
    line: "Forage — autonomous research that gathers and distills sources — runs on your desktop Leash. Pair a device to launch and read forages.",
  },
};

export function BrainScreen({ onMenu, onChanged, onPair, selectChatModel, chatKey }: { onMenu: () => void; onChanged: () => void; onPair: () => void; selectChatModel: (key: string, onProgress?: (pct: number) => void) => Promise<void>; chatKey: string }) {
  const [tab, setTab] = useState<Tab>("memory");
  const desktop = DESKTOP_COPY[tab];

  return (
    <View style={{ flex: 1, backgroundColor: C.cream }}>
      <ScreenHeader kicker="On this device" title="Brain" onMenu={onMenu} />
      <TabBar tabs={TABS} active={tab} onChange={setTab} />
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        {tab === "memory" ? (
          <MemoryPanel onChanged={onChanged} onPair={onPair} />
        ) : tab === "prompts" ? (
          <PromptsPanel onChanged={onChanged} />
        ) : tab === "models" ? (
          <ModelsPanel selectChatModel={selectChatModel} currentChatKey={chatKey} />
        ) : tab === "proactivity" ? (
          <ProactivityPanel onChanged={onChanged} onPair={onPair} />
        ) : desktop ? (
          <DesktopNote Icon={Brain} title={desktop.title} line={desktop.line} onPair={onPair} />
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 48 },
});
