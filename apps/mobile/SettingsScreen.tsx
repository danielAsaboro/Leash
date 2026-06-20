import React, { useEffect, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { Audio } from "expo-av";
import * as ImagePicker from "expo-image-picker";
import { C, F, TRACKING_LABEL } from "./theme";
import { ScreenHeader } from "./ScreenHeader";
import { TabBar } from "./TabBar";
import { clearChats, deleteChat, listChats } from "./chats";
import { clearMemories } from "./memories";
import { clearTasks } from "./tasks";
import { clearNotes } from "./notes";
import { clearAll as clearNotifications } from "./notifications";
import { KNOWN_SECRETS, listSecretStatus, setSecret, deleteSecret, type SecretStatus } from "./secrets";
import { type OffloadStatus } from "./mesh";
import appJson from "./app.json";
import { SETTINGS_TABS, type SettingsTab } from "./tabSets";
import { SCREEN_COPY } from "./screenCopy";

/**
 * SETTINGS — on-device, full 1:1 with the desktop /settings tab set: Account · Storage · Permissions
 * · Devices · Secrets · About. Account and Secrets are the two tabs the desktop has that the mobile
 * client was missing. Nothing here touches a server — the secret values live in the iOS Keychain and
 * are consumed by connectors on the paired desktop Leash.
 */
type PermState = "granted" | "denied" | "undetermined";
function permLabel(s: PermState): string {
  return s === "granted" ? "ALLOWED" : s === "denied" ? "DENIED" : "NOT ASKED";
}
function permColor(s: PermState): string {
  return s === "granted" ? C.sage : s === "denied" ? C.brick : C.faint;
}

function shortKey(k: string): string {
  return k && k.length > 16 ? `${k.slice(0, 8)}…${k.slice(-6)}` : k || "—";
}

export function SettingsScreen({
  onMenu,
  modelLabel,
  onGoMesh,
  onClearedConversations,
  deviceName,
  mesh,
  onResetDevice,
}: {
  onMenu: () => void;
  modelLabel: string;
  onGoMesh: () => void;
  onClearedConversations: () => void;
  deviceName: string;
  mesh: { on: boolean; providerName?: string; providerKey: string; status: OffloadStatus };
  onResetDevice: () => void;
}) {
  const [tab, setTab] = useState<SettingsTab>("account");
  const [count, setCount] = useState<number | null>(null);
  const [perms, setPerms] = useState<{ mic: PermState; camera: PermState; photos: PermState }>({
    mic: "undetermined",
    camera: "undetermined",
    photos: "undetermined",
  });

  // Secrets — set/not-set status only (never the value), plus an inline editor row.
  const [secrets, setSecrets] = useState<SecretStatus[] | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [savingSecret, setSavingSecret] = useState(false);

  const refreshCount = () => void listChats().then((l) => setCount(l.length));
  const refreshSecrets = () => void listSecretStatus().then(setSecrets);

  useEffect(() => {
    refreshCount();
  }, []);

  useEffect(() => {
    if (tab === "secrets") refreshSecrets();
  }, [tab]);

  // Read (never request) the current permission status — Settings only reports, it doesn't prompt.
  useEffect(() => {
    if (tab !== "permissions") return;
    void (async () => {
      const norm = (status: string): PermState =>
        status === "granted" ? "granted" : status === "denied" ? "denied" : "undetermined";
      const [mic, cam, lib] = await Promise.all([
        Audio.getPermissionsAsync().catch(() => ({ status: "undetermined" })),
        ImagePicker.getCameraPermissionsAsync().catch(() => ({ status: "undetermined" })),
        ImagePicker.getMediaLibraryPermissionsAsync().catch(() => ({ status: "undetermined" })),
      ]);
      setPerms({ mic: norm(mic.status), camera: norm(cam.status), photos: norm(lib.status) });
    })();
  }, [tab]);

  const clearConversations = () => {
    Alert.alert("Clear conversations", "Delete every saved conversation on this device? This can't be undone.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete all",
        style: "destructive",
        onPress: () => {
          void (async () => {
            const list = await listChats();
            for (const c of list) await deleteChat(c.id);
            refreshCount();
            onClearedConversations();
          })();
        },
      },
    ]);
  };

  const resetDevice = () => {
    Alert.alert(
      "Reset this device",
      "Erase ALL on-device Leash data — conversations, memories, tasks, local text entries, and alerts. Secrets in the Keychain are kept. This can't be undone.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Erase everything",
          style: "destructive",
          onPress: () => {
            void (async () => {
              await Promise.all([clearChats(), clearMemories(), clearTasks(), clearNotes(), clearNotifications()]);
              refreshCount();
              onResetDevice();
            })();
          },
        },
      ],
    );
  };

  const saveSecret = (name: string) => {
    const value = draft;
    setSavingSecret(true);
    void (async () => {
      try {
        await setSecret(name, value);
        setEditing(null);
        setDraft("");
        refreshSecrets();
      } catch (e) {
        Alert.alert("Couldn't save", (e as Error)?.message ?? String(e));
      } finally {
        setSavingSecret(false);
      }
    })();
  };

  const clearSecret = (name: string, label: string) => {
    Alert.alert("Clear secret", `Remove ${label} from this device's Keychain?`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Clear",
        style: "destructive",
        onPress: () => void deleteSecret(name).then(refreshSecrets),
      },
    ]);
  };

  const meshSummary = mesh.on
    ? `${mesh.providerName ? mesh.providerName : "Paired provider"} · ${
        mesh.status === "online" ? "live" : mesh.status === "offline" ? "down" : "checking"
      }`
    : "Not paired — on-device only";

  return (
    <View style={{ flex: 1, backgroundColor: C.cream }}>
      <ScreenHeader kicker={SCREEN_COPY.settings.kicker} title={SCREEN_COPY.settings.title} onMenu={onMenu} />
      <TabBar tabs={SETTINGS_TABS} active={tab} onChange={setTab} />

      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        {tab === "account" && (
          <>
            <Row label="Device" value={deviceName} />
            <Row label="Mesh" value={meshSummary} />
            {mesh.on ? <Row label="Provider key" value={shortKey(mesh.providerKey)} /> : null}
            <Row label="Model" value={modelLabel} />
            <Text style={styles.note}>
              Leash mobile is single-user and standalone — there's no cloud account, password, or
              session to manage. Your identity here is this device and (optionally) the mesh provider
              it's paired with.
            </Text>
            <Pressable onPress={resetDevice} style={({ pressed }) => [styles.dangerBtn, pressed && styles.pressed]}>
              <Text style={styles.dangerText}>⊘  RESET THIS DEVICE</Text>
            </Pressable>
            <Text style={styles.subNote}>
              Erases conversations, memories, tasks, local text entries, and alerts. Keychain secrets and the mesh
              pairing are kept.
            </Text>
          </>
        )}

        {tab === "storage" && (
          <>
            <Row label="Conversations" value={count == null ? "…" : String(count)} />
            <Row label="Model" value={modelLabel} />
            <Pressable onPress={clearConversations} style={({ pressed }) => [styles.dangerBtn, pressed && styles.pressed]}>
              <Text style={styles.dangerText}>⊘  CLEAR CONVERSATIONS</Text>
            </Pressable>
            <Text style={styles.note}>
              Conversations are stored as plain files in this app's private container — they never
              leave the device.
            </Text>
          </>
        )}

        {tab === "permissions" && (
          <>
            <PermRow label="Microphone" sub="Voice input — transcribed on-device (Whisper)" state={perms.mic} />
            <PermRow label="Camera" sub="Scans a pairing QR to connect to a provider" state={perms.camera} />
            <PermRow label="Photo library" sub="Attach an image for a mesh vision answer" state={perms.photos} />
            <Text style={styles.note}>
              Status only. To change a permission, use the system Settings app — Leash asks the first
              time a feature needs it.
            </Text>
          </>
        )}

        {tab === "devices" && (
          <>
            <Text style={styles.head}>Your mesh</Text>
            <Text style={styles.note}>
              Pair a provider device to offload inference, or use a desktop Leash for the dashboard
              sections. Pairing lives on the Mesh screen.
            </Text>
            <Pressable onPress={onGoMesh} style={({ pressed }) => [styles.primaryBtn, pressed && styles.pressed]}>
              <Text style={styles.primaryText}>OPEN MESH  ›</Text>
            </Pressable>
          </>
        )}

        {tab === "secrets" && (
          <>
            {secrets == null ? (
              <ActivityIndicator color={C.sage} style={{ marginTop: 24 }} />
            ) : (
              secrets.map((s) => (
                <View key={s.name} style={styles.secretRow}>
                  <View style={styles.secretHead}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.permName}>{s.label}</Text>
                      <Text style={styles.permSub}>{s.hint}</Text>
                    </View>
                    <Text style={[styles.permBadge, { color: s.set ? C.sage : C.faint }]}>
                      {s.set ? "● SET" : "○ NOT SET"}
                    </Text>
                  </View>
                  {editing === s.name ? (
                    <View style={styles.secretEditor}>
                      <TextInput
                        style={styles.secretInput}
                        value={draft}
                        onChangeText={setDraft}
                        placeholder={`Enter ${s.label}`}
                        placeholderTextColor={C.faint}
                        secureTextEntry
                        autoCapitalize="none"
                        autoCorrect={false}
                        autoFocus
                      />
                      <View style={styles.secretBtnRow}>
                        <Pressable onPress={() => { setEditing(null); setDraft(""); }} style={styles.secretGhostBtn}>
                          <Text style={styles.secretGhostText}>CANCEL</Text>
                        </Pressable>
                        <Pressable
                          onPress={() => saveSecret(s.name)}
                          disabled={savingSecret || !draft.trim()}
                          style={[styles.secretSaveBtn, (!draft.trim() || savingSecret) && styles.pressed]}
                        >
                          <Text style={styles.secretSaveText}>{savingSecret ? "SAVING…" : "SAVE"}</Text>
                        </Pressable>
                      </View>
                    </View>
                  ) : (
                    <View style={styles.secretBtnRow}>
                      <Pressable
                        onPress={() => { setEditing(s.name); setDraft(""); }}
                        style={({ pressed }) => [styles.secretGhostBtn, pressed && styles.pressed]}
                      >
                        <Text style={styles.secretGhostText}>{s.set ? "REPLACE" : "SET"}</Text>
                      </Pressable>
                      {s.set ? (
                        <Pressable
                          onPress={() => clearSecret(s.name, s.label)}
                          style={({ pressed }) => [styles.secretGhostBtn, pressed && styles.pressed]}
                        >
                          <Text style={[styles.secretGhostText, { color: C.brick }]}>CLEAR</Text>
                        </Pressable>
                      ) : null}
                    </View>
                  )}
                </View>
              ))
            )}
            <Text style={styles.note}>
              Stored in this device's Keychain — values are never displayed back. Home Assistant and
              SearXNG secrets are consumed by connectors running on your paired desktop Leash.
            </Text>
          </>
        )}

        {tab === "about" && (
          <>
            <Row label="App" value={appJson.expo.name} />
            <Row label="Version" value={appJson.expo.version} />
            <Row label="Engine" value="On-device · @qvac/sdk" />
            <Row label="Developer" value="Mycelium · QVAC" />
            <Row label="License" value="Apache-2.0" />
            <Text style={styles.note}>
              Leash runs entirely on this device — your mind, on your own devices. Built for the QVAC
              Hackathon.
            </Text>
          </>
        )}
      </ScrollView>
    </View>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

