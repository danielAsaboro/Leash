/**
 * RN port of `apps/web/components/ai-elements/tool.tsx`.
 *
 * One tool invocation: a collapsible card with a status badge (Pending → Running → Completed/Error)
 * and, when expanded, the JSON input ("Parameters") and output ("Result"/"Error"). State strings
 * match the AI SDK tool-part lifecycle so the badge tracks the loop in real time.
 */
import React, { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { CheckCircle2, ChevronDown, Circle, Clock, Wrench, XCircle } from "lucide-react-native";
import { C, F, TRACKING_LABEL } from "../theme";

type ToolState = "input-streaming" | "input-available" | "approval-requested" | "approval-responded" | "output-available" | "output-denied" | "output-error";

const STATUS_LABEL: Record<ToolState, string> = {
  "input-streaming": "Pending",
  "input-available": "Running",
  "approval-requested": "Awaiting approval",
  "approval-responded": "Responded",
  "output-available": "Completed",
  "output-denied": "Denied",
  "output-error": "Error",
};

function StatusIcon({ state }: { state: ToolState }): React.JSX.Element {
  switch (state) {
    case "output-available":
      return <CheckCircle2 size={13} color={C.sage} />;
    case "output-error":
      return <XCircle size={13} color={C.brick} />;
    case "output-denied":
      return <XCircle size={13} color="#c2691f" />;
    case "input-available":
      return <Clock size={13} color={C.muted} />;
    default:
      return <Circle size={13} color={C.faint} />;
  }
}

/** The fields the renderer pulls off a `tool-*` / `dynamic-tool` UIMessagePart. */
export type ToolView = {
  toolName: string;
  state: ToolState;
  input?: unknown;
  output?: unknown;
  errorText?: string;
};

function pretty(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

export function Tool({ tool }: { tool: ToolView }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const hasBody = tool.input !== undefined || tool.output !== undefined || !!tool.errorText;
  return (
    <View style={styles.card}>
      <Pressable style={styles.header} onPress={() => hasBody && setOpen((o) => !o)} hitSlop={4}>
        <View style={styles.headerLeft}>
          <Wrench size={13} color={C.muted} />
          <Text style={styles.name}>{tool.toolName}</Text>
          <View style={styles.badge}>
            <StatusIcon state={tool.state} />
            <Text style={styles.badgeText}>{STATUS_LABEL[tool.state]}</Text>
          </View>
        </View>
        {hasBody ? <ChevronDown size={14} color={C.faint} style={{ transform: [{ rotate: open ? "180deg" : "0deg" }] }} /> : null}
      </Pressable>
      {open ? (
        <View style={styles.body}>
          {tool.input !== undefined ? (
            <View style={styles.section}>
              <Text style={styles.sectionLabel}>PARAMETERS</Text>
              <Text style={styles.code} selectable>
                {pretty(tool.input)}
              </Text>
            </View>
          ) : null}
          {tool.errorText ? (
            <View style={styles.section}>
              <Text style={styles.sectionLabel}>ERROR</Text>
              <Text style={[styles.code, { color: C.brick }]} selectable>
                {tool.errorText}
              </Text>
            </View>
          ) : tool.output !== undefined ? (
            <View style={styles.section}>
              <Text style={styles.sectionLabel}>RESULT</Text>
              <Text style={styles.code} selectable>
                {pretty(tool.output)}
              </Text>
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: 1, borderColor: C.rule, borderRadius: 8, marginBottom: 10, overflow: "hidden" },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 11, paddingVertical: 9 },
  headerLeft: { flexDirection: "row", alignItems: "center", gap: 8, flex: 1 },
  name: { fontFamily: F.bodySemi, fontSize: 14, color: C.ink },
  badge: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 7, paddingVertical: 2, borderRadius: 999, backgroundColor: C.cream, borderWidth: 1, borderColor: C.rule },
  badgeText: { fontFamily: F.monoMed, fontSize: 9.5, color: C.muted, letterSpacing: TRACKING_LABEL * 0.3 },
  body: { paddingHorizontal: 11, paddingBottom: 11, gap: 10, borderTopWidth: 1, borderTopColor: C.rule, paddingTop: 10 },
  section: { gap: 5 },
  sectionLabel: { fontFamily: F.monoMed, fontSize: 9, color: C.faint, letterSpacing: TRACKING_LABEL },
  code: { fontFamily: F.mono, fontSize: 12.5, color: C.inkSoft, lineHeight: 18 },
});
