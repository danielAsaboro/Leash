import React from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { C } from "./theme";
import { ScreenHeader } from "./ScreenHeader";
import { DesktopNote } from "./DesktopNote";
import { Bell, Brain, Database, Services } from "./icons";

type IconCmp = (p: { size?: number; color?: string; strokeWidth?: number }) => React.JSX.Element;
export type DesktopRoute = "brain" | "alerts" | "economy" | "services";

/**
 * Thin full-screen wrapper around DesktopNote for native screens that still need to explain
 * desktop-only sub-features. Top-level iPad tabs now have native surfaces.
 */
const COPY: Record<DesktopRoute, { Icon: IconCmp; title: string; line: string }> = {
  brain: {
    Icon: Brain,
    title: "Brain lives on your desktop.",
    line: "Brain is assembled on your desktop Leash from its on-disk store. Pair a device to browse it here.",
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
