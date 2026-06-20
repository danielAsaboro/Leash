import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import * as ImagePicker from "expo-image-picker";
import * as DocumentPicker from "expo-document-picker";
import { Mic, Square, ArrowUp, Plus, X, Phone, Menu } from "./icons";
import { AddToChat } from "./AddToChat";
import { VoiceCall } from "./VoiceCall";
import { ChatHistory } from "./ChatHistory";
import { MarkdownText } from "./markdown";
import {
  listChats,
  loadChat,
  saveChat,
  deleteChat,
  newChatId,
  deriveTitle,
  type ChatSummary,
  type ChatRecord,
} from "./chats";
import { meshForward, meshVision, abortMeshForward } from "./forwardWorklet";
import { loadStt, startRecording, stopRecording, transcribeWav, type RecHandle } from "./voice";
import { useFonts } from "expo-font";
import {
  Fraunces_400Regular,
  Fraunces_400Regular_Italic,
  Fraunces_600SemiBold,
  Fraunces_900Black,
} from "@expo-google-fonts/fraunces";
import {
  Newsreader_400Regular,
  Newsreader_400Regular_Italic,
  Newsreader_500Medium,
  Newsreader_600SemiBold,
} from "@expo-google-fonts/newsreader";
import {
  IBMPlexMono_400Regular,
  IBMPlexMono_500Medium,
  IBMPlexMono_600SemiBold,
} from "@expo-google-fonts/ibm-plex-mono";

import {
  cancel,
  completion,
  downloadAsset,
  loadModel,
  type ModelProgressUpdate,
  unloadModel,
  VERBOSITY,
} from "@qvac/sdk";
import { CHAT_MODELS, chatEntry, DEFAULT_CHAT_KEY } from "./modelsInventory";
import { getSelectedChatKey, setSelectedChatKey } from "./selectedModel";

import { C, F, TRACKING_LABEL } from "./theme";
import { LeashMark } from "./LeashMark";
import { pickChatProvider, selfConsumerKey, type ChatOffloadTarget } from "./meshClient";
import { NavDrawer } from "./NavDrawer";
import { TabletRail } from "./TabletRail";
import type { Route } from "./tabs";
import { HomeScreen } from "./HomeScreen";
import { FeedScreen } from "./FeedScreen";
import { MeshScreen } from "./MeshScreen";
import { SettingsScreen } from "./SettingsScreen";
import { TasksScreen } from "./TasksScreen";
import { AlertsScreen } from "./AlertsScreen";
import { BrainScreen } from "./BrainScreen";
import { EconomyScreen } from "./EconomyScreen";
import { ServicesScreen } from "./ServicesScreen";
import { initMesh } from "./meshClient";
import { getPrompts, CHAT_SYSTEM_PROMPT, VOICE_RESPONSE_PROMPT } from "./prompts";
import { DEFAULT_IMAGE_PROMPT, NO_THINK_DIRECTIVE } from "./prompt";
import { getConstitution } from "./constitution";
import { listMemories, type Memory } from "./memories";
import { addNotification, unreadCount } from "./notifications";
import * as Device from "expo-device";
import { AppState, Keyboard } from "react-native";
import { buildDeviceTools } from "./lib/agent/tools";
import { runNativeTurn, splitThink, partsFromText, type Part } from "./lib/agent/native-loop";
import { logChatTurn, summarizeParts } from "./lib/agent/chat-log";
import { activeSkillForTurn, syncSkillsFromMesh } from "./lib/agent/skills";
import { MessageParts } from "./ai-elements/MessageParts";
import { reconnect as meshReconnect } from "./meshClient";
import { isTabletLayout } from "./layout";

const SELF_DEVICE = Device.deviceName || Device.modelName || "An iPhone";

/**
 * Leash mobile — your mind, on your own devices. A fully on-device LLM chat: @qvac/sdk
 * runs inference natively on the phone (no server, offline after the first download),
 * dressed in "The Understory" broadsheet brand shared with the web + desktop clients.
 * Requires a PHYSICAL device — llamacpp does not run on the iOS simulator / Android emulator.
 */

// MODEL_LABEL removed — replaced by dynamic chatKey state + chatEntry(chatKey).label below.

/**
 * Compose the chat system message from the user's Brain edits — the persisted Chat prompt
 * override (or its default) plus the constitution's soul/goals and the enabled memories. This is
 * what makes Brain → Prompts / Proactivity / Memory genuinely change how Leash answers (Rule 4),
 * rather than being decorative tabs. The voice directive and `/no_think` are appended at call time.
 */
function composeBaseSystem(chatPrompt: string, soul: string, goals: string, memories: Memory[]): string {
  let s = chatPrompt.trim() || CHAT_SYSTEM_PROMPT;
  if (soul.trim()) s += `\n\nWho you are:\n${soul.trim()}`;
  if (goals.trim()) s += `\n\nWhat the user is working toward:\n${goals.trim()}`;
  if (memories.length) {
    const lines = memories.map((m) => `- (${m.type}) ${m.text}`).join("\n");
    s += `\n\nWhat you know about the user — carry this across conversations:\n${lines}`;
  }
  return s;
}

/** Strip Qwen3 `<think>…</think>` reasoning from displayed/returned text (we run /no_think, but
 *  the model still emits an empty block; also hide an un-closed block mid-stream). */
function stripThink(s: string): string {
  let out = s.replace(/<think>[\s\S]*?<\/think>/gi, "");
  const open = out.indexOf("<think>");
  if (open !== -1) out = out.slice(0, open);
  return out.replace(/^\s+/, "");
}

const SUGGESTIONS = [
  "What can you do offline?",
  "Summarize an idea for me",
  "Draft a short note",
  "Explain a concept simply",
];

type Role = "user" | "assistant";
type Telemetry = { tokens: number; tps: number; ttftMs: number; where: "mesh" | "local"; device?: string };
type ChatMessage = { id: string; role: Role; content: string; telemetry?: Telemetry; image?: string; parts?: Part[] };

let idSeq = 0;
const makeId = () => `m${(idSeq += 1)}`;

/** "⛓ mesh · 142 tok · 18 tok/s · ttft 120 ms" — broadsheet telemetry under a finished answer. */
function telemetryLine(t: Telemetry): string {
  const place = t.where === "mesh" ? `⛓ mesh${t.device ? ` · ${t.device}` : ""}` : "⌂ on-device";
  return [
    place,
    `${t.tokens} tok`,
    t.tps ? `${t.tps} tok/s` : "",
    t.ttftMs ? `ttft ${t.ttftMs} ms` : "",
  ]
    .filter(Boolean)
    .join("  ·  ");
}

