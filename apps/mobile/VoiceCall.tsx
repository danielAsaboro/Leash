import React, { useCallback, useEffect, useRef, useState } from "react";
import { Animated, Easing, Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import Svg, { Circle, Defs, RadialGradient, Stop } from "react-native-svg";
import { C, F, TRACKING_LABEL } from "./theme";
import { X, Mic, Plus } from "./icons";
import { loadStt, loadTts, startRecording, stopRecording, transcribeWav, synthToFile, playWav, stopPlayback, fileKB } from "./voice";
import { stripMarkdownForSpeech, segmentSentences, pickFillerPhrase } from "./speech";

/**
 * Full-screen hands-free voice call — the mobile port of apps/web/components/VoiceCall.tsx,
 * mirroring its end-to-end UX: spoken turns land in the SAME transcript (shown here as a live,
 * auto-scrolling conversation), the reply is spoken PROGRESSIVELY (sentence 1 plays while the
 * rest still generates), and a short query-relevant SPOKEN FILLER masks the think gap. All
 * on-device via @qvac/sdk: Whisper STT → the shared LLM → Supertonic TTS.
 *
 * Loop: listen (record + meter) → end-of-speech (VAD) → transcribe → think → speak → listen.
 */

type CallState = "idle" | "listening" | "capturing" | "transcribing" | "thinking" | "speaking" | "error";
type CallMsg = { id: string; role: "user" | "assistant"; content: string };

// VAD on the 0..1 mic level (derived from metering dBFS). Tuned for an iPhone mic; adjust here.
const ONSET = 0.5;
const SILENCE = 0.42;
const ONSET_SUSTAIN_MS = 140;
const SILENCE_HANG_MS = 800;
const MIN_UTTER_MS = 300;
const MAX_UTTER_MS = 13_000;
const FILLER_DELAY_MS = 650;

const LABELS: Record<CallState, string> = {
  idle: "Tap to start",
  listening: "Listening…",
  capturing: "Listening…",
  transcribing: "Got it…",
  thinking: "Thinking…",
  speaking: "Speaking…",
  error: "Something went wrong",
};

export function VoiceCall({
  visible,
  onClose,
  onVoiceTurn,
  ready,
  messages,
  onNew,
}: {
  visible: boolean;
  onClose: () => void;
  onVoiceTurn: (text: string, onToken?: (full: string) => void) => Promise<string>;
  ready: boolean;
  messages: CallMsg[];
  onNew: () => void;
}): React.JSX.Element {
  const [state, setState] = useState<CallState>("idle");
  const [level, setLevel] = useState(0);
  const [note, setNote] = useState("");
  const [muted, setMuted] = useState(false);

  const stateRef = useRef<CallState>("idle");
  const mountedRef = useRef(false);
  const mutedRef = useRef(false);
  const recRef = useRef<Awaited<ReturnType<typeof startRecording>> | null>(null);
  const speechRef = useRef(false);
  const captureStartRef = useRef(0);
  const lastVoiceRef = useRef(0);
  const onsetSinceRef = useRef(0);
  const endingRef = useRef(false);
  const interruptRef = useRef(false);
  const scrollRef = useRef<ScrollView | null>(null);

  // TTS pipeline (progressive, sentence-chunked) + spoken filler bookkeeping.
  const ttsIdRef = useRef<string | null>(null);
  const ttsQueueRef = useRef<string[]>([]);
  const pumpingRef = useRef(false);
  const turnDoneRef = useRef(false);
  const spokenCharsRef = useRef(0);
  const fillerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fillerDoneRef = useRef(false);
  const turnSeedRef = useRef(0);

  // Peer-call + latest-prop refs (no stale closures: the loop must always call the live versions).
  const turnRef = useRef(onVoiceTurn);
  turnRef.current = onVoiceTurn;
  const beginRef = useRef<() => void>(() => {});
  const levelRef = useRef<(lv: number) => void>(() => {});
  const endRef = useRef<() => void>(() => {});
  const pumpRef = useRef<() => void>(() => {});

  const setCallState = useCallback((s: CallState) => {
    stateRef.current = s;
    setState(s);
  }, []);

  // ── Spoken filler — masks the silent think gap with a short relevant phrase ────
  const stopFiller = useCallback(() => {
    fillerDoneRef.current = true;
    if (fillerTimerRef.current) {
      clearTimeout(fillerTimerRef.current);
      fillerTimerRef.current = null;
    }
  }, []);

  const startFiller = useCallback((text: string) => {
    fillerDoneRef.current = false;
    const phrase = pickFillerPhrase(text, turnSeedRef.current++);
    fillerTimerRef.current = setTimeout(async () => {
      fillerTimerRef.current = null;
      if (!mountedRef.current || stateRef.current !== "thinking" || fillerDoneRef.current) return;
      try {
        const id = ttsIdRef.current ?? (await loadTts());
        ttsIdRef.current = id;
        const f = await synthToFile(id, phrase);
        if (!mountedRef.current || stateRef.current !== "thinking" || fillerDoneRef.current) return;
        await playWav(f);
      } catch {
        /* offline / cold → no filler, graceful */
      }
    }, FILLER_DELAY_MS);
  }, []);

  // ── Progressive TTS pump: synth + play one queued sentence at a time, in order ──
  const pump = useCallback(async () => {
    if (pumpingRef.current) return;
    pumpingRef.current = true;
    while (ttsQueueRef.current.length && mountedRef.current && !interruptRef.current) {
      const sentence = ttsQueueRef.current.shift() as string;
      stopFiller();
      if (stateRef.current !== "speaking") setCallState("speaking");
      try {
        const id = ttsIdRef.current ?? (await loadTts());
        ttsIdRef.current = id;
        const f = await synthToFile(id, sentence);
        if (!mountedRef.current || interruptRef.current) break;
        await playWav(f);
      } catch {
        /* drop this chunk, keep going */
      }
    }
    pumpingRef.current = false;
    if (ttsQueueRef.current.length === 0 && turnDoneRef.current) {
      turnDoneRef.current = false;
      if (mountedRef.current && !mutedRef.current && !interruptRef.current) beginRef.current();
    }
  }, [setCallState, stopFiller]);
  pumpRef.current = () => void pump();

  // ── The listen → transcribe → think → speak loop ──────────────────────────────
  const beginListening = useCallback(async () => {
    if (!mountedRef.current || mutedRef.current) return;
    speechRef.current = false;
    captureStartRef.current = 0;
    lastVoiceRef.current = 0;
    onsetSinceRef.current = 0;
    endingRef.current = false;
    setCallState("listening");
    try {
      const h = await startRecording({ onLevel: (lv) => levelRef.current(lv) });
      if (!mountedRef.current || mutedRef.current) {
        void stopRecording(h).catch(() => {});
        return;
      }
      recRef.current = h;
    } catch (e) {
      setNote((e as Error)?.message ?? String(e));
      setCallState("error");
    }
  }, [setCallState]);

  const handleLevel = useCallback(
    (lv: number) => {
      setLevel(lv);
      const st = stateRef.current;
      if (st !== "listening" && st !== "capturing") return;
      const now = Date.now();
      if (lv >= ONSET) {
        lastVoiceRef.current = now;
        if (!onsetSinceRef.current) onsetSinceRef.current = now;
        if (!speechRef.current && now - onsetSinceRef.current >= ONSET_SUSTAIN_MS) {
          speechRef.current = true;
          captureStartRef.current = now;
          setCallState("capturing");
        }
      } else if (lv < SILENCE) {
        onsetSinceRef.current = 0;
      }
      if (stateRef.current === "capturing" && speechRef.current) {
        const dur = now - captureStartRef.current;
        const quiet = now - lastVoiceRef.current;
        if (dur >= MAX_UTTER_MS || (dur >= MIN_UTTER_MS && quiet >= SILENCE_HANG_MS)) {
          endRef.current();
        }
      }
    },
    [setCallState],
  );

  const endUtterance = useCallback(async () => {
    if (endingRef.current) return;
    endingRef.current = true;
    const h = recRef.current;
    recRef.current = null;
    setCallState("transcribing");
    let wav: string | null = null;
    try {
      if (h) wav = await stopRecording(h);
    } catch {
      return void beginRef.current();
    }
    try {
      const sttId = await loadStt();
      const text = wav ? (await transcribeWav(sttId, wav)).trim() : "";
      if (text.length < 2) {
        const kb = wav ? await fileKB(wav) : 0;
        setNote(`Didn't catch that — ${kb} KB recorded. Keep talking…`);
        return void beginRef.current();
      }
      setNote("");
      await runTurn(text);
    } catch (e) {
      setNote((e as Error)?.message ?? String(e));
      setCallState("error");
    }
  }, [setCallState]);

  // Speaks the reply PROGRESSIVELY: complete sentences are queued as they stream so synthesis of
  // sentence 1 starts before generation finishes. The turn also lands in the shared transcript.
  const runTurn = useCallback(
    async (text: string) => {
      interruptRef.current = false;
      spokenCharsRef.current = 0;
      ttsQueueRef.current = [];
      turnDoneRef.current = false;
      setCallState("thinking");
      startFiller(text);
      // Make sure TTS is loaded (warmed at open) before the first sentence is ready.
      if (!ttsIdRef.current) {
        try {
          ttsIdRef.current = await loadTts();
        } catch {
          /* TTS unavailable → the turn still streams text + appears in the transcript */
        }
      }
      let answer = "";
      try {
        answer = await turnRef.current(text, (full) => {
          const clean = stripMarkdownForSpeech(full);
          const slice = clean.slice(spokenCharsRef.current);
          const { sentences, rest } = segmentSentences(slice);
          if (sentences.length) {
            spokenCharsRef.current += slice.length - rest.length;
            for (const s of sentences) ttsQueueRef.current.push(s);
            pumpRef.current();
          }
        });
      } catch (e) {
        stopFiller();
        setNote((e as Error)?.message ?? String(e));
        setCallState("error");
        return;
      }
      if (!mountedRef.current) return;
      // Flush the trailing partial sentence.
      const cleanFull = stripMarkdownForSpeech(answer);
      const tail = cleanFull.slice(spokenCharsRef.current).trim();
      if (tail) ttsQueueRef.current.push(tail);
      turnDoneRef.current = true;
      if (!ttsQueueRef.current.length && !pumpingRef.current) {
        turnDoneRef.current = false;
        stopFiller();
        if (mountedRef.current && !mutedRef.current) beginRef.current();
      } else {
        pumpRef.current();
      }
    },
    [setCallState, startFiller, stopFiller],
  );

  // Keep peer-call refs pointed at the latest function instances every render.
  levelRef.current = handleLevel;
  beginRef.current = () => void beginListening();
  endRef.current = () => void endUtterance();

  // ── Lifecycle: arm + warm on open, tear down on close ─────────────────────────
  useEffect(() => {
    if (!visible) return;
    mountedRef.current = true;
    mutedRef.current = false;
    interruptRef.current = false;
    setMuted(false);
    setNote("");
    // Warm STT + TTS so turn 1 isn't cold (first Supertonic synth is ~10s cold, ~0.3s after).
    void loadStt().catch(() => {});
    void (async () => {
      try {
        const id = await loadTts();
        ttsIdRef.current = id;
        await synthToFile(id, "Okay."); // throwaway warmup synth
      } catch {
        /* offline → first synth will be cold but still works */
      }
    })();
    if (ready) beginRef.current();
    else {
      setNote("The model is still loading…");
      setCallState("idle");
    }
    return () => {
      mountedRef.current = false;
      interruptRef.current = true;
      stopFiller();
      const h = recRef.current;
      recRef.current = null;
      if (h) void stopRecording(h).catch(() => {});
      void stopPlayback().catch(() => {});
      ttsQueueRef.current = [];
      pumpingRef.current = false;
      turnDoneRef.current = false;
      setCallState("idle");
      setLevel(0);
    };
  }, [visible, ready]);

  const hangUp = useCallback(() => {
    interruptRef.current = true;
    onClose();
  }, [onClose]);

  const toggleMute = useCallback(() => {
    const next = !mutedRef.current;
    mutedRef.current = next;
    setMuted(next);
    interruptRef.current = true;
    stopFiller();
    void stopPlayback().catch(() => {});
    const h = recRef.current;
    recRef.current = null;
    if (h) void stopRecording(h).catch(() => {});
    if (next) setCallState("idle");
    else {
      interruptRef.current = false;
      beginRef.current();
    }
  }, [setCallState, stopFiller]);

  // Start a fresh conversation without leaving the call — the loop keeps listening, new turns
  // land in the new (empty) thread. (Also doubles as a recover-from-error / restart-listening.)
  const startNew = useCallback(() => {
    interruptRef.current = true;
    stopFiller();
    void stopPlayback().catch(() => {});
    ttsQueueRef.current = [];
    pumpingRef.current = false;
    turnDoneRef.current = false;
    setNote("");
    onNew();
    interruptRef.current = false;
    beginRef.current();
  }, [onNew, stopFiller]);

  const liveSpeaking = state === "speaking" || state === "thinking";

  return (
    <Modal visible={visible} animationType="fade" onRequestClose={hangUp} statusBarTranslucent>
      <View style={styles.stage}>
        <View style={styles.header}>
          <Orb state={state} level={level} />
          <Text style={styles.stateLabel}>{muted ? "Paused" : LABELS[state]}</Text>
        </View>

        <ScrollView
          ref={scrollRef}
          style={styles.convo}
          contentContainerStyle={styles.convoContent}
          onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })}
          showsVerticalScrollIndicator={false}
        >
          {messages.length === 0 ? (
            <Text style={styles.hint}>Say something — Leash is listening.</Text>
          ) : (
            messages.map((m, i) => {
              const isUser = m.role === "user";
              const streaming = !isUser && i === messages.length - 1 && liveSpeaking && !m.content;
              return (
                <View key={m.id} style={[styles.bubbleRow, isUser ? styles.rowRight : styles.rowLeft]}>
                  <View style={[styles.bubble, isUser ? styles.bubbleUser : styles.bubbleAsst]}>
                    <Text style={[styles.bubbleText, isUser ? styles.bubbleTextUser : styles.bubbleTextAsst]}>
                      {m.content || (streaming ? "…" : "")}
                    </Text>
                  </View>
                </View>
              );
            })
          )}
          {note ? <Text style={styles.note}>{note}</Text> : null}
        </ScrollView>

        <View style={styles.controls}>
          <Pressable onPress={startNew} style={styles.ctrlBtn} hitSlop={10}>
            <Plus size={24} color={C.cream} strokeWidth={2.2} />
          </Pressable>
          <Pressable onPress={toggleMute} style={[styles.ctrlBtn, !muted && styles.ctrlActive]} hitSlop={10}>
            <Mic size={24} color={muted ? C.faint : C.cream} strokeWidth={2} />
          </Pressable>
          <Pressable onPress={hangUp} style={[styles.ctrlBtn, styles.ctrlHangup]} hitSlop={10}>
            <X size={26} color={C.cream} strokeWidth={2.4} />
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

