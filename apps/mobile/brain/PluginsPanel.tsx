import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";

import type { CapabilityPlugin } from "../../../packages/capability-runtime/src/index";
import { Card } from "../Card";
import { listCapabilityPlugins, setCapabilityPluginEnabled } from "../lib/capability/store";
import { panelStyles } from "./capabilityShared";

export function PluginsPanel(): React.JSX.Element {
  const [plugins, setPlugins] = useState<CapabilityPlugin[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const next = await listCapabilityPlugins();
    setPlugins(next);
    setSelectedId((current) => {
      if (current && next.some((plugin) => plugin.id === current)) return current;
      return next[0]?.id ?? null;
    });
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const selected = useMemo(() => plugins.find((plugin) => plugin.id === selectedId) ?? null, [plugins, selectedId]);

  return (
    <View>
      <Text style={panelStyles.sectionLabel}>PLUGINS</Text>

      <Card title="Installed plugins">
        {plugins.length === 0 ? (
          <Text style={panelStyles.empty}>No plugins are installed locally yet. When a plugin is present, mobile will honor the skills, agents, and MCP servers it contributes.</Text>
        ) : (
          plugins.map((plugin) => (
            <View key={plugin.id} style={panelStyles.row}>
              <Pressable style={panelStyles.rowText} onPress={() => setSelectedId(plugin.id)}>
                <Text style={panelStyles.rowTitle}>
                  {plugin.name}
                  {selectedId === plugin.id ? "  ·  open" : ""}
                </Text>
                <Text style={panelStyles.rowMeta}>
                  {plugin.version ? `v${plugin.version} · ` : ""}{plugin.enabled ? "enabled" : "disabled"} · {plugin.skills.length} skills · {plugin.agents.length} agents · {plugin.mcpServers.length} mcp
                </Text>
                <Text style={panelStyles.rowSub}>{plugin.description || "No description."}</Text>
              </Pressable>
              <View style={panelStyles.rowActions}>
                <Pressable onPress={() => void setCapabilityPluginEnabled(plugin.id, !plugin.enabled).then(refresh)}>
                  <Text style={panelStyles.actionLink}>{plugin.enabled ? "DISABLE" : "ENABLE"}</Text>
                </Pressable>
              </View>
            </View>
          ))
        )}
      </Card>

      {selected ? (
        <Card title="Selected plugin">
          <View style={panelStyles.detail}>
            <View style={panelStyles.detailHead}>
              <Text style={panelStyles.detailTitle}>{selected.name}</Text>
              <View style={[panelStyles.chip, selected.enabled ? panelStyles.chipOn : panelStyles.chipOff]}>
                <Text style={panelStyles.chipText}>{selected.enabled ? "enabled" : "disabled"}</Text>
              </View>
              {selected.version ? (
                <View style={panelStyles.chip}>
                  <Text style={panelStyles.chipText}>v{selected.version}</Text>
                </View>
              ) : null}
            </View>
            <Text style={panelStyles.detailBody}>{selected.description || "No description."}</Text>
            {selected.skills.length ? (
              <View style={panelStyles.editorField}>
                <Text style={panelStyles.detailLabel}>Skills</Text>
                <View style={panelStyles.chipRow}>
                  {selected.skills.map((skill) => (
                    <View key={skill.slug} style={panelStyles.chip}>
                      <Text style={panelStyles.chipText}>{skill.name}</Text>
                    </View>
                  ))}
                </View>
              </View>
            ) : null}
            {selected.agents.length ? (
              <View style={panelStyles.editorField}>
                <Text style={panelStyles.detailLabel}>Agents</Text>
                <View style={panelStyles.chipRow}>
                  {selected.agents.map((agent) => (
                    <View key={agent.slug} style={panelStyles.chip}>
                      <Text style={panelStyles.chipText}>{agent.name}</Text>
                    </View>
                  ))}
                </View>
              </View>
            ) : null}
            {selected.mcpServers.length ? (
              <View style={panelStyles.editorField}>
                <Text style={panelStyles.detailLabel}>MCP servers</Text>
                <View style={panelStyles.chipRow}>
                  {selected.mcpServers.map((server) => (
                    <View key={server.id} style={panelStyles.chip}>
                      <Text style={panelStyles.chipText}>{server.name}</Text>
                    </View>
                  ))}
                </View>
              </View>
            ) : null}
          </View>
        </Card>
      ) : null}
    </View>
  );
}