export default function App(): React.JSX.Element {
  const { width, height } = useWindowDimensions();
  const tabletShell = isTabletLayout(width, height);
  const [fontsLoaded] = useFonts({
    Fraunces_400Regular,
    Fraunces_400Regular_Italic,
    Fraunces_600SemiBold,
    Fraunces_900Black,
    Newsreader_400Regular,
    Newsreader_400Regular_Italic,
    Newsreader_500Medium,
    Newsreader_600SemiBold,
    IBMPlexMono_400Regular,
    IBMPlexMono_500Medium,
    IBMPlexMono_600SemiBold,
  });

  const [modelId, setModelId] = useState<string | null>(null);
  const [status, setStatus] = useState("Waking the press…");
  const [progress, setProgress] = useState<number | null>(null);
  const [booting, setBooting] = useState(true);

  // Dynamic chat model — driven by the user's saved choice (or the default on fresh install).
  const [chatKey, setChatKey] = useState<string>(DEFAULT_CHAT_KEY);
  const modelLabel = chatEntry(chatKey).label;

  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);

  // Persisted conversations (on-device). The text chat AND the voice call share the current one.
  const [chatId, setChatId] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [chatList, setChatList] = useState<ChatSummary[]>([]);
  const chatCreatedRef = useRef(Date.now());

  // Attachment busy state + the "+" Add-to-Chat sheet + the staged (not-yet-sent) attachments
  // (up to 5, shown as thumbnails hoisted inside the composer box).
  const [attaching, setAttaching] = useState(false);
  const [addSheetOpen, setAddSheetOpen] = useState(false);
  const [attachments, setAttachments] = useState<{ dataUrl: string; uri: string }[]>([]);

  // Voice input — mic push-to-talk (record → on-device Whisper → fill the input).
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const recHandleRef = useRef<RecHandle | null>(null);

  const listRef = useRef<FlatList<ChatMessage>>(null);
  const messagesRef = useRef<ChatMessage[]>([]);
  messagesRef.current = messages;
  const cancelRef = useRef(false);
  const agentAbortRef = useRef<AbortController | null>(null); // aborts the on-device agent loop on stop()
  const modelIdRef = useRef<string | null>(null);
  const activeRequestIdRef = useRef<string | null>(null); // the active single-shot completion's requestId (for targeted cancel)

  // Brain-composed prompt parts (loaded from prompts/constitution/memories on mount, refreshed when
  // the Brain screen edits them). Held in refs so runCompletion — whose deps are empty — reads the
  // latest without re-binding. Initialized to the defaults so the very first turn still has identity.
  const baseSystemRef = useRef<string>(CHAT_SYSTEM_PROMPT);
  const voiceDirectiveRef = useRef<string>(VOICE_RESPONSE_PROMPT);

  // Mesh offload — the phone AUTO-borrows chat compute from a provider it discovers in its joined
  // mesh. No provider key is ever typed or stored; `offload` is the live target (null = on-device).
  const [offload, setOffload] = useState<ChatOffloadTarget | null>(null);
  // The dashboard shell: which screen is showing + the left nav drawer.
  const [route, setRoute] = useState<Route>("chat");
  const [drawerOpen, setDrawerOpen] = useState(false);
  // Unread alerts → the drawer bell badge.
  const [unread, setUnread] = useState(0);
  const [delegatedId, setDelegatedId] = useState<string | null>(null);
  // Full-screen live voice call (hands-free conversation).
  const [callOpen, setCallOpen] = useState(false);
  const consumerKeyRef = useRef<string>(""); // this phone's stable mesh consumerPublicKey (forward identity)
  const offloadRef = useRef<ChatOffloadTarget | null>(null);
  offloadRef.current = offload;
  const meshOnRef = useRef(false);
  meshOnRef.current = !!delegatedId; // "borrowing" = a forward provider target is set

  const hasContent = input.trim().length > 0 || attachments.length > 0;
  const canSend = !!modelId && !isGenerating && hasContent;
  const MAX_ATTACH = 5;
  const openMenu = useCallback(() => {
    if (!tabletShell) setDrawerOpen(true);
  }, [tabletShell]);
  const addAttachment = useCallback((a: { dataUrl: string; uri: string }) => {
    setAttachments((prev) => {
      if (prev.length >= MAX_ATTACH) {
        Alert.alert("Attachments", `You can attach up to ${MAX_ATTACH} images.`);
        return prev;
      }
      return [...prev, a];
    });
  }, []);

  useEffect(() => {
    const t = setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 60);
    return () => clearTimeout(t);
  }, [messages]);

  // Bring the mesh worklet up once on launch so a phone that's already a mesh member recovers its
  // membership and replicates tasks in the background (lazy init covers first use too). Fire-and-forget.
  useEffect(() => {
    void initMesh()
      .then(() => syncSkillsFromMesh()) // pull any desktop-published skills into the local selector
      .catch(() => {});
  }, []);

  // Auto-rejoin: when the app returns to the foreground, nudge the mesh worklet to reconnect (it
  // re-joins the swarm + re-advertises) and refresh skills. Silent and best-effort — no-op when mesh-less.
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        void meshReconnect().catch(() => {});
        void syncSkillsFromMesh().catch(() => {});
      }
    });
    return () => sub.remove();
  }, []);

  // Shared config object for all loadModel calls (mount + selectChatModel switch). Never drift.
  const LLM_CONFIG = { modelType: "llm" as const, modelConfig: { device: "gpu", ctx_size: 4096, verbosity: VERBOSITY.ERROR } };

  // Download + load the model once on mount (using the user's saved chat model choice).
  useEffect(() => {
    let cancelled = false;
    let didDownload = false;
    (async () => {
      try {
        const savedKey = await getSelectedChatKey();
        const entry = chatEntry(savedKey);
        setChatKey(entry.chatKey);
        setStatus("Fetching the model");
        await downloadAsset({
          assetSrc: entry.assetSrc,
          onProgress: (p: ModelProgressUpdate) => {
            if (p.percentage < 100) didDownload = true;
            if (!cancelled) setProgress(Math.round(p.percentage));
          },
        });
        if (cancelled) return;

        setStatus("Loading into memory");
        setProgress(null);
        const id = await loadModel({
          modelSrc: entry.assetSrc,
          ...LLM_CONFIG,
          onProgress: (p: ModelProgressUpdate) => {
            if (!cancelled) setProgress(Math.round(p.percentage));
          },
        });
        if (cancelled) return;

        modelIdRef.current = id;
        setModelId(id);
        setStatus("On the press");
        setProgress(null);
        setBooting(false);
        // Real on-device event → Alerts feed (only when weights were actually fetched, not a cache hit).
        if (didDownload) {
          void addNotification({
            title: "Model ready",
            body: `${entry.label} finished downloading and is loaded on-device.`,
            why: "First run fetches the GGUF weights once; it now runs fully offline.",
            tier: "auto",
          });
        }
      } catch (e) {
        if (!cancelled) {
          const msg = (e as Error)?.message ?? String(e);
          setStatus(`Couldn't start: ${msg}`);
          setBooting(false);
          void addNotification({ title: "Model failed to load", body: msg, tier: "ask" });
        }
      }
    })();
    return () => {
      cancelled = true;
      const id = modelIdRef.current;
      if (id) void unloadModel({ modelId: id, clearStorage: false }).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Pre-warm Whisper once the chat model is up, so the first mic tap transcribes
  // near-instantly instead of stalling on a cold model load/download.
  useEffect(() => {
    if (!modelId) return;
    const t = setTimeout(() => void loadStt().catch(() => {}), 1500);
    return () => clearTimeout(t);
  }, [modelId]);

  // Load (and re-load, after a Brain edit) the composed system prompt parts: the System/Voice
  // prompt overrides, the constitution's soul+goals, and the enabled memories.
  const refreshBrain = useCallback(async () => {
    const [prompts, constitution, memories] = await Promise.all([getPrompts(), getConstitution(), listMemories()]);
    baseSystemRef.current = composeBaseSystem(prompts.chat, constitution.soul, constitution.goals, memories);
    voiceDirectiveRef.current = prompts.voice || VOICE_RESPONSE_PROMPT;
  }, []);

  useEffect(() => {
    void refreshBrain();
  }, [refreshBrain]);

  // Keep the drawer bell badge fresh — on mount, when the drawer opens, and on route changes
  // (the Alerts screen also calls this via onChanged after mark-read / snooze / dismiss).
  const refreshUnread = useCallback(() => void unreadCount().then(setUnread), []);
  useEffect(() => {
    refreshUnread();
  }, [refreshUnread, drawerOpen, route]);

  // Restore the most recent conversation on first mount (or start a fresh one).
  useEffect(() => {
    void (async () => {
      const list = await listChats();
      if (list.length) {
        const rec = await loadChat(list[0]!.id);
        if (rec) {
          chatCreatedRef.current = rec.createdAt;
          setChatId(rec.id);
          setMessages(rec.messages as ChatMessage[]);
          return;
        }
      }
      setChatId(newChatId());
    })();
  }, []);

  // Persist the current conversation whenever it settles (a turn finished, not mid-stream).
  useEffect(() => {
    if (!chatId || isGenerating || messages.length === 0) return;
    const rec: ChatRecord = {
      id: chatId,
      createdAt: chatCreatedRef.current,
      updatedAt: Date.now(),
      title: deriveTitle(messages),
      messages,
    };
    void saveChat(rec);
  }, [messages, isGenerating, chatId]);

  // AUTO-BORROW (forward transport). Poll the joined mesh for a live provider serving a chat model and,
  // with this phone's STABLE mesh identity, mark it as the borrow target. Inference is NOT loaded on the
  // phone (no SDK delegate, no on-phone weights) — runCompletion sends the request over the per-pair
  // forward transport to the provider's RESIDENT serve model (single owner, no duplicate load, no registry
  // contention). When no provider/identity is ready, chat runs on-device. No key is ever typed/hardcoded.
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      const target = await pickChatProvider().catch(() => null);
      if (cancelled) return;
      const ck = target ? await selfConsumerKey().catch(() => "") : "";
      if (cancelled) return;
      if (!target || !ck) {
        if (offloadRef.current) { consumerKeyRef.current = ""; setOffload(null); setDelegatedId(null); }
        return;
      }
      consumerKeyRef.current = ck;
      const cur = offloadRef.current;
      if (!cur || cur.providerPublicKey !== target.providerPublicKey || cur.alias !== target.alias) {
        setOffload(target);
        setDelegatedId(target.providerPublicKey); // non-null marker → meshOnRef/badges reflect "borrowing"
        console.log("[autoborrow] forward target:", target.displayName, "model=", target.alias, "consumer=", ck.slice(0, 8));
      }
    };
    void tick();
    const interval = setInterval(() => void tick(), 6000);
    return () => { cancelled = true; clearInterval(interval); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Borrow start/stop → Alerts feed (a real on-device event), only on an actual transition.
  const lastBorrowingRef = useRef<boolean | null>(null);
  useEffect(() => {
    const borrowing = !!delegatedId;
    if (lastBorrowingRef.current === borrowing) return;
    const first = lastBorrowingRef.current === null;
    lastBorrowingRef.current = borrowing;
    if (first) return; // don't announce the initial state
    const name = offload?.displayName ? ` · ${offload.displayName}` : "";
    void addNotification(
      borrowing
        ? { title: "Borrowing compute", body: `Chat now runs on a mesh provider${name}.`, tier: "auto" }
        : { title: "Back on-device", body: `No mesh provider available; chat runs on this device.`, tier: "notify" },
    );
  }, [delegatedId, offload]);

  // Failure-safe chat model switch — unloads the current model, downloads+loads the new one,
  // restores the previous on failure so the app is never left without a working chat model.
  const switchingRef = useRef(false);
  const selectChatModel = useCallback(async (key: string, onProgress?: (pct: number) => void): Promise<void> => {
    if (switchingRef.current) return;
    if (isGenerating) { Alert.alert("Busy", "Finish the current reply before switching models."); return; }
    const target = chatEntry(key);
    if (target.chatKey === chatKey) return;
    switchingRef.current = true;
    const prev = chatEntry(chatKey);
    const prevId = modelIdRef.current;
    try {
      if (prevId) { try { await unloadModel({ modelId: prevId, clearStorage: false }); } catch { /* continue */ } }
      modelIdRef.current = null;
      setModelId(null);
      await downloadAsset({ assetSrc: target.assetSrc, onProgress: (p: ModelProgressUpdate) => onProgress?.(Math.round(p.percentage)) });
      const id = await loadModel({ modelSrc: target.assetSrc, ...LLM_CONFIG });
      modelIdRef.current = id;
      setModelId(id);
      setChatKey(target.chatKey);
      await setSelectedChatKey(target.chatKey);
    } catch (e) {
      // Failure-safe: restore the previous model so the app is never left without a chat model.
      try {
        await downloadAsset({ assetSrc: prev.assetSrc });
        const id = await loadModel({ modelSrc: prev.assetSrc, ...LLM_CONFIG });
        modelIdRef.current = id;
        setModelId(id);
        setChatKey(prev.chatKey);
      } catch { /* leave refs null; mount-style recovery on next launch */ }
      Alert.alert("Couldn't switch model", e instanceof Error ? e.message : String(e));
    } finally {
      switchingRef.current = false;
    }
  }, [chatKey, isGenerating]);

  const runCompletion = useCallback(
    async (
      history: { role: Role; content: string }[],
      assistantId: string,
      onToken?: (full: string) => void,
      voice?: boolean,
    ): Promise<string> => {
      cancelRef.current = false;
      activeRequestIdRef.current = null;
      const target = offloadRef.current;
      const useMesh = !!target && !!consumerKeyRef.current;
      const where: "mesh" | "local" = useMesh ? "mesh" : "local";
      if (!useMesh && !modelIdRef.current) return "";

      const started = Date.now();
      let firstAt = 0;
      let acc = "";
      // Transcript logging (testing evidence): captured per turn, written in `finally`.
      const prompt = history.length ? history[history.length - 1]!.content : "";
      let turnParts: Part[] = [];
      let turnTelemetry: Telemetry | undefined;
      let turnError: string | undefined;

      // Direct system prompt for the MESH-borrow and VOICE paths: Brain identity (+ voice directive on
      // spoken turns), with `/no_think` to keep the small model fast and markdown-free for TTS. The
      // LOCAL text-chat path below runs the agent loop WITHOUT `/no_think` so reasoning is produced and
      // shown in a collapsible block (the whole point of this screen).
      const directBase = voice ? `${baseSystemRef.current}\n\n${voiceDirectiveRef.current}` : baseSystemRef.current;
      const directSystem = `${directBase}\n${NO_THINK_DIRECTIVE}`;
      const fullHistory = [{ role: "system" as const, content: directSystem }, ...history];

      const writeDisplay = (full: string) => {
        const display = stripThink(full);
        onToken?.(display);
        setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, content: display } : m)));
      };

      try {
        if (useMesh && voice) {
          // FORWARD (voice): borrow the peer's resident serve over the per-pair forward transport, direct
          // fast path (plain text → TTS). Non-voice borrow goes through the agent loop below instead.
          const messages = fullHistory.map((m) => ({ role: m.role, content: m.content }));
          acc = await meshForward({
            providerKey: target!.providerPublicKey,
            consumerKey: consumerKeyRef.current,
            model: target!.alias,
            messages,
            onChunk: (full) => {
              if (cancelRef.current) return;
              if (!firstAt) firstAt = Date.now();
              writeDisplay(full);
            },
          });
          acc = stripThink(acc);
          const elapsed = (Date.now() - started) / 1000;
          const tokens = Math.max(1, Math.round(acc.length / 4));
          const tps = elapsed > 0 ? Math.round(tokens / elapsed) : 0;
          const ttftMs = firstAt ? firstAt - started : 0;
          const telemetry: Telemetry = { tokens, tps, ttftMs, where: "mesh", device: target!.displayName };
          console.log(`[chat] DONE where=mesh provider=${target!.displayName} model=${target!.alias} chars=${acc.length} ~${tps} tok/s ttft ${ttftMs}ms`);
          setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, content: acc || (cancelRef.current ? "⊘ Stopped." : ""), telemetry } : m)));
        } else if (voice) {
          // LOCAL VOICE: direct fast path — plain tokenStream + stripThink, read aloud by TTS.
          let chunks = 0;
          const result = completion({ modelId: modelIdRef.current!, history: fullHistory, stream: true });
          activeRequestIdRef.current = (result as { requestId?: string }).requestId ?? null;
          for await (const token of result.tokenStream) {
            if (cancelRef.current) break;
            if (!firstAt) firstAt = Date.now();
            chunks += 1;
            acc += token;
            writeDisplay(acc);
          }
          acc = stripThink(acc);
          const elapsed = (Date.now() - started) / 1000;
          let stats: any = null;
          try { stats = await (result as any).stats; } catch {}
          const tokens: number = stats?.tokens ?? stats?.totalTokens ?? stats?.completionTokens ?? chunks;
          const tpsRaw: number = stats?.tokensPerSecond ?? stats?.tps ?? (elapsed > 0 ? tokens / elapsed : 0);
          const ttftMs: number = Math.round(stats?.ttftMs ?? stats?.timeToFirstTokenMs ?? stats?.timeToFirstToken ?? (firstAt ? firstAt - started : 0));
          const device: string | undefined = stats?.backendDevice ?? stats?.device;
          const telemetry: Telemetry = { tokens, tps: Math.round(tpsRaw), ttftMs, where: "local", device };
          console.log(`[chat] DONE where=local(voice) device=${device ?? "?"} tokens=${tokens} tps=${Math.round(tpsRaw)} ttft=${ttftMs}ms`);
          setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, content: acc || (cancelRef.current ? "⊘ Stopped." : ""), telemetry } : m)));
        } else {
          // CHAT AGENT LOOP — native (@qvac/sdk completion), JSC-safe. Renders a parts stream
          // (reasoning → tool steps → answer). Local turns run on-device with tools; borrowed turns
          // stream the peer's resident model over the forward transport (plain chat, reasoning split).

          // Skill selection (lexical + on-device embeddings + RRF). When one clears the gate, inject its
          // body into the system prompt and prepend a "Loaded skill ·" card to the rendered parts.
          const lead: Part[] = [];
          let agentSystem = baseSystemRef.current;
          try {
            const active = await activeSkillForTurn(history[history.length - 1]?.content ?? "");
            if (active) {
              agentSystem += active.systemAddon;
              lead.push({ type: "data-skill", data: active.event });
            }
          } catch (e) {
            console.warn("[chat] skill selection failed:", (e as Error)?.message ?? String(e));
          }

          if (useMesh) {
            // BORROW: stream the peer's resident model over the forward transport (known-good text path),
            // splitting <think> into a reasoning part so borrowed turns get the same reasoning panel.
            const messages = [{ role: "system" as const, content: agentSystem }, ...history];
            acc = await meshForward({
              providerKey: target!.providerPublicKey,
              consumerKey: consumerKeyRef.current,
              model: target!.alias,
              messages,
              onChunk: (full) => {
                if (cancelRef.current) return;
                if (!firstAt) firstAt = Date.now();
                const { reasoning, text } = splitThink(full);
                onToken?.(text);
                setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, parts: partsFromText(reasoning, text, lead, true), content: text } : m)));
              },
            });
            const { reasoning, text } = splitThink(acc);
            acc = text;
            turnParts = partsFromText(reasoning, text, lead, false);
            setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, parts: turnParts } : m)));
          } else {
            // LOCAL: on-device completion with the native tool loop.
            acc = await runNativeTurn({
              modelId: modelIdRef.current!,
              system: agentSystem,
              history,
              tools: buildDeviceTools(),
              maxSteps: 6,
              leadingParts: lead,
              isCancelled: () => cancelRef.current,
              onUpdate: (parts) => {
                if (!firstAt) firstAt = Date.now();
                turnParts = [...parts];
                setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, parts: turnParts } : m)));
              },
            });
          }

          const elapsed = (Date.now() - started) / 1000;
          const tokens = Math.max(1, Math.round(acc.length / 4));
          const tps = elapsed > 0 ? Math.round(tokens / elapsed) : 0;
          const ttftMs = firstAt ? firstAt - started : 0;
          const telemetry: Telemetry = { tokens, tps, ttftMs, where, device: useMesh ? target!.displayName : undefined };
          turnTelemetry = telemetry;
          console.log(`[chat] DONE where=${where}(native) chars=${acc.length} ~${tps} tok/s ttft ${ttftMs}ms`);
          setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, telemetry, content: acc || (cancelRef.current ? "⊘ Stopped." : "") } : m)));
        }
      } catch (e) {
        turnError = (e as Error)?.message ?? String(e);
        console.warn(`[chat] FAILED where=${where}:`, turnError);
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? { ...m, content: `⚠ ${turnError}` }
              : m,
          ),
        );
      } finally {
        setIsGenerating(false);
        // Append this turn to the on-device JSONL transcript (testing evidence). Best-effort.
        const { reasoning, tools, skill } = summarizeParts(turnParts);
        void logChatTurn({
          ts: new Date().toISOString(),
          device: SELF_DEVICE,
          where,
          ...(voice ? { voice: true } : {}),
          model: useMesh ? target?.alias ?? "?" : modelIdRef.current ?? "?",
          ...(useMesh && target ? { provider: target.displayName } : {}),
          prompt,
          ...(reasoning ? { reasoning } : {}),
          answer: acc,
          ...(tools.length ? { tools } : {}),
          ...(skill ? { skill } : {}),
          ...(turnTelemetry ? { telemetry: { tokens: turnTelemetry.tokens, tps: turnTelemetry.tps, ttftMs: turnTelemetry.ttftMs } } : {}),
          ...(turnError ? { error: turnError } : {}),
        });
      }
      return acc;
    },
    [],
  );

  // A spoken turn from the live call: lands in the shared transcript and runs the LLM
  // (mesh or local), streaming tokens to the caller for the on-screen caption + TTS.
  const handleVoiceTurn = useCallback(
    async (text: string, onToken?: (full: string) => void): Promise<string> => {
      if (!modelId) return "";
      const userMsg: ChatMessage = { id: makeId(), role: "user", content: text };
      const assistantId = makeId();
      setMessages((prev) => [...prev, userMsg, { id: assistantId, role: "assistant", content: "" }]);
      setIsGenerating(true);
      const history = [...messagesRef.current, userMsg].map((m) => ({ role: m.role, content: m.content }));
      return runCompletion(history, assistantId, onToken, true);
    },
    [modelId, runCompletion],
  );

  const send = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!modelId || isGenerating || !trimmed) return;
      setInput("");
      setIsGenerating(true);

      const userMsg: ChatMessage = { id: makeId(), role: "user", content: trimmed };
      const assistantId = makeId();
      setMessages((prev) => [...prev, userMsg, { id: assistantId, role: "assistant", content: "" }]);

      const history = [...messagesRef.current, userMsg].map((m) => ({ role: m.role, content: m.content }));
      void runCompletion(history, assistantId);
    },
    [modelId, isGenerating, runCompletion],
  );

  const stop = useCallback(() => {
    cancelRef.current = true;
    // On-device agent loop: abort the AI SDK stream so a multi-step turn stops promptly.
    agentAbortRef.current?.abort();
    // Borrowed (forward) chat: cancel the provider's decode — the worklet sends a forward-control
    // cancel so the provider aborts its local serve fetch (cancel-bridge; safe on 0.13.5) — and unblock
    // the phone. (Requires the forward worklet bundle rebuilt from forward-worklet.mjs.)
    abortMeshForward();
    // Prefer a targeted cancel of the active single-shot turn's requestId (safe on 0.13.5);
    // fall back to the broad per-model cancel for the multi-step native loop (no single requestId).
    const rid = activeRequestIdRef.current;
    const id = modelIdRef.current;
    if (rid) void (cancel as any)?.({ requestId: rid })?.catch?.(() => {});
    else if (id) void (cancel as any)?.({ modelId: id })?.catch?.(() => {});
  }, []);

  // ── Image(s) → vision over the mesh ──────────────────────────────────
  const sendImage = useCallback(
    async (items: { dataUrl: string; uri: string }[]) => {
      if (isGenerating || items.length === 0) return;
      const prompt = input.trim() || DEFAULT_IMAGE_PROMPT;
      setInput("");
      setIsGenerating(true);
      const userMsg: ChatMessage = { id: makeId(), role: "user", content: prompt, image: items[0]!.uri };
      const assistantId = makeId();
      setMessages((prev) => [...prev, userMsg, { id: assistantId, role: "assistant", content: "" }]);
      let acc = "";
      const target = offloadRef.current;
      if (!target || !consumerKeyRef.current) {
        setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, content: "⚠ Vision needs a mesh provider — join a mesh with a provider that serves a multimodal model." } : m)));
        setIsGenerating(false);
        return;
      }
      try {
        // Same forward transport + resident multimodal model as text — it handles image content too.
        const full = await meshVision(
          target.providerPublicKey,
          consumerKeyRef.current,
          target.alias,
          items.map((i) => i.dataUrl),
          prompt,
          (display) => {
            acc = display;
            setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, content: display } : m)));
          },
        );
        const text = full || acc;
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? { ...m, content: text, telemetry: { tokens: Math.max(1, Math.round(text.length / 4)), tps: 0, ttftMs: 0, where: "mesh", device: target.displayName } }
              : m,
          ),
        );
      } catch (e) {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId ? { ...m, content: `⚠ Mesh vision: ${(e as Error)?.message ?? String(e)}` } : m,
          ),
        );
      } finally {
        setIsGenerating(false);
      }
    },
    [isGenerating, input],
  );

  const pickImage = useCallback(async () => {
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) return Alert.alert("Photos", "Allow photo access to attach an image.");
      setAttaching(true);
      const res = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: "images",
        base64: true,
        quality: 0.6,
        allowsMultipleSelection: true,
        selectionLimit: MAX_ATTACH,
      });
      setAttaching(false);
      if (res.canceled) return;
      for (const a of res.assets ?? []) {
        if (a.base64) addAttachment({ dataUrl: `data:${a.mimeType || "image/jpeg"};base64,${a.base64}`, uri: a.uri });
      }
    } catch (e) {
      setAttaching(false);
      Alert.alert("Couldn't attach image", (e as Error)?.message ?? String(e));
    }
  }, []);

  const takePhoto = useCallback(async () => {
    try {
      const perm = await ImagePicker.requestCameraPermissionsAsync();
      if (!perm.granted) return Alert.alert("Camera", "Allow the camera to take a photo.");
      setAttaching(true);
      const res = await ImagePicker.launchCameraAsync({ base64: true, quality: 0.6 });
      setAttaching(false);
      const a = res.assets?.[0];
      if (res.canceled || !a?.base64) return;
      addAttachment({ dataUrl: `data:${a.mimeType || "image/jpeg"};base64,${a.base64}`, uri: a.uri });
    } catch (e) {
      setAttaching(false);
      Alert.alert("Couldn't take photo", (e as Error)?.message ?? String(e));
    }
  }, []);

  const pickFile = useCallback(async () => {
    try {
      const res = await DocumentPicker.getDocumentAsync({ type: ["image/*", "text/*"], copyToCacheDirectory: true });
      const a = res.assets?.[0];
      if (res.canceled || !a) return;
      const FS = await import("expo-file-system/legacy");
      if ((a.mimeType || "").startsWith("image/")) {
        const b64 = await FS.readAsStringAsync(a.uri, { encoding: "base64" as any });
        addAttachment({ dataUrl: `data:${a.mimeType};base64,${b64}`, uri: a.uri });
      } else {
        const text = await FS.readAsStringAsync(a.uri);
        setInput((prev) => (prev ? prev + "\n" : "") + text.slice(0, 4000));
      }
    } catch (e) {
      Alert.alert("Couldn't attach file", (e as Error)?.message ?? String(e));
    }
  }, []);

  // Send the draft: attached image(s) (with the text as the prompt) go to mesh vision;
  // otherwise a plain text turn.
  const handleSend = useCallback(() => {
    if (!modelId || isGenerating) return;
    Keyboard.dismiss(); // drop the keyboard on send so the conversation fills the screen; tap the box to type again
    if (attachments.length > 0) {
      const items = attachments;
      setAttachments([]);
      void sendImage(items);
    } else if (input.trim().length > 0) {
      send(input);
    }
  }, [modelId, isGenerating, attachments, input, sendImage, send]);

  // Mic push-to-talk: tap to record, tap to stop → transcribe on-device (Whisper) → fill input.
  const toggleRecord = useCallback(async () => {
    if (transcribing) return;
    if (recording) {
      const h = recHandleRef.current;
      recHandleRef.current = null;
      setRecording(false);
      if (!h) return;
      setTranscribing(true);
      try {
        const wav = await stopRecording(h);
        const sttId = await loadStt();
        const text = await transcribeWav(sttId, wav);
        if (text) setInput((prev) => (prev.trim() ? `${prev.trim()} ${text}` : text));
      } catch (e) {
        Alert.alert("Voice", (e as Error)?.message ?? String(e));
      } finally {
        setTranscribing(false);
      }
    } else {
      try {
        void loadStt().catch(() => {}); // warm the model in the background while we record
        const h = await startRecording();
        recHandleRef.current = h;
        setRecording(true);
      } catch (e) {
        Alert.alert("Voice", (e as Error)?.message ?? String(e));
      }
    }
  }, [recording, transcribing]);

  const regenerate = useCallback(() => {
    if (!modelId || isGenerating) return;
    const msgs = messagesRef.current;
    // Drop the trailing assistant turn, keep history through the last user message.
    let cut = msgs.length;
    while (cut > 0 && msgs[cut - 1]!.role === "assistant") cut -= 1;
    const history = msgs.slice(0, cut).map((m) => ({ role: m.role, content: m.content }));
    if (!history.length) return;
    setIsGenerating(true);
    const assistantId = makeId();
    setMessages([...msgs.slice(0, cut), { id: assistantId, role: "assistant", content: "" }]);
    void runCompletion(history, assistantId);
  }, [modelId, isGenerating, runCompletion]);

  // Start a fresh conversation. The current one was already auto-saved after its last turn, so
  // clearing here just opens a new thread (works from the masthead AND mid-call).
  const newChat = useCallback(() => {
    if (isGenerating) stop();
    chatCreatedRef.current = Date.now();
    setChatId(newChatId());
    setMessages([]);
    setInput("");
  }, [isGenerating, stop]);

  const openHistory = useCallback(async () => {
    setChatList(await listChats());
    setHistoryOpen(true);
  }, []);

  const selectChat = useCallback(
    async (id: string) => {
      if (id === chatId) return;
      if (isGenerating) stop();
      const rec = await loadChat(id);
      if (!rec) return;
      chatCreatedRef.current = rec.createdAt;
      setChatId(rec.id);
      setMessages(rec.messages as ChatMessage[]);
      setInput("");
    },
    [chatId, isGenerating, stop],
  );

  const removeChat = useCallback(
    async (id: string) => {
      await deleteChat(id);
      setChatList(await listChats());
      if (id === chatId) newChat();
    },
    [chatId, newChat],
  );

  const lastAssistantId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i]!.role === "assistant") return messages[i]!.id;
    return null;
  }, [messages]);

  if (!fontsLoaded) {
    return (
      <View style={[styles.safe, styles.center]}>
        <LeashMark size={44} mark={C.ink} tile={C.cream} cutout={C.cream} />
      </View>
    );
  }

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="dark-content" backgroundColor={C.cream} />
      <View style={[styles.shell, tabletShell && styles.tabletShell]}>
        {tabletShell ? <TabletRail route={route} unread={unread} onNavigate={setRoute} /> : null}
        <View style={[styles.contentPane, tabletShell && styles.tabletContentPane]}>
      {route === "chat" ? (
      <KeyboardAvoidingView
        style={styles.safe}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={Platform.OS === "ios" ? 4 : 0}
      >
        {/* ── Masthead ─────────────────────────────────────────────── */}
        <View style={styles.masthead}>
          <View style={styles.mastheadRow}>
            {!tabletShell ? (
              <Pressable onPress={openMenu} hitSlop={8} style={styles.markTile}>
                <LeashMark size={26} mark={C.cream} cutout={C.ink} />
              </Pressable>
            ) : null}
            <View style={{ flex: 1 }}>
              <Text style={styles.wordmark}>{tabletShell ? "Chat" : "Leash"}</Text>
              <Text style={styles.tagline}>{tabletShell ? "private · local · mesh-ready" : "your mind · on your own devices"}</Text>
            </View>
            <Pressable onPress={openHistory} hitSlop={10} style={styles.histBtn}>
              <Menu size={20} color={C.inkSoft} strokeWidth={2} />
            </Pressable>
            <Pressable onPress={newChat} hitSlop={10} style={styles.newBtn}>
              <Text style={styles.newBtnText}>NEW</Text>
            </Pressable>
          </View>
          <View style={styles.ruleStrong} />
          <View style={styles.statusRow}>
            <View style={styles.statusLeft}>
              <View style={[styles.dot, { backgroundColor: modelId ? C.sage : C.faint }]} />
              <Text style={styles.kicker}>
                {modelId ? modelLabel : status}
                {progress != null ? ` · ${progress}%` : ""}
              </Text>
            </View>
            <Pressable onPress={() => setRoute("mesh")} hitSlop={8}>
              {meshOnRef.current ? (
                <Text style={[styles.kicker, { color: C.sageDeep }]}>
                  ⛓ MESH · LIVE
                </Text>
              ) : (
                <Text style={styles.kicker}>⌂ ON-DEVICE</Text>
              )}
            </Pressable>
          </View>
          {progress != null && (
            <View style={styles.progressTrack}>
              <View style={[styles.progressFill, { width: `${progress}%` }]} />
            </View>
          )}
        </View>

        {/* ── Conversation ─────────────────────────────────────────── */}
        {messages.length === 0 ? (
          <ScrollView contentContainerStyle={styles.emptyWrap} keyboardShouldPersistTaps="handled">
            <Text style={styles.emptyKicker}>TODAY'S EDITION</Text>
            <Text style={styles.emptyHead}>
              Ask your{"\n"}
              <Text style={styles.emptyHeadItalic}>exocortex.</Text>
            </Text>
            <Text style={styles.emptyDek}>
              A private mind that runs entirely on this device. No servers, no cloud — it keeps working in
              airplane mode.
            </Text>
            <View style={styles.suggestList}>
              {SUGGESTIONS.map((s) => (
                <Pressable
                  key={s}
                  onPress={() => send(s)}
                  disabled={!modelId}
                  style={({ pressed }) => [styles.suggest, pressed && styles.suggestPressed, !modelId && styles.suggestDisabled]}
                >
                  <Text style={styles.suggestArrow}>→</Text>
                  <Text style={styles.suggestText}>{s}</Text>
                </Pressable>
              ))}
            </View>
          </ScrollView>
        ) : (
          <FlatList
            ref={listRef}
            data={messages}
            keyExtractor={(m) => m.id}
            contentContainerStyle={styles.feed}
            keyboardShouldPersistTaps="handled"
            renderItem={({ item }) => (
              <MessageBlock
                message={item}
                generating={isGenerating && item.id === lastAssistantId}
                canRegenerate={!isGenerating && item.id === lastAssistantId && item.role === "assistant"}
                onRegenerate={regenerate}
              />
            )}
          />
        )}

        {/* ── Composer — Claude-style box: attachments hoisted inside, actions in a toolbar ── */}
        <View style={styles.composerWrap}>
          <View style={styles.pill}>
            {attachments.length > 0 ? (
              <View style={styles.attachRow}>
                {attachments.map((a, i) => (
                  <View key={`${a.uri}-${i}`} style={styles.attachChip}>
                    <Image source={{ uri: a.uri }} style={styles.attachThumb} resizeMode="cover" />
                    <Pressable
                      onPress={() => setAttachments((prev) => prev.filter((_, j) => j !== i))}
                      style={styles.attachRemove}
                      hitSlop={8}
                    >
                      <X size={11} color={C.cream} strokeWidth={3} />
                    </Pressable>
                  </View>
                ))}
              </View>
            ) : null}
            <TextInput
              style={styles.pillInput}
              value={input}
              onChangeText={setInput}
              placeholder={modelId ? "Message your exocortex…" : "Loading the model…"}
              placeholderTextColor={C.faint}
              editable={!!modelId}
              multiline
              blurOnSubmit={false}
            />
            <View style={styles.pillToolbar}>
              <Pressable onPress={() => setAddSheetOpen(true)} disabled={isGenerating} style={styles.toolBtn} hitSlop={6}>
                <Plus size={22} color={C.inkSoft} strokeWidth={2} />
              </Pressable>
              <View style={{ flex: 1 }} />
              {attaching ? <ActivityIndicator size="small" color={C.sage} style={{ marginHorizontal: 6 }} /> : null}
              <Pressable onPress={() => setCallOpen(true)} disabled={!modelId} style={styles.toolBtn} hitSlop={6}>
                <Phone size={19} color={modelId ? C.inkSoft : C.faint} strokeWidth={1.9} />
              </Pressable>
              {transcribing ? (
                <View style={[styles.toolBtn, styles.toolBtnBusy]}>
                  <ActivityIndicator size="small" color={C.cream} />
                </View>
              ) : (
                <Pressable onPress={toggleRecord} style={[styles.toolBtn, recording && styles.toolBtnRec]} hitSlop={6}>
                  {recording ? (
                    <Square size={14} color={C.cream} fill={C.cream} strokeWidth={1.5} />
                  ) : (
                    <Mic size={20} color={C.inkSoft} strokeWidth={1.8} />
                  )}
                </Pressable>
              )}
              {isGenerating ? (
                <Pressable onPress={stop} style={styles.pillSend} hitSlop={6}>
                  <Square size={14} color={C.cream} fill={C.cream} strokeWidth={1.5} />
                </Pressable>
              ) : (
                <Pressable
                  onPress={handleSend}
                  disabled={!canSend}
                  style={[styles.pillSend, !hasContent && styles.pillSendIdle]}
                  hitSlop={6}
                >
                  <ArrowUp size={20} color={hasContent ? C.cream : C.faint} strokeWidth={2.4} />
                </Pressable>
              )}
            </View>
          </View>
          <Text style={styles.footerKicker}>PRIVATE · OFFLINE-CAPABLE · NOTHING LEAVES THIS DEVICE</Text>
        </View>
      </KeyboardAvoidingView>
      ) : route === "home" ? (
        <HomeScreen
          onMenu={openMenu}
          modelLabel={modelLabel}
          modelReady={!!modelId}
          meshOn={meshOnRef.current}
          meshLive={meshOnRef.current}
          onNewChat={() => {
            newChat();
            setRoute("chat");
          }}
          onCall={() => setCallOpen(true)}
          onOpenChat={(id) => {
            void selectChat(id);
            setRoute("chat");
          }}
          onGoActivity={() => setRoute("activity")}
          onGoModels={() => setRoute("brain")}
        />
      ) : route === "feed" ? (
        <FeedScreen
          onMenu={openMenu}
          onOpenChat={(id) => {
            void selectChat(id);
            setRoute("chat");
          }}
          onGoActivity={() => setRoute("activity")}
          onGoAlerts={() => setRoute("alerts")}
          onGoServices={() => setRoute("services")}
        />
      ) : route === "mesh" ? (
        <MeshScreen
          onMenu={openMenu}
          selfNote={`this device · consumer · ${modelLabel.toLowerCase()}`}
        />
      ) : route === "settings" ? (
        <SettingsScreen
          onMenu={openMenu}
          modelLabel={modelLabel}
          onGoMesh={() => setRoute("mesh")}
          onClearedConversations={() => newChat()}
          deviceName={SELF_DEVICE}
          mesh={{ on: meshOnRef.current, providerName: offload?.displayName, providerKey: offload?.providerPublicKey ?? "", status: meshOnRef.current ? "online" : "unset" }}
          onResetDevice={() => {
            newChat();
            void refreshBrain();
          }}
        />
      ) : route === "brain" ? (
        <BrainScreen onMenu={openMenu} onChanged={refreshBrain} onPair={() => setRoute("mesh")} selectChatModel={selectChatModel} chatKey={chatKey} />
      ) : route === "activity" ? (
        <TasksScreen onMenu={openMenu} onPair={() => setRoute("mesh")} />
      ) : route === "alerts" ? (
        <AlertsScreen onMenu={openMenu} onChanged={refreshUnread} />
      ) : route === "economy" ? (
        <EconomyScreen
          onMenu={openMenu}
          onPair={() => setRoute("mesh")}
          mesh={{ on: meshOnRef.current, providerName: offload?.displayName, providerKey: offload?.providerPublicKey ?? "", status: meshOnRef.current ? "online" : "unset" }}
        />
      ) : route === "services" ? (
        <ServicesScreen onMenu={openMenu} onPair={() => setRoute("mesh")} selectChatModel={selectChatModel} chatKey={chatKey} />
      ) : (
        null
      )}
        </View>
      </View>

      {!tabletShell ? (
        <NavDrawer
          visible={drawerOpen}
          route={route}
          unread={unread}
          onNavigate={setRoute}
          onClose={() => setDrawerOpen(false)}
        />
      ) : null}

      <AddToChat
        visible={addSheetOpen}
        onClose={() => setAddSheetOpen(false)}
        onCamera={takePhoto}
        onPhotos={pickImage}
        onFiles={pickFile}
      />

      <VoiceCall
        visible={callOpen}
        onClose={() => setCallOpen(false)}
        onVoiceTurn={handleVoiceTurn}
        ready={!!modelId}
        messages={messages}
        onNew={newChat}
      />

      <ChatHistory
        visible={historyOpen}
        chats={chatList}
        currentId={chatId}
        onSelect={selectChat}
        onNew={newChat}
        onDelete={removeChat}
        onClose={() => setHistoryOpen(false)}
      />
    </SafeAreaView>
  );
}

