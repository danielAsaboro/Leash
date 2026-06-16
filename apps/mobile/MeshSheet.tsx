import React, { useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { C, F, TRACKING_LABEL } from "./theme";
import { LeashMark } from "./LeashMark";
import { isValidProviderKey } from "./mesh";
import { QRScanner } from "./QRScanner";

export type MeshStatus = "unset" | "checking" | "online" | "offline";

type MeshPanelProps = {
  providerKey: string;
  meshOn: boolean;
  status: MeshStatus;
  onChangeKey: (k: string) => void;
  onToggle: (on: boolean) => void;
  onPair: (key: string, name?: string, cb?: string) => void;
  onPing: () => void;
  selfNote?: string;
};

/**
 * The mesh-pairing UI body — extracted so it can render full-screen under the MESH nav tab
 * (MeshScreen) AND inside the legacy bottom sheet. When `onClose` is provided it shows the
 * sheet's own header + close button; the full-screen route omits it (ScreenHeader supplies
 * the title).
 */
export function MeshPanel({
  providerKey,
  meshOn,
  status,
  onChangeKey,
  onToggle,
  onPair,
  onPing,
  selfNote,
  onClose,
}: MeshPanelProps & { onClose?: () => void }) {
  const [draft, setDraft] = useState(providerKey);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [paired, setPaired] = useState<{ name?: string } | null>(null);
  const valid = isValidProviderKey(draft);
  const dirty = draft.trim() !== providerKey.trim();

  function onScanned(key: string, name?: string, cb?: string) {
    setDraft(key);
    onPair(key, name, cb);
    setPaired({ name });
    setScannerOpen(false);
  }

  // The banner shown after a successful scan, tracking the live connection.
  const pairedColor =
    status === "online" ? C.sage : status === "offline" ? C.brick : C.sageDeep;
  const pairedLine =
    status === "online" ? "Connected — chat now runs on the provider" :
    status === "offline" ? "Provider unreachable — falling back to this device" :
    "Connecting over the encrypted mesh…";

  const statusText =
    status === "online" ? "PROVIDER ONLINE" :
    status === "offline" ? "PROVIDER UNREACHABLE" :
    status === "checking" ? "PINGING…" : "NO PROVIDER SET";
  const statusColor = status === "online" ? C.sage : status === "offline" ? C.brick : C.faint;

  return (
    <View style={{ flex: 1 }}>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.body}>
        {onClose && (
          <View style={styles.headRow}>
            <View style={styles.markTile}>
              <LeashMark size={22} mark={C.cream} cutout={C.ink} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.kicker}>THE MESH</Text>
              <Text style={styles.title}>Offload to your mesh</Text>
            </View>
            <Pressable onPress={onClose} hitSlop={12}>
              <Text style={styles.close}>✕</Text>
            </Pressable>
          </View>
        )}

        {paired && (
              <View style={[styles.banner, { borderColor: pairedColor }]}>
                <View style={styles.bannerRow}>
                  {status === "checking" ? (
                    <ActivityIndicator size="small" color={pairedColor} />
                  ) : (
                    <Text style={[styles.bannerCheck, { color: pairedColor }]}>
                      {status === "offline" ? "⚠" : "✓"}
                    </Text>
                  )}
                  <Text style={styles.bannerTitle}>Paired{paired.name ? ` with ${paired.name}` : ""}</Text>
                </View>
                <Text style={styles.bannerSub}>{pairedLine}</Text>
              </View>
            )}

            <Text style={styles.dek}>
              Borrow a stronger brain. Inference runs on a provider device over an end-to-end-encrypted
              peer-to-peer link — this phone just sends the prompt and streams the tokens back. Nothing
              touches a cloud.
            </Text>

            {/* Scan to pair — the primary path */}
            <Pressable onPress={() => setScannerOpen(true)} style={styles.scanBtn}>
              <Text style={styles.scanGlyph}>⌑</Text>
              <View style={{ flex: 1 }}>
                <Text style={styles.scanBtnTitle}>Scan QR to pair</Text>
                <Text style={styles.scanBtnSub}>Point at the code your web app shows</Text>
              </View>
              <Text style={styles.scanChevron}>›</Text>
            </Pressable>

            {/* Status */}
            <View style={styles.statusRow}>
              <View style={styles.statusLeft}>
                {status === "checking" ? (
                  <ActivityIndicator size="small" color={C.sage} />
                ) : (
                  <View style={[styles.dot, { backgroundColor: statusColor }]} />
                )}
                <Text style={[styles.statusText, { color: statusColor }]}>{statusText}</Text>
              </View>
              <Pressable onPress={onPing} disabled={!isValidProviderKey(providerKey)} hitSlop={8}>
                <Text style={[styles.test, !isValidProviderKey(providerKey) && styles.testDisabled]}>↻ TEST</Text>
              </Pressable>
            </View>

            {/* Provider key */}
            <Text style={styles.fieldLabel}>PROVIDER PUBLIC KEY</Text>
            <TextInput
              style={styles.keyInput}
              value={draft}
              onChangeText={setDraft}
              placeholder="64-character hex key from the provider"
              placeholderTextColor={C.faint}
              autoCapitalize="none"
              autoCorrect={false}
              multiline
            />
            <View style={styles.keyMetaRow}>
              <Text style={[styles.hint, draft.length > 0 && !valid && styles.hintError]}>
                {draft.length === 0
                  ? "Run a provider, paste its key here"
                  : valid
                    ? "Valid key"
                    : `${draft.trim().length}/64 hex chars`}
              </Text>
              {dirty && (
                <Pressable onPress={() => onChangeKey(draft.trim())} disabled={!valid} hitSlop={8}>
                  <Text style={[styles.save, !valid && styles.saveDisabled]}>SAVE KEY</Text>
                </Pressable>
              )}
            </View>

            {/* Toggle */}
            <View style={styles.toggleRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.toggleLabel}>Offload to mesh</Text>
                <Text style={styles.toggleSub}>
                  {meshOn ? "Chat runs on the provider" : "Chat runs on this device"}
                </Text>
              </View>
              <Switch
                value={meshOn}
                onValueChange={onToggle}
                disabled={!isValidProviderKey(providerKey)}
                trackColor={{ true: C.sage, false: C.rule }}
                thumbColor={C.cream}
                ios_backgroundColor={C.rule}
              />
            </View>

            {meshOn && (
              <Pressable
                onPress={() => {
                  onToggle(false);
                  setPaired(null);
                }}
                style={styles.disconnectBtn}
              >
                <Text style={styles.disconnectText}>⊘  DISCONNECT FROM MESH</Text>
              </Pressable>
            )}

            <Text style={styles.foot}>
              If the link drops, chat falls back to this device automatically. Transport is
              Noise-encrypted by design — no plaintext on the wire.
            </Text>
            {selfNote ? <Text style={styles.selfNote}>{selfNote}</Text> : null}
      </ScrollView>
      {/* The camera scanner overlays the whole panel while pairing — mounted only while
          scanning so the camera API is never touched at app launch, and absoluteFill so it
          covers the full screen on the MESH route. */}
      {scannerOpen && (
        <QRScanner onClose={() => setScannerOpen(false)} onScanned={onScanned} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  body: { padding: 22, paddingBottom: 40 },
  headRow: { flexDirection: "row", alignItems: "center", gap: 12, marginBottom: 14 },
  markTile: { width: 40, height: 40, borderRadius: 11, backgroundColor: C.ink, alignItems: "center", justifyContent: "center" },
  kicker: { fontFamily: F.monoMed, fontSize: 10, color: C.sageDeep, letterSpacing: TRACKING_LABEL },
  title: { fontFamily: F.display, fontSize: 24, color: C.ink, marginTop: 2 },
  close: { fontFamily: F.body, fontSize: 22, color: C.muted },
  dek: { fontFamily: F.body, fontSize: 16, lineHeight: 24, color: C.inkSoft, marginBottom: 18 },
  banner: {
    backgroundColor: C.paper,
    borderLeftWidth: 3,
    borderRadius: 6,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 18,
  },
  bannerRow: { flexDirection: "row", alignItems: "center", gap: 9 },
  bannerCheck: { fontFamily: F.bodySemi, fontSize: 17 },
  bannerTitle: { fontFamily: F.bodySemi, fontSize: 17, color: C.ink },
  bannerSub: { fontFamily: F.mono, fontSize: 11, color: C.muted, marginTop: 5, letterSpacing: 0.3 },
  scanBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    backgroundColor: C.ink,
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 16,
    marginBottom: 20,
  },
  scanGlyph: { fontSize: 26, color: C.glow },
  scanBtnTitle: { fontFamily: F.bodySemi, fontSize: 18, color: C.cream },
  scanBtnSub: { fontFamily: F.mono, fontSize: 10.5, color: C.faint, letterSpacing: 0.4, marginTop: 2 },
  scanChevron: { fontFamily: F.body, fontSize: 26, color: C.faint },
  visionTestBtn: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: C.sageDeep,
    borderStyle: "dashed",
    borderRadius: 6,
    paddingVertical: 13,
    alignItems: "center",
    marginBottom: 20,
  },
  visionTestText: { fontFamily: F.monoSemi, fontSize: 11, color: C.sageDeep, letterSpacing: TRACKING_LABEL },
  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: C.rule,
  },
  statusLeft: { flexDirection: "row", alignItems: "center", gap: 9 },
  dot: { width: 8, height: 8, borderRadius: 5 },
  statusText: { fontFamily: F.monoMed, fontSize: 11, letterSpacing: TRACKING_LABEL },
  test: { fontFamily: F.monoMed, fontSize: 11, color: C.sageDeep, letterSpacing: TRACKING_LABEL },
  testDisabled: { color: C.faint },
  fieldLabel: { fontFamily: F.monoMed, fontSize: 10, color: C.muted, letterSpacing: TRACKING_LABEL, marginTop: 20, marginBottom: 8 },
  keyInput: {
    fontFamily: F.mono,
    fontSize: 13,
    color: C.ink,
    backgroundColor: C.paper,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: C.ruleStrong,
    borderRadius: 4,
    padding: 12,
    minHeight: 64,
  },
  keyMetaRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 8 },
  hint: { fontFamily: F.mono, fontSize: 11, color: C.muted },
  hintError: { color: C.brick },
  save: { fontFamily: F.monoSemi, fontSize: 11, color: C.sageDeep, letterSpacing: TRACKING_LABEL },
  saveDisabled: { color: C.faint },
  toggleRow: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: 26,
    paddingTop: 18,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: C.rule,
  },
  toggleLabel: { fontFamily: F.bodySemi, fontSize: 18, color: C.ink },
  toggleSub: { fontFamily: F.body, fontSize: 14, color: C.muted, marginTop: 2 },
  disconnectBtn: {
    marginTop: 22,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: C.brick,
    borderRadius: 6,
    paddingVertical: 14,
    alignItems: "center",
  },
  disconnectText: { fontFamily: F.monoSemi, fontSize: 12, color: C.brick, letterSpacing: TRACKING_LABEL },
  foot: { fontFamily: F.body, fontSize: 13, lineHeight: 20, color: C.muted, marginTop: 22 },
  selfNote: { fontFamily: F.mono, fontSize: 10, color: C.faint, marginTop: 12, letterSpacing: 0.4 },
});
