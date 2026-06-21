import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Pressable, Text, TextInput, View } from "react-native";

import type { McpServerEntry } from "../../../packages/capability-runtime/src/index";
import { Card, StateBadge } from "../Card";
import { getMobileCapabilityRuntime } from "../lib/capability/runtime";
import {
  listCapabilityMcpServers,
  removeCapabilityMcpServer,
  saveCapabilityMcpServer,
  setCapabilityMcpEnabled,
} from "../lib/capability/store";
import { C } from "../theme";
import { panelStyles } from "./capabilityShared";

type Transport = "http" | "sse";
type McpDraft = {
  id: string;
  name: string;
  transport: Transport;
  url: string;
  headersJson: string;
};

function emptyDraft(): McpDraft {
  return { id: "", name: "", transport: "http", url: "", headersJson: "" };
}

function toDraft(server: McpServerEntry): McpDraft {
  return {
    id: server.id,
    name: server.name,
    transport: server.transport === "sse" ? "sse" : "http",
    url: server.url ?? "",
    headersJson: server.headers ? JSON.stringify(server.headers, null, 2) : "",
  };
}

function parseHeaders(text: string): Record<string, string> | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const parsed = JSON.parse(trimmed) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Headers must be a JSON object.");
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === "string" && key.trim()) out[key.trim()] = value;
  }
  return Object.keys(out).length ? out : undefined;
}

