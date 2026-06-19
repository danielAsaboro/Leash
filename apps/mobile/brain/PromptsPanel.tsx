import React, { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { C, F, TRACKING_LABEL } from "../theme";
import { getPrompts, isOverridden, PROMPT_META, resetPrompt, setPrompt, type PromptKey } from "../prompts";

/**
 * Brain → Prompts. Edit the Chat prompt + Voice response prompt overrides. Saving writes the override
 * and calls onChanged so App recomposes the live chat system message — so an edit here visibly
 * changes the next reply (the proof these tabs are real, Rule 4). Reset restores the code default.
 */
export function PromptsPanel({ onChanged }: { onChanged: () => void }) {
  const [drafts, setDrafts] = useState<Record<PromptKey, string>>({ chat: "", voice: "" });
  const [overridden, setOverridden] = useState<Record<PromptKey, boolean>>({ chat: false, voice: false });
  const [saved, setSaved] = useState<PromptKey | null>(null);

  const load = async () => {
    const p = await getPrompts();
    setDrafts({ chat: p.chat, voice: p.voice });
    setOverridden({ chat: await isOverridden("chat"), voice: await isOverridden("voice") });
  };
  useEffect(() => {
    void load();
  }, []);

  const save = (key: PromptKey) => {
    void setPrompt(key, drafts[key]).then(async () => {
      await load();
      onChanged();
      setSaved(key);
      setTimeout(() => setSaved((s) => (s === key ? null : s)), 1600);
    });
  };
  const reset = (key: PromptKey) => {
    void resetPrompt(key).then(async () => {
      await load();
      onChanged();
    });
  };

  return (
    <View>
      {PROMPT_META.map((m) => (
        <View key={m.key} style={styles.block}>
          <View style={styles.head}>
            <Text style={styles.label}>{m.label}</Text>
            <View style={{ flex: 1 }} />
            {overridden[m.key] ? <Text style={styles.overTag}>OVERRIDDEN</Text> : <Text style={styles.defTag}>DEFAULT</Text>}
          </View>
          <Text style={styles.hint}>{m.hint}</Text>
          <TextInput
            style={styles.area}
            value={drafts[m.key]}
            onChangeText={(t) => setDrafts((d) => ({ ...d, [m.key]: t }))}
            multiline
            placeholder={m.def}
            placeholderTextColor={C.faint}
          />
          <View style={styles.btnRow}>
            {overridden[m.key] ? (
              <Pressable onPress={() => reset(m.key)} style={({ pressed }) => [styles.ghostBtn, pressed && styles.dim]}>
                <Text style={styles.ghostText}>RESET TO DEFAULT</Text>
              </Pressable>
            ) : null}
            <View style={{ flex: 1 }} />
            <Pressable onPress={() => save(m.key)} style={({ pressed }) => [styles.saveBtn, pressed && styles.dim]}>
              <Text style={styles.saveText}>{saved === m.key ? "SAVED ✓" : "SAVE"}</Text>
            </Pressable>
          </View>
        </View>
      ))}
      <Text style={styles.foot}>
        These are applied live: the Chat prompt (plus your soul, goals, and memories) is composed
        into every chat turn; the Voice response prompt is appended on spoken replies.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  block: { marginBottom: 22 },
  head: { flexDirection: "row", alignItems: "center" },
  label: { fontFamily: F.displaySemi, fontSize: 18, color: C.ink },
  overTag: { fontFamily: F.monoMed, fontSize: 9, color: C.sageDeep, letterSpacing: 1 },
  defTag: { fontFamily: F.monoMed, fontSize: 9, color: C.faint, letterSpacing: 1 },
  hint: { fontFamily: F.body, fontSize: 14, color: C.muted, marginTop: 3, lineHeight: 20 },
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
    paddingTop: 10,
    paddingBottom: 10,
    minHeight: 110,
    marginTop: 10,
    textAlignVertical: "top",
  },
  btnRow: { flexDirection: "row", alignItems: "center", marginTop: 10 },
  ghostBtn: { borderWidth: StyleSheet.hairlineWidth, borderColor: C.ruleStrong, borderRadius: 6, paddingHorizontal: 14, paddingVertical: 9 },
  ghostText: { fontFamily: F.monoSemi, fontSize: 10, color: C.muted, letterSpacing: 0.8 },
  saveBtn: { backgroundColor: C.sageDeep, borderRadius: 6, paddingHorizontal: 20, paddingVertical: 9 },
  saveText: { fontFamily: F.monoSemi, fontSize: 10.5, color: C.cream, letterSpacing: 1 },
  dim: { opacity: 0.6 },
  foot: { fontFamily: F.body, fontSize: 13.5, color: C.muted, lineHeight: 20, marginTop: 4 },
});
