/**
 * RN port of `apps/web/components/SkillEventCard.tsx`.
 *
 * A "loaded skill" timeline node: one skill → a single muted "Loaded skill · name · mode" line;
 * many → a collapsible "Loaded N skills" that expands to the names. Emitted by the agent loop as a
 * `data-skill` UI part (see lib/agent/skills).
 */
import React, { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { ChevronDown } from "lucide-react-native";
import { C, F, TRACKING_LABEL } from "../theme";

export type SkillRef = { name: string; slug?: string };
export type SkillEvent = { skills: SkillRef[]; mode: "explicit" | "auto" };

function modeLabel(mode: SkillEvent["mode"]): string {
  return mode === "explicit" ? "requested" : "auto-matched";
}

/** The slug only when it adds information beyond the name. */
function usefulSlug(s: SkillRef): string | null {
  if (!s.slug) return null;
  const norm = s.name.trim().toLowerCase();
  const slug = s.slug.toLowerCase();
  return slug === norm || slug === norm.replace(/\s+/g, "-") ? null : s.slug;
}

export function SkillEventCard({ event }: { event: SkillEvent }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const count = event.skills.length;

  if (count === 1) {
    const s = event.skills[0]!;
    return (
      <View style={styles.row}>
        <Text style={styles.line}>
          Loaded skill · <Text style={styles.name}>{s.name}</Text>
        </Text>
        <Text style={styles.mode}>{modeLabel(event.mode)}</Text>
      </View>
    );
  }

  return (
    <View style={styles.wrap}>
      <Pressable style={styles.row} onPress={() => setOpen((o) => !o)} hitSlop={6}>
        <Text style={styles.line}>Loaded {count} skills</Text>
        <Text style={styles.mode}>{modeLabel(event.mode)}</Text>
        <ChevronDown size={13} color={C.faint} style={{ transform: [{ rotate: open ? "180deg" : "0deg" }] }} />
      </Pressable>
      {open ? (
        <View style={styles.list}>
          {event.skills.map((s) => {
            const slug = usefulSlug(s);
            return (
              <View key={s.slug ?? s.name} style={styles.listItem}>
                <Text style={styles.name}>{s.name}</Text>
                {slug ? <Text style={styles.slug}>{slug}</Text> : null}
              </View>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginBottom: 10 },
  row: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 10 },
  line: { fontFamily: F.body, fontSize: 14, color: C.muted, flexShrink: 1 },
  name: { fontFamily: F.bodyMed, color: C.inkSoft },
  mode: { fontFamily: F.monoMed, fontSize: 9.5, color: C.sageDeep, letterSpacing: TRACKING_LABEL * 0.4 },
  list: { gap: 6, paddingLeft: 4 },
  listItem: { flexDirection: "row", alignItems: "baseline", gap: 8 },
  slug: { fontFamily: F.mono, fontSize: 10.5, color: C.faint, letterSpacing: TRACKING_LABEL * 0.3 },
});
