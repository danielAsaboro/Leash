import React, { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, Vibration, View } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as Device from "expo-device";
import { C, F, TRACKING_LABEL } from "./theme";

/** Pull a 64-hex provider key out of a scanned payload: bare hex, a `leash://pair?provider=…`
 *  URI, or a small JSON `{ "provider": "…" }`. */
export function parseProviderKey(data: string): string | null {
  const t = (data ?? "").trim();
  if (/^[0-9a-fA-F]{64}$/.test(t)) return t.toLowerCase();
  const m = t.match(/provider=([0-9a-fA-F]{64})/i);
  if (m) return m[1].toLowerCase();
  try {
    const j = JSON.parse(t);
    if (typeof j?.provider === "string" && /^[0-9a-fA-F]{64}$/.test(j.provider)) return j.provider.toLowerCase();
  } catch {}
  return null;
}

/**
 * Pull a MESH INVITE out of a scanned payload — the blind-pairing invite the web's MeshInvite QR
 * encodes (a long even-length hex string, ~132 chars; distinct from a 64-hex provider key). Also
 * tolerates a `leash://join?invite=…` URI or `{ "invite": "…" }` JSON. Returns the hex or null.
 */
export function parseMeshInvite(data: string): string | null {
  const t = (data ?? "").trim().toLowerCase();
  if (/^[0-9a-f]+$/.test(t) && t.length >= 96 && t.length % 2 === 0) return t;
  const m = t.match(/invite=([0-9a-f]{96,})/i);
  if (m) return m[1].toLowerCase();
  try {
    const j = JSON.parse(data);
    if (typeof j?.invite === "string" && /^[0-9a-f]{96,}$/i.test(j.invite)) return j.invite.toLowerCase();
  } catch {}
  return null;
}

/** Parse the full pairing payload — provider key, optional friendly name, optional callback URL. */
export function parsePairPayload(data: string): { key: string; name?: string; cb?: string } | null {
  const key = parseProviderKey(data);
  if (!key) return null;
  const grab = (re: RegExp) => {
    const m = (data ?? "").match(re);
    if (!m) return undefined;
    try {
      return decodeURIComponent(m[1]);
    } catch {
      return m[1];
    }
  };
  return { key, name: grab(/[?&]name=([^&\s]+)/i), cb: grab(/[?&]cb=([^&\s]+)/i) };
}

export function QRScanner({
  onClose,
  onScanned,
  onInvite,
}: {
  onClose: () => void;
  /** Provider-pairing mode (inference offload): scans a 64-hex provider key. */
  onScanned?: (providerKey: string, name?: string, cb?: string) => void;
  /** Mesh-membership mode: scans the blind-pairing invite the web's MeshInvite QR shows. */
  onInvite?: (invite: string) => void;
}) {
  const [permission, requestPermission] = useCameraPermissions();
  const [bad, setBad] = useState(false);
  const [done, setDone] = useState<{ name?: string; mesh?: boolean } | null>(null);
  const handled = useRef(false);

  // On open: reset the one-shot guard and proactively ask for the camera if we can.
  useEffect(() => {
    handled.current = false;
    setBad(false);
    setDone(null);
    if (permission && !permission.granted && permission.canAskAgain) void requestPermission();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [permission?.granted, permission?.canAskAgain]);

  function handleScan(data: string) {
    if (handled.current) return;
    // Mesh-membership mode: accept the blind-pairing invite and hand it to joinMesh.
    if (onInvite) {
      const inv = parseMeshInvite(data);
      if (!inv) {
        setBad(true);
        return;
      }
      handled.current = true;
      Vibration.vibrate(40);
      setDone({ mesh: true });
      setTimeout(() => onInvite(inv), 650);
      return;
    }
    const parsed = parsePairPayload(data);
    if (!parsed) {
      setBad(true);
      return;
    }
    handled.current = true;
    Vibration.vibrate(40);
    setDone({ name: parsed.name });
    // Tell the pairing web page we connected, so it shows the success screen (best-effort).
    if (parsed.cb) {
      const device = Device.deviceName || Device.modelName || "An iPhone";
      void fetch(parsed.cb, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ device, connected: true }),
      }).catch(() => {});
    }
    // Hold the success flash briefly, then hand the key (+ callback) back to the sheet.
    setTimeout(() => onScanned?.(parsed.key, parsed.name, parsed.cb), 850);
  }

  return (
    <View style={[StyleSheet.absoluteFill, styles.root]}>
      {!permission ? (
        <View style={styles.permWrap}>
          <ActivityIndicator color={C.sage} />
          <Text style={styles.cancel}>Starting camera…</Text>
        </View>
      ) : !permission.granted ? (
          <View style={styles.permWrap}>
            <Text style={styles.kicker}>CAMERA</Text>
            <Text style={styles.permTitle}>Let Leash use the camera</Text>
            <Text style={styles.permDek}>
              To pair, Leash scans the QR your web app shows. The camera is used only for this.
            </Text>
            <Pressable onPress={requestPermission} style={styles.primaryBtn}>
              <Text style={styles.primaryBtnText}>ALLOW CAMERA</Text>
            </Pressable>
            <Pressable onPress={onClose} hitSlop={10}>
              <Text style={styles.cancel}>Cancel</Text>
            </Pressable>
          </View>
        ) : (
          <>
            <CameraView
              style={StyleSheet.absoluteFill}
              facing="back"
              barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
              onBarcodeScanned={({ data }) => handleScan(data)}
            />
            {/* Broadsheet overlay */}
            <View style={styles.overlay} pointerEvents="box-none">
              <View style={styles.topbar}>
                <Text style={styles.scanKicker}>{onInvite ? "SCAN MESH INVITE" : "SCAN TO PAIR"}</Text>
                <Pressable onPress={onClose} hitSlop={12}>
                  <Text style={styles.close}>✕</Text>
                </Pressable>
              </View>
              <View style={styles.reticleWrap} pointerEvents="none">
                <View style={styles.reticle}>
                  <View style={[styles.corner, styles.tl]} />
                  <View style={[styles.corner, styles.tr]} />
                  <View style={[styles.corner, styles.bl]} />
                  <View style={[styles.corner, styles.br]} />
                </View>
              </View>
              <View style={styles.hintWrap} pointerEvents="none">
                <Text style={styles.hint}>
                  {bad
                    ? onInvite
                      ? "That isn't a mesh invite QR — show it from Settings → Devices → your mesh → Invite a device."
                      : "That isn't a Leash pairing code — try again."
                    : onInvite
                      ? "Point at the mesh invite QR your desktop shows"
                      : "Point at the QR in your web app"}
                </Text>
              </View>
            </View>
            {done && (
              <View style={styles.successWrap} pointerEvents="none">
                <View style={styles.successCard}>
                  <Text style={styles.successCheck}>✓</Text>
                  <Text style={styles.successTitle}>{done.mesh ? "Invite scanned" : "Paired"}</Text>
                  <Text style={styles.successSub}>
                    {done.mesh ? "Joining the mesh…" : done.name ? `Connecting to ${done.name}…` : "Connecting to provider…"}
                  </Text>
                </View>
              </View>
            )}
          </>
        )}
    </View>
  );
}

