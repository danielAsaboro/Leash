import React from "react";
import { StyleSheet, Text, View } from "react-native";

import { C, F, TRACKING_LABEL } from "../theme";

export type AgentEvent = {
  name: string;
  slug: string;
  description?: string;
  source?: "local" | "plugin";
};

export function AgentEventCard({ event }: { event: AgentEvent }): React.JSX.Element {
  return (
    <View style={styles.wrap}>
      <Text style={styles.line}>
        Routed to agent · <Text style={styles.name}>{event.name}</Text>
      </Text>
      <Text style={styles.meta}>
        {event.source === "plugin" ? "plugin specialist" : "local specialist"}
        {event.description ? ` · ${event.description}` : ""}
      </Text>
      <Text style={styles.slug}>{event.slug}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginBottom: 10, gap: 3 },
  line: { fontFamily: F.body, fontSize: 14, color: C.muted },
  name: { fontFamily: F.bodyMed, color: C.inkSoft },
  meta: { fontFamily: F.monoMed, fontSize: 9.5, color: C.sageDeep, letterSpacing: TRACKING_LABEL * 0.35 },
  slug: { fontFamily: F.mono, fontSize: 10.5, color: C.faint, letterSpacing: TRACKING_LABEL * 0.25 },
});
