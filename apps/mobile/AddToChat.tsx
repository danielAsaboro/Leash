import React from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { C, F } from "./theme";
import { Camera, ImageIcon, FileUp, X } from "./icons";

/** The "+" sheet — Camera / Photos / Files, matching the familiar add-to-chat pattern. */
export function AddToChat({
  visible,
  onClose,
  onCamera,
  onPhotos,
  onFiles,
}: {
  visible: boolean;
  onClose: () => void;
  onCamera: () => void;
  onPhotos: () => void;
  onFiles: () => void;
}) {
  const Tile = ({ label, icon, onPress }: { label: string; icon: React.ReactNode; onPress: () => void }) => (
    <Pressable
      onPress={() => {
        onClose();
        setTimeout(onPress, 180);
      }}
      style={({ pressed }) => [styles.tile, pressed && styles.tilePressed]}
    >
      {icon}
      <Text style={styles.tileLabel}>{label}</Text>
    </Pressable>
  );

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
            <Text style={styles.title}>Add to Chat</Text>
          </View>
          <View style={styles.row}>
            <Tile label="Camera" icon={<Camera size={26} color={C.ink} strokeWidth={1.6} />} onPress={onCamera} />
            <Tile label="Photos" icon={<ImageIcon size={26} color={C.ink} strokeWidth={1.6} />} onPress={onPhotos} />
            <Tile label="Files" icon={<FileUp size={26} color={C.ink} strokeWidth={1.6} />} onPress={onFiles} />
          </View>
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
    paddingBottom: 40,
    borderTopWidth: 2,
    borderColor: C.ink,
  },
  grip: { alignSelf: "center", width: 40, height: 4, borderRadius: 2, backgroundColor: C.ruleStrong, marginTop: 10 },
  header: { alignItems: "center", justifyContent: "center", paddingVertical: 18 },
  close: { position: "absolute", left: 18, top: 14 },
  title: { fontFamily: F.display, fontSize: 24, color: C.ink },
  row: { flexDirection: "row", paddingHorizontal: 16, gap: 12 },
  tile: {
    flex: 1,
    aspectRatio: 1,
    backgroundColor: C.paper,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: C.rule,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    gap: 14,
  },
  tilePressed: { opacity: 0.6 },
  tileLabel: { fontFamily: F.bodyMed, fontSize: 17, color: C.ink },
});
