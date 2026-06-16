/**
 * "The Understory" — the Leash brand system, ported from the web app's design tokens
 * (apps/web/app/globals.css) so the mobile client reads as the same private broadsheet:
 * cream paper, ink, sage green, a brick rule for unverified claims, and a dark
 * control-room palette. Three voices: Fraunces (display), Newsreader (body),
 * IBM Plex Mono (labels / telemetry).
 */

export const C = {
  cream: "#f1efe6",
  paper: "#f7f5ed",
  ink: "#191712",
  inkSoft: "#3b382f",
  muted: "#6c685c",
  faint: "#9b9588",
  rule: "#d4cfbf",
  ruleStrong: "#b9b2a0",
  sage: "#3f7d4e",
  sageDeep: "#2c5a39",
  brick: "#ad3322",
  control: "#15140f",
  control2: "#1f1d16",
  controlLine: "#34301f",
  glow: "#79b985",
} as const;

/** Font family keys — must match the names passed to useFonts() in App.tsx. */
export const F = {
  display: "Fraunces_900Black",
  displaySemi: "Fraunces_600SemiBold",
  displayReg: "Fraunces_400Regular",
  displayItalic: "Fraunces_400Regular_Italic",
  body: "Newsreader_400Regular",
  bodyItalic: "Newsreader_400Regular_Italic",
  bodyMed: "Newsreader_500Medium",
  bodySemi: "Newsreader_600SemiBold",
  mono: "IBMPlexMono_400Regular",
  monoMed: "IBMPlexMono_500Medium",
  monoSemi: "IBMPlexMono_600SemiBold",
} as const;

/** Mono uppercase eyebrow — sections, labels, timestamps, telemetry. */
export const TRACKING_LABEL = 2.4; // ~0.18em at 13px, in RN letterSpacing points
