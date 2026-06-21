import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  AccessibilityInfo,
  ActivityIndicator,
  Animated,
  Easing,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from "react-native";
import { QRScanner } from "./QRScanner";
import { Camera, ChevronRight, Cpu, MeshNodes, RotateCcw } from "./icons";
import { LeashMark } from "./LeashMark";
import { C, F, TRACKING_LABEL } from "./theme";
import type { DeviceSetupMode } from "./onboarding";
import type { DownloadPlan } from "./onboardingPlan";
import type { DeviceSetupDecision } from "@mycelium/brain";

export type WarmStep = {
  key: string;
  label: string;
  status: "pending" | "active" | "done";
};

type BootSource = "new" | "restore";

function derivedProgress(progress: number | null, steps: WarmStep[]): number | null {
  if (progress != null) return Math.max(6, Math.min(100, progress));
  if (!steps.length) return null;
  const done = steps.filter((step) => step.status === "done").length;
  const active = steps.some((step) => step.status === "active") ? 0.5 : 0;
  return Math.round(((done + active) / steps.length) * 100);
}

function failureCopy(error: string, mode: DeviceSetupMode | null, source: BootSource) {
  const text = error.toLowerCase();
  if (text.includes("space") || text.includes("storage") || text.includes("no space")) {
    return {
      title: "This iPad needs more free space",
      body: "Leash could not finish caching its local models. Free up storage, then resume setup from here.",
    };
  }
  if (
    text.includes("network") ||
    text.includes("timed out") ||
    text.includes("offline") ||
    text.includes("econn") ||
    text.includes("unreachable")
  ) {
    return {
      title: "Connect once to finish setup",
      body:
        source === "restore"
          ? "This device needs the network briefly so it can reopen its local runtime cleanly."
          : "First run downloads the local models this device needs. After setup, the app can keep working offline.",
    };
  }
  if (mode === "sync-existing") {
    return {
      title: "This invite needs another pass",
      body: "Open a fresh device invite on the trusted device, then scan or paste it here again.",
    };
  }
  return {
    title: "Setup paused",
    body: "This device is fine. Leash just could not finish preparing the local workspace on this pass.",
  };
}

function prepareHeadline(mode: DeviceSetupMode | null, source: BootSource) {
  if (source === "restore") return "Restoring this device";
  if (mode === "sync-existing") return "Bringing this iPad into your workspace";
  return "Preparing your local edition";
}

function prepareBody(mode: DeviceSetupMode | null, source: BootSource) {
  if (source === "restore") {
    return "Reopening the local runtime and private workspace this device already uses.";
  }
  if (mode === "sync-existing") {
    return "This iPad is pairing with a device you already trust, then loading its local chat runtime.";
  }
  return "Leash is downloading the on-device models this iPad needs so it can work locally after setup.";
}