function PermRow({ label, sub, state }: { label: string; sub: string; state: PermState }) {
  return (
    <View style={styles.permRow}>
      <View style={{ flex: 1 }}>
        <Text style={styles.permName}>{label}</Text>
        <Text style={styles.permSub}>{sub}</Text>
      </View>
      <Text style={[styles.permBadge, { color: permColor(state) }]}>{permLabel(state)}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: 20, paddingTop: 14, paddingBottom: 40 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    paddingVertical: 15,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: C.rule,
  },
  rowLabel: { fontFamily: F.bodyMed, fontSize: 16, color: C.inkSoft },
  rowValue: { fontFamily: F.mono, fontSize: 13, color: C.ink, letterSpacing: 0.3, flexShrink: 1, textAlign: "right" },
  permRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 15,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: C.rule,
  },
  permName: { fontFamily: F.bodyMed, fontSize: 16, color: C.ink },
  permSub: { fontFamily: F.body, fontSize: 13.5, color: C.muted, marginTop: 2 },
  permBadge: { fontFamily: F.monoMed, fontSize: 10, letterSpacing: TRACKING_LABEL },
  head: { fontFamily: F.display, fontSize: 24, color: C.ink, marginTop: 4 },
  note: { fontFamily: F.body, fontSize: 14.5, lineHeight: 22, color: C.muted, marginTop: 18 },
  subNote: { fontFamily: F.body, fontSize: 13, lineHeight: 19, color: C.faint, marginTop: 10 },
  pressed: { opacity: 0.6 },
  dangerBtn: {
    marginTop: 26,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: C.brick,
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: "center",
  },
  dangerText: { fontFamily: F.monoSemi, fontSize: 12, color: C.brick, letterSpacing: TRACKING_LABEL },
  primaryBtn: { marginTop: 22, backgroundColor: C.ink, borderRadius: 8, paddingVertical: 15, alignItems: "center" },
  primaryText: { fontFamily: F.monoSemi, fontSize: 12, color: C.cream, letterSpacing: TRACKING_LABEL },

  // Secrets
  secretRow: { paddingVertical: 15, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.rule },
  secretHead: { flexDirection: "row", alignItems: "center", gap: 12 },
  secretEditor: { marginTop: 12 },
  secretInput: {
    fontFamily: F.mono,
    fontSize: 14,
    color: C.ink,
    backgroundColor: C.paper,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: C.ruleStrong,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 11,
  },
  secretBtnRow: { flexDirection: "row", gap: 10, marginTop: 12 },
  secretGhostBtn: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: C.ruleStrong,
    borderRadius: 6,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  secretGhostText: { fontFamily: F.monoSemi, fontSize: 10.5, color: C.inkSoft, letterSpacing: 1 },
  secretSaveBtn: { backgroundColor: C.sageDeep, borderRadius: 6, paddingHorizontal: 16, paddingVertical: 8 },
  secretSaveText: { fontFamily: F.monoSemi, fontSize: 10.5, color: C.cream, letterSpacing: 1 },
});
