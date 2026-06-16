import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { C, F, TRACKING_LABEL } from "./theme";
import { LeashMark } from "./LeashMark";

/**
 * The lightweight top bar shared by Home / Mesh / Settings / Desktop screens. The brand tile
 * is a Pressable that slides the nav drawer in (mirroring the chat masthead's logo). The chat
 * screen keeps its own richer masthead — this is for the secondary surfaces.
 */
export function ScreenHeader({
  title,
  kicker,
  onMenu,
  right,
}: {
  title: string;
  kicker?: string;
  onMenu: () => void;
  right?: React.ReactNode;
}) {
  return (
    <View style={styles.wrap}>
      <View style={styles.row}>
        <Pressable onPress={onMenu} hitSlop={8} style={styles.markTile}>
          <LeashMark size={24} mark={C.cream} cutout={C.ink} />
        </Pressable>
        <View style={{ flex: 1 }}>
          {kicker ? <Text style={styles.kicker}>{kicker}</Text> : null}
          <Text style={styles.title}>{title}</Text>
        </View>
        {right}
      </View>
      <View style={styles.rule} />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 10 },
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingBottom: 10 },
  markTile: {
    width: 42,
    height: 42,
    borderRadius: 12,
    backgroundColor: C.ink,
    alignItems: "center",
    justifyContent: "center",
  },
  kicker: {
    fontFamily: F.monoMed,
    fontSize: 9.5,
    color: C.sageDeep,
    letterSpacing: TRACKING_LABEL,
    textTransform: "uppercase",
    marginBottom: 2,
  },
  title: { fontFamily: F.display, fontSize: 28, color: C.ink, letterSpacing: -0.5, lineHeight: 32 },
  rule: { height: StyleSheet.hairlineWidth, backgroundColor: C.ink },
});
