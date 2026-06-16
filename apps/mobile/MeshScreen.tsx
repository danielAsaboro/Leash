import React, { useCallback, useEffect, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { C, F, TRACKING_LABEL } from "./theme";
import { ScreenHeader } from "./ScreenHeader";
import { MeshPanel, type MeshStatus as OffloadStatus } from "./MeshSheet";
import { JoinMeshSheet } from "./JoinMeshSheet";
import { Plus, MeshNodes, Phone, Incognito, LogOut, ChevronDown, ChevronRight, Cpu, Brain } from "./icons";
import { meshStatus, peersList, leaveMesh, onTasksChanged, type MeshStatus, type MeshPeer } from "./meshClient";
import { listModels, stateLabel, fmtBytes, type ModelStatus } from "./modelsInventory";

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
  const [peers, setPeers] = useState<MeshPeer[]>([]);
  const [models, setModels] = useState<ModelStatus[] | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [joinOpen, setJoinOpen] = useState(false);
  const [offloadOpen, setOffloadOpen] = useState(false);

  const refresh = useCallback(async () => {
    const s = await meshStatus().catch(() => null);
    if (s) setMesh(s);
    if (s?.joined) setPeers(await peersList().catch(() => []));
    else setPeers([]);
  }, []);

  useEffect(() => {
    let alive = true;
    const tick = () => void refresh().then(() => { if (!alive) return; });
    tick();
    const id = setInterval(tick, 5000);
    const off = onTasksChanged(tick);
    return () => { alive = false; clearInterval(id); off(); };
  }, [refresh]);

  // Probe the phone's own models the first time the card is expanded (the SDK probe is heavier than status).
  useEffect(() => {
    if (!expanded || models) return;
    let alive = true;
    void listModels().then((m) => alive && setModels(m)).catch(() => {});
    return () => { alive = false; };
  }, [expanded, models]);

  const joined = mesh?.joined;
  const isPublic = mesh?.visibility === "public";

  const onLeave = useCallback(() => {
    Alert.alert(
      "Leave this mesh?",
      "This phone drops its membership and its local copy is wiped. The mesh lives on for your other devices.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Leave", style: "destructive", onPress: () => {
            setLeaving(true);
            void leaveMesh().then(() => { setExpanded(false); return refresh(); }).catch(() => {}).finally(() => setLeaving(false));
          },
        },
      ],
    );
  }, [refresh]);

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
            <Pressable onPress={() => setExpanded((v) => !v)} style={styles.meshHeader} accessibilityLabel={expanded ? "Collapse mesh details" : "Expand mesh details"}>
              <View style={styles.meshTile}>
                <Incognito size={20} color={isPublic ? C.faint : C.sage} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.meshName}>{mesh!.meshLabel || (isPublic ? "Public mesh" : "Private mesh")}</Text>
                <Text style={styles.meshMeta}>
                  {isPublic ? "Public" : "Private"} · {mesh!.peers} peer{mesh!.peers === 1 ? "" : "s"}
                  {mesh!.leader ? (mesh!.leader === mesh!.deviceId ? " · leader: you" : " · leader: a peer") : ""}
                </Text>
              </View>
              <View style={styles.statusWrap}>
                <View style={[styles.dot, { backgroundColor: mesh!.writable ? C.sage : C.faint }]} />
                <Text style={[styles.statusText, { color: mesh!.writable ? C.sageDeep : C.faint }]}>{mesh!.writable ? "synced" : "syncing"}</Text>
              </View>
              {expanded ? <ChevronDown size={16} color={C.faint} /> : <ChevronRight size={16} color={C.faint} />}
            </Pressable>

            {expanded && (
              <View style={styles.meshDetail}>
                <Text style={styles.detailLabel}>PEERS</Text>
                {peers.length === 0 ? (
                  <Text style={styles.detailEmpty}>No peers seen yet — they appear here once they advertise.</Text>
                ) : (
                  peers.map((p) => {
                    const self = !!mesh!.deviceId && p.deviceId === mesh!.deviceId;
                    const seen = Date.parse(p.lastSeen || "");
                    const live = Number.isFinite(seen) && Date.now() - seen <= 30_000;
                    return (
                      <View key={p.deviceId || p.displayName} style={styles.peerRow}>
                        <View style={[styles.peerDot, { backgroundColor: live ? C.sage : C.faint }]} />
                        <Text style={styles.peerName}>{p.displayName || (p.deviceId ? p.deviceId.slice(0, 8) : "device")}</Text>
                        {self && <Text style={styles.selfTag}>this device</Text>}
                        <View style={{ flex: 1 }} />
                        <Cpu size={12} color={C.faint} />
                        <Text style={styles.peerMeta}>{p.computeClass || "device"}{p.isProvider ? " · provider" : ""}</Text>
                      </View>
                    );
                  })
                )}

                <Text style={[styles.detailLabel, { marginTop: 14 }]}>MODELS ON THIS PHONE</Text>
                {!models ? (
                  <Text style={styles.detailEmpty}>Checking…</Text>
                ) : (
                  models.map((m) => (
                    <View key={m.key} style={styles.peerRow}>
                      <Brain size={13} color={m.state === "loaded" || m.state === "cached" ? C.sageDeep : C.faint} />
                      <Text style={styles.peerName}>{m.label}</Text>
                      <View style={{ flex: 1 }} />
                      <Text style={styles.peerMeta}>{stateLabel(m.state)}{m.sizeBytes ? ` · ${fmtBytes(m.sizeBytes)}` : ""}</Text>
                    </View>
                  ))
                )}

                <Pressable onPress={onLeave} disabled={leaving} style={[styles.leaveBtn, leaving && { opacity: 0.5 }]} accessibilityLabel="Leave this mesh">
                  <LogOut size={15} color={C.brick} />
                  <Text style={styles.leaveText}>{leaving ? "Leaving…" : "Leave mesh"}</Text>
                </Pressable>
              </View>
            )}
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

      {joinOpen && <JoinMeshSheet onClose={() => setJoinOpen(false)} onJoined={() => { setJoinOpen(false); void refresh(); }} />}
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

  meshCard: { backgroundColor: C.paper, borderWidth: StyleSheet.hairlineWidth, borderColor: C.rule, borderRadius: 12, overflow: "hidden" },
  meshHeader: { flexDirection: "row", alignItems: "center", gap: 13, padding: 14 },
  meshTile: { width: 40, height: 40, borderRadius: 11, backgroundColor: "rgba(63,125,78,0.12)", alignItems: "center", justifyContent: "center" },
  meshName: { fontFamily: F.bodySemi, fontSize: 17, color: C.ink },
  meshMeta: { fontFamily: F.mono, fontSize: 11, color: C.muted, marginTop: 3, letterSpacing: 0.2 },
  statusWrap: { alignItems: "center", gap: 4 },
  dot: { width: 8, height: 8, borderRadius: 5 },
  statusText: { fontFamily: F.monoMed, fontSize: 8.5, letterSpacing: 0.6, textTransform: "uppercase" },

  meshDetail: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.rule, paddingHorizontal: 14, paddingTop: 12, paddingBottom: 14 },
  detailLabel: { fontFamily: F.monoMed, fontSize: 9, color: C.faint, letterSpacing: TRACKING_LABEL, marginBottom: 8 },
  detailEmpty: { fontFamily: F.body, fontSize: 13, color: C.muted, fontStyle: "italic" },
  peerRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 5 },
  peerDot: { width: 7, height: 7, borderRadius: 4 },
  peerName: { fontFamily: F.bodySemi, fontSize: 13.5, color: C.ink },
  selfTag: { fontFamily: F.mono, fontSize: 9, color: C.sageDeep, borderWidth: StyleSheet.hairlineWidth, borderColor: C.rule, borderRadius: 3, paddingHorizontal: 4, paddingVertical: 1 },
  peerMeta: { fontFamily: F.mono, fontSize: 10.5, color: C.muted, letterSpacing: 0.2 },
  leaveBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 7, marginTop: 14, borderWidth: StyleSheet.hairlineWidth, borderColor: C.brick, borderRadius: 10, paddingVertical: 10 },
  leaveText: { fontFamily: F.bodySemi, fontSize: 14, color: C.brick },

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
