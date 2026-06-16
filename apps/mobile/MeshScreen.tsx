import React, { useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { C, F, TRACKING_LABEL } from "./theme";
import { ScreenHeader } from "./ScreenHeader";
import { MeshPanel, type MeshStatus as OffloadStatus } from "./MeshSheet";
import { JoinMeshSheet } from "./JoinMeshSheet";
import { Plus, MeshNodes, Phone } from "./icons";
import { meshStatus, onTasksChanged, type MeshStatus } from "./meshClient";

/**
 * The MESH tab — your private-mesh MEMBERSHIPS first (the meshes this phone syncs with, or an empty
 * state), with a top-right "+" to join one (scan an invite QR or paste a sync key). Borrowing compute
 * from a stronger device (delegated inference) is a separate concern, tucked into a secondary row that
 * opens the existing offload panel.
 */
export function MeshScreen(props: {
  onMenu: () => void;
  providerKey: string;
  meshOn: boolean;
  status: OffloadStatus;
  onChangeKey: (k: string) => void;
  onToggle: (on: boolean) => void;
  onPair: (key: string, name?: string, cb?: string) => void;
  onPing: () => void;
  selfNote?: string;
}) {
  const { onMenu, ...offload } = props;
  const [mesh, setMesh] = useState<MeshStatus | null>(null);
  const [joinOpen, setJoinOpen] = useState(false);
  const [offloadOpen, setOffloadOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    const tick = () => void meshStatus().then((s) => alive && setMesh(s)).catch(() => {});
    tick();
    const id = setInterval(tick, 5000);
    const off = onTasksChanged(tick);
    return () => { alive = false; clearInterval(id); off(); };
  }, []);

  const joined = mesh?.joined;

  return (
    <View style={{ flex: 1, backgroundColor: C.cream }}>
      <ScreenHeader
        kicker="The Mesh"
        title="Mesh"
        onMenu={onMenu}
        right={
          <Pressable onPress={() => setJoinOpen(true)} hitSlop={8} style={styles.plus} accessibilityLabel="Join a mesh">
            <Plus size={20} color={C.cream} strokeWidth={2.4} />
          </Pressable>
        }
      />

      <ScrollView contentContainerStyle={styles.body}>
        <Text style={styles.sectionLabel}>YOUR MESHES</Text>

        {joined ? (
          <View style={styles.meshCard}>
            <View style={styles.meshTile}>
              <MeshNodes size={20} color={C.sage} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.meshName}>Private mesh</Text>
              <Text style={styles.meshMeta}>
                Member · {mesh!.peers} peer{mesh!.peers === 1 ? "" : "s"}
                {mesh!.leader ? (mesh!.leader === mesh!.deviceId ? " · leader: you" : " · leader: a peer") : ""}
              </Text>
            </View>
            <View style={styles.statusWrap}>
              <View style={[styles.dot, { backgroundColor: mesh!.writable ? C.sage : C.faint }]} />
              <Text style={[styles.statusText, { color: mesh!.writable ? C.sageDeep : C.faint }]}>{mesh!.writable ? "synced" : "syncing"}</Text>
            </View>
          </View>
        ) : (
          <View style={styles.empty}>
            <View style={styles.emptyTile}>
              <MeshNodes size={28} color={C.faint} />
            </View>
            <Text style={styles.emptyTitle}>Not in a mesh yet</Text>
            <Text style={styles.emptyDek}>Join your other devices to sync tasks and data privately — peer-to-peer, no cloud.</Text>
            <Pressable onPress={() => setJoinOpen(true)} style={styles.emptyCta}>
              <Plus size={15} color={C.cream} strokeWidth={2.4} />
              <Text style={styles.emptyCtaText}>Join a mesh</Text>
            </Pressable>
          </View>
        )}

        <Text style={[styles.sectionLabel, { marginTop: 30 }]}>COMPUTE</Text>
        <Pressable onPress={() => setOffloadOpen(true)} style={styles.row}>
          <View style={styles.rowTile}>
            <Phone size={17} color={C.sageDeep} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.rowTitle}>Borrow a brain</Text>
            <Text style={styles.rowSub}>{props.meshOn ? "Chat runs on a provider device" : "Run chat on a stronger device"}</Text>
          </View>
          <Text style={styles.chev}>›</Text>
        </Pressable>
      </ScrollView>

      {joinOpen && <JoinMeshSheet onClose={() => setJoinOpen(false)} onJoined={() => { setJoinOpen(false); void meshStatus().then(setMesh).catch(() => {}); }} />}
      {offloadOpen && (
        <View style={StyleSheet.absoluteFill}>
          <View style={{ flex: 1, backgroundColor: C.cream }}>
            <MeshPanel {...offload} onClose={() => setOffloadOpen(false)} />
          </View>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 40 },
  plus: { width: 38, height: 38, borderRadius: 11, backgroundColor: C.sageDeep, alignItems: "center", justifyContent: "center" },
  sectionLabel: { fontFamily: F.monoMed, fontSize: 10, color: C.faint, letterSpacing: TRACKING_LABEL, marginBottom: 10 },

  meshCard: { flexDirection: "row", alignItems: "center", gap: 13, backgroundColor: C.paper, borderWidth: StyleSheet.hairlineWidth, borderColor: C.rule, borderRadius: 12, padding: 14 },
  meshTile: { width: 40, height: 40, borderRadius: 11, backgroundColor: "rgba(63,125,78,0.12)", alignItems: "center", justifyContent: "center" },
  meshName: { fontFamily: F.bodySemi, fontSize: 17, color: C.ink },
  meshMeta: { fontFamily: F.mono, fontSize: 11, color: C.muted, marginTop: 3, letterSpacing: 0.2 },
  statusWrap: { alignItems: "center", gap: 4 },
  dot: { width: 8, height: 8, borderRadius: 5 },
  statusText: { fontFamily: F.monoMed, fontSize: 8.5, letterSpacing: 0.6, textTransform: "uppercase" },

  empty: { alignItems: "center", backgroundColor: C.paper, borderWidth: StyleSheet.hairlineWidth, borderColor: C.rule, borderRadius: 12, paddingVertical: 30, paddingHorizontal: 24 },
  emptyTile: { width: 56, height: 56, borderRadius: 16, backgroundColor: C.cream, borderWidth: StyleSheet.hairlineWidth, borderColor: C.rule, alignItems: "center", justifyContent: "center", marginBottom: 14 },
  emptyTitle: { fontFamily: F.bodySemi, fontSize: 18, color: C.ink },
  emptyDek: { fontFamily: F.body, fontSize: 14.5, lineHeight: 21, color: C.muted, textAlign: "center", marginTop: 6, marginBottom: 18 },
  emptyCta: { flexDirection: "row", alignItems: "center", gap: 7, backgroundColor: C.sageDeep, borderRadius: 10, paddingVertical: 11, paddingHorizontal: 18 },
  emptyCtaText: { fontFamily: F.bodySemi, fontSize: 15, color: C.cream },

  row: { flexDirection: "row", alignItems: "center", gap: 13, backgroundColor: C.paper, borderWidth: StyleSheet.hairlineWidth, borderColor: C.rule, borderRadius: 12, padding: 14 },
  rowTile: { width: 38, height: 38, borderRadius: 11, backgroundColor: "rgba(63,125,78,0.10)", alignItems: "center", justifyContent: "center" },
  rowTitle: { fontFamily: F.bodySemi, fontSize: 16, color: C.ink },
  rowSub: { fontFamily: F.body, fontSize: 13, color: C.muted, marginTop: 2 },
  chev: { fontFamily: F.body, fontSize: 24, color: C.faint },
});