export function McpPanel(): React.JSX.Element {
  const [servers, setServers] = useState<McpServerEntry[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<McpDraft>(emptyDraft);
  const [statuses, setStatuses] = useState<Record<string, { connected: boolean; tools: string[]; error?: string }>>({});

  const refresh = useCallback(async () => {
    const [nextServers, runtime] = await Promise.all([listCapabilityMcpServers(), getMobileCapabilityRuntime()]);
    setServers(nextServers);
    setSelectedId((current) => {
      if (current && nextServers.some((server) => server.id === current)) return current;
      return nextServers[0]?.id ?? null;
    });
    setStatuses(
      Object.fromEntries(
        runtime.mcpStatuses.map((status) => [
          status.id,
          { connected: status.connected, tools: status.tools, ...(status.error ? { error: status.error } : {}) },
        ]),
      ),
    );
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const selected = useMemo(() => servers.find((server) => server.id === selectedId) ?? null, [servers, selectedId]);
  const selectedStatus = selected ? statuses[selected.id] : undefined;

  const saveDraft = useCallback(async () => {
    try {
      const saved = await saveCapabilityMcpServer({
        id: draft.id.trim() || undefined,
        name: draft.name.trim(),
        transport: draft.transport,
        url: draft.url.trim(),
        headers: parseHeaders(draft.headersJson),
        enabled: true,
      });
      setEditing(false);
      setDraft(emptyDraft());
      await refresh();
      setSelectedId(saved.id);
    } catch (error) {
      Alert.alert("Couldn't save MCP server", error instanceof Error ? error.message : String(error));
    }
  }, [draft, refresh]);

  const deleteSelected = useCallback(() => {
    if (!selected) return;
    Alert.alert("Delete MCP server?", `Remove "${selected.name}" from this device?`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => {
          void removeCapabilityMcpServer(selected.id).then(refresh).catch(() => {});
        },
      },
    ]);
  }, [refresh, selected]);

  return (
    <View>
      <Text style={panelStyles.sectionLabel}>MCP</Text>
      <View style={panelStyles.actionRow}>
        <Pressable
          onPress={() => {
            setEditing(true);
            setDraft(emptyDraft());
          }}
        >
          <Text style={panelStyles.actionLink}>+ NEW SERVER</Text>
        </Pressable>
        <Pressable onPress={() => void refresh()}>
          <Text style={panelStyles.actionLink}>REFRESH STATUS</Text>
        </Pressable>
      </View>

      {editing ? (
        <Card title={draft.id ? "Edit MCP server" : "New MCP server"}>
          <View style={panelStyles.editorField}>
            <Text style={panelStyles.editorLabel}>Name</Text>
            <TextInput style={panelStyles.input} value={draft.name} onChangeText={(value) => setDraft((current) => ({ ...current, name: value }))} placeholder="Tavily" placeholderTextColor={C.faint} />
          </View>
          <View style={panelStyles.editorField}>
            <Text style={panelStyles.editorLabel}>Transport</Text>
            <View style={panelStyles.chipRow}>
              {(["http", "sse"] as const).map((transport) => (
                <Pressable key={transport} onPress={() => setDraft((current) => ({ ...current, transport }))} style={[panelStyles.chip, draft.transport === transport ? panelStyles.chipOn : panelStyles.chipOff]}>
                  <Text style={panelStyles.chipText}>{transport.toUpperCase()}</Text>
                </Pressable>
              ))}
            </View>
          </View>
          <View style={panelStyles.editorField}>
            <Text style={panelStyles.editorLabel}>URL</Text>
            <TextInput style={panelStyles.input} value={draft.url} onChangeText={(value) => setDraft((current) => ({ ...current, url: value }))} placeholder="https://example.com/mcp" placeholderTextColor={C.faint} autoCapitalize="none" autoCorrect={false} />
          </View>
          <View style={panelStyles.editorField}>
            <Text style={panelStyles.editorLabel}>Headers JSON</Text>
            <TextInput style={panelStyles.textarea} multiline value={draft.headersJson} onChangeText={(value) => setDraft((current) => ({ ...current, headersJson: value }))} placeholder='{"Authorization":"Bearer …"}' placeholderTextColor={C.faint} autoCapitalize="none" autoCorrect={false} />
          </View>
          <View style={panelStyles.buttonRow}>
            <Pressable
              onPress={() => {
                setEditing(false);
                setDraft(emptyDraft());
              }}
              style={panelStyles.secondaryBtn}
            >
              <Text style={panelStyles.secondaryText}>CANCEL</Text>
            </Pressable>
            <Pressable onPress={() => void saveDraft()} style={panelStyles.primaryBtn}>
              <Text style={panelStyles.primaryText}>SAVE</Text>
            </Pressable>
          </View>
        </Card>
      ) : null}

      <Card title="Configured servers">
        {servers.length === 0 ? (
          <Text style={panelStyles.empty}>No mobile-safe MCP servers are configured. Only HTTP and SSE transports are allowed here.</Text>
        ) : (
          servers.map((server) => {
            const status = statuses[server.id];
            return (
              <View key={server.id} style={panelStyles.row}>
                <Pressable style={panelStyles.rowText} onPress={() => setSelectedId(server.id)}>
                  <Text style={panelStyles.rowTitle}>
                    {server.name}
                    {selectedId === server.id ? "  ·  open" : ""}
                  </Text>
                  <Text style={panelStyles.rowMeta}>
                    {server.transport.toUpperCase()} · {server.enabled ? "enabled" : "disabled"} · {status?.connected ? "connected" : status?.error ? "error" : "idle"}
                  </Text>
                  <Text style={panelStyles.rowSub}>{server.url}</Text>
                </Pressable>
                <View style={panelStyles.rowActions}>
                  <Pressable onPress={() => void setCapabilityMcpEnabled(server.id, !server.enabled).then(refresh)}>
                    <Text style={panelStyles.actionLink}>{server.enabled ? "DISABLE" : "ENABLE"}</Text>
                  </Pressable>
                </View>
              </View>
            );
          })
        )}
      </Card>

      {selected ? (
        <Card title="Selected server" action={<StateBadge ok={selectedStatus ? selectedStatus.connected : null} label={selectedStatus?.connected ? "connected" : selected.enabled ? "idle" : "disabled"} />}>
          <View style={panelStyles.detail}>
            <View style={panelStyles.detailHead}>
              <Text style={panelStyles.detailTitle}>{selected.name}</Text>
              <View style={[panelStyles.chip, selected.enabled ? panelStyles.chipOn : panelStyles.chipOff]}>
                <Text style={panelStyles.chipText}>{selected.enabled ? "enabled" : "disabled"}</Text>
              </View>
              <View style={panelStyles.chip}>
                <Text style={panelStyles.chipText}>{selected.transport.toUpperCase()}</Text>
              </View>
            </View>
            <Text style={panelStyles.detailBody}>{selected.url}</Text>
            {selectedStatus?.tools?.length ? (
              <View style={panelStyles.editorField}>
                <Text style={panelStyles.detailLabel}>Published tools</Text>
                <View style={panelStyles.chipRow}>
                  {selectedStatus.tools.map((tool) => (
                    <View key={tool} style={panelStyles.chip}>
                      <Text style={panelStyles.chipText}>{tool}</Text>
                    </View>
                  ))}
                </View>
              </View>
            ) : null}
            {selectedStatus?.error ? (
              <View style={panelStyles.editorField}>
                <Text style={panelStyles.detailLabel}>Last error</Text>
                <Text style={panelStyles.detailBody}>{selectedStatus.error}</Text>
              </View>
            ) : null}
            <View style={panelStyles.actionRow}>
              <Pressable onPress={() => void setCapabilityMcpEnabled(selected.id, !selected.enabled).then(refresh)}>
                <Text style={panelStyles.actionLink}>{selected.enabled ? "DISABLE" : "ENABLE"}</Text>
              </Pressable>
              <Pressable
                onPress={() => {
                  setDraft(toDraft(selected));
                  setEditing(true);
                }}
              >
                <Text style={panelStyles.actionLink}>EDIT</Text>
              </Pressable>
              <Pressable onPress={deleteSelected}>
                <Text style={[panelStyles.actionLink, panelStyles.dangerLink]}>DELETE</Text>
              </Pressable>
            </View>
          </View>
        </Card>
      ) : null}
    </View>
  );
}
