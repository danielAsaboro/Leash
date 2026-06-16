import React, { useEffect, useRef, useState } from "react";
import { Animated, Modal, Pressable, SafeAreaView, ScrollView, StyleSheet, Text, View } from "react-native";
import { C, F, TRACKING_LABEL } from "./theme";
import { LeashMark } from "./LeashMark";
import {
  Bell,
  Brain,
  ChatBubble,
  Database,
  Home,
  ListChecks,
  MeshNodes,
  Newspaper,
  Services,
  Settings,
} from "./icons";

/**
 * The mobile left-rail — a slide-in dashboard drawer porting apps/web's LeashRail. Full web
 * parity: HOME · CHAT · FEED · BRAIN · TASKS · ALERTS · ECONOMY · MESH · SERVICES, with a
 * settings gear pinned at the foot. The active row highlights in sage (color: sage-deep +
 * sage 16% tint + a 2px inset left border), exactly like `.leash-rail-item.is-active`.
 *
 * Slides over a transparent Modal; the panel translateX (-PANEL_W → 0) and the backdrop
 * opacity animate manually via the built-in Animated API (react-native-reanimated is not
 * installed) on the native driver.
 */

export type Route =
  | "home"
  | "chat"
  | "mesh"
  | "settings"
  | "feed"
  | "brain"
  | "tasks"
  | "alerts"
  | "economy"
  | "services";

type IconCmp = (p: { size?: number; color?: string; strokeWidth?: number }) => React.JSX.Element;

/**
 * Every section now has a real (or honest-inline) on-device screen, so the old "DESKTOP" tag is
 * gone — only FEED remains a pure desktop stand-in, kept low-key without a tag. The ALERTS row
 * carries an unread-count bell badge.
 */
const ITEMS: { key: Route; label: string; Icon: IconCmp }[] = [
  { key: "home", label: "Home", Icon: Home },
  { key: "chat", label: "Chat", Icon: ChatBubble },
  { key: "feed", label: "Feed", Icon: Newspaper },
  { key: "brain", label: "Brain", Icon: Brain },
  { key: "tasks", label: "Tasks", Icon: ListChecks },
  { key: "alerts", label: "Alerts", Icon: Bell },
  { key: "economy", label: "Economy", Icon: Database },
  { key: "mesh", label: "Mesh", Icon: MeshNodes },
  { key: "services", label: "Services", Icon: Services },
];

const PANEL_W = 300;

