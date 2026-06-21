/**
 * Renders the agent turn's parts array in order — the on-device equivalent of the web chat's
 * per-part switch. Each part maps to a broadsheet element:
 *   reasoning   → <Reasoning>      (collapsible "Thinking…/Thought for Ns")
 *   text        → <MarkdownText>   (the answer)
 *   tool-* / dynamic-tool → <Tool> (status badge + collapsible IO)
 *   data-skill  → <SkillEventCard> ("Loaded skill ·")
 *   data-agent  → <AgentEventCard> ("Routed to agent ·")
 *   step-start  → a hairline divider between loop steps
 *
 * The parts are built natively (lib/agent/native-loop.ts) — driving the model is JSC-safe `@qvac/sdk`,
 * not the Vercel AI SDK runtime. We deliberately switch on the `type` string directly (no `ai`
 * runtime helpers) so this render path never touches AI SDK code.
 */
import React from "react";
import { StyleSheet, View } from "react-native";
import { MarkdownText } from "../markdown";
import { Reasoning } from "./Reasoning";
import { Tool, type ToolView } from "./Tool";
import { SkillEventCard, type SkillEvent } from "./SkillEventCard";
import { AgentEventCard, type AgentEvent } from "./AgentEventCard";
import { C, F } from "../theme";

type AnyPart = { type: string; [k: string]: unknown };

function answerStyle(): { fontFamily: string; fontSize: number; color: string; lineHeight: number } {
  return { fontFamily: F.body, fontSize: 16, color: C.ink, lineHeight: 24 };
}

export function MessageParts({ parts }: { parts: readonly unknown[] }): React.JSX.Element {
  return (
    <View>
      {(parts as AnyPart[]).map((part, i) => {
        const key = `p${i}`;
        const type = part.type;

        if (type === "reasoning") {
          return <Reasoning key={key} text={(part.text as string) ?? ""} isStreaming={part.state === "streaming"} />;
        }
        if (type === "text") {
          const text = (part.text as string) ?? "";
          if (!text) return null;
          return <MarkdownText key={key} content={text} baseStyle={answerStyle()} />;
        }
        if (typeof type === "string" && (type.startsWith("tool-") || type === "dynamic-tool")) {
          const toolName = (part.toolName as string) ?? (type.startsWith("tool-") ? type.slice(5) : "tool");
          return (
            <Tool
              key={key}
              tool={{ toolName, state: part.state as ToolView["state"], input: part.input, output: part.output, errorText: part.errorText as string | undefined }}
            />
          );
        }
        if (type === "data-skill") {
          return <SkillEventCard key={key} event={part.data as SkillEvent} />;
        }
        if (type === "data-agent") {
          return <AgentEventCard key={key} event={part.data as AgentEvent} />;
        }
        if (type === "step-start") {
          return i === 0 ? null : <View key={key} style={styles.stepRule} />;
        }
        return null;
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  stepRule: { height: 1, backgroundColor: C.rule, marginVertical: 10, opacity: 0.6 },
});
