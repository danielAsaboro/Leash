import React, { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { C, F, TRACKING_LABEL } from "../theme";
import { fmtBytes, listChatModels, listModels, redownload, stateLabel, type ChatModelStatus, type ModelStatus } from "../modelsInventory";
import { loadStt, loadTts, unloadStt, unloadTts } from "../voice";

/**
 * Brain → Models. The phone's real model inventory — exactly the three @qvac/sdk models it wires
 * (chat, STT, TTS), with live state + on-disk size straight from the SDK (no fabricated catalog,
 * Rule 4). Speech models can be loaded/unloaded on demand; the chat model is managed by the app
 * (unloading it would break chat) so it offers re-download only.
 *
 * The top "Chat model" section lets the user pick from the curated phone-runnable chat models;
 * the legacy single "chat" row is replaced by the richer selector below.
 */
function stateColor(s: ModelStatus["state"]): string {
  return s === "loaded" ? C.sage : s === "cached" ? C.sageDeep : s === "not-downloaded" ? C.muted : C.faint;
}

export function ModelsPanel({ selectChatModel, currentChatKey }: { selectChatModel: (key: string, onProgress?: (pct: number) => void) => Promise<void>; currentChatKey: string }) {
  const [models, setModels] = useState<ModelStatus[] | null>(null);
  const [chats, setChats] = useState<ChatModelStatus[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [pct, setPct] = useState<Record<string, number | null>>({});

  const refresh = useCallback(() => {
    void listModels().then(setModels);
    void listChatModels().then(setChats);
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh]);

  const run = (key: string, p: Promise<unknown>) => {
    setBusy(key);
    void p.finally(() => {
      setBusy(null);
      setPct((x) => ({ ...x, [key]: null }));
      refresh();
    });
  };

  const doLoad = (m: ModelStatus) => {
    if (m.key === "stt") run(m.key, loadStt());
    else if (m.key === "tts") run(m.key, loadTts());
  };
  const doUnload = (m: ModelStatus) => {
    if (m.key === "stt") run(m.key, unloadStt());
    else if (m.key === "tts") run(m.key, unloadTts());
  };
  const doRedownload = (m: ModelStatus) => {
    run(m.key, redownload(m, (p) => setPct((x) => ({ ...x, [m.key]: p }))));
  };

  if (models == null) return <ActivityIndicator color={C.sage} style={{ marginTop: 24 }} />;

  return (
    <View>
      {/* ── Chat model selector ───────────────────────────────────── */}
      <Text style={styles.sectionHead}>CHAT MODEL</Text>
      {chats?.map((m) => {
        const isCurrent = m.chatKey === currentChatKey;
        const isBusy = busy === m.chatKey;
        const p = pct[m.chatKey];
        return (
          <View key={m.chatKey} style={styles.row}>
            <View style={styles.rowTop}>
              <View style={{ flex: 1 }}>
                <Text style={styles.name}>{m.label}{isCurrent ? "  ·  current" : ""}</Text>
                <Text style={styles.role}>Chat · {m.alias}</Text>
              </View>
              <View style={styles.badge}>
                <View style={[styles.dot, { backgroundColor: stateColor(m.state) }]} />
                <Text style={[styles.badgeText, { color: stateColor(m.state) }]}>{isBusy && p != null ? `${p}%` : stateLabel(m.state)}</Text>
              </View>
            </View>
            <View style={styles.rowBottom}>
              <Text style={styles.size}>{fmtBytes(m.sizeBytes)}</Text>
              <View style={{ flex: 1 }} />
              {isBusy ? <ActivityIndicator size="small" color={C.sage} /> : !isCurrent ? (
                <Pressable
                  disabled={busy != null}
                  onPress={() => {
                    setBusy(m.chatKey);
                    void selectChatModel(m.chatKey, (p) => setPct((x) => ({ ...x, [m.chatKey]: p }))).finally(() => {
                      setBusy(null);
                      refresh();
                    });
                  }}
                  hitSlop={6}
                  style={styles.actionBtn}
                >
                  <Text style={styles.action}>USE</Text>
                </Pressable>
              ) : null}
            </View>
          </View>
        );
      })}

      {/* ── Media models ─────────────────────────────────────────── */}
      <Text style={[styles.sectionHead, { marginTop: 20 }]}>MEDIA MODELS</Text>
      {models.filter((m) => m.key !== "chat").map((m) => {
        const isBusy = busy === m.key;
        const p = pct[m.key];
        return (
          <View key={m.key} style={styles.row}>
            <View style={styles.rowTop}>
              <View style={{ flex: 1 }}>
                <Text style={styles.name}>{m.label}</Text>
                <Text style={styles.role}>{m.role} · {m.alias}</Text>
              </View>
              <View style={styles.badge}>
                <View style={[styles.dot, { backgroundColor: stateColor(m.state) }]} />
                <Text style={[styles.badgeText, { color: stateColor(m.state) }]}>
                  {isBusy && p != null ? `${p}%` : stateLabel(m.state)}
                </Text>
              </View>
            </View>
            <View style={styles.rowBottom}>
              <Text style={styles.size}>{fmtBytes(m.sizeBytes)}</Text>
              <View style={{ flex: 1 }} />
              {isBusy ? (
                <ActivityIndicator size="small" color={C.sage} />
              ) : (
                <>
                  {m.key !== "chat" && m.state === "loaded" ? (
                    <Pressable onPress={() => doUnload(m)} hitSlop={6} style={styles.actionBtn}>
                      <Text style={styles.action}>UNLOAD</Text>
                    </Pressable>
                  ) : null}
                  {m.key !== "chat" && m.state !== "loaded" ? (
                    <Pressable onPress={() => doLoad(m)} hitSlop={6} style={styles.actionBtn}>
                      <Text style={styles.action}>LOAD</Text>
                    </Pressable>
                  ) : null}
                  <Pressable onPress={() => doRedownload(m)} hitSlop={6} style={styles.actionBtn}>
                    <Text style={styles.action}>{m.state === "not-downloaded" ? "DOWNLOAD" : "RE-DOWNLOAD"}</Text>
                  </Pressable>
                </>
              )}
            </View>
          </View>
        );
      })}
      <Text style={styles.foot}>
        State and size come straight from the on-device SDK. Weights download once (online), then run
        fully offline. The chat model is loaded by the app at launch.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  sectionHead: { fontFamily: F.monoMed, fontSize: 9.5, color: C.muted, letterSpacing: 1.4, textTransform: "uppercase", marginBottom: 4 },
  row: { paddingVertical: 16, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.rule },
  rowTop: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
  name: { fontFamily: F.bodySemi, fontSize: 17, color: C.ink },
  role: { fontFamily: F.mono, fontSize: 11, color: C.muted, letterSpacing: 0.3, marginTop: 3 },
  badge: { flexDirection: "row", alignItems: "center", gap: 6 },
  dot: { width: 7, height: 7, borderRadius: 4 },
  badgeText: { fontFamily: F.monoSemi, fontSize: 9.5, letterSpacing: 1 },
  rowBottom: { flexDirection: "row", alignItems: "center", gap: 14, marginTop: 12 },
  size: { fontFamily: F.mono, fontSize: 11, color: C.faint, letterSpacing: 0.3 },
  actionBtn: { paddingVertical: 2 },
  action: { fontFamily: F.monoMed, fontSize: 10, color: C.sageDeep, letterSpacing: 1 },
  foot: { fontFamily: F.body, fontSize: 13.5, color: C.muted, lineHeight: 20, marginTop: 14 },
});