// ── The orb — a glowing gradient core, a breathing halo, and three tilted ─────
// orbital rings whose glowing dots circle on different planes (atom-like).

const BOX = 248;
const CORE = 120;
const ORBITS = [
  { size: 248, rotateX: 72, rotateY: 0, dir: 1, dur: 9000 },
  { size: 206, rotateX: 68, rotateY: 62, dir: -1, dur: 14000 },
  { size: 236, rotateX: 70, rotateY: 118, dir: 1, dur: 22000 },
];

function coreStops(state: CallState): [string, string, string] {
  if (state === "error") return ["#e57a6a", C.brick, "#7d1d12"];
  if (state === "thinking" || state === "transcribing") return [C.glow, C.sageDeep, "#1d3d27"];
  return [C.glow, C.sage, C.sageDeep];
}

const Orb = React.memo(function Orb({ state, level }: { state: CallState; level: number }): React.JSX.Element {
  const breathe = useRef(new Animated.Value(0)).current;
  const halo = useRef(new Animated.Value(0)).current;
  const ring = useRef(new Animated.Value(1)).current;
  const spins = useRef(ORBITS.map(() => new Animated.Value(0))).current;

  useEffect(() => {
    const breatheLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(breathe, { toValue: 1, duration: 1700, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(breathe, { toValue: 0, duration: 1700, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ]),
    );
    const haloLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(halo, { toValue: 1, duration: 1400, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(halo, { toValue: 0, duration: 1400, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ]),
    );
    breatheLoop.start();
    haloLoop.start();
    return () => {
      breatheLoop.stop();
      haloLoop.stop();
    };
  }, [breathe, halo]);

  useEffect(() => {
    const loops = ORBITS.map((o, i) =>
      Animated.loop(Animated.timing(spins[i]!, { toValue: 1, duration: o.dur, easing: Easing.linear, useNativeDriver: true })),
    );
    loops.forEach((l) => l.start());
    return () => loops.forEach((l) => l.stop());
  }, [spins]);

  useEffect(() => {
    const active = state === "listening" || state === "capturing";
    Animated.timing(ring, {
      toValue: active ? 1 + Math.min(level, 0.5) * 1.1 : state === "speaking" ? 1.16 : 1,
      duration: 90,
      useNativeDriver: true,
    }).start();
  }, [level, state, ring]);

  const breatheScale = breathe.interpolate({ inputRange: [0, 1], outputRange: [1, 1.05] });
  const haloScale = halo.interpolate({ inputRange: [0, 1], outputRange: [0.92, 1.12] });
  const speaking = state === "speaking";
  const haloOpacity = halo.interpolate({ inputRange: [0, 1], outputRange: speaking ? [0.3, 0.62] : [0.16, 0.34] });
  const [s0, s1, s2] = coreStops(state);
  const dotColor = state === "error" ? "#e57a6a" : C.glow;
  const allOrbits = state !== "thinking" && state !== "transcribing";

  return (
    <View style={styles.orbBox}>
      <Animated.View style={[styles.halo, { opacity: haloOpacity, transform: [{ scale: haloScale }] }]} />
      <Animated.View style={[styles.levelRing, { transform: [{ scale: ring }] }]} />
      {ORBITS.map((o, i) => {
        const rotate = spins[i]!.interpolate({
          inputRange: [0, 1],
          outputRange: o.dir > 0 ? ["0deg", "360deg"] : ["360deg", "0deg"],
        });
        const r = o.size / 2 - 7;
        return (
          <Animated.View
            key={i}
            pointerEvents="none"
            style={[
              styles.orbitLayer,
              { width: o.size, height: o.size, opacity: allOrbits ? 1 : 0.4 },
              { transform: [{ perspective: 700 }, { rotateX: `${o.rotateX}deg` }, { rotateY: `${o.rotateY}deg` }, { rotate }] },
            ]}
          >
            <Svg width={o.size} height={o.size}>
              <Circle cx={o.size / 2} cy={o.size / 2} r={r} stroke={C.sage} strokeWidth={1.25} fill="none" opacity={0.5} />
              <Circle cx={o.size / 2 + r} cy={o.size / 2} r={10} fill={dotColor} opacity={0.2} />
              <Circle cx={o.size / 2 + r} cy={o.size / 2} r={5} fill={dotColor} />
            </Svg>
          </Animated.View>
        );
      })}
      <Animated.View style={[styles.core, { transform: [{ scale: breatheScale }] }]}>
        <Svg width={CORE} height={CORE}>
          <Defs>
            <RadialGradient id="orbCore" cx="34%" cy="28%" r="78%">
              <Stop offset="0%" stopColor={s0} />
              <Stop offset="55%" stopColor={s1} />
              <Stop offset="100%" stopColor={s2} />
            </RadialGradient>
            <RadialGradient id="orbSpec" cx="32%" cy="24%" r="34%">
              <Stop offset="0%" stopColor="#ffffff" stopOpacity={0.8} />
              <Stop offset="100%" stopColor="#ffffff" stopOpacity={0} />
            </RadialGradient>
          </Defs>
          <Circle cx={CORE / 2} cy={CORE / 2} r={CORE / 2} fill="url(#orbCore)" />
          <Circle cx={CORE / 2} cy={CORE / 2} r={CORE / 2} fill="url(#orbSpec)" />
        </Svg>
      </Animated.View>
    </View>
  );
});

const styles = StyleSheet.create({
  stage: { flex: 1, backgroundColor: C.control, paddingTop: 64, paddingBottom: 44, paddingHorizontal: 20 },
  header: { alignItems: "center", justifyContent: "center" },
  orbBox: { width: BOX, height: BOX, alignItems: "center", justifyContent: "center" },
  halo: {
    position: "absolute",
    width: 206,
    height: 206,
    borderRadius: 103,
    backgroundColor: C.glow,
    shadowColor: C.glow,
    shadowOpacity: 0.9,
    shadowRadius: 56,
    shadowOffset: { width: 0, height: 0 },
  },
  levelRing: {
    position: "absolute",
    width: CORE + 26,
    height: CORE + 26,
    borderRadius: (CORE + 26) / 2,
    borderWidth: 1.5,
    borderColor: C.glow,
    opacity: 0.45,
  },
  orbitLayer: { position: "absolute", alignItems: "center", justifyContent: "center" },
  core: {
    width: CORE,
    height: CORE,
    borderRadius: CORE / 2,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: C.glow,
    shadowOpacity: 0.8,
    shadowRadius: 32,
    shadowOffset: { width: 0, height: 0 },
  },
  stateLabel: {
    fontFamily: F.monoMed,
    fontSize: 12,
    color: C.glow,
    letterSpacing: TRACKING_LABEL,
    textTransform: "uppercase",
    marginTop: 6,
  },
  convo: { flex: 1, alignSelf: "stretch", marginTop: 12 },
  convoContent: { paddingVertical: 12, gap: 10 },
  hint: { fontFamily: F.body, fontSize: 16, color: C.faint, textAlign: "center", marginTop: 24 },
  bubbleRow: { flexDirection: "row" },
  rowRight: { justifyContent: "flex-end" },
  rowLeft: { justifyContent: "flex-start" },
  bubble: { maxWidth: "86%", paddingHorizontal: 14, paddingVertical: 10, borderRadius: 16 },
  bubbleUser: { backgroundColor: C.sageDeep, borderBottomRightRadius: 5 },
  bubbleAsst: { backgroundColor: C.control2, borderBottomLeftRadius: 5, borderWidth: StyleSheet.hairlineWidth, borderColor: C.controlLine },
  bubbleText: { fontSize: 16.5, lineHeight: 24 },
  bubbleTextUser: { fontFamily: F.bodyMed, color: C.cream },
  bubbleTextAsst: { fontFamily: F.body, color: C.cream },
  note: { fontFamily: F.mono, fontSize: 12, color: C.faint, textAlign: "center", marginTop: 8 },
  controls: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 26, paddingTop: 8 },
  ctrlBtn: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: C.control2,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: C.controlLine,
    alignItems: "center",
    justifyContent: "center",
  },
  ctrlActive: { backgroundColor: C.sageDeep, borderColor: C.sage },
  ctrlHangup: { backgroundColor: C.brick, borderColor: C.brick },
});
