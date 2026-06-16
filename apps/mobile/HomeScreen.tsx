import React, { useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { C, F, TRACKING_LABEL } from "./theme";
import { ScreenHeader } from "./ScreenHeader";
import { Card, CardAction, Stat } from "./Card";
import { ChatBubble, Phone, Plus } from "./icons";
import { ago, listChats, type ChatSummary } from "./chats";
import { taskCounts, type TaskCounts } from "./tasks";
import { fmtBytes, listModels, totalDiskBytes, type ModelStatus } from "./modelsInventory";

/**
 * HOME — a real on-device dashboard mirroring the desktop's glanceable cards, every byte local:
 * a status line, Tasks counts, Model runtime + disk, recent conversations, and quick actions.
 * No daemon, no server.
 */
export function HomeScreen({
  onMenu,
  modelLabel,
  modelReady,
  meshOn,
  meshLive,
  onNewChat,
  onCall,
  onOpenChat,
  onGoTasks,
  onGoModels,
}: {
  onMenu: () => void;
  modelLabel: string;
  modelReady: boolean;
  meshOn: boolean;
  meshLive: boolean;
  onNewChat: () => void;
  onCall: () => void;
  onOpenChat: (id: string) => void;
  onGoTasks: () => void;
  onGoModels: () => void;
}) {
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [counts, setCounts] = useState<TaskCounts | null>(null);
  const [models, setModels] = useState<ModelStatus[] | null>(null);

  useEffect(() => {
    void listChats().then(setChats);
    void taskCounts().then(setCounts);
    void listModels().then(setModels);
  }, []);

  const loadedCount = models?.filter((m) => m.state === "loaded").length ?? 0;
  const disk = models ? totalDiskBytes(models) : null;

  return (
    <View style={{ flex: 1, backgroundColor: C.cream }}>
      <ScreenHeader kicker="Today's edition" title="Home" onMenu={onMenu} />
      <ScrollView contentContainerStyle={styles.body}>
        {/* Status line — model + where it runs (all on-device unless mesh is engaged). */}
        <View style={styles.statusRow}>
          <View style={[styles.dot, { backgroundColor: modelReady ? C.sage : C.faint }]} />
          <Text style={styles.statusText}>{modelReady ? modelLabel : "Waking the press…"}</Text>
          <View style={{ flex: 1 }} />
          <Text style={[styles.statusWhere, meshOn && { color: meshLive ? C.sageDeep : C.brick }]}>
            {meshOn ? `⛓ MESH${meshLive ? " · LIVE" : " · DOWN"}` : "⌂ ON-DEVICE"}
          </Text>
        </View>

        {/* Quick actions. */}
        <View style={styles.actions}>
          <Pressable onPress={onNewChat} style={({ pressed }) => [styles.action, pressed && styles.actionPressed]}>
            <Plus size={20} color={C.cream} strokeWidth={2.2} />
            <Text style={styles.actionText}>New chat</Text>
          </Pressable>
          <Pressable
            onPress={onCall}
            disabled={!modelReady}
            style={({ pressed }) => [styles.actionAlt, pressed && styles.actionPressed, !modelReady && styles.actionDisabled]}
          >
            <Phone size={18} color={C.ink} strokeWidth={1.9} />
            <Text style={styles.actionAltText}>Call</Text>
          </Pressable>
        </View>

        {/* Tasks + Model runtime cards — real on-device data. */}
        <View style={{ marginTop: 22 }}>
          <Card title="Tasks" action={<CardAction label="OPEN ›" onPress={onGoTasks} />}>
            <View style={styles.statRow}>
              <Stat label="Open" value={counts ? String(counts.open) : "…"} />
              <Stat label="In progress" value={counts ? String(counts.in_progress) : "…"} accent={C.sageDeep} />
              <Stat label="Done" value={counts ? String(counts.done) : "…"} accent={C.sage} />
            </View>
          </Card>

          <Card title="Model runtime" action={<CardAction label="MANAGE ›" onPress={onGoModels} />}>
            <View style={styles.statRow}>
              <Stat label="Loaded" value={models ? `${loadedCount}/${models.length}` : "…"} accent={loadedCount ? C.sage : undefined} />
              <Stat label="On disk" value={disk != null ? fmtBytes(disk) : "…"} />
            </View>
          </Card>
        </View>

        {/* Recent conversations — on-device store. */}
        <Text style={styles.sectionLabel}>RECENT</Text>
        <View style={styles.rule} />
        {chats.length === 0 ? (
          <Text style={styles.empty}>No conversations yet. Start one from “New chat”.</Text>
        ) : (
          chats.map((c) => (
            <Pressable
              key={c.id}
              onPress={() => onOpenChat(c.id)}
              style={({ pressed }) => [styles.chatRow, pressed && styles.chatRowPressed]}
            >
              <ChatBubble size={18} color={C.sageDeep} strokeWidth={1.7} />
              <View style={{ flex: 1 }}>
                <Text style={styles.chatTitle} numberOfLines={1}>
                  {c.title}
                </Text>
                <Text style={styles.chatMeta}>
                  {c.count} {c.count === 1 ? "message" : "messages"} · {ago(c.updatedAt)}
                </Text>
              </View>
              <Text style={styles.chevron}>›</Text>
            </Pressable>
          ))
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: 20, paddingTop: 18, paddingBottom: 40 },
  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 12,
    paddingHorizontal: 14,
    backgroundColor: C.paper,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: C.rule,
    borderRadius: 10,
  },
  dot: { width: 7, height: 7, borderRadius: 4 },
  statusText: { fontFamily: F.monoMed, fontSize: 11, color: C.inkSoft, letterSpacing: 0.6 },
  statusWhere: { fontFamily: F.monoMed, fontSize: 10, color: C.muted, letterSpacing: TRACKING_LABEL },
  actions: { flexDirection: "row", gap: 12, marginTop: 18 },
  action: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 9,
    backgroundColor: C.sageDeep,
    borderRadius: 10,
    paddingVertical: 15,
  },
  actionAlt: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 9,
    backgroundColor: C.paper,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: C.ruleStrong,
    borderRadius: 10,
    paddingVertical: 15,
  },
  actionPressed: { opacity: 0.7 },
  actionDisabled: { opacity: 0.45 },
  actionText: { fontFamily: F.bodySemi, fontSize: 16, color: C.cream },
  actionAltText: { fontFamily: F.bodySemi, fontSize: 16, color: C.ink },
  statRow: { flexDirection: "row", flexWrap: "wrap", paddingBottom: 6 },
  sectionLabel: {
    fontFamily: F.monoMed,
    fontSize: 10,
    color: C.muted,
    letterSpacing: TRACKING_LABEL,
    marginTop: 26,
    marginBottom: 10,
  },
  rule: { height: StyleSheet.hairlineWidth, backgroundColor: C.ink, marginBottom: 4 },
  empty: { fontFamily: F.body, fontSize: 16, color: C.muted, marginTop: 16, lineHeight: 24 },
  chatRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: C.rule,
  },
  chatRowPressed: { opacity: 0.55 },
  chatTitle: { fontFamily: F.bodyMed, fontSize: 17, color: C.ink },
  chatMeta: { fontFamily: F.mono, fontSize: 10.5, color: C.faint, letterSpacing: 0.4, marginTop: 3 },
  chevron: { fontFamily: F.body, fontSize: 22, color: C.faint },
});
