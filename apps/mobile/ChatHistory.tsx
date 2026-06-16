import React from "react";
import { FlatList, Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { C, F, TRACKING_LABEL } from "./theme";
import { Plus, X, Trash } from "./icons";
import { ago, type ChatSummary } from "./chats";

/** Slide-up drawer listing saved conversations — browse, switch, delete, or start a new one. */
export function ChatHistory({
  visible,
  chats,
  currentId,
  onSelect,
  onNew,
  onDelete,
  onClose,
}: {
  visible: boolean;
  chats: ChatSummary[];
  currentId: string;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}): React.JSX.Element {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <Pressable style={styles.backdropTap} onPress={onClose} />
        <View style={styles.sheet}>
          <View style={styles.grip} />
          <View style={styles.header}>
            <Pressable onPress={onClose} hitSlop={12} style={styles.close}>
              <X size={24} color={C.ink} strokeWidth={2} />
            </Pressable>
            <Text style={styles.title}>Conversations</Text>
          </View>

          <Pressable
            onPress={() => {
              onNew();
              onClose();
            }}
            style={({ pressed }) => [styles.newRow, pressed && styles.pressed]}
          >
            <Plus size={20} color={C.sageDeep} strokeWidth={2.2} />
            <Text style={styles.newText}>New conversation</Text>
          </Pressable>

          <FlatList
            data={chats}
            keyExtractor={(c) => c.id}
            style={styles.list}
            ListEmptyComponent={<Text style={styles.empty}>No saved conversations yet.</Text>}
            renderItem={({ item }) => {
              const active = item.id === currentId;
              return (
                <Pressable
                  onPress={() => {
                    onSelect(item.id);
                    onClose();
                  }}
                  style={({ pressed }) => [styles.row, active && styles.rowActive, pressed && styles.pressed]}
                >
                  <View style={{ flex: 1 }}>
                    <Text numberOfLines={1} style={[styles.rowTitle, active && styles.rowTitleActive]}>
                      {item.title}
                    </Text>
                    <Text style={styles.rowMeta}>
                      {item.count} {item.count === 1 ? "message" : "messages"} · {ago(item.updatedAt)}
                    </Text>
                  </View>
                  <Pressable onPress={() => onDelete(item.id)} hitSlop={10} style={styles.del}>
                    <Trash size={17} color={C.faint} strokeWidth={1.8} />
                  </Pressable>
                </Pressable>
              );
            }}
          />
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(25,23,18,0.45)" },
  backdropTap: { flex: 1 },
  sheet: {
    backgroundColor: C.cream,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingBottom: 36,
    borderTopWidth: 2,
    borderColor: C.ink,
    maxHeight: "82%",
  },
  grip: { alignSelf: "center", width: 40, height: 4, borderRadius: 2, backgroundColor: C.ruleStrong, marginTop: 10 },
  header: { alignItems: "center", justifyContent: "center", paddingVertical: 16 },
  close: { position: "absolute", left: 18, top: 12 },
  title: { fontFamily: F.display, fontSize: 24, color: C.ink },
  newRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginHorizontal: 18,
    paddingVertical: 14,
    paddingHorizontal: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: C.ruleStrong,
    borderRadius: 12,
  },
  newText: { fontFamily: F.bodySemi, fontSize: 16, color: C.ink },
  list: { marginTop: 6 },
  empty: { fontFamily: F.body, fontSize: 15, color: C.faint, textAlign: "center", paddingVertical: 28 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 14,
    paddingHorizontal: 18,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: C.rule,
  },
  rowActive: { backgroundColor: C.paper },
  pressed: { opacity: 0.6 },
  rowTitle: { fontFamily: F.bodyMed, fontSize: 16, color: C.ink },
  rowTitleActive: { color: C.sageDeep },
  rowMeta: { fontFamily: F.mono, fontSize: 10.5, color: C.faint, letterSpacing: 0.4, marginTop: 3, textTransform: "uppercase" },
  del: { padding: 6 },
});
