import React from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { C, F, TRACKING_LABEL } from "./theme";
import { LeashMark } from "./LeashMark";
import { NAV_ITEMS } from "./NavDrawer";
import { Settings } from "./icons";
import { SETTINGS_TAB, type Route } from "./tabs";

export const TABLET_RAIL_WIDTH = 248;

export function TabletRail({
  route,
  unread = 0,
  onNavigate,
}: {
  route: Route;
  unread?: number;
  onNavigate: (r: Route) => void;
}) {
  return (
    <View style={styles.rail}>
      <View style={styles.header}>
        <View style={styles.markTile}>
          <LeashMark size={25} mark={C.cream} cutout={C.ink} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.wordmark}>Leash</Text>
          <Text style={styles.tagline}>your mind · on your own devices</Text>
        </View>
      </View>
      <View style={styles.ruleStrong} />

      <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.navList}>
        {NAV_ITEMS.map(({ key, label, Icon }) => {
          const active = route === key;
          const badge = key === "alerts" && unread > 0;
          return (
            <Pressable
              key={key}
              onPress={() => onNavigate(key)}
              style={({ pressed }) => [styles.item, active && styles.itemActive, pressed && !active && styles.itemPressed]}
            >
              {active && <View style={styles.activeBar} />}
              <Icon size={21} color={active ? C.sageDeep : C.inkSoft} strokeWidth={1.7} />
              <Text style={[styles.itemLabel, active && styles.itemLabelActive]}>{label}</Text>
              <View style={{ flex: 1 }} />
              {badge ? (
                <View style={styles.badge}>
                  <Text style={styles.badgeText}>{unread > 9 ? "9+" : unread}</Text>
                </View>
              ) : null}
            </Pressable>
          );
        })}
      </ScrollView>

      <View style={styles.rule} />
      <Pressable
        onPress={() => onNavigate(SETTINGS_TAB.key)}
        style={({ pressed }) => [
          styles.item,
          styles.footItem,
          route === "settings" && styles.itemActive,
          pressed && route !== "settings" && styles.itemPressed,
        ]}
      >
        {route === "settings" && <View style={styles.activeBar} />}
        <Settings size={21} color={route === "settings" ? C.sageDeep : C.inkSoft} strokeWidth={1.7} />
        <Text style={[styles.itemLabel, route === "settings" && styles.itemLabelActive]}>{SETTINGS_TAB.label}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  rail: {
    width: TABLET_RAIL_WIDTH,
    backgroundColor: C.cream,
    borderRightWidth: 2,
    borderRightColor: C.ink,
  },
  header: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingTop: 8, paddingBottom: 14 },
  markTile: {
    width: 42,
    height: 42,
    borderRadius: 12,
    backgroundColor: C.ink,
    alignItems: "center",
    justifyContent: "center",
  },
  wordmark: { fontFamily: F.display, fontSize: 25, color: C.ink, lineHeight: 29 },
  tagline: {
    fontFamily: F.mono,
    fontSize: 8,
    color: C.muted,
    letterSpacing: 1.2,
    textTransform: "uppercase",
    marginTop: 1,
  },
  ruleStrong: { height: StyleSheet.hairlineWidth, backgroundColor: C.ink, marginHorizontal: 14 },
  rule: { height: StyleSheet.hairlineWidth, backgroundColor: C.rule, marginHorizontal: 14 },
  navList: { paddingVertical: 10, paddingHorizontal: 10 },
  item: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 13,
    borderRadius: 8,
    overflow: "hidden",
  },
  footItem: { marginHorizontal: 10, marginVertical: 10 },
  itemPressed: { backgroundColor: "rgba(63,125,78,0.10)" },
  itemActive: { backgroundColor: "rgba(63,125,78,0.16)" },
  activeBar: { position: "absolute", left: 0, top: 0, bottom: 0, width: 2, backgroundColor: C.sageDeep },
  itemLabel: {
    fontFamily: F.monoMed,
    fontSize: 11,
    color: C.inkSoft,
    letterSpacing: TRACKING_LABEL,
    textTransform: "uppercase",
  },
  itemLabelActive: { color: C.sageDeep },
  badge: {
    minWidth: 20,
    height: 20,
    borderRadius: 10,
    paddingHorizontal: 6,
    backgroundColor: C.brick,
    alignItems: "center",
    justifyContent: "center",
  },
  badgeText: { fontFamily: F.monoSemi, fontSize: 10, color: C.cream, letterSpacing: 0.3 },
});
