import "./polyfills"; // MUST be first — installs ReadableStream/structuredClone for the AI SDK on JSC.
import { registerRootComponent } from "expo";
import React from "react";
import { ScrollView, Text, View } from "react-native";

/**
 * Entry point. The app graph is loaded via require() inside a try/catch so a *module-load*
 * throw (an import side-effect, before React renders) surfaces on screen instead of a black
 * void — a Release build has no Metro/console to show it otherwise.
 */
function ErrorScreen(error: unknown): React.ReactElement {
  const e = error as { message?: string; stack?: string };
  return React.createElement(
    View,
    { style: { flex: 1, backgroundColor: "#f1efe6", padding: 22, paddingTop: 70 } },
    React.createElement(Text, { style: { color: "#ad3322", fontSize: 20, fontWeight: "700" } }, "Leash failed to load"),
    React.createElement(Text, { style: { color: "#6c685c", fontSize: 12, marginBottom: 14 } }, "Screenshot this and send it."),
    React.createElement(
      ScrollView,
      { style: { flex: 1 } },
      React.createElement(
        Text,
        { selectable: true, style: { color: "#191712", fontSize: 14, fontWeight: "600", marginBottom: 8 } },
        String(e?.message ?? error),
      ),
      React.createElement(Text, { selectable: true, style: { color: "#3b382f", fontSize: 11 } }, String(e?.stack ?? "")),
    ),
  );
}

let RootComponent: React.ComponentType;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  RootComponent = require("./Root").default;
} catch (e) {
  RootComponent = () => ErrorScreen(e);
}

registerRootComponent(RootComponent);
