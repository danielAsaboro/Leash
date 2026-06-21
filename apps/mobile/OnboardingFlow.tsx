import React, { useState } from "react";
import { ActivityIndicator, Pressable, SafeAreaView, StyleSheet, Text, TextInput, View } from "react-native";
import { QRScanner } from "./QRScanner";
import { Camera, Cpu, MeshNodes } from "./icons";
import { LeashMark } from "./LeashMark";
import { C, F, TRACKING_LABEL } from "./theme";
import type { DeviceSetupMode } from "./onboarding";

export type WarmStep = {
  key: string;
  label: string;
  status: "pending" | "active" | "done";
};

export function OnboardingFlow({
  stage,
  selectedMode,
  progress,
  status,
  detail,
  error,
  steps,
  joinBusy,
  onSelectMode,
  onContinue,
  onJoin,
  onRetry,
  onBack,
}: {
  stage: "choose" | "sync" | "prepare";
  selectedMode: DeviceSetupMode | null;
  progress: number | null;
  status: string;
  detail: string;
  error: string | null;
  steps: WarmStep[];
  joinBusy?: boolean;
  onSelectMode: (mode: DeviceSetupMode) => void;
  onContinue: () => void;
  onJoin: (invite: string) => void;
  onRetry: () => void;
  onBack: () => void;
}) {
  const [invite, setInvite] = useState("");
  const [scanOpen, setScanOpen] = useState(false);

  if (stage === "choose") {
    return (
      <SafeAreaView style={styles.safe}>
        <View style={styles.hero}>
          <View style={styles.logoRing}>
            <LeashMark size={30} mark={C.glow} tile="transparent" cutout="transparent" />
          </View>
          <Text style={styles.title}>Device synchronization</Text>
          <Text style={styles.dek}>Connect this QVAC workbench to your other devices, or start a private local workspace here.</Text>
        </View>

        <View style={styles.choiceWrap}>
          <Text style={styles.prompt}>Is this your first device with QVAC Workbench?</Text>

          <ChoiceCard
            title="Yes, this is my first device"
            body="Set up a new private workspace here and download the local models this device needs."
            selected={selectedMode === "first-device"}
            onPress={() => onSelectMode("first-device")}
            icon={<Cpu size={20} color={selectedMode === "first-device" ? C.glow : C.faint} strokeWidth={1.8} />}
          />

          <ChoiceCard
            title="No, sync with my existing devices"
            body="Join an existing private mesh from a desktop or another QVAC device using its sync key."
            selected={selectedMode === "sync-existing"}
            onPress={() => onSelectMode("sync-existing")}
            icon={<MeshNodes size={20} color={selectedMode === "sync-existing" ? C.glow : C.faint} strokeWidth={1.8} />}
          />
        </View>

        <View style={styles.footer}>
          <Pressable
            onPress={onContinue}
            disabled={!selectedMode}
            style={({ pressed }) => [
              styles.primaryBtn,
              !selectedMode && styles.primaryBtnDisabled,
              pressed && selectedMode && styles.primaryBtnPressed,
            ]}
          >
            <Text style={styles.primaryText}>Get started  →</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  if (stage === "sync") {
    return (
      <SafeAreaView style={styles.safe}>
        <View style={styles.hero}>
          <View style={styles.logoRing}>
            <MeshNodes size={28} color={C.glow} strokeWidth={1.8} />
          </View>
          <Text style={styles.title}>Sync this device</Text>
          <Text style={styles.dek}>Scan the invite QR from your desktop, or paste the sync key it generated for this device.</Text>
        </View>

        <View style={styles.syncPanel}>
          <Pressable
            onPress={() => setScanOpen(true)}
            disabled={!!joinBusy}
            style={({ pressed }) => [styles.scanBtn, pressed && styles.primaryBtnPressed, !!joinBusy && styles.primaryBtnDisabled]}
          >
            {joinBusy ? <ActivityIndicator size="small" color={C.cream} /> : <Camera size={18} color={C.cream} strokeWidth={2} />}
            <Text style={styles.scanText}>{joinBusy ? "Joining…" : "Scan sync key"}</Text>
          </Pressable>

          <View style={styles.orRow}>
            <View style={styles.orLine} />
            <Text style={styles.orText}>or paste it</Text>
            <View style={styles.orLine} />
          </View>

          <TextInput
            style={styles.input}
            value={invite}
            onChangeText={setInvite}
            placeholder="Paste sync key"
            placeholderTextColor={C.faint}
            autoCapitalize="none"
            autoCorrect={false}
            multiline
          />
          {error ? <Text style={styles.syncError}>{error}</Text> : null}

          <Pressable
            onPress={() => onJoin(invite)}
            disabled={!!joinBusy || invite.trim().length < 16}
            style={({ pressed }) => [
              styles.secondaryBtn,
              (!!joinBusy || invite.trim().length < 16) && styles.secondaryBtnDisabled,
              pressed && invite.trim().length >= 16 && styles.secondaryBtnPressed,
            ]}
          >
            <Text style={styles.secondaryText}>{joinBusy ? "Joining…" : "Join existing mesh"}</Text>
          </Pressable>

          <Pressable onPress={onBack} hitSlop={10} style={styles.linkBtn}>
            <Text style={styles.linkText}>← Back</Text>
          </Pressable>
        </View>

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

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.hero}>
        <View style={styles.logoRing}>
          <LeashMark size={30} mark={C.glow} tile="transparent" cutout="transparent" />
        </View>
        <Text style={styles.title}>{error ? "We hit a startup issue" : "Preparing your workspace"}</Text>
        <Text style={styles.dek}>{error ? "The app stayed alive, but startup could not finish. Retry from here instead of dropping you into a broken chat shell." : detail}</Text>
      </View>

      <View style={styles.loadingPanel}>
        <Text style={styles.loadingLabel}>{status}</Text>
        {progress != null ? <Text style={styles.loadingPct}>{progress}%</Text> : null}
        <View style={styles.progressTrack}>
          <View style={[styles.progressFill, { width: `${Math.max(6, progress ?? 12)}%` }]} />
        </View>

        <View style={styles.steps}>
          {steps.map((step) => (
            <View key={step.key} style={styles.stepRow}>
              <View
                style={[
                  styles.stepDot,
                  step.status === "done" && styles.stepDotDone,
                  step.status === "active" && styles.stepDotActive,
                ]}
              />
              <Text
                style={[
                  styles.stepText,
                  step.status === "done" && styles.stepTextDone,
                  step.status === "active" && styles.stepTextActive,
                ]}
              >
                {step.label}
              </Text>
            </View>
          ))}
        </View>

        {error ? (
          <View style={styles.errorBox}>
            <Text style={styles.errorTitle}>Startup blocked</Text>
            <Text style={styles.errorBody}>{error}</Text>
            <Pressable onPress={onRetry} style={({ pressed }) => [styles.primaryBtn, pressed && styles.primaryBtnPressed]}>
              <Text style={styles.primaryText}>Try again</Text>
            </Pressable>
            <Pressable onPress={onBack} hitSlop={10} style={styles.linkBtn}>
              <Text style={styles.linkText}>← Change setup</Text>
            </Pressable>
          </View>
        ) : (
          <Text style={styles.loadingNote}>Everything here stays local to this device unless you explicitly join a private mesh.</Text>
        )}
      </View>
    </SafeAreaView>
  );
}

function ChoiceCard({
  title,
  body,
  selected,
  onPress,
  icon,
}: {
  title: string;
  body: string;
  selected: boolean;
  onPress: () => void;
  icon: React.ReactNode;
}) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.choiceCard, selected && styles.choiceCardSelected, pressed && styles.choiceCardPressed]}>
      <View style={styles.choiceHead}>
        <View style={[styles.radioOuter, selected && styles.radioOuterSelected]}>
          {selected ? <View style={styles.radioInner} /> : null}
        </View>
        <View style={styles.choiceIcon}>{icon}</View>
        <View style={{ flex: 1 }}>
          <Text style={styles.choiceTitle}>{title}</Text>
          <Text style={styles.choiceBody}>{body}</Text>
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.control, paddingHorizontal: 18, paddingTop: 16, paddingBottom: 18 },
  hero: { alignItems: "center", paddingTop: 12, paddingBottom: 24 },
  logoRing: {
    width: 78,
    height: 78,
    borderRadius: 39,
    borderWidth: 1.5,
    borderColor: C.controlLine,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: C.control2,
    marginBottom: 18,
  },
  title: { fontFamily: F.displaySemi, fontSize: 30, color: C.cream, textAlign: "center" },
  dek: { fontFamily: F.body, fontSize: 17, lineHeight: 24, color: C.faint, textAlign: "center", marginTop: 10, maxWidth: 330 },
  choiceWrap: { gap: 14 },
  prompt: { fontFamily: F.monoMed, fontSize: 11, color: C.faint, letterSpacing: TRACKING_LABEL, textAlign: "center", marginBottom: 4 },
  choiceCard: {
    backgroundColor: C.control2,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: C.controlLine,
    padding: 18,
  },
  choiceCardSelected: { borderColor: C.glow, shadowColor: C.glow, shadowOpacity: 0.18, shadowRadius: 16, shadowOffset: { width: 0, height: 8 } },
  choiceCardPressed: { opacity: 0.9 },
  choiceHead: { flexDirection: "row", alignItems: "flex-start", gap: 14 },
  radioOuter: {
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: C.controlLine,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 2,
  },
  radioOuterSelected: { borderColor: C.glow },
  radioInner: { width: 10, height: 10, borderRadius: 5, backgroundColor: C.glow },
  choiceIcon: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: C.control,
    alignItems: "center",
    justifyContent: "center",
    marginTop: -2,
  },
  choiceTitle: { fontFamily: F.bodySemi, fontSize: 19, color: C.cream, marginBottom: 6 },
  choiceBody: { fontFamily: F.body, fontSize: 15.5, lineHeight: 22, color: C.faint },
  footer: { marginTop: "auto", paddingTop: 18 },
  primaryBtn: {
    minHeight: 52,
    borderRadius: 12,
    backgroundColor: C.glow,
    alignItems: "center",
    justifyContent: "center",
  },
  primaryBtnDisabled: { opacity: 0.35 },
  primaryBtnPressed: { opacity: 0.82 },
  primaryText: { fontFamily: F.bodySemi, fontSize: 17, color: C.control },
  syncPanel: { gap: 16, marginTop: 4 },
  scanBtn: {
    minHeight: 52,
    borderRadius: 12,
    backgroundColor: C.sageDeep,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
  },
  scanText: { fontFamily: F.bodySemi, fontSize: 16, color: C.cream },
  orRow: { flexDirection: "row", alignItems: "center", gap: 12, marginTop: 2 },
  orLine: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: C.controlLine },
  orText: { fontFamily: F.mono, fontSize: 10.5, color: C.faint, letterSpacing: 0.8 },
  input: {
    minHeight: 64,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: C.controlLine,
    backgroundColor: C.control2,
    paddingHorizontal: 14,
    paddingVertical: 14,
    color: C.cream,
    fontFamily: F.mono,
    fontSize: 12.5,
  },
  syncError: { fontFamily: F.mono, fontSize: 11.5, color: C.brick, marginTop: -4 },
  secondaryBtn: {
    minHeight: 52,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: C.ruleStrong,
    backgroundColor: C.control2,
    alignItems: "center",
    justifyContent: "center",
  },
  secondaryBtnDisabled: { opacity: 0.35 },
  secondaryBtnPressed: { opacity: 0.82 },
  secondaryText: { fontFamily: F.bodySemi, fontSize: 16, color: C.cream },
  linkBtn: { alignSelf: "center", paddingVertical: 8 },
  linkText: { fontFamily: F.monoMed, fontSize: 11, color: C.faint, letterSpacing: 0.8 },
  loadingPanel: {
    backgroundColor: C.control2,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: C.controlLine,
    padding: 18,
    gap: 14,
  },
  loadingLabel: { fontFamily: F.bodySemi, fontSize: 21, color: C.cream },
  loadingPct: { fontFamily: F.monoSemi, fontSize: 11, color: C.glow, letterSpacing: TRACKING_LABEL },
  progressTrack: { height: 8, borderRadius: 999, backgroundColor: C.control, overflow: "hidden" },
  progressFill: { height: "100%", borderRadius: 999, backgroundColor: C.glow },
  steps: { gap: 10, paddingTop: 2 },
  stepRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  stepDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: C.controlLine },
  stepDotActive: { width: 10, height: 10, borderRadius: 5, backgroundColor: C.glow },
  stepDotDone: { backgroundColor: C.sage },
  stepText: { fontFamily: F.body, fontSize: 15.5, color: C.faint },
  stepTextActive: { color: C.cream },
  stepTextDone: { color: C.glow },
  loadingNote: { fontFamily: F.body, fontSize: 14.5, lineHeight: 21, color: C.faint, marginTop: 4 },
  errorBox: {
    marginTop: 6,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "rgba(173,51,34,0.45)",
    backgroundColor: "rgba(173,51,34,0.12)",
    padding: 14,
    gap: 10,
  },
  errorTitle: { fontFamily: F.bodySemi, fontSize: 18, color: C.cream },
  errorBody: { fontFamily: F.body, fontSize: 14.5, lineHeight: 21, color: C.paper },
});
