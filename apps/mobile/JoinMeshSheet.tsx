import React, { useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { C, F, TRACKING_LABEL } from "./theme";
import { Camera } from "./icons";
import { QRScanner } from "./QRScanner";
import { joinMesh } from "./meshClient";

/**
 * Join-a-mesh bottom sheet — opened from the Mesh tab's "+" action. Two paths to the SAME
 * blind-pairing invite a desktop mints (Leash → Settings → Devices → your mesh → Invite a device):
 * scan its QR, or paste its sync key. Icon-led, short labels — the app's design language.
 */
export function JoinMeshSheet({ onClose, onJoined }: { onClose: () => void; onJoined: () => void }) {
  const [scanOpen, setScanOpen] = useState(false);
  const [invite, setInvite] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const join = async (hex: string) => {
    const inv = hex.trim();
    if (inv.length < 16) { setErr("That doesn't look like a full invite."); return; }
    setBusy(true); setErr(null);
    try {
      await joinMesh(inv);
      onJoined();
    } catch (e: any) {
      setErr(e?.message || "Join failed — is the invite still showing on the desktop?");
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={StyleSheet.absoluteFill}>
      <Pressable style={styles.scrim} onPress={onClose} />
      <View style={styles.sheet}>
        <View style={styles.grabber} />
        <View style={styles.headRow}>
          <Text style={styles.title}>Join a mesh</Text>
          <Pressable onPress={onClose} hitSlop={12}><Text style={styles.close}>✕</Text></Pressable>
        </View>
        <Text style={styles.dek}>Scan the invite QR your desktop shows, or paste its sync key. Single-use; expires shortly.</Text>

        <Pressable onPress={() => { setErr(null); setScanOpen(true); }} disabled={busy} style={styles.scanBtn}>
          <Camera size={18} color={C.cream} strokeWidth={2} />
          <Text style={styles.scanText}>Scan invite</Text>
        </Pressable>

        <View style={styles.orRow}>
          <View style={styles.orLine} /><Text style={styles.orText}>or</Text><View style={styles.orLine} />
        </View>

        <TextInput
          style={styles.input}
          value={invite}
          onChangeText={(t) => { setInvite(t); setErr(null); }}
          placeholder="Paste sync key"
          placeholderTextColor={C.faint}
          autoCapitalize="none"
          autoCorrect={false}
          multiline
        />
        {err ? <Text style={styles.err}>{err}</Text> : null}
        <Pressable onPress={() => void join(invite)} disabled={busy || invite.trim().length < 16} style={[styles.joinBtn, (busy || invite.trim().length < 16) && { opacity: 0.4 }]}>
          {busy ? <ActivityIndicator size="small" color={C.cream} /> : null}
          <Text style={styles.joinText}>{busy ? "Joining…" : "Join"}</Text>
        </Pressable>
      </View>

      {scanOpen && (
        <QRScanner onClose={() => setScanOpen(false)} onInvite={(inv) => { setScanOpen(false); void join(inv); }} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  scrim: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(20,18,14,0.45)" },
  sheet: { position: "absolute", left: 0, right: 0, bottom: 0, backgroundColor: C.cream, borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingHorizontal: 22, paddingTop: 10, paddingBottom: 38 },
  grabber: { alignSelf: "center", width: 38, height: 4, borderRadius: 2, backgroundColor: C.rule, marginBottom: 14 },
  headRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  title: { fontFamily: F.display, fontSize: 22, color: C.ink },
  close: { fontFamily: F.body, fontSize: 22, color: C.muted },
  dek: { fontFamily: F.body, fontSize: 14.5, lineHeight: 21, color: C.muted, marginTop: 4, marginBottom: 18 },
  scanBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10, backgroundColor: C.ink, borderRadius: 10, paddingVertical: 15 },
  scanText: { fontFamily: F.bodySemi, fontSize: 16, color: C.cream },
  orRow: { flexDirection: "row", alignItems: "center", gap: 10, marginVertical: 16 },
  orLine: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: C.rule },
  orText: { fontFamily: F.mono, fontSize: 11, color: C.faint },
  input: { fontFamily: F.mono, fontSize: 12.5, color: C.ink, backgroundColor: C.paper, borderWidth: StyleSheet.hairlineWidth, borderColor: C.ruleStrong, borderRadius: 8, padding: 12, minHeight: 56 },
  err: { fontFamily: F.mono, fontSize: 11.5, color: C.brick, marginTop: 8 },
  joinBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, backgroundColor: C.sageDeep, borderRadius: 10, paddingVertical: 14, marginTop: 12 },
  joinText: { fontFamily: F.bodySemi, fontSize: 16, color: C.cream },
});
