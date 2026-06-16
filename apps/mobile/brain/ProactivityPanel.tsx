import React, { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { C, F } from "../theme";
import { DesktopNote } from "../DesktopNote";
import { Services } from "../icons";
import { FIELD_META, getConstitution, setConstitution, type Constitution, type ConstitutionField } from "../constitution";

/**
 * Brain → Proactivity. Soul / Goals / Heartbeat editors. Soul + Goals are composed into the chat
 * system prompt (onChanged → App recomposes), so they genuinely steer Leash. The heartbeat text is
 * the user's authored intent; the background loop that runs it each beat lives on the desktop Leash
 * (stated honestly), so this panel ends with a DesktopNote about the loop.
 */
export function ProactivityPanel({ onChanged, onPair }: { onChanged: () => void; onPair: () => void }) {
  const [c, setC] = useState<Constitution>({ soul: "", goals: "", heartbeat: "" });
  const [saved, setSaved] = useState<ConstitutionField | null>(null);

  useEffect(() => {
    void getConstitution().then(setC);
  }, []);

  const save = (field: ConstitutionField) => {
    void setConstitution(field, c[field]).then(() => {
      // soul + goals feed the system prompt; refresh App's composed prompt.
      if (field !== "heartbeat") onChanged();
      setSaved(field);
      setTimeout(() => setSaved((s) => (s === field ? null : s)), 1600);
    });
  };

  return (
    <View>
      {FIELD_META.map((m) => (
        <View key={m.key} style={styles.block}>
          <Text style={styles.label}>{m.label}</Text>
          <Text style={styles.blurb}>{m.blurb}</Text>
          <TextInput
            style={[styles.area, { minHeight: m.rows * 20 }]}
            value={c[m.key]}
            onChangeText={(t) => setC((prev) => ({ ...prev, [m.key]: t }))}
            multiline
            textAlignVertical="top"
          />
          <View style={styles.btnRow}>
            <Pressable onPress={() => save(m.key)} style={({ pressed }) => [styles.saveBtn, pressed && styles.dim]}>
              <Text style={styles.saveText}>{saved === m.key ? "SAVED ✓" : "SAVE"}</Text>
            </Pressable>
          </View>
        </View>
      ))}
      <DesktopNote
        Icon={Services}
        title="The heartbeat loop runs on desktop."
        line="Your soul and goals steer every chat here. The background loop that acts on the heartbeat each beat (proactive nudges, scheduled checks) runs on your desktop Leash. Pair a device to run it."
        onPair={onPair}
        compact
      />
    </View>
  );
}

const styles = StyleSheet.create({
  block: { marginBottom: 22 },
  label: { fontFamily: F.displaySemi, fontSize: 18, color: C.ink },
  blurb: { fontFamily: F.body, fontSize: 14, color: C.muted, marginTop: 3, lineHeight: 20 },
  area: {
    fontFamily: F.body,
    fontSize: 15.5,
    color: C.ink,
    lineHeight: 23,
    backgroundColor: C.paper,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: C.ruleStrong,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginTop: 10,
  },
  btnRow: { flexDirection: "row", justifyContent: "flex-end", marginTop: 10 },
  saveBtn: { backgroundColor: C.sageDeep, borderRadius: 6, paddingHorizontal: 20, paddingVertical: 9 },
  saveText: { fontFamily: F.monoSemi, fontSize: 10.5, color: C.cream, letterSpacing: 1 },
  dim: { opacity: 0.6 },
});
