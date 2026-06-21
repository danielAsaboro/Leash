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
import { AgentsPanel } from "./brain/AgentsPanel";
import { SkillsPanel } from "./brain/SkillsPanel";
import { PluginsPanel } from "./brain/PluginsPanel";
import { ToolsPanel } from "./brain/ToolsPanel";
import { McpPanel } from "./brain/McpPanel";
import { BRAIN_TABS, type BrainTab } from "./tabSets";
import { SCREEN_COPY } from "./screenCopy";

/**
 * BRAIN — the phone's real local capability runtime controls. Skills, agents, tools, plugins, and
 * mobile-safe MCP now reflect the on-device stores and runtime inventory directly. Growth and Forage
 * remain honest desktop-only notes.
 */
const DESKTOP_COPY: Partial<Record<BrainTab, { title: string; line: string }>> = {
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
  const [tab, setTab] = useState<BrainTab>("memory");
  const desktop = DESKTOP_COPY[tab];

  return (
    <View style={{ flex: 1, backgroundColor: C.cream }}>
      <ScreenHeader kicker={SCREEN_COPY.brain.kicker} title={SCREEN_COPY.brain.title} onMenu={onMenu} />
      <TabBar tabs={BRAIN_TABS} active={tab} onChange={setTab} />
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        {tab === "memory" ? (
          <MemoryPanel onChanged={onChanged} onPair={onPair} />
        ) : tab === "skills" ? (
          <SkillsPanel />
        ) : tab === "plugins" ? (
          <PluginsPanel />
        ) : tab === "agents" ? (
          <AgentsPanel />
        ) : tab === "tools" ? (
          <ToolsPanel />
        ) : tab === "mcp" ? (
          <McpPanel />
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
