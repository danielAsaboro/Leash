import React from "react";
import { ScrollView, StatusBar, Text, View } from "react-native";
import App from "./App";

/**
 * Root wrapper with an error boundary. A Release build shows nothing (a black screen) when
 * a render throws — this surfaces the actual error on a cream screen instead, so failures
 * are diagnosable on-device without a Metro/console connection.
 */
class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    const e = this.state.error;
    if (!e) return this.props.children;
    return (
      <View style={{ flex: 1, backgroundColor: "#f1efe6", padding: 22, paddingTop: 70 }}>
        <StatusBar barStyle="dark-content" />
        <Text style={{ color: "#ad3322", fontSize: 20, fontWeight: "700", marginBottom: 4 }}>Leash hit an error</Text>
        <Text style={{ color: "#6c685c", fontSize: 12, marginBottom: 16 }}>Screenshot this and send it over.</Text>
        <ScrollView style={{ flex: 1 }}>
          <Text selectable style={{ color: "#191712", fontSize: 14, fontWeight: "600", marginBottom: 10 }}>
            {String(e.message ?? e)}
          </Text>
          <Text selectable style={{ color: "#3b382f", fontSize: 11, lineHeight: 16 }}>
            {String((e as { stack?: string }).stack ?? "")}
          </Text>
        </ScrollView>
      </View>
    );
  }
}

export default function Root(): React.JSX.Element {
  return (
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  );
}
