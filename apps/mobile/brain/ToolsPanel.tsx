import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";

import type { CapabilityToolRow } from "../../../packages/capability-runtime/src/index";
import { Card, StateBadge } from "../Card";
import { MOBILE_TOOL_CATALOG } from "../lib/agent/tools";
import { getMobileCapabilityRuntime } from "../lib/capability/runtime";
import { setCapabilityToolAskFirst, setCapabilityToolEnabled } from "../lib/capability/store";
import { panelStyles } from "./capabilityShared";

const LOCAL_TOOL_NAMES = new Set<string>(MOBILE_TOOL_CATALOG.map((tool) => tool.name));

export function ToolsPanel(): React.JSX.Element {
  const [tools, setTools] = useState<CapabilityToolRow[]>([]);
  const [connectedServers, setConnectedServers] = useState(0);

  const refresh = useCallback(async () => {
    const runtime = await getMobileCapabilityRuntime();
    setTools(runtime.snapshot.inventory.tools);
    setConnectedServers(runtime.mcpStatuses.filter((status) => status.connected).length);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const summary = useMemo(() => {
    const enabled = tools.filter((tool) => tool.enabled).length;
    const askFirst = tools.filter((tool) => tool.askFirst).length;
    return { enabled, askFirst };
  }, [tools]);

  return (
    <View>
      <Text style={panelStyles.sectionLabel}>TOOLS</Text>

      <Card title="Policy summary" action={<StateBadge ok={connectedServers > 0 ? true : null} label={connectedServers > 0 ? `${connectedServers} MCP live` : "local only"} />}>
        <Text style={panelStyles.detailBody}>
          {summary.enabled} enabled · {summary.askFirst} ask-first. Ask-first tools stay visible to the model, but mobile blocks execution until you flip them to always allow.
        </Text>
      </Card>

      <Card title="Tool registry">
        {tools.length === 0 ? (
          <Text style={panelStyles.empty}>No tools are registered right now.</Text>
        ) : (
          tools.map((tool) => {
            const local = LOCAL_TOOL_NAMES.has(tool.name);
            return (
              <View key={tool.name} style={panelStyles.row}>
                <View style={panelStyles.rowTop}>
                  <View style={panelStyles.rowText}>
                    <Text style={panelStyles.rowTitle}>{tool.name}</Text>
                    <Text style={panelStyles.rowMeta}>
                      {local ? "on-device tool" : "mcp tool"} · {tool.enabled ? "enabled" : "disabled"} · {tool.askFirst ? "ask-first" : "always allow"}
                    </Text>
                    <Text style={panelStyles.rowSub}>{tool.description || "No description."}</Text>
                    {tool.askFirstDefault ? <Text style={panelStyles.rowMeta}>default approval policy: ask first</Text> : null}
                  </View>
                  <View style={panelStyles.rowActions}>
                    <Pressable onPress={() => void setCapabilityToolEnabled(tool.name, !tool.enabled).then(refresh)}>
                      <Text style={panelStyles.actionLink}>{tool.enabled ? "DISABLE" : "ENABLE"}</Text>
                    </Pressable>
                    <Pressable onPress={() => void setCapabilityToolAskFirst(tool.name, !tool.askFirst).then(refresh)}>
                      <Text style={panelStyles.actionLink}>{tool.askFirst ? "ALWAYS" : "ASK FIRST"}</Text>
                    </Pressable>
                  </View>
                </View>
              </View>
            );
          })
        )}
      </Card>
    </View>
  );
}
