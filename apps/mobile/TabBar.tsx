import React from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { C, F } from "./theme";

/**
 * Horizontal scrollable segmented tab bar — extracted from the pattern inline in SettingsScreen so
 * Brain / Tasks / Settings (and the Economy/Services section headers) all read identically: a
 * sage-tint active pill with a sage-deep label, ported from the web's `.is-active` tab styling.
 */
export type TabItem<K extends string = string> = { key: K; label: string };

export function TabBar<K extends string>({
  tabs,
  active,
  onChange,
}: {
  tabs: TabItem<K>[];
  active: K;
  onChange: (key: K) => void;
}) {
  return (
    <View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.bar}
        keyboardShouldPersistTaps="handled"
      >
        {tabs.map((t) => {
          const on = t.key === active;
          return (
            <Pressable key={t.key} onPress={() => onChange(t.key)} style={[styles.tab, on && styles.tabActive]}>
              <Text style={[styles.tabText, on && styles.tabTextActive]}>{t.label}</Text>
            </Pressable>
          );
        })}
      </ScrollView>
      <View style={styles.rule} />
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: "row", gap: 6, paddingHorizontal: 20, paddingVertical: 2 },
  tab: { paddingVertical: 8, paddingHorizontal: 12, borderRadius: 6 },
  tabActive: { backgroundColor: "rgba(63,125,78,0.16)" },
  tabText: { fontFamily: F.monoMed, fontSize: 10.5, color: C.muted, letterSpacing: 0.8, textTransform: "uppercase" },
  tabTextActive: { color: C.sageDeep },
  rule: { height: StyleSheet.hairlineWidth, backgroundColor: C.rule, marginTop: 4 },
});
