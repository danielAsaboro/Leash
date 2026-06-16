import React from "react";
import { View } from "react-native";
import { C } from "./theme";
import { ScreenHeader } from "./ScreenHeader";
import { MeshPanel, type MeshStatus } from "./MeshSheet";

/** The MESH nav tab — the mesh-pairing UI (MeshPanel) full-screen under a shared top bar. */
export function MeshScreen(props: {
  onMenu: () => void;
  providerKey: string;
  meshOn: boolean;
  status: MeshStatus;
  onChangeKey: (k: string) => void;
  onToggle: (on: boolean) => void;
  onPair: (key: string, name?: string, cb?: string) => void;
  onPing: () => void;
  selfNote?: string;
}) {
  const { onMenu, ...panel } = props;
  return (
    <View style={{ flex: 1, backgroundColor: C.cream }}>
      <ScreenHeader kicker="The Mesh" title="Mesh" onMenu={onMenu} />
      <MeshPanel {...panel} />
    </View>
  );
}
