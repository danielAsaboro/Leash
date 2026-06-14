import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  SafeAreaView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import {
  completion,
  downloadAsset,
  LLAMA_3_2_1B_INST_Q4_0,
  loadModel,
  type ModelProgressUpdate,
  unloadModel,
  VERBOSITY,
} from "@qvac/sdk";

/**
 * Leash mobile — a fully on-device LLM chat. The QVAC SDK runs inference natively on the phone
 * (no server, no network after the first model download), via the @qvac/sdk Expo integration.
 * Requires a PHYSICAL device — llamacpp does not run on the iOS simulator / Android emulator.
 */

type Role = "user" | "assistant";
type ChatMessage = { id: string; role: Role; content: string };

let idSeq = 0;
function makeId(): string {
  // Deterministic-enough unique key for list items (avoids Math.random in render paths).
  idSeq += 1;
  return `m${idSeq}`;
}

export default function App(): React.JSX.Element {
  const [modelId, setModelId] = useState<string | null>(null);
  const [status, setStatus] = useState<string>("Initializing…");
  const [downloadPct, setDownloadPct] = useState<number | null>(null);

  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);

  const listRef = useRef<FlatList<ChatMessage>>(null);
  const messagesRef = useRef<ChatMessage[]>([]);
  messagesRef.current = messages;

  const canSend = useMemo(
    () => !!modelId && !isGenerating && input.trim().length > 0,
    [modelId, isGenerating, input],
  );

  useEffect(() => {
    const t = setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 0);
    return () => clearTimeout(t);
  }, [messages]);

  // Download + load the model once on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setStatus("Downloading model…");
        await downloadAsset({
          assetSrc: LLAMA_3_2_1B_INST_Q4_0,
          onProgress: (p: ModelProgressUpdate) => {
            if (!cancelled) setDownloadPct(Math.round(p.percentage));
          },
        });
        if (cancelled) return;

        setStatus("Loading model into memory…");
        const id = await loadModel({
          modelSrc: LLAMA_3_2_1B_INST_Q4_0,
          modelType: "llm",
          modelConfig: { device: "gpu", ctx_size: 2048, verbosity: VERBOSITY.ERROR },
          onProgress: (p: ModelProgressUpdate) => {
            if (!cancelled) setDownloadPct(Math.round(p.percentage));
          },
        });
        if (cancelled) return;

        setModelId(id);
        setStatus("Ready");
        setDownloadPct(null);
      } catch (e) {
        if (!cancelled) setStatus(`Init failed: ${(e as Error)?.message ?? String(e)}`);
      }
    })();

    return () => {
      cancelled = true;
      const id = modelId;
      if (id) void unloadModel({ modelId: id, clearStorage: false }).catch(() => {});
    };
    // Init runs once; intentionally not keyed on modelId.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSend(): Promise<void> {
    if (!modelId || isGenerating) return;
    const trimmed = input.trim();
    if (!trimmed) return;

    setInput("");
    setIsGenerating(true);

    const userMsg: ChatMessage = { id: makeId(), role: "user", content: trimmed };
    const assistantId = makeId();
    setMessages((prev) => [...prev, userMsg, { id: assistantId, role: "assistant", content: "" }]);

    try {
      const history = [...messagesRef.current, userMsg].map((m) => ({ role: m.role, content: m.content }));
      const result = completion({ modelId, history, stream: true });

      let acc = "";
      for await (const token of result.tokenStream) {
        acc += token;
        setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, content: acc } : m)));
      }
    } catch (e) {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId ? { ...m, content: `❌ Error: ${(e as Error)?.message ?? String(e)}` } : m,
        ),
      );
    } finally {
      setIsGenerating(false);
    }
  }

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView
        style={styles.safe}
        behavior="padding"
        keyboardVerticalOffset={Platform.OS === "ios" ? 8 : StatusBar.currentHeight || 0}
      >
        <View style={styles.header}>
          <Text style={styles.title}>Leash</Text>
          <Text style={styles.subtitle}>
            {status}
            {downloadPct != null ? ` (${downloadPct}%)` : ""}
          </Text>
          {downloadPct != null && (
            <View style={styles.progressBar}>
              <View style={[styles.progressFill, { width: `${downloadPct}%` }]} />
            </View>
          )}
        </View>

        <View style={styles.chat}>
          <FlatList
            ref={listRef}
            data={messages}
            keyExtractor={(m) => m.id}
            renderItem={({ item }) => (
              <View style={[styles.bubble, item.role === "user" ? styles.bubbleUser : styles.bubbleAssistant]}>
                <Text style={styles.bubbleText}>{item.content}</Text>
              </View>
            )}
            contentContainerStyle={styles.chatContent}
          />
        </View>

        <View style={styles.inputRow}>
          <TextInput
            style={styles.input}
            value={input}
            onChangeText={setInput}
            placeholder={modelId ? "Message your on-device assistant…" : "Loading model…"}
            placeholderTextColor="#7E7E8A"
            editable={!!modelId && !isGenerating}
            returnKeyType="send"
            onSubmitEditing={() => canSend && void handleSend()}
            blurOnSubmit={false}
          />
          {isGenerating ? <ActivityIndicator /> : null}
        </View>

        <Text style={styles.hint}>Runs entirely on-device via QVAC — private and offline after the first load.</Text>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#0B0B0F", paddingTop: Platform.OS === "android" ? StatusBar.currentHeight : 0 },
  header: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8 },
  title: { color: "white", fontSize: 18, fontWeight: "600" },
  subtitle: { color: "#A7A7B3", marginTop: 4 },
  progressBar: { height: 8, backgroundColor: "#1A1A22", borderRadius: 4, overflow: "hidden", marginTop: 8 },
  progressFill: { height: "100%", backgroundColor: "#22C55E", borderRadius: 4 },
  chat: { flex: 1 },
  chatContent: { paddingHorizontal: 16, paddingVertical: 12, gap: 10 },
  bubble: { maxWidth: "85%", paddingHorizontal: 12, paddingVertical: 10, borderRadius: 14 },
  bubbleUser: { alignSelf: "flex-end", backgroundColor: "#2B2BFF" },
  bubbleAssistant: { alignSelf: "flex-start", backgroundColor: "#1A1A22" },
  bubbleText: { color: "white", lineHeight: 20 },
  inputRow: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#2A2A33",
    flexDirection: "row",
    gap: 10,
    alignItems: "center",
  },
  input: { flex: 1, backgroundColor: "#121219", color: "white", paddingHorizontal: 12, paddingVertical: 10, borderRadius: 12 },
  hint: { paddingHorizontal: 16, paddingBottom: 12, color: "#7E7E8A", fontSize: 12 },
});