export function OnboardingFlow({
  stage,
  selectedMode,
  source,
  reviewDecision,
  reviewPlan,
  progress,
  status,
  detail,
  error,
  steps,
  joinBusy,
  onSelectMode,
  onContinue,
  onAcceptReview,
  onJoin,
  onRetry,
  onBack,
}: {
  stage: "choose" | "decide" | "review" | "sync" | "prepare";
  selectedMode: DeviceSetupMode | null;
  source: BootSource;
  reviewDecision: DeviceSetupDecision | null;
  reviewPlan: DownloadPlan;
  progress: number | null;
  status: string;
  detail: string;
  error: string | null;
  steps: WarmStep[];
  joinBusy?: boolean;
  onSelectMode: (mode: DeviceSetupMode) => void;
  onContinue: () => void;
  onAcceptReview: () => void;
  onJoin: (invite: string) => void;
  onRetry: () => void;
  onBack: () => void;
}) {
  const [invite, setInvite] = useState("");
  const [scanOpen, setScanOpen] = useState(false);
  const [downloadsOpen, setDownloadsOpen] = useState(false);
  const { width } = useWindowDimensions();
  const wide = width >= 860;
  const progressPct = useMemo(() => derivedProgress(progress, steps), [progress, steps]);
  const failure = error ? failureCopy(error, selectedMode, source) : null;

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView style={styles.safe} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <View style={[styles.frame, wide && styles.frameWide]}>
            <View style={styles.masthead}>
              <View style={styles.mastheadRow}>
                <View style={styles.markTile}>
                  <LeashMark size={26} mark={C.cream} cutout={C.ink} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.wordmark}>Leash</Text>
                  <Text style={styles.tagline}>private · local · mesh-ready</Text>
                </View>
              </View>
              <View style={styles.ruleStrong} />
            </View>

            {stage === "choose" ? (
              <>
                <Hero
                  kicker="Device setup"
                  title="Set up this iPad"
                  body="No account. No cloud handoff. Choose whether this device starts its own private workspace or joins one you already use."
                />

                <View style={styles.noteBand}>
                  <Text style={styles.noteLabel}>FIRST RUN</Text>
                  <Text style={styles.noteText}>
                    Leash downloads its local models once, then keeps chat on-device and can keep working offline.
                  </Text>
                </View>

                <View style={[styles.choiceGrid, wide && styles.choiceGridWide]}>
                  <ChoiceCard
                    eyebrow="New workspace"
                    title="Start on this iPad"
                    body="Create a private local workspace here, cache the required models, and begin from a clean slate."
                    aside="Best for a first device."
                    selected={selectedMode === "first-device"}
                    icon={<Cpu size={20} color={selectedMode === "first-device" ? C.sageDeep : C.muted} strokeWidth={1.8} />}
                    onPress={() => onSelectMode("first-device")}
                  />
                  <ChoiceCard
                    eyebrow="Existing workspace"
                    title="Join a device you already use"
                    body="Scan or paste a fresh invite from another Leash device to bring this iPad into that private workspace."
                    aside="Best when another device is already set up."
                    selected={selectedMode === "sync-existing"}
                    icon={<MeshNodes size={20} color={selectedMode === "sync-existing" ? C.sageDeep : C.muted} strokeWidth={1.8} />}
                    onPress={() => onSelectMode("sync-existing")}
                  />
                </View>

                <View style={styles.footerBlock}>
                  <Pressable
                    onPress={onContinue}
                    disabled={!selectedMode}
                    style={({ pressed }) => [
                      styles.primaryBtn,
                      !selectedMode && styles.primaryBtnDisabled,
                      pressed && selectedMode && styles.primaryBtnPressed,
                    ]}
                  >
                    <Text style={styles.primaryBtnText}>Continue</Text>
                    <ChevronRight size={16} color={C.cream} strokeWidth={2.1} />
                  </Pressable>
                  <Text style={styles.footnote}>You can change this later from Settings.</Text>
                </View>
              </>
            ) : stage === "decide" ? (
              <>
                <Hero
                  kicker="First run"
                  title="Deciding the best local setup"
                  body="Leash is checking this device’s form factor, memory, storage, and runtime path before it shows the exact assets to download."
                />

                <View style={[styles.twoUp, wide && styles.twoUpWide]}>
                  <View style={styles.panel}>
                    <Text style={styles.panelLabel}>DECISION SIGNALS</Text>
                    <View style={styles.infoList}>
                      <InfoRow title="Form factor" body="Phone and tablet hardware get different model budgets." />
                      <InfoRow title="Memory budget" body="Local RAM affects whether Leash should start compact, balanced, or full." />
                      <InfoRow title="Free space" body="First run only pulls the assets this device can reasonably carry." />
                    </View>
                  </View>

                  <View style={styles.panel}>
                    <Text style={styles.panelLabel}>WORKING NOW</Text>
                    <Text style={styles.panelTitle}>Choosing the safest strong default</Text>
                    <Text style={styles.panelBody}>{detail}</Text>

                    <View style={styles.prepareStatusCard}>
                      <ActivityIndicator size="small" color={C.sageDeep} />
                      <View style={{ flex: 1 }}>
                        <Text style={styles.statusTitle}>{status}</Text>
                        <Text style={styles.statusBody}>The review screen comes next with the exact local assets before anything downloads.</Text>
                      </View>
                    </View>
                  </View>
                </View>
              </>
            ) : stage === "review" ? (
              <>
                <Hero
                  kicker="First run"
                  title="Review the recommended local setup"
                  body="Leash picked the local runtime for this device first. Now you can inspect the exact assets it will cache before setup begins."
                />

                <View style={[styles.twoUp, wide && styles.twoUpWide]}>
                  <View style={styles.panel}>
                    <Text style={styles.panelLabel}>RECOMMENDED LOCAL SETUP</Text>
                    <Text style={styles.panelTitle}>{reviewDecision?.title ?? "Local setup"}</Text>
                    <Text style={styles.panelBody}>{reviewDecision?.summary ?? reviewPlan.summary}</Text>

                    {reviewDecision?.signals?.length ? (
                      <View style={styles.reviewSummary}>
                        {reviewDecision.signals.slice(0, 4).map((signal: DeviceSetupDecision["signals"][number]) => (
                          <SummaryPill key={signal.label} label={signal.label} value={signal.value} />
                        ))}
                      </View>
                    ) : null}

                    {reviewDecision?.reasons?.length ? (
                      <View style={styles.infoList}>
                        {reviewDecision.reasons.map((reason: string, index: number) => (
                          <InfoRow key={`${reason}-${index}`} title={index === 0 ? "Why this setup" : "Also considered"} body={reason} />
                        ))}
                      </View>
                    ) : null}
                  </View>

                  <View style={styles.panel}>
                    <Text style={styles.panelLabel}>SETUP DOWNLOADS</Text>
                    <Text style={styles.panelTitle}>{reviewPlan.title}</Text>
                    <Text style={styles.panelBody}>{reviewPlan.summary}</Text>
                    <View style={styles.reviewSummary}>
                      <SummaryPill label="Assets" value={String(reviewPlan.rows.length)} />
                      <SummaryPill label="Approx. total" value={reviewPlan.totalSizeLabel} />
                    </View>

                    <Pressable
                      onPress={() => setDownloadsOpen((open) => !open)}
                      style={({ pressed }) => [styles.disclosureToggle, pressed && styles.choiceCardPressed]}
                    >
                      <Text style={styles.disclosureToggleText}>
                        {downloadsOpen ? "Hide detailed download list" : "Show detailed download list"}
                      </Text>
                      <View style={{ transform: [{ rotate: downloadsOpen ? "90deg" : "0deg" }] }}>
                        <ChevronRight size={15} color={C.inkSoft} strokeWidth={2} />
                      </View>
                    </Pressable>

                    {downloadsOpen ? (
                      <View style={styles.assetList}>
                        {reviewPlan.rows.map((row, index) => (
                          <View
                            key={row.key}
                            style={[styles.assetRow, index === reviewPlan.rows.length - 1 && styles.assetRowLast]}
                          >
                            <View style={styles.assetRowTop}>
                              <Text style={styles.assetLabel}>{row.label}</Text>
                              <Text style={styles.assetMeta}>{row.sizeLabel}</Text>
                            </View>
                            <Text style={styles.assetPurpose}>{row.purpose}</Text>
                            <Text style={styles.assetTiming}>
                              {row.timing === "during-setup" ? "Downloads during setup" : "Downloads later when first used"}
                            </Text>
                          </View>
                        ))}
                      </View>
                    ) : null}
                    <View style={styles.infoList}>
                      <InfoRow title="Before you accept" body="This is the exact first-run scope for the setup path Leash just chose for this device." />
                      <InfoRow title="Private local cache" body="These assets are stored on this iPad so Leash can keep running locally after setup." />
                      <InfoRow title="One-time warmup" body="Once the listed assets finish downloading, later launches should reopen the local runtime instead of repeating setup." />
                    </View>

                    <Pressable onPress={onAcceptReview} style={({ pressed }) => [styles.primaryBtn, pressed && styles.primaryBtnPressed]}>
                      <Text style={styles.primaryBtnText}>Accept and continue</Text>
                      <ChevronRight size={16} color={C.cream} strokeWidth={2.1} />
                    </Pressable>

                    <Pressable onPress={onBack} style={({ pressed }) => [styles.secondaryBtn, pressed && styles.secondaryBtnPressed]}>
                      <Text style={styles.secondaryBtnText}>Choose a different setup path</Text>
                    </Pressable>
                  </View>
                </View>
              </>
            ) : stage === "sync" ? (
              <>
                <Hero
                  kicker="Existing workspace"
                  title="Bring this iPad into an existing workspace"
                  body="Open Leash on a device you already trust, create a fresh device invite there, then scan or paste it here."
                />

                <View style={[styles.twoUp, wide && styles.twoUpWide]}>
                  <View style={styles.panel}>
                    <Text style={styles.panelLabel}>PAIR THIS DEVICE</Text>
                    <Text style={styles.panelTitle}>Use a fresh invite</Text>
                    <Text style={styles.panelBody}>
                      Invites are single-use and short-lived. If one fails, mint a new one from the trusted device.
                    </Text>

                    <Pressable
                      onPress={() => setScanOpen(true)}
                      disabled={!!joinBusy}
                      style={({ pressed }) => [
                        styles.primaryBtn,
                        !!joinBusy && styles.primaryBtnDisabled,
                        pressed && !joinBusy && styles.primaryBtnPressed,
                      ]}
                    >
                      {joinBusy ? (
                        <ActivityIndicator size="small" color={C.cream} />
                      ) : (
                        <Camera size={18} color={C.cream} strokeWidth={2} />
                      )}
                      <Text style={styles.primaryBtnText}>{joinBusy ? "Joining…" : "Scan invite"}</Text>
                    </Pressable>

                    <View style={styles.dividerRow}>
                      <View style={styles.divider} />
                      <Text style={styles.dividerText}>or paste the sync key</Text>
                      <View style={styles.divider} />
                    </View>

                    <TextInput
                      style={styles.input}
                      value={invite}
                      onChangeText={(next) => setInvite(next)}
                      placeholder="Paste sync key"
                      placeholderTextColor={C.faint}
                      autoCapitalize="none"
                      autoCorrect={false}
                      multiline
                    />

                    {error ? (
                      <View style={styles.inlineIssue}>
                        <Text style={styles.inlineIssueTitle}>Invite not accepted</Text>
                        <Text style={styles.inlineIssueBody}>{error}</Text>
                      </View>
                    ) : null}

                    <Pressable
                      onPress={() => onJoin(invite)}
                      disabled={!!joinBusy || invite.trim().length < 16}
                      style={({ pressed }) => [
                        styles.secondaryBtn,
                        (!!joinBusy || invite.trim().length < 16) && styles.secondaryBtnDisabled,
                        pressed && invite.trim().length >= 16 && styles.secondaryBtnPressed,
                      ]}
                    >
                      <Text style={styles.secondaryBtnText}>{joinBusy ? "Joining…" : "Join workspace"}</Text>
                    </Pressable>

                    <Pressable onPress={onBack} hitSlop={10} style={styles.linkBtn}>
                      <Text style={styles.linkText}>Choose a different setup path</Text>
                    </Pressable>
                  </View>

                  <View style={styles.panel}>
                    <Text style={styles.panelLabel}>WHAT TO EXPECT</Text>
                    <View style={styles.infoList}>
                      <InfoRow title="Private pairing" body="This invite only links devices you explicitly approve." />
                      <InfoRow title="Local runtime" body="Even after joining a workspace, this iPad still runs its own local chat model." />
                      <InfoRow title="Short recovery path" body="If an invite expires, just generate a fresh one on the trusted device." />
                    </View>
                  </View>
                </View>
              </>
            ) : (
              <>
                <Hero
                  kicker={source === "restore" ? "Reopening device" : selectedMode === "sync-existing" ? "Existing workspace" : "First run"}
                  title={failure ? failure.title : prepareHeadline(selectedMode, source)}
                  body={failure ? failure.body : prepareBody(selectedMode, source)}
                />

                <View style={[styles.twoUp, wide && styles.twoUpWide]}>
                  <View style={[styles.panel, styles.progressPanel]}>
                    <View style={styles.progressHead}>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.panelLabel}>{failure ? "SETUP STATUS" : "PREPARING THIS DEVICE"}</Text>
                        <Text style={styles.progressTitle}>{status}</Text>
                      </View>
                      {progressPct != null ? <Text style={styles.progressPct}>{progressPct}%</Text> : null}
                    </View>

                    <AnimatedProgressBar progressPct={progressPct} active={!failure} />

                    <Text style={styles.progressBody}>{detail}</Text>

                    <View style={styles.stepList}>
                      {steps.map((step) => (
                        <View key={step.key} style={styles.stepRow}>
                          <View
                            style={[
                              styles.stepDot,
                              step.status === "active" && styles.stepDotActive,
                              step.status === "done" && styles.stepDotDone,
                            ]}
                          />
                          <Text
                            style={[
                              styles.stepLabel,
                              step.status === "active" && styles.stepLabelActive,
                              step.status === "done" && styles.stepLabelDone,
                            ]}
                          >
                            {step.label}
                          </Text>
                        </View>
                      ))}
                    </View>
                  </View>

                  <View style={styles.panel}>
                    {failure ? (
                      <>
                        <Text style={styles.panelLabel}>RECOVERY</Text>
                        <Text style={styles.panelTitle}>Take another pass</Text>
                        <Text style={styles.panelBody}>
                          Retry from this step, or switch to a different setup path if this iPad should be configured another way.
                        </Text>

                        <Pressable onPress={onRetry} style={({ pressed }) => [styles.primaryBtn, pressed && styles.primaryBtnPressed]}>
                          <RotateCcw size={16} color={C.cream} strokeWidth={2.1} />
                          <Text style={styles.primaryBtnText}>Try again</Text>
                        </Pressable>

                        <Pressable onPress={onBack} style={({ pressed }) => [styles.secondaryBtn, pressed && styles.secondaryBtnPressed]}>
                          <Text style={styles.secondaryBtnText}>Choose setup path</Text>
                        </Pressable>

                        <View style={styles.detailBox}>
                          <Text style={styles.detailLabel}>DETAIL</Text>
                          <Text style={styles.detailText}>{error}</Text>
                        </View>
                      </>
                    ) : (
                      <>
                        <Text style={styles.panelLabel}>WHAT LEASH IS DOING</Text>
                        <View style={styles.infoList}>
                          <InfoRow title="Keeping chat local" body="The chat model is being downloaded and loaded on this iPad, not delegated to a cloud service." />
                          <InfoRow title="Preparing offline use" body="Once setup finishes, the local model stays available even when the network is gone." />
                          <InfoRow title="Optional mesh later" body="Joining another device is additive. It does not stop this iPad from running its own local runtime." />
                        </View>
                      </>
                    )}
                  </View>
                </View>
              </>
            )}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>

      {scanOpen ? (
        <QRScanner
          onClose={() => setScanOpen(false)}
          onInvite={(nextInvite) => {
            setScanOpen(false);
            setInvite(nextInvite);
            onJoin(nextInvite);
          }}
        />
      ) : null}
    </SafeAreaView>
  );
}

