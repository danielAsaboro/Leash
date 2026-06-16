import React, { useCallback, useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { C, F, TRACKING_LABEL } from "./theme";
import { ScreenHeader } from "./ScreenHeader";
import { ago } from "./chats";
import {
  dismiss,
  listNotifications,
  markAllRead,
  markRead,
  snooze,
  type Notification,
  type Tier,
} from "./notifications";

/**
 * ALERTS — a single on-device notifications feed, 1:1 with the desktop /notifications page. The
 * rows are GENUINE on-device events (a model finished downloading, the mesh connected/dropped, a
 * load failed) — never fabricated (Rule 4). Each row shows the unread dot, tier label, why-line, and
 * Mark read / Snooze / Dismiss; the drawer bell badge reads the same unread count via onChanged.
 */
const TIER_META: Record<Tier, { label: string; color: string }> = {
  auto: { label: "AUTO", color: C.faint },
  notify: { label: "NOTIFY", color: C.sageDeep },
  ask: { label: "ASK", color: C.brick },
};

export function AlertsScreen({ onMenu, onChanged }: { onMenu: () => void; onChanged?: () => void }) {
  const [items, setItems] = useState<Notification[]>([]);

  const refresh = useCallback(() => {
    void listNotifications().then(setItems);
    onChanged?.();
  }, [onChanged]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const unread = items.filter((n) => !n.read).length;

  return (
    <View style={{ flex: 1, backgroundColor: C.cream }}>
      <ScreenHeader
        kicker="On this device"
        title="Alerts"
        onMenu={onMenu}
        right={
          unread > 0 ? (
            <Pressable onPress={() => void markAllRead().then(refresh)} hitSlop={8}>
              <Text style={styles.markAll}>MARK ALL READ</Text>
            </Pressable>
          ) : undefined
        }
      />
      <ScrollView contentContainerStyle={styles.body}>
        {items.length === 0 ? (
          <View style={styles.emptyWrap}>
            <Text style={styles.emptyHead}>All quiet.</Text>
            <Text style={styles.emptyLine}>
              Alerts appear here on real on-device events — a model finishing its first download, the
              mesh connecting or dropping, a load failing. Nothing is fabricated.
            </Text>
          </View>
        ) : (
          items.map((n) => {
            const tier = TIER_META[n.tier];
            return (
              <View key={n.id} style={[styles.row, !n.read && styles.rowUnread]}>
                <View style={styles.rowHead}>
                  {!n.read ? <View style={styles.unreadDot} /> : null}
                  <Text style={[styles.tier, { color: tier.color }]}>{tier.label}</Text>
                  <View style={{ flex: 1 }} />
                  <Text style={styles.age}>{ago(n.createdAt)}</Text>
                </View>
                <Text style={styles.title}>{n.title}</Text>
                <Text style={styles.bodyText}>{n.body}</Text>
                {n.why ? <Text style={styles.why}>Why: {n.why}</Text> : null}
                <View style={styles.actions}>
                  {!n.read ? (
                    <Pressable onPress={() => void markRead(n.id).then(refresh)} hitSlop={6}>
                      <Text style={styles.action}>MARK READ</Text>
                    </Pressable>
                  ) : null}
                  <Pressable onPress={() => void snooze(n.id, 60).then(refresh)} hitSlop={6}>
                    <Text style={styles.action}>SNOOZE 1H</Text>
                  </Pressable>
                  <Pressable onPress={() => void dismiss(n.id).then(refresh)} hitSlop={6}>
                    <Text style={[styles.action, { color: C.brick }]}>DISMISS</Text>
                  </Pressable>
                </View>
              </View>
            );
          })
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 40 },
  markAll: { fontFamily: F.monoMed, fontSize: 9.5, color: C.sageDeep, letterSpacing: 1 },
  emptyWrap: { paddingTop: 40 },
  emptyHead: { fontFamily: F.display, fontSize: 30, color: C.ink, letterSpacing: -0.5 },
  emptyLine: { fontFamily: F.body, fontSize: 16, lineHeight: 25, color: C.muted, marginTop: 12, maxWidth: 460 },
  row: {
    paddingVertical: 16,
    paddingHorizontal: 14,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: C.rule,
    backgroundColor: C.paper,
    marginBottom: 10,
  },
  rowUnread: { borderColor: C.ruleStrong, backgroundColor: C.cream },
  rowHead: { flexDirection: "row", alignItems: "center", gap: 7, marginBottom: 7 },
  unreadDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: C.sageDeep },
  tier: { fontFamily: F.monoSemi, fontSize: 9.5, letterSpacing: TRACKING_LABEL },
  age: { fontFamily: F.mono, fontSize: 10, color: C.faint, letterSpacing: 0.4 },
  title: { fontFamily: F.bodySemi, fontSize: 17, color: C.ink, lineHeight: 23 },
  bodyText: { fontFamily: F.body, fontSize: 15, color: C.inkSoft, lineHeight: 22, marginTop: 4 },
  why: { fontFamily: F.bodyItalic, fontSize: 13.5, color: C.muted, lineHeight: 20, marginTop: 6 },
  actions: { flexDirection: "row", gap: 18, marginTop: 14 },
  action: { fontFamily: F.monoMed, fontSize: 10, color: C.sageDeep, letterSpacing: 1 },
});
