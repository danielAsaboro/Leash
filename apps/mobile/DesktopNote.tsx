import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { C, F, TRACKING_LABEL } from "./theme";

/**
 * The honest inline "this lives on your desktop Leash" block (Rule 4 — no fake rows). Embeddable
 * inside a tab OR used full-bleed as a whole screen. It states plainly where the real feature runs
 * (a Prisma DB, the newsroom/hypha/cron daemons, host process control, or a chain RPC — none of
 * which run standalone on a phone) and points the user at MESH to pair a device.
 */
type IconCmp = (p: { size?: number; color?: string; strokeWidth?: number }) => React.JSX.Element;

export function DesktopNote({
  Icon,
  title,
  line,
  onPair,
  compact,
}: {
  Icon: IconCmp;
  title: string;
  line: string;
  onPair?: () => void;
  /** compact = embedded in a tab/card (smaller, left-aligned); default = roomy section. */
  compact?: boolean;
}) {
  return (
    <View style={[styles.wrap, compact && styles.wrapCompact]}>
      <View style={[styles.iconTile, compact && styles.iconTileCompact]}>
        <Icon size={compact ? 26 : 40} color={C.sageDeep} strokeWidth={1.7} />
      </View>
      <Text style={styles.kicker}>RUNS ON YOUR DESKTOP</Text>
      <Text style={[styles.head, compact && styles.headCompact]}>{title}</Text>
      <Text style={styles.line}>{line}</Text>
      {onPair ? (
        <Pressable onPress={onPair} style={({ pressed }) => [styles.btn, pressed && styles.btnPressed]}>
          <Text style={styles.btnText}>PAIR A DEVICE  ›</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingTop: 8, alignItems: "flex-start" },
  wrapCompact: {
    paddingVertical: 18,
    paddingHorizontal: 16,
    backgroundColor: C.paper,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: C.rule,
    borderRadius: 12,
  },
  iconTile: {
    width: 76,
    height: 76,
    borderRadius: 18,
    backgroundColor: C.paper,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: C.rule,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 22,
  },
  iconTileCompact: { width: 48, height: 48, borderRadius: 12, marginBottom: 14, backgroundColor: C.cream },
  kicker: { fontFamily: F.monoMed, fontSize: 10, color: C.sageDeep, letterSpacing: TRACKING_LABEL, marginBottom: 10 },
  head: { fontFamily: F.display, fontSize: 30, color: C.ink, lineHeight: 34, letterSpacing: -0.5 },
  headCompact: { fontSize: 21, lineHeight: 25 },
  line: { fontFamily: F.body, fontSize: 16, lineHeight: 25, color: C.inkSoft, marginTop: 12, maxWidth: 460 },
  btn: { marginTop: 22, backgroundColor: C.ink, borderRadius: 8, paddingHorizontal: 18, paddingVertical: 13 },
  btnPressed: { opacity: 0.7 },
  btnText: { fontFamily: F.monoSemi, fontSize: 12, color: C.cream, letterSpacing: TRACKING_LABEL },
});