export function NavDrawer({
  visible,
  route,
  unread = 0,
  onNavigate,
  onClose,
}: {
  visible: boolean;
  route: Route;
  unread?: number;
  onNavigate: (r: Route) => void;
  onClose: () => void;
}) {
  const tx = useRef(new Animated.Value(-PANEL_W)).current;
  const fade = useRef(new Animated.Value(0)).current;
  // Keep the Modal mounted through the slide-out so the exit animation plays before unmount.
  const [mounted, setMounted] = useState(visible);

  useEffect(() => {
    if (visible) {
      setMounted(true);
      Animated.parallel([
        Animated.timing(tx, { toValue: 0, duration: 220, useNativeDriver: true }),
        Animated.timing(fade, { toValue: 1, duration: 220, useNativeDriver: true }),
      ]).start();
    } else {
      Animated.parallel([
        Animated.timing(tx, { toValue: -PANEL_W, duration: 190, useNativeDriver: true }),
        Animated.timing(fade, { toValue: 0, duration: 190, useNativeDriver: true }),
      ]).start(({ finished }) => {
        if (finished) setMounted(false);
      });
    }
  }, [visible, tx, fade]);

  if (!mounted) return null;

  const Row = ({ key, label, Icon }: (typeof ITEMS)[number]) => {
    const active = route === key;
    const badge = key === "alerts" && unread > 0;
    return (
      <Pressable
        key={key}
        onPress={() => {
          onNavigate(key);
          onClose();
        }}
        style={({ pressed }) => [styles.item, active && styles.itemActive, pressed && !active && styles.itemPressed]}
      >
        {active && <View style={styles.activeBar} />}
        <Icon size={22} color={active ? C.sageDeep : C.inkSoft} strokeWidth={1.7} />
        <Text style={[styles.itemLabel, active && styles.itemLabelActive]}>{label}</Text>
        <View style={{ flex: 1 }} />
        {badge ? (
          <View style={styles.badge}>
            <Text style={styles.badgeText}>{unread > 9 ? "9+" : unread}</Text>
          </View>
        ) : null}
      </Pressable>
    );
  };

  return (
    <Modal visible transparent animationType="none" onRequestClose={onClose}>
      <View style={styles.root}>
        <Animated.View style={[styles.backdrop, { opacity: fade }]}>
          <Pressable style={{ flex: 1 }} onPress={onClose} />
        </Animated.View>
        <Animated.View style={[styles.panel, { transform: [{ translateX: tx }] }]}>
          <SafeAreaView style={{ flex: 1 }}>
            <View style={styles.header}>
              <View style={styles.markTile}>
                <LeashMark size={26} mark={C.cream} cutout={C.ink} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.wordmark}>Leash</Text>
                <Text style={styles.tagline}>your mind · on your own devices</Text>
              </View>
            </View>
            <View style={styles.ruleStrong} />

            <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.navList}>
              {ITEMS.map((it) => Row(it))}
            </ScrollView>

            <View style={styles.rule} />
            {(() => {
              const active = route === "settings";
              return (
                <Pressable
                  onPress={() => {
                    onNavigate("settings");
                    onClose();
                  }}
                  style={({ pressed }) => [
                    styles.item,
                    styles.footItem,
                    active && styles.itemActive,
                    pressed && !active && styles.itemPressed,
                  ]}
                >
                  {active && <View style={styles.activeBar} />}
                  <Settings size={22} color={active ? C.sageDeep : C.inkSoft} strokeWidth={1.7} />
                  <Text style={[styles.itemLabel, active && styles.itemLabelActive]}>Settings</Text>
                </Pressable>
              );
            })()}
          </SafeAreaView>
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, flexDirection: "row" },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(25,23,18,0.45)" },
  panel: {
    width: PANEL_W,
    backgroundColor: C.cream,
    borderRightWidth: 2,
    borderRightColor: C.ink,
  },
  header: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 18, paddingTop: 8, paddingBottom: 14 },
  markTile: {
    width: 44,
    height: 44,
    borderRadius: 12,
    backgroundColor: C.ink,
    alignItems: "center",
    justifyContent: "center",
  },
  wordmark: { fontFamily: F.display, fontSize: 26, color: C.ink, letterSpacing: -0.5, lineHeight: 30 },
  tagline: {
    fontFamily: F.mono,
    fontSize: 8.5,
    color: C.muted,
    letterSpacing: 1.3,
    textTransform: "uppercase",
    marginTop: 1,
  },
  ruleStrong: { height: StyleSheet.hairlineWidth, backgroundColor: C.ink, marginHorizontal: 14 },
  rule: { height: StyleSheet.hairlineWidth, backgroundColor: C.rule, marginHorizontal: 14 },
  navList: { paddingVertical: 10, paddingHorizontal: 10 },
  item: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    paddingVertical: 13,
    paddingHorizontal: 14,
    borderRadius: 8,
    overflow: "hidden",
  },
  footItem: { marginHorizontal: 10, marginVertical: 10 },
  itemPressed: { backgroundColor: "rgba(63,125,78,0.10)" },
  itemActive: { backgroundColor: "rgba(63,125,78,0.16)" },
  activeBar: { position: "absolute", left: 0, top: 0, bottom: 0, width: 2, backgroundColor: C.sageDeep },
  itemLabel: {
    fontFamily: F.monoMed,
    fontSize: 12,
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
