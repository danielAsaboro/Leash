import React from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { C, F } from "./theme";
import { ScreenHeader } from "./ScreenHeader";
import { Card } from "./Card";
import { DesktopNote } from "./DesktopNote";
import { Services } from "./icons";
import { ModelsPanel } from "./brain/ModelsPanel";

/**
 * SERVICES — 1:1 with the desktop /services daemon cards. The phone's genuine analog of "Model
 * Serve" is its on-device runtime (the loaded chat/STT/TTS models + load/unload), shown as a real
 * card reusing the Models inventory. The rest — Newsroom · Watcher · Scheduler · Hypha · Schedules —
 * are host daemons with no on-device backing, so they're honest DesktopNote cards (Rule 4).
 */
const DESKTOP_SERVICES: { title: string; line: string }[] = [
  { title: "Newsroom", line: "The newsroom daemon builds your feed from sources on a schedule — it runs on your desktop Leash." },
  { title: "Screen watcher", line: "The watcher turns what you read into memories. It's a desktop host process." },
  { title: "Scheduler (cron)", line: "mcp-cron schedules and fires recurring jobs on your desktop Leash." },
  { title: "Hypha", line: "The hypha daemon advertises this node on the mesh and brokers delegated compute from the desktop." },
  { title: "Schedules", line: "Saved cron schedules — name, command, next/last run — are managed by the desktop scheduler." },
];

export function ServicesScreen({ onMenu, onPair }: { onMenu: () => void; onPair: () => void }) {
  return (
    <View style={{ flex: 1, backgroundColor: C.cream }}>
      <ScreenHeader kicker="On this device" title="Services" onMenu={onMenu} />
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        <Card title="Model runtime">
          <Text style={styles.cardNote}>The phone's on-device serve — the models it runs, with live state.</Text>
          <ModelsPanel />
        </Card>

        <Text style={styles.sectionLabel}>DESKTOP DAEMONS</Text>
        {DESKTOP_SERVICES.map((s, i) => (
          <View key={s.title} style={i === 0 ? undefined : { marginTop: 12 }}>
            <DesktopNote Icon={Services} title={s.title} line={s.line} onPair={i === 0 ? onPair : undefined} compact />
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 40 },
  cardNote: { fontFamily: F.body, fontSize: 13.5, color: C.muted, lineHeight: 20, marginBottom: 4 },
  sectionLabel: { fontFamily: F.monoMed, fontSize: 10, color: C.muted, letterSpacing: 2.4, marginTop: 18, marginBottom: 12 },
});
