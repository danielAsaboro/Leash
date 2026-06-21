import { StyleSheet } from "react-native";

import { C, F, TRACKING_LABEL } from "../theme";

export function splitCsv(text: string): string[] {
  return text
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

export function joinCsv(values: readonly string[]): string {
  return values.join(", ");
}

export function summarizeLines(text: string, max = 5): string {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.slice(0, max).join("\n");
}

export const panelStyles = StyleSheet.create({
  sectionLabel: { fontFamily: F.monoMed, fontSize: 10, color: C.muted, letterSpacing: TRACKING_LABEL, marginBottom: 10, marginTop: 4 },
  actionRow: { flexDirection: "row", alignItems: "center", gap: 14, marginBottom: 14 },
  actionLink: { fontFamily: F.monoMed, fontSize: 10.5, color: C.sageDeep, letterSpacing: 1 },
  dangerLink: { color: C.brick },
  mutedLink: { color: C.muted },
  empty: { fontFamily: F.body, fontSize: 14.5, color: C.muted, lineHeight: 22 },
  row: { paddingVertical: 13, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.rule },
  rowTop: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  rowText: { flex: 1, gap: 4 },
  rowTitle: { fontFamily: F.bodySemi, fontSize: 16, color: C.ink },
  rowMeta: { fontFamily: F.mono, fontSize: 10.5, color: C.faint, letterSpacing: 0.3 },
  rowSub: { fontFamily: F.body, fontSize: 13.5, color: C.muted, lineHeight: 20 },
  rowActions: { alignItems: "flex-end", gap: 8 },
  code: { fontFamily: F.mono, fontSize: 11.5, color: C.inkSoft, lineHeight: 18 },
  detail: { gap: 10 },
  detailHead: { flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" },
  detailTitle: { fontFamily: F.bodySemi, fontSize: 18, color: C.ink },
  detailBody: { fontFamily: F.body, fontSize: 15, color: C.inkSoft, lineHeight: 23 },
  detailLabel: { fontFamily: F.monoMed, fontSize: 9.5, color: C.faint, letterSpacing: 1.2, textTransform: "uppercase" },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: { borderWidth: StyleSheet.hairlineWidth, borderColor: C.ruleStrong, borderRadius: 999, paddingHorizontal: 9, paddingVertical: 4 },
  chipText: { fontFamily: F.monoMed, fontSize: 9.5, color: C.inkSoft, letterSpacing: 0.6 },
  chipOn: { backgroundColor: "rgba(63,125,78,0.12)", borderColor: C.sage },
  chipOff: { backgroundColor: "rgba(155,149,136,0.14)" },
  editorField: { gap: 6, marginBottom: 12 },
  editorLabel: { fontFamily: F.monoMed, fontSize: 9.5, color: C.muted, letterSpacing: 1.1, textTransform: "uppercase" },
  input: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: C.ruleStrong,
    borderRadius: 10,
    backgroundColor: C.cream,
    fontFamily: F.body,
    fontSize: 15,
    color: C.ink,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  textarea: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: C.ruleStrong,
    borderRadius: 10,
    backgroundColor: C.cream,
    fontFamily: F.body,
    fontSize: 15,
    color: C.ink,
    paddingHorizontal: 12,
    paddingVertical: 12,
    minHeight: 110,
    lineHeight: 22,
    textAlignVertical: "top",
  },
  buttonRow: { flexDirection: "row", justifyContent: "flex-end", gap: 10, marginTop: 4 },
  secondaryBtn: { borderWidth: StyleSheet.hairlineWidth, borderColor: C.ruleStrong, borderRadius: 8, paddingHorizontal: 14, paddingVertical: 9 },
  secondaryText: { fontFamily: F.monoSemi, fontSize: 10.5, color: C.inkSoft, letterSpacing: 1 },
  primaryBtn: { backgroundColor: C.sageDeep, borderRadius: 8, paddingHorizontal: 16, paddingVertical: 9 },
  primaryText: { fontFamily: F.monoSemi, fontSize: 10.5, color: C.cream, letterSpacing: 1 },
});
