import React, { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { C, F, TRACKING_LABEL } from "./theme";
import { ScreenHeader } from "./ScreenHeader";
import { listChats } from "./chats";
import { listTasks } from "./tasks";
import { listNotifications } from "./notifications";
import { buildLocalFeedStories, type FeedSection, type FeedStory } from "./feed";

const SECTIONS: ("ALL" | FeedSection)[] = ["ALL", "AI", "COMPUTE", "SOLANA", "BRIEF"];

function dateline(): string {
  return new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
}

function age(ts: number): string {
  const mins = Math.max(0, Math.floor((Date.now() - ts) / 60_000));
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function FeedScreen({
  onMenu,
  onOpenChat,
  onGoActivity,
  onGoAlerts,
  onGoServices,
}: {
  onMenu: () => void;
  onOpenChat: (id: string) => void;
  onGoActivity: () => void;
  onGoAlerts: () => void;
  onGoServices: () => void;
}) {
  const [stories, setStories] = useState<FeedStory[]>([]);
  const [section, setSection] = useState<"ALL" | FeedSection>("ALL");

  useEffect(() => {
    let alive = true;
    void Promise.all([listChats(), listTasks(), listNotifications()]).then(([chats, tasks, notifications]) => {
      if (!alive) return;
      setStories(buildLocalFeedStories({ chats, tasks, notifications }));
    });
    return () => {
      alive = false;
    };
  }, []);

  const shown = useMemo(() => (section === "ALL" ? stories : stories.filter((s) => s.section === section)), [section, stories]);
  const lead = shown[0];
  const rest = shown.slice(1);

  const openStory = (story: FeedStory) => {
    if (story.target === "chat" && story.targetId) onOpenChat(story.targetId);
    else if (story.target === "activity") onGoActivity();
    else onGoAlerts();
  };

  return (
    <View style={{ flex: 1, backgroundColor: C.cream }}>
      <ScreenHeader kicker="The Understory" title="Feed" onMenu={onMenu} />
      <ScrollView contentContainerStyle={styles.body}>
        <View style={styles.masthead}>
          <Text style={styles.paperName}>THE UNDERSTORY</Text>
          <View style={styles.doubleRule}>
            <View style={styles.ruleStrong} />
            <View style={styles.rule} />
          </View>
          <View style={styles.dateline}>
            <Text style={styles.datelineText}>Late Edition</Text>
            <Text style={styles.datelineText}>{dateline()}</Text>
            <Text style={styles.datelineText}>On-device</Text>
          </View>
        </View>

        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.sectionRow}>
          {SECTIONS.map((s) => {
            const active = section === s;
            return (
              <Pressable key={s} onPress={() => setSection(s)} style={[styles.sectionChip, active && styles.sectionChipOn]}>
                <Text style={[styles.sectionText, active && styles.sectionTextOn]}>{s}</Text>
              </Pressable>
            );
          })}
        </ScrollView>

        {!lead ? (
          <View style={styles.empty}>
            <Text style={styles.emptyHead}>The press is warming up.</Text>
            <Text style={styles.emptyText}>
              Start a chat, add an Activity TODO, or let a local event arrive. The iPad edition is built from real data on this device.
            </Text>
            <Pressable onPress={onGoServices} style={styles.emptyLink}>
              <Text style={styles.emptyLinkText}>OPEN SERVICES ›</Text>
            </Pressable>
          </View>
        ) : (
          <>
            <Pressable onPress={() => openStory(lead)} style={({ pressed }) => [styles.leadStory, pressed && styles.pressed]}>
              <View style={styles.kickerRow}>
                <Text style={styles.kickerSage}>{lead.section}</Text>
                <View style={styles.hairline} />
              </View>
              <Text style={styles.leadHeadline}>{lead.headline}</Text>
              <Text style={styles.leadDek}>{lead.dek}</Text>
              <Text style={styles.meta}>{lead.kicker} · {age(lead.updatedAt)}</Text>
            </Pressable>

            <View style={styles.storyGrid}>
              {rest.map((story) => (
                <Pressable key={story.id} onPress={() => openStory(story)} style={({ pressed }) => [styles.story, pressed && styles.pressed]}>
                  <Text style={styles.kickerSage}>{story.section}</Text>
                  <Text style={styles.storyHeadline}>{story.headline}</Text>
                  <View style={styles.storyRule} />
                  <Text style={styles.storyDek}>{story.dek}</Text>
                  <Text style={styles.meta}>{story.kicker} · {age(story.updatedAt)}</Text>
                </Pressable>
              ))}
            </View>
          </>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: 20, paddingTop: 14, paddingBottom: 42 },
  masthead: { alignItems: "center" },
  paperName: { fontFamily: F.display, fontSize: 36, lineHeight: 40, color: C.ink, letterSpacing: 0 },
  doubleRule: { alignSelf: "stretch", gap: 3, marginTop: 8 },
  ruleStrong: { height: 2, backgroundColor: C.ink },
  rule: { height: StyleSheet.hairlineWidth, backgroundColor: C.ink },
  dateline: { alignSelf: "stretch", flexDirection: "row", justifyContent: "space-between", paddingVertical: 7 },
  datelineText: { fontFamily: F.monoMed, fontSize: 9.5, color: C.muted, letterSpacing: 1.1, textTransform: "uppercase" },
  sectionRow: { gap: 8, paddingTop: 12, paddingBottom: 18 },
  sectionChip: { borderWidth: StyleSheet.hairlineWidth, borderColor: C.ruleStrong, paddingHorizontal: 12, paddingVertical: 7 },
  sectionChipOn: { backgroundColor: C.ink, borderColor: C.ink },
  sectionText: { fontFamily: F.monoMed, fontSize: 10, color: C.muted, letterSpacing: TRACKING_LABEL },
  sectionTextOn: { color: C.cream },
  empty: { alignItems: "center", paddingVertical: 54, paddingHorizontal: 20 },
  emptyHead: { fontFamily: F.displaySemi, fontSize: 28, color: C.ink, textAlign: "center" },
  emptyText: { fontFamily: F.body, fontSize: 17, lineHeight: 25, color: C.inkSoft, textAlign: "center", marginTop: 12 },
  emptyLink: { marginTop: 18 },
  emptyLinkText: { fontFamily: F.monoMed, fontSize: 10, color: C.sageDeep, letterSpacing: TRACKING_LABEL },
  leadStory: { borderBottomWidth: 2, borderBottomColor: C.ink, paddingBottom: 20, marginBottom: 20 },
  kickerRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  kickerSage: { fontFamily: F.monoSemi, fontSize: 10, color: C.sageDeep, letterSpacing: TRACKING_LABEL },
  hairline: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: C.rule },
  leadHeadline: { fontFamily: F.display, fontSize: 44, lineHeight: 43, color: C.ink, marginTop: 10 },
  leadDek: { fontFamily: F.bodyItalic, fontSize: 19, lineHeight: 27, color: C.inkSoft, marginTop: 12 },
  storyGrid: { gap: 18 },
  story: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.rule, paddingBottom: 16 },
  storyHeadline: { fontFamily: F.displaySemi, fontSize: 24, lineHeight: 26, color: C.ink, marginTop: 5 },
  storyRule: { height: StyleSheet.hairlineWidth, backgroundColor: C.rule, marginVertical: 9 },
  storyDek: { fontFamily: F.body, fontSize: 16.5, lineHeight: 24, color: C.inkSoft },
  meta: { fontFamily: F.mono, fontSize: 10, color: C.faint, letterSpacing: 0.5, marginTop: 12, textTransform: "uppercase" },
  pressed: { opacity: 0.58 },
});