const RET = 240;
const styles = StyleSheet.create({
  root: { backgroundColor: "#000", zIndex: 50, elevation: 50 },
  overlay: { flex: 1, justifyContent: "space-between" },
  topbar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingTop: 56,
    paddingHorizontal: 22,
  },
  scanKicker: { fontFamily: F.monoMed, fontSize: 11, color: C.cream, letterSpacing: TRACKING_LABEL },
  close: { fontFamily: F.body, fontSize: 26, color: C.cream },
  reticleWrap: { alignItems: "center", justifyContent: "center" },
  reticle: { width: RET, height: RET },
  corner: { position: "absolute", width: 34, height: 34, borderColor: C.glow },
  tl: { top: 0, left: 0, borderTopWidth: 3, borderLeftWidth: 3, borderTopLeftRadius: 6 },
  tr: { top: 0, right: 0, borderTopWidth: 3, borderRightWidth: 3, borderTopRightRadius: 6 },
  bl: { bottom: 0, left: 0, borderBottomWidth: 3, borderLeftWidth: 3, borderBottomLeftRadius: 6 },
  br: { bottom: 0, right: 0, borderBottomWidth: 3, borderRightWidth: 3, borderBottomRightRadius: 6 },
  hintWrap: { alignItems: "center", paddingBottom: 70, paddingHorizontal: 24 },
  hint: {
    fontFamily: F.mono,
    fontSize: 12,
    color: C.cream,
    textAlign: "center",
    backgroundColor: "rgba(25,23,18,0.6)",
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 4,
    overflow: "hidden",
  },
  successWrap: { ...StyleSheet.absoluteFillObject, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(25,23,18,0.55)" },
  successCard: { alignItems: "center", backgroundColor: C.cream, borderRadius: 16, paddingHorizontal: 36, paddingVertical: 30, gap: 6 },
  successCheck: {
    fontSize: 30,
    color: C.cream,
    width: 56,
    height: 56,
    lineHeight: 54,
    textAlign: "center",
    backgroundColor: C.sage,
    borderRadius: 28,
    overflow: "hidden",
    marginBottom: 6,
  },
  successTitle: { fontFamily: F.display, fontSize: 26, color: C.ink },
  successSub: { fontFamily: F.mono, fontSize: 11, color: C.muted, letterSpacing: 0.4 },
  // Permission gate
  permWrap: { flex: 1, backgroundColor: C.cream, alignItems: "center", justifyContent: "center", padding: 32, gap: 14 },
  kicker: { fontFamily: F.monoMed, fontSize: 10, color: C.sageDeep, letterSpacing: TRACKING_LABEL },
  permTitle: { fontFamily: F.display, fontSize: 28, color: C.ink, textAlign: "center" },
  permDek: { fontFamily: F.body, fontSize: 16, lineHeight: 24, color: C.inkSoft, textAlign: "center" },
  primaryBtn: { backgroundColor: C.sageDeep, paddingHorizontal: 22, paddingVertical: 14, borderRadius: 4, marginTop: 8 },
  primaryBtnText: { fontFamily: F.monoSemi, fontSize: 12, color: C.cream, letterSpacing: TRACKING_LABEL },
  cancel: { fontFamily: F.body, fontSize: 16, color: C.muted, marginTop: 4 },
});