function Hero({ kicker, title, body }: { kicker: string; title: string; body: string }) {
  return (
    <View style={styles.hero}>
      <Text style={styles.heroKicker}>{kicker}</Text>
      <Text style={styles.heroTitle}>{title}</Text>
      <Text style={styles.heroBody}>{body}</Text>
    </View>
  );
}

function ChoiceCard({
  eyebrow,
  title,
  body,
  aside,
  selected,
  icon,
  onPress,
}: {
  eyebrow: string;
  title: string;
  body: string;
  aside: string;
  selected: boolean;
  icon: React.ReactNode;
  onPress: () => void;
}) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.choiceCard, selected && styles.choiceCardSelected, pressed && styles.choiceCardPressed]}>
      <View style={styles.choiceHead}>
        <View style={[styles.choiceBadge, selected && styles.choiceBadgeSelected]}>{icon}</View>
        <View style={{ flex: 1 }}>
          <Text style={styles.choiceEyebrow}>{eyebrow}</Text>
          <Text style={styles.choiceTitle}>{title}</Text>
        </View>
      </View>
      <Text style={styles.choiceBody}>{body}</Text>
      <Text style={styles.choiceAside}>{aside}</Text>
    </Pressable>
  );
}

function InfoRow({ title, body }: { title: string; body: string }) {
  return (
    <View style={styles.infoRow}>
      <View style={styles.infoDot} />
      <View style={{ flex: 1 }}>
        <Text style={styles.infoTitle}>{title}</Text>
        <Text style={styles.infoBody}>{body}</Text>
      </View>
    </View>
  );
}

