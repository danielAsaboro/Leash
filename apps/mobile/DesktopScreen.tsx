import React from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { C } from "./theme";
import { ScreenHeader } from "./ScreenHeader";
import { DesktopNote } from "./DesktopNote";
import { Bell, Brain, Database, ListChecks, Newspaper, Services } from "./icons";

type IconCmp = (p: { size?: number; color?: string; strokeWidth?: number }) => React.JSX.Element;
export type DesktopRoute = "feed" | "brain" | "tasks" | "alerts" | "economy" | "services";

/**
 * Thin full-screen wrapper around DesktopNote, kept for the FEED route (which has no on-device
 * backing at all). The other five sections now have real screens that embed DesktopNote per-tab
 * only where a sub-feature is genuinely desktop/daemon-bound.
 */
const COPY: Record<DesktopRoute, { Icon: IconCmp; title: string; line: string }> = {
  feed: {
    Icon: Newspaper,
    title: "Feed lives on your desktop.",
    line: "Feed is the newsroom daemon and its database — both run on your desktop Leash. Pair this phone to a device to read it here.",
  },
  brain: {
    Icon: Brain,
    title: "Brain lives on your desktop.",
    line: "Brain is assembled on your desktop Leash from its on-disk store. Pair a device to browse it here.",
  },
  tasks: {
    Icon: ListChecks,
    title: "Tasks lives on your desktop.",
    line: "Tasks, pipelines, and daemons are scheduled and run by your desktop Leash. Pair this phone to a device to track them here.",
  },
  alerts: {
    Icon: Bell,
    title: "Alerts lives on your desktop.",
    line: "Alerts are raised by the daemons running on your desktop Leash. Pair a device to receive them on this phone.",
  },
  economy: {
    Icon: Database,
    title: "Economy lives on your desktop.",
    line: "The economy — provider earnings, ledger, and settlement — is kept by your desktop Leash and its chain RPC. Pair a device to view it here.",
  },
  services: {
    Icon: Services,
    title: "Services lives on your desktop.",
    line: "Services control the model serve and host processes on your desktop Leash. Pair a device to manage them from this phone.",
  },
};

export function DesktopScreen({ route, onMenu, onPair }: { route: DesktopRoute; onMenu: () => void; onPair: () => void }) {
  const { Icon, title, line } = COPY[route];
  const kicker = route.charAt(0).toUpperCase() + route.slice(1);
  return (
    <View style={{ flex: 1, backgroundColor: C.cream }}>
      <ScreenHeader kicker="Desktop Leash" title={kicker} onMenu={onMenu} />
      <ScrollView contentContainerStyle={styles.body}>
        <DesktopNote Icon={Icon} title={title} line={line} onPair={onPair} />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: 28, paddingTop: 40, paddingBottom: 40 },
});
