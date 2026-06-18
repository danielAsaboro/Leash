/**
 * RN port of `apps/web/components/ai-elements/reasoning.tsx`.
 *
 * A collapsible reasoning panel for the model's `<think>` stream. Collapsed by default; auto-opens
 * while reasoning streams, shows a shimmering "Thinking…" then "Thought for N seconds" and
 * auto-collapses ~1s after the reasoning ends. This is what replaces the old `stripThink()` —
 * reasoning is now shown deliberately in its own block instead of being discarded (or leaked as
 * half-open `<think` tags).
 */
import React, { useEffect, useRef, useState } from "react";
import { Animated, Pressable, StyleSheet, Text, View } from "react-native";
import { Brain, ChevronDown } from "lucide-react-native";
import { C, F, TRACKING_LABEL } from "../theme";
import { MarkdownText } from "../markdown";

const AUTO_CLOSE_MS = 1000;

/** A low-cost opacity pulse — the RN stand-in for the web's text shimmer. */
function Shimmer({ children }: { children: React.ReactNode }): React.JSX.Element {
  const v = useRef(new Animated.Value(0.45)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(v, { toValue: 1, duration: 700, useNativeDriver: true }),
        Animated.timing(v, { toValue: 0.45, duration: 700, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [v]);
  return <Animated.Text style={[styles.label, { opacity: v }]}>{children}</Animated.Text>;
}

export function Reasoning({ text, isStreaming }: { text: string; isStreaming: boolean }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [duration, setDuration] = useState<number | undefined>(undefined);
  const startRef = useRef<number | null>(null);
  const everStreamedRef = useRef(isStreaming);
  const [autoClosed, setAutoClosed] = useState(false);

  // Track streaming start → compute duration on stop (mirrors the web timing).
  useEffect(() => {
    if (isStreaming) {
      everStreamedRef.current = true;
      if (startRef.current === null) startRef.current = Date.now();
    } else if (startRef.current !== null) {
      setDuration(Math.max(1, Math.ceil((Date.now() - startRef.current) / 1000)));
      startRef.current = null;
    }
  }, [isStreaming]);

  // Auto-open while streaming.
  useEffect(() => {
    if (isStreaming && !open) setOpen(true);
  }, [isStreaming]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-collapse once, shortly after streaming ends.
  useEffect(() => {
    if (everStreamedRef.current && !isStreaming && open && !autoClosed) {
      const t = setTimeout(() => {
        setOpen(false);
        setAutoClosed(true);
      }, AUTO_CLOSE_MS);
      return () => clearTimeout(t);
    }
  }, [isStreaming, open, autoClosed]);

  const message = isStreaming || duration === 0 ? null : duration === undefined ? "Thought for a few seconds" : `Thought for ${duration} second${duration === 1 ? "" : "s"}`;

  return (
    <View style={styles.wrap}>
      <Pressable style={styles.trigger} onPress={() => setOpen((o) => !o)} hitSlop={6}>
        <Brain size={14} color={C.muted} />
        {message === null ? <Shimmer>Thinking…</Shimmer> : <Text style={styles.label}>{message}</Text>}
        <ChevronDown size={14} color={C.faint} style={{ transform: [{ rotate: open ? "180deg" : "0deg" }] }} />
      </Pressable>
      {open && text.length > 0 ? (
        <View style={styles.content}>
          <MarkdownText content={text} baseStyle={styles.contentText} />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginBottom: 10 },
  trigger: { flexDirection: "row", alignItems: "center", gap: 7 },
  label: { fontFamily: F.monoMed, fontSize: 11, color: C.muted, letterSpacing: TRACKING_LABEL * 0.4 },
  content: { marginTop: 8, paddingLeft: 11, borderLeftWidth: 2, borderLeftColor: C.rule },
  contentText: { fontFamily: F.body, fontSize: 14, color: C.muted, lineHeight: 21 },
});