function SummaryPill({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.summaryPill}>
      <Text style={styles.summaryPillLabel}>{label}</Text>
      <Text style={styles.summaryPillValue}>{value}</Text>
    </View>
  );
}

function AnimatedProgressBar({ progressPct, active }: { progressPct: number | null; active: boolean }) {
  const [trackWidth, setTrackWidth] = useState(0);
  const [reduceMotion, setReduceMotion] = useState(false);
  const sheen = useRef(new Animated.Value(0)).current;
  const fillPct = Math.max(8, progressPct ?? 10);
  const fillWidth = trackWidth > 0 ? (trackWidth * fillPct) / 100 : 0;

  useEffect(() => {
    let mounted = true;

    AccessibilityInfo.isReduceMotionEnabled()
      .then((enabled) => {
        if (mounted) setReduceMotion(enabled);
      })
      .catch(() => {});

    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduceMotion);
    return () => {
      mounted = false;
      subscription.remove();
    };
  }, []);

  useEffect(() => {
    if (!active || reduceMotion || fillWidth <= 0) {
      sheen.stopAnimation();
      sheen.setValue(0);
      return;
    }

    sheen.setValue(0);
    const loop = Animated.loop(
      Animated.timing(sheen, {
        toValue: 1,
        duration: 1500,
        easing: Easing.inOut(Easing.ease),
        useNativeDriver: true,
      }),
    );
    loop.start();

    return () => loop.stop();
  }, [active, fillWidth, reduceMotion, sheen]);

  const sheenTravel = Math.max(fillWidth + 64, 96);
  const sheenTranslate = sheen.interpolate({
    inputRange: [0, 1],
    outputRange: [-72, sheenTravel],
  });
  const sheenOpacity = sheen.interpolate({
    inputRange: [0, 0.12, 0.5, 0.88, 1],
    outputRange: [0, 0.16, 0.28, 0.16, 0],
  });

  return (
    <View
      style={styles.progressTrack}
      onLayout={(event) => setTrackWidth(event.nativeEvent.layout.width)}
    >
      <View style={[styles.progressFillWrap, { width: `${fillPct}%` }]}>
        <View style={styles.progressFill} />
        {active && !reduceMotion && fillWidth > 0 ? (
          <Animated.View
            pointerEvents="none"
            style={[
              styles.progressSheen,
              {
                opacity: sheenOpacity,
                transform: [{ translateX: sheenTranslate }, { rotate: "16deg" }],
              },
            ]}
          />
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.cream },
  scroll: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 36 },
  frame: { width: "100%", maxWidth: 940, alignSelf: "center" },
  frameWide: { paddingTop: 6 },

  masthead: { paddingBottom: 22 },
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
  ruleStrong: { height: StyleSheet.hairlineWidth, backgroundColor: C.ink },

  hero: { paddingBottom: 24 },
  heroKicker: {
    fontFamily: F.monoMed,
    fontSize: 10,
    color: C.sageDeep,
    letterSpacing: TRACKING_LABEL,
    textTransform: "uppercase",
    marginBottom: 12,
  },
  heroTitle: { fontFamily: F.display, fontSize: 42, lineHeight: 42, letterSpacing: -1, color: C.ink, maxWidth: 760 },
  heroBody: {
    fontFamily: F.body,
    fontSize: 18,
    lineHeight: 28,
    color: C.inkSoft,
    marginTop: 14,
    maxWidth: 760,
  },

  noteBand: {
    backgroundColor: C.paper,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: C.rule,
    borderRadius: 14,
    paddingHorizontal: 16,
    paddingVertical: 15,
    marginBottom: 18,
    gap: 6,
  },
  noteLabel: {
    fontFamily: F.monoSemi,
    fontSize: 10,
    color: C.sageDeep,
    letterSpacing: TRACKING_LABEL,
    textTransform: "uppercase",
  },
  noteText: { fontFamily: F.body, fontSize: 16, lineHeight: 24, color: C.inkSoft },

  choiceGrid: { gap: 14 },
  choiceGridWide: { flexDirection: "row", alignItems: "stretch" },
  choiceCard: {
    flex: 1,
    backgroundColor: C.paper,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: C.rule,
    borderRadius: 16,
    paddingHorizontal: 18,
    paddingTop: 18,
    paddingBottom: 16,
    minHeight: 220,
  },
  choiceCardSelected: { borderColor: C.sageDeep, backgroundColor: "#f3f1e8" },
  choiceCardPressed: { opacity: 0.86 },
  choiceHead: { flexDirection: "row", alignItems: "center", gap: 12, marginBottom: 16 },
  choiceBadge: {
    width: 42,
    height: 42,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: C.cream,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: C.rule,
  },
  choiceBadgeSelected: { borderColor: C.sageDeep, backgroundColor: "#eef3eb" },
  choiceEyebrow: {
    fontFamily: F.monoMed,
    fontSize: 10,
    color: C.muted,
    letterSpacing: TRACKING_LABEL,
    textTransform: "uppercase",
    marginBottom: 4,
  },
  choiceTitle: { fontFamily: F.bodySemi, fontSize: 22, lineHeight: 26, color: C.ink },
  choiceBody: { fontFamily: F.body, fontSize: 16.5, lineHeight: 24, color: C.inkSoft },
  choiceAside: { fontFamily: F.mono, fontSize: 10.5, lineHeight: 15, color: C.faint, marginTop: 16, letterSpacing: 0.5 },

  footerBlock: { paddingTop: 18, gap: 10 },
  footnote: { fontFamily: F.mono, fontSize: 10.5, color: C.faint, letterSpacing: 0.5 },

  twoUp: { gap: 14 },
  twoUpWide: { flexDirection: "row", alignItems: "stretch" },
  panel: {
    flex: 1,
    backgroundColor: C.paper,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: C.rule,
    borderRadius: 16,
    paddingHorizontal: 18,
    paddingTop: 18,
    paddingBottom: 18,
  },
  progressPanel: { minHeight: 360 },
  panelLabel: {
    fontFamily: F.monoSemi,
    fontSize: 10,
    color: C.sageDeep,
    letterSpacing: TRACKING_LABEL,
    textTransform: "uppercase",
    marginBottom: 8,
  },
  panelTitle: { fontFamily: F.bodySemi, fontSize: 22, lineHeight: 28, color: C.ink, marginBottom: 6 },
  panelBody: { fontFamily: F.body, fontSize: 16, lineHeight: 24, color: C.inkSoft },
  prepareStatusCard: {
    marginTop: 18,
    paddingHorizontal: 14,
    paddingVertical: 14,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: C.rule,
    backgroundColor: C.cream,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 12,
  },
  statusTitle: { fontFamily: F.bodySemi, fontSize: 16, lineHeight: 22, color: C.ink, marginBottom: 4 },
  statusBody: { fontFamily: F.body, fontSize: 14.5, lineHeight: 22, color: C.inkSoft },
  reviewSummary: { flexDirection: "row", flexWrap: "wrap", gap: 10, marginTop: 18, marginBottom: 16 },
  summaryPill: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: C.rule,
    backgroundColor: C.cream,
    gap: 2,
  },
  summaryPillLabel: {
    fontFamily: F.mono,
    fontSize: 9.5,
    color: C.muted,
    letterSpacing: TRACKING_LABEL,
    textTransform: "uppercase",
  },
  summaryPillValue: { fontFamily: F.bodyMed, fontSize: 15, color: C.ink },
  disclosureToggle: {
    marginBottom: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: C.rule,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 13,
    backgroundColor: C.cream,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  disclosureToggleText: { flex: 1, fontFamily: F.bodyMed, fontSize: 15, color: C.ink },
  assetList: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: C.rule,
    borderRadius: 14,
    overflow: "hidden",
    backgroundColor: C.cream,
  },
  assetRow: {
    paddingHorizontal: 14,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: C.rule,
    gap: 5,
  },
  assetRowLast: { borderBottomWidth: 0 },
  assetRowTop: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", gap: 10 },
  assetLabel: { flex: 1, fontFamily: F.bodyMed, fontSize: 16, color: C.ink },
  assetMeta: { fontFamily: F.mono, fontSize: 11, color: C.sageDeep, letterSpacing: 0.8, textTransform: "uppercase" },
  assetPurpose: { fontFamily: F.body, fontSize: 14.5, lineHeight: 22, color: C.inkSoft },
  assetTiming: { fontFamily: F.mono, fontSize: 10, color: C.muted, letterSpacing: TRACKING_LABEL, textTransform: "uppercase" },

  primaryBtn: {
    minHeight: 52,
    borderRadius: 12,
    backgroundColor: C.sageDeep,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 8,
    paddingHorizontal: 16,
    marginTop: 6,
  },
  primaryBtnDisabled: { opacity: 0.38 },
  primaryBtnPressed: { opacity: 0.82 },
  primaryBtnText: { fontFamily: F.bodySemi, fontSize: 16, color: C.cream },
  secondaryBtn: {
    minHeight: 52,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: C.ruleStrong,
    backgroundColor: C.cream,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 16,
    marginTop: 12,
  },
  secondaryBtnDisabled: { opacity: 0.38 },
  secondaryBtnPressed: { opacity: 0.82 },
  secondaryBtnText: { fontFamily: F.bodySemi, fontSize: 16, color: C.ink },
  linkBtn: { alignSelf: "flex-start", paddingVertical: 10, marginTop: 4 },
  linkText: { fontFamily: F.monoMed, fontSize: 10.5, color: C.sageDeep, letterSpacing: 0.8 },

  dividerRow: { flexDirection: "row", alignItems: "center", gap: 10, marginVertical: 16 },
  divider: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: C.rule },
  dividerText: { fontFamily: F.mono, fontSize: 10.5, color: C.faint, letterSpacing: 0.5 },
  input: {
    minHeight: 108,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: C.ruleStrong,
    backgroundColor: C.cream,
    paddingHorizontal: 14,
    paddingVertical: 14,
    color: C.ink,
    fontFamily: F.mono,
    fontSize: 12.5,
    lineHeight: 18,
    textAlignVertical: "top",
  },
  inlineIssue: {
    borderLeftWidth: 3,
    borderLeftColor: C.brick,
    paddingLeft: 12,
    paddingTop: 4,
    marginTop: 12,
  },
  inlineIssueTitle: { fontFamily: F.bodySemi, fontSize: 16, color: C.ink, marginBottom: 4 },
  inlineIssueBody: { fontFamily: F.body, fontSize: 15, lineHeight: 22, color: C.inkSoft },

  progressHead: { flexDirection: "row", alignItems: "flex-start", gap: 12, marginBottom: 14 },
  progressTitle: { fontFamily: F.bodySemi, fontSize: 22, lineHeight: 28, color: C.ink },
  progressPct: { fontFamily: F.monoSemi, fontSize: 11, color: C.sageDeep, letterSpacing: TRACKING_LABEL, marginTop: 2 },
  progressTrack: { height: 8, borderRadius: 999, backgroundColor: C.rule, overflow: "hidden", marginBottom: 14 },
  progressFillWrap: { height: "100%", borderRadius: 999, overflow: "hidden" },
  progressFill: { ...StyleSheet.absoluteFillObject, borderRadius: 999, backgroundColor: C.sageDeep },
  progressSheen: {
    position: "absolute",
    top: -4,
    bottom: -4,
    width: 36,
    backgroundColor: "rgba(255,255,255,0.72)",
    borderRadius: 999,
  },
  progressBody: { fontFamily: F.body, fontSize: 16, lineHeight: 24, color: C.inkSoft },
  stepList: { gap: 10, marginTop: 18 },
  stepRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  stepDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: C.ruleStrong },
  stepDotActive: { width: 10, height: 10, borderRadius: 5, backgroundColor: C.sageDeep },
  stepDotDone: { backgroundColor: C.sage },
  stepLabel: { fontFamily: F.body, fontSize: 15.5, lineHeight: 22, color: C.muted, flex: 1 },
  stepLabelActive: { color: C.ink },
  stepLabelDone: { color: C.sageDeep },

  infoList: { gap: 16 },
  infoRow: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  infoDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: C.sage, marginTop: 8 },
  infoTitle: { fontFamily: F.bodySemi, fontSize: 16, lineHeight: 22, color: C.ink, marginBottom: 2 },
  infoBody: { fontFamily: F.body, fontSize: 15.5, lineHeight: 23, color: C.inkSoft },

  detailBox: {
    marginTop: 16,
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: C.rule,
  },
  detailLabel: {
    fontFamily: F.monoSemi,
    fontSize: 10,
    color: C.muted,
    letterSpacing: TRACKING_LABEL,
    textTransform: "uppercase",
    marginBottom: 8,
  },
  detailText: { fontFamily: F.mono, fontSize: 11.5, lineHeight: 18, color: C.inkSoft },
});
