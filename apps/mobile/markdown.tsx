import React from "react";
import { StyleSheet, Text, View, type TextStyle } from "react-native";
import { C, F } from "./theme";

/**
 * A small, dependency-free markdown renderer for assistant answers. The model emits
 * **bold**, *italic*, `code`, `#` headings and `-`/`1.` lists — without this they showed
 * up as literal asterisks on device. We deliberately avoid react-native-markdown-display
 * (and any barrel-heavy lib) because large module graphs black-screen the app under JSC.
 *
 * Supported: paragraphs, # headings, - / * / + bullets, 1. numbered, **bold**, __bold__,
 * *italic*, _italic_, `inline code`. Block math / tables / images are rendered as plain text.
 */

const INLINE = /(\*\*[^*]+\*\*|__[^_]+__|\*[^*\n]+\*|_[^_\n]+_|`[^`\n]+`)/g;

function renderInline(text: string, keyBase: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  INLINE.lastIndex = 0;
  while ((m = INLINE.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const tok = m[0];
    const key = `${keyBase}-${i++}`;
    if (tok.startsWith("**") || tok.startsWith("__")) {
      nodes.push(
        <Text key={key} style={md.bold}>
          {tok.slice(2, -2)}
        </Text>,
      );
    } else if (tok.startsWith("`")) {
      nodes.push(
        <Text key={key} style={md.code}>
          {tok.slice(1, -1)}
        </Text>,
      );
    } else {
      nodes.push(
        <Text key={key} style={md.italic}>
          {tok.slice(1, -1)}
        </Text>,
      );
    }
    last = m.index + tok.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

export function MarkdownText({ content, baseStyle }: { content: string; baseStyle?: TextStyle }): React.JSX.Element {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const blocks: React.ReactNode[] = [];
  let para: string[] = [];

  const flush = (k: string) => {
    if (!para.length) return;
    const joined = para.join(" ");
    blocks.push(
      <Text key={k} style={[baseStyle, md.p]} selectable>
        {renderInline(joined, k)}
      </Text>,
    );
    para = [];
  };

  lines.forEach((raw, idx) => {
    const t = raw.trim();
    if (t === "") {
      flush(`p${idx}`);
      return;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(t);
    if (heading) {
      flush(`p${idx}`);
      blocks.push(
        <Text key={`h${idx}`} style={[baseStyle, md.h]} selectable>
          {renderInline(heading[2]!, `h${idx}`)}
        </Text>,
      );
      return;
    }
    const bullet = /^[-*+]\s+(.*)$/.exec(t);
    if (bullet) {
      flush(`p${idx}`);
      blocks.push(
        <View key={`b${idx}`} style={md.itemRow}>
          <Text style={[baseStyle, md.bulletDot]}>•</Text>
          <Text style={[baseStyle, md.itemText]} selectable>
            {renderInline(bullet[1]!, `b${idx}`)}
          </Text>
        </View>,
      );
      return;
    }
    const numbered = /^(\d+)\.\s+(.*)$/.exec(t);
    if (numbered) {
      flush(`p${idx}`);
      blocks.push(
        <View key={`n${idx}`} style={md.itemRow}>
          <Text style={[baseStyle, md.bulletDot]}>{numbered[1]}.</Text>
          <Text style={[baseStyle, md.itemText]} selectable>
            {renderInline(numbered[2]!, `n${idx}`)}
          </Text>
        </View>,
      );
      return;
    }
    para.push(t);
  });
  flush("pend");

  return <View>{blocks}</View>;
}

const md = StyleSheet.create({
  p: { marginBottom: 10 },
  h: { fontFamily: F.bodySemi, fontSize: 19, marginTop: 6, marginBottom: 8, color: C.ink },
  bold: { fontFamily: F.bodySemi, color: C.ink },
  italic: { fontFamily: F.bodyItalic },
  code: { fontFamily: F.mono, fontSize: 15, color: C.sageDeep },
  itemRow: { flexDirection: "row", marginBottom: 6, paddingRight: 6 },
  bulletDot: { marginRight: 8, color: C.sage },
  itemText: { flex: 1 },
});