/** One turn rendered as a broadsheet column: a mono kicker byline + serif body. */
function MessageBlock({
  message,
  generating,
  canRegenerate,
  onRegenerate,
}: {
  message: ChatMessage;
  generating: boolean;
  canRegenerate: boolean;
  onRegenerate: () => void;
}) {
  const isUser = message.role === "user";
  const isError = message.content.startsWith("⚠") || message.content.startsWith("⊘");

  // User turns: a right-aligned bubble. Assistant turns: left-aligned prose with a byline.
  if (isUser) {
    return (
      <View style={styles.rowRight}>
        <View style={styles.userBubble}>
          {message.image ? <Image source={{ uri: message.image }} style={styles.bubbleImage} resizeMode="cover" /> : null}
          {message.content ? (
            <Text style={styles.userBubbleText} selectable>
              {message.content}
            </Text>
          ) : null}
        </View>
      </View>
    );
  }

  return (
    <View style={styles.asstBlock}>
      <View style={styles.bylineRow}>
        <View style={styles.bylineBullet} />
        <Text style={[styles.byline, styles.bylineAssistant]}>LEASH</Text>
      </View>
      {message.image ? <Image source={{ uri: message.image }} style={styles.msgImage} resizeMode="cover" /> : null}
      {generating && !message.content && !message.parts?.length ? (
        <View style={styles.thinkingRow}>
          <ActivityIndicator size="small" color={C.sage} />
          <Text style={styles.thinking}>Composing…</Text>
        </View>
      ) : isError ? (
        <Text style={[styles.bodyText, styles.bodyTextError]} selectable>
          {message.content}
        </Text>
      ) : message.parts?.length ? (
        // Agent turns: render the parts stream (reasoning → tool steps → answer).
        <MessageParts parts={message.parts} />
      ) : (
        // Mesh-borrow / voice / direct turns: plain markdown answer.
        <MarkdownText content={message.content} baseStyle={styles.bodyText} />
      )}
      {message.telemetry && (
        <View style={styles.telemetryRow}>
          <Text style={styles.telemetry}>{telemetryLine(message.telemetry)}</Text>
          {canRegenerate && (
            <Pressable onPress={onRegenerate} hitSlop={8}>
              <Text style={styles.regen}>↻ REGENERATE</Text>
            </Pressable>
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.cream },
  center: { alignItems: "center", justifyContent: "center" },
  shell: { flex: 1, backgroundColor: C.cream },
  tabletShell: { flexDirection: "row" },
  contentPane: { flex: 1, minWidth: 0 },
  tabletContentPane: {
    backgroundColor: C.cream,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: C.rule,
  },

  // Masthead
  masthead: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 10 },
  mastheadRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingBottom: 10 },
  markTile: {
    width: 44,
    height: 44,
    borderRadius: 12,
    backgroundColor: C.ink,
    alignItems: "center",
    justifyContent: "center",
  },
  wordmark: { fontFamily: F.display, fontSize: 30, color: C.ink, letterSpacing: -0.5, lineHeight: 34 },
  tagline: {
    fontFamily: F.mono,
    fontSize: 9.5,
    color: C.muted,
    letterSpacing: 1.4,
    textTransform: "uppercase",
    marginTop: 1,
  },
  histBtn: {
    width: 36,
    height: 36,
    borderRadius: 2,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: C.ruleStrong,
    alignItems: "center",
    justifyContent: "center",
    marginRight: 8,
  },
  newBtn: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: C.ruleStrong,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 2,
  },
  newBtnText: { fontFamily: F.monoMed, fontSize: 10, color: C.inkSoft, letterSpacing: TRACKING_LABEL },
  ruleStrong: { height: StyleSheet.hairlineWidth, backgroundColor: C.ink },
  rule: { height: StyleSheet.hairlineWidth, backgroundColor: C.rule },
  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingTop: 8,
  },
  statusLeft: { flexDirection: "row", alignItems: "center", gap: 7 },
  dot: { width: 7, height: 7, borderRadius: 4 },
  kicker: {
    fontFamily: F.monoMed,
    fontSize: 10,
    color: C.muted,
    letterSpacing: TRACKING_LABEL,
    textTransform: "uppercase",
  },
  progressTrack: {
    height: 3,
    backgroundColor: C.rule,
    borderRadius: 2,
    overflow: "hidden",
    marginTop: 10,
  },
  progressFill: { height: "100%", backgroundColor: C.sageDeep, borderRadius: 2 },

  // Empty state
  emptyWrap: { paddingHorizontal: 24, paddingTop: 30, paddingBottom: 24 },
  emptyKicker: {
    fontFamily: F.monoMed,
    fontSize: 10,
    color: C.sageDeep,
    letterSpacing: TRACKING_LABEL,
    marginBottom: 14,
  },
  emptyHead: { fontFamily: F.display, fontSize: 46, color: C.ink, lineHeight: 46, letterSpacing: -1 },
  emptyHeadItalic: { fontFamily: F.displayItalic, color: C.sageDeep },
  emptyDek: {
    fontFamily: F.body,
    fontSize: 17,
    lineHeight: 26,
    color: C.inkSoft,
    marginTop: 16,
    maxWidth: 460,
  },
  suggestList: { marginTop: 26, gap: 0 },
  suggest: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: C.rule,
  },
  suggestPressed: { opacity: 0.55 },
  suggestDisabled: { opacity: 0.4 },
  suggestArrow: { fontFamily: F.body, fontSize: 18, color: C.sage },
  suggestText: { fontFamily: F.bodyMed, fontSize: 17, color: C.ink, flex: 1 },

  // Feed
  feed: { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 18 },
  // User turns → right-aligned bubble; assistant turns → left-aligned prose.
  rowRight: { flexDirection: "row", justifyContent: "flex-end", paddingVertical: 7 },
  userBubble: {
    maxWidth: "82%",
    backgroundColor: C.sageDeep,
    borderRadius: 18,
    borderBottomRightRadius: 5,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  userBubbleText: { fontFamily: F.bodyMed, fontSize: 16.5, lineHeight: 24, color: C.cream },
  bubbleImage: { width: 200, height: 200, borderRadius: 10, marginBottom: 8, backgroundColor: C.rule, alignSelf: "stretch" },
  asstBlock: { paddingTop: 10, paddingBottom: 14 },
  bylineRow: { flexDirection: "row", alignItems: "center", gap: 7, marginBottom: 7 },
  bylineBullet: { width: 7, height: 7, backgroundColor: C.sage, transform: [{ rotate: "45deg" }] },
  byline: { fontFamily: F.monoSemi, fontSize: 10.5, letterSpacing: TRACKING_LABEL },
  bylineUser: { color: C.muted },
  bylineAssistant: { color: C.sageDeep },
  bodyText: { fontFamily: F.body, fontSize: 17.5, lineHeight: 27, color: C.inkSoft },
  bodyTextUser: { fontFamily: F.bodyMed, color: C.ink },
  bodyTextError: { fontFamily: F.mono, fontSize: 14, color: C.brick, lineHeight: 21 },
  thinkingRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 4 },
  thinking: { fontFamily: F.displayItalic, fontSize: 17, color: C.muted },
  telemetryRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 12,
    gap: 12,
  },
  telemetry: { fontFamily: F.mono, fontSize: 10, color: C.faint, letterSpacing: 0.6, flex: 1 },
  regen: { fontFamily: F.monoMed, fontSize: 10, color: C.sageDeep, letterSpacing: TRACKING_LABEL },

  // Composer — Claude-style input pill with actions inside.
  composerWrap: { paddingHorizontal: 20, paddingTop: 0, paddingBottom: 8 },
  pill: {
    backgroundColor: C.paper,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: C.ruleStrong,
    borderRadius: 26,
    paddingHorizontal: 8,
    paddingTop: 6,
    paddingBottom: 6,
    marginTop: 10,
  },
  pillInput: {
    fontFamily: F.body,
    fontSize: 17,
    color: C.ink,
    paddingHorizontal: 8,
    paddingTop: 10,
    paddingBottom: 4,
    minHeight: 48,
    maxHeight: 150,
  },
  pillToolbar: { flexDirection: "row", alignItems: "center", gap: 4, paddingTop: 2 },
  toolBtn: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
  toolBtnRec: { backgroundColor: C.brick },
  toolBtnBusy: { backgroundColor: C.sageDeep },
  pillSend: { width: 40, height: 40, borderRadius: 20, backgroundColor: C.sageDeep, alignItems: "center", justifyContent: "center" },
  pillSendIdle: { backgroundColor: C.rule },
  attachRow: { flexDirection: "row", flexWrap: "wrap", gap: 10, paddingTop: 8, paddingHorizontal: 4, paddingBottom: 2 },
  attachChip: { width: 58, height: 58 },
  attachThumb: {
    width: 58,
    height: 58,
    borderRadius: 12,
    backgroundColor: C.rule,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: C.rule,
  },
  attachRemove: {
    position: "absolute",
    top: -6,
    right: -6,
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: C.ink,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    borderColor: C.paper,
  },
  actionRow: { flexDirection: "row", alignItems: "center", gap: 6, paddingTop: 10 },
  actionBtn: {
    width: 40,
    height: 40,
    borderRadius: 8,
    backgroundColor: C.paper,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: C.rule,
    alignItems: "center",
    justifyContent: "center",
  },
  actionBtnRec: { backgroundColor: C.brick, borderColor: C.brick },
  actionGlyph: { fontSize: 18 },
  recHint: { fontFamily: F.mono, fontSize: 10.5, color: C.brick, marginLeft: 8, letterSpacing: 0.3 },
  msgImage: { width: 180, height: 180, borderRadius: 8, marginBottom: 10, backgroundColor: C.rule },
  composer: { flexDirection: "row", alignItems: "flex-end", gap: 10, paddingTop: 12 },
  input: {
    flex: 1,
    fontFamily: F.body,
    fontSize: 17,
    color: C.ink,
    backgroundColor: C.paper,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: C.ruleStrong,
    borderRadius: 4,
    paddingHorizontal: 14,
    paddingTop: 11,
    paddingBottom: 11,
    maxHeight: 130,
  },
  sendBtn: {
    width: 46,
    height: 46,
    borderRadius: 4,
    backgroundColor: C.sageDeep,
    alignItems: "center",
    justifyContent: "center",
  },
  sendBtnDisabled: { backgroundColor: C.ruleStrong },
  sendArrow: { color: C.cream, fontSize: 22, fontWeight: "700", lineHeight: 24 },
  stopBtn: {
    width: 46,
    height: 46,
    borderRadius: 4,
    backgroundColor: C.brick,
    alignItems: "center",
    justifyContent: "center",
  },
  stopSquare: { width: 14, height: 14, borderRadius: 2, backgroundColor: C.cream },
  footerKicker: {
    fontFamily: F.mono,
    fontSize: 8.5,
    color: C.faint,
    letterSpacing: 1.6,
    textAlign: "center",
    marginTop: 12,
  },
});
