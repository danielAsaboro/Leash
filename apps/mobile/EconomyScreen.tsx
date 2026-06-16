import React from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { C } from "./theme";
import { ScreenHeader } from "./ScreenHeader";
import { Card, Row, StateBadge } from "./Card";
import { DesktopNote } from "./DesktopNote";
import { Database } from "./icons";
import { type MeshStatus } from "./MeshSheet";

/**
 * ECONOMY — the phone is a pure mesh consumer: no on-device ledger, wallet, or chain RPC. The page
 * structure is preserved (hero / market / receipts) but the only REAL bit is the current mesh-offload
 * status, shown in a live card above an honest DesktopNote (Rule 4 — the ledger lives on your
 * provider / desktop Leash, so we don't fabricate balances or receipts).
 */
function shortKey(k: string): string {
  return k && k.length > 16 ? `${k.slice(0, 8)}…${k.slice(-6)}` : k || "—";
}

export function EconomyScreen({
  onMenu,
  onPair,
  mesh,
}: {
  onMenu: () => void;
  onPair: () => void;
  mesh: { on: boolean; providerName?: string; providerKey: string; status: MeshStatus };
}) {
  const ok = mesh.on ? (mesh.status === "online" ? true : mesh.status === "offline" ? false : null) : null;
  const stateLabel = !mesh.on
    ? "ON-DEVICE"
    : mesh.status === "online"
      ? "LIVE"
      : mesh.status === "offline"
        ? "DOWN"
        : "CHECKING";

  return (
    <View style={{ flex: 1, backgroundColor: C.cream }}>
      <ScreenHeader kicker="On this device" title="Economy" onMenu={onMenu} />
      <ScrollView contentContainerStyle={styles.body}>
        <Card title="Mesh offload" action={<StateBadge ok={mesh.on ? ok : null} label={stateLabel} />}>
          <Row label="Role" value="Consumer (this device)" mono={false} />
          <Row label="Provider" value={mesh.on ? mesh.providerName || "Paired provider" : "Not paired"} mono={false} />
          {mesh.on ? <Row label="Provider key" value={shortKey(mesh.providerKey)} /> : null}
          <Row label="Inference" value={mesh.on && mesh.status === "online" ? "Running on provider" : "Running on-device"} mono={false} />
        </Card>

        <View style={{ marginTop: 8 }}>
          <DesktopNote
            Icon={Database}
            title="The ledger lives on your provider."
            line="Earnings, spend, market pricing, and settlement receipts are kept by the provider / desktop Leash and its chain RPC. This phone consumes inference but holds no wallet or ledger — so there's nothing to fabricate here. Pair a device to view the books."
            onPair={onPair}
          />
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 40 },
});
