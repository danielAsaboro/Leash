import React, { useEffect, useState } from "react";
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
import { joinMesh, meshStatus, type MeshStatus as MeshMemberStatus } from "./meshClient";

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
 * Mesh MEMBERSHIP card — the phone joins the user's private mesh and replicates the task CRDT
 * (distinct from the inference-offload provider key below). Paste the invite a desktop mints
 * (Leash → Mesh → "Add a device", or hypha `POST /mesh/invite`) and tap Join; the worklet
 * blind-pairs in and tasks start syncing. Status shows joined ✓ / peer count / leader.
 */
function MeshMembershipCard() {
  const [invite, setInvite] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [status, setStatus] = useState<MeshMemberStatus | null>(null);

  useEffect(() => {
    let alive = true;
    const tick = () => void meshStatus().then((s) => alive && setStatus(s)).catch(() => {});
    tick();
    const id = setInterval(tick, 5000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  const join = async () => {
    const inv = invite.trim();
    if (inv.length < 16) { setErr("Paste the full invite from your desktop."); return; }
    setBusy(true); setErr(null);
    try {
      await joinMesh(inv);
      setInvite("");
      setStatus(await meshStatus());
    } catch (e: any) {
      setErr(e?.message || "Join failed — is the desktop still showing the invite?");
    } finally { setBusy(false); }
  };

  const joined = status?.joined;
  const line = joined
    ? `Member ✓ · ${status!.peers} peer${status!.peers === 1 ? "" : "s"}${status!.leader ? (status!.leader === status!.deviceId ? " · leader: you" : " · leader: a peer") : ""}${status!.writable ? "" : " · syncing…"}`
    : "Not in a mesh — paste an invite to join";

  return (
    <View style={mstyles.card}>
      <Text style={mstyles.cardKicker}>MESH MEMBERSHIP · SYNC YOUR TASKS</Text>
      <View style={mstyles.statusLine}>
        {busy ? <ActivityIndicator size="small" color={C.sage} /> : <View style={[mstyles.dot, { backgroundColor: joined ? C.sage : C.faint }]} />}
        <Text style={[mstyles.statusLineText, { color: joined ? C.sageDeep : C.muted }]}>{line}</Text>
      </View>
      <TextInput
        style={mstyles.inviteInput}
        value={invite}
        onChangeText={setInvite}
        placeholder="Paste mesh invite (hex)…"
        placeholderTextColor={C.faint}
        autoCapitalize="none"
        autoCorrect={false}
        multiline
      />
      {err ? <Text style={mstyles.err}>{err}</Text> : null}
      <Pressable onPress={join} disabled={busy || invite.trim().length < 16} style={[mstyles.joinBtn, (busy || invite.trim().length < 16) && { opacity: 0.45 }]}>
        <Text style={mstyles.joinBtnText}>{joined ? "JOIN ANOTHER MESH" : "JOIN MESH"}</Text>
      </Pressable>
    </View>
  );
}

const mstyles = StyleSheet.create({
  card: { backgroundColor: C.paper, borderWidth: StyleSheet.hairlineWidth, borderColor: C.ruleStrong, borderRadius: 10, padding: 14, marginBottom: 20 },
  cardKicker: { fontFamily: F.monoMed, fontSize: 10, color: C.sageDeep, letterSpacing: TRACKING_LABEL, marginBottom: 10 },
  statusLine: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 12 },
  dot: { width: 8, height: 8, borderRadius: 5 },
  statusLineText: { fontFamily: F.monoMed, fontSize: 11, letterSpacing: 0.4 },
  inviteInput: { fontFamily: F.mono, fontSize: 12, color: C.ink, backgroundColor: C.cream, borderWidth: StyleSheet.hairlineWidth, borderColor: C.rule, borderRadius: 4, padding: 10, minHeight: 52 },
  err: { fontFamily: F.mono, fontSize: 11, color: C.brick, marginTop: 8 },
  joinBtn: { marginTop: 10, backgroundColor: C.sageDeep, borderRadius: 8, paddingVertical: 12, alignItems: "center" },
  joinBtnText: { fontFamily: F.monoSemi, fontSize: 12, color: C.cream, letterSpacing: TRACKING_LABEL },
});

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

        {/* Mesh membership (task sync) — distinct from the inference-offload provider key below. */}
        <MeshMembershipCard />

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
