import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { C, F, TRACKING_LABEL } from "./theme";

/**
 * Card / Row / Stat / StateBadge — the mobile port of the web's dash.tsx primitives, used across
 * Home / Services / Economy. A Card is a bordered section with a mono kicker title + optional
 * right-side action; Row is a label↔value line; Stat is a big-number block; StateBadge is a
 * colored dot + label (green ok / red down / grey unknown), exactly like the web StateBadge.
 */

export function Card({
  title,
  action,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.card}>
      <View style={styles.cardHead}>
        <Text style={styles.cardTitle}>{title}</Text>
        <View style={{ flex: 1 }} />
        {action}
      </View>
      {children}
    </View>
  );
}

export function Row({ label, value, mono = true }: { label: string; value: string; mono?: boolean }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={[styles.rowValue, !mono && styles.rowValueProse]} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

export function Stat({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <View style={styles.stat}>
      <Text style={[styles.statValue, accent ? { color: accent } : null]}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

/** ok=true → sage dot, ok=false → brick dot, ok=null → grey dot. */
export function StateBadge({ ok, label }: { ok: boolean | null; label: string }) {
  const color = ok === true ? C.sage : ok === false ? C.brick : C.faint;
  return (
    <View style={styles.badge}>
      <View style={[styles.badgeDot, { backgroundColor: color }]} />
      <Text style={[styles.badgeText, { color }]}>{label}</Text>
    </View>
  );
}

export function CardAction({ label, onPress, danger }: { label: string; onPress: () => void; danger?: boolean }) {
  return (
    <Pressable onPress={onPress} hitSlop={6}>
      <Text style={[styles.cardActionText, danger && { color: C.brick }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: C.paper,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: C.rule,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 6,
    marginBottom: 14,
  },
  cardHead: { flexDirection: "row", alignItems: "center", marginBottom: 6 },
  cardTitle: { fontFamily: F.monoSemi, fontSize: 10.5, color: C.sageDeep, letterSpacing: TRACKING_LABEL, textTransform: "uppercase" },
  cardActionText: { fontFamily: F.monoMed, fontSize: 10, color: C.sageDeep, letterSpacing: 1 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    paddingVertical: 11,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: C.rule,
  },
  rowLabel: { fontFamily: F.bodyMed, fontSize: 15, color: C.inkSoft },
  rowValue: { fontFamily: F.mono, fontSize: 12.5, color: C.ink, letterSpacing: 0.3, flexShrink: 1, textAlign: "right" },
  rowValueProse: { fontFamily: F.bodyMed, fontSize: 15 },
  stat: { paddingVertical: 8, paddingRight: 24 },
  statValue: { fontFamily: F.display, fontSize: 28, color: C.ink, letterSpacing: -0.5 },
  statLabel: { fontFamily: F.monoMed, fontSize: 9.5, color: C.muted, letterSpacing: TRACKING_LABEL, textTransform: "uppercase", marginTop: 2 },
  badge: { flexDirection: "row", alignItems: "center", gap: 6 },
  badgeDot: { width: 7, height: 7, borderRadius: 4 },
  badgeText: { fontFamily: F.monoMed, fontSize: 10, letterSpacing: 1 },
});
