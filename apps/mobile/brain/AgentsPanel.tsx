import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { C, F } from "../theme";
import { DesktopNote } from "../DesktopNote";
import { Brain } from "../icons";
import { AGENTS } from "../agents";

/**
 * Brain → Agents — the agent roster, matching the desktop's Agents tab. Leash (the main
 * orchestrator) runs on THIS device; the specialists are the experts it delegates to, but their
 * tools (web, files, code) live on a paired desktop — so on the phone this is the roster VIEW, not a
 * run/edit surface (Rule 4: honest about where each part runs). There is no agent picker by design —
 * Leash does the orchestration; the user only chooses the model (Brain → Models).
 */
export function AgentsPanel({ onPair }: { onPair: () => void }) {
  const main = AGENTS.find((a) => a.main)!;
  const specialists = AGENTS.filter((a) => !a.main);
  return (
    <View>
      <View style={styles.mainCard}>
        <Text style={styles.kicker}>MAIN ORCHESTRATOR · ON THIS DEVICE</Text>
        <Text style={styles.name}>{main.name}</Text>
        <Text style={styles.desc}>{main.description}</Text>
      </View>

      <Text style={styles.sectionKicker}>SPECIALISTS</Text>
      {specialists.map((a) => (
        <View key={a.name} style={styles.row}>
          <View style={styles.rowTop}>
            <Text style={styles.name}>{a.name}</Text>
            <Text style={styles.role}>{a.role}</Text>
          </View>
          <Text style={styles.desc}>{a.description}</Text>
        </View>
      ))}

      <View style={{ marginTop: 18 }}>
        <DesktopNote
          Icon={Brain}
          title="Specialists run on your desktop."
          line="Leash orchestrates on this device and delegates to a specialist when a request is outside its strength. The specialists use tools — web, files, code — that live on your desktop Leash. Pair a device to put them to work."
          onPair={onPair}
          compact
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  mainCard: {
    paddingVertical: 16,
    paddingHorizontal: 16,
    backgroundColor: C.paper,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: C.rule,
    borderRadius: 12,
    marginBottom: 20,
  },
  kicker: { fontFamily: F.monoSemi, fontSize: 9.5, color: C.sageDeep, letterSpacing: 1, marginBottom: 6 },
  sectionKicker: { fontFamily: F.monoSemi, fontSize: 9.5, color: C.muted, letterSpacing: 1, marginBottom: 4 },
  row: { paddingVertical: 16, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.rule },
  rowTop: { flexDirection: "row", alignItems: "baseline", gap: 10 },
  name: { fontFamily: F.bodySemi, fontSize: 17, color: C.ink },
  role: { fontFamily: F.mono, fontSize: 11, color: C.muted, letterSpacing: 0.3 },
  desc: { fontFamily: F.body, fontSize: 14, color: C.muted, lineHeight: 20, marginTop: 5 },
});
