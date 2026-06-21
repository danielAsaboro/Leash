import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Pressable, Text, TextInput, View } from "react-native";

import type { CapabilityAgent } from "../../../packages/capability-runtime/src/index";
import { Card } from "../Card";
import {
  deleteCapabilityAgent,
  listCapabilityAgents,
  listCapabilityPlugins,
  saveCapabilityAgent,
  setCapabilityAgentEnabled,
} from "../lib/capability/store";
import { C } from "../theme";
import { joinCsv, panelStyles, splitCsv } from "./capabilityShared";

type AgentDraft = {
  slug: string;
  name: string;
  description: string;
  body: string;
  toolsCsv: string;
  disallowedToolsCsv: string;
  skillsCsv: string;
  maxTurns: string;
};

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function emptyDraft(): AgentDraft {
  return { slug: "", name: "", description: "", body: "", toolsCsv: "", disallowedToolsCsv: "", skillsCsv: "", maxTurns: "6" };
}

function toDraft(agent: CapabilityAgent): AgentDraft {
  return {
    slug: agent.slug,
    name: agent.name,
    description: agent.description,
    body: agent.body,
    toolsCsv: joinCsv(agent.tools),
    disallowedToolsCsv: joinCsv(agent.disallowedTools),
    skillsCsv: joinCsv(agent.skills),
    maxTurns: String(agent.maxTurns || 6),
  };
}

function sourceLabel(agent: CapabilityAgent): string {
  if (agent.source === "plugin") return `plugin · ${agent.pluginId}`;
  if (agent.builtin) return "built-in";
  return "local";
}

export function AgentsPanel(): React.JSX.Element {
  const [agents, setAgents] = useState<CapabilityAgent[]>([]);
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<AgentDraft>(emptyDraft);

  const refresh = useCallback(async () => {
    const [localAgents, plugins] = await Promise.all([listCapabilityAgents(), listCapabilityPlugins()]);
    const pluginAgents = plugins.flatMap((plugin) =>
      plugin.agents.map((agent) => ({
        ...agent,
        source: "plugin" as const,
        pluginId: plugin.id,
        enabled: plugin.enabled && agent.enabled,
      })),
    );
    const next = [...localAgents, ...pluginAgents].sort((a, b) => a.name.localeCompare(b.name));
    setAgents(next);
    setSelectedSlug((current) => {
      if (current && next.some((agent) => agent.slug === current)) return current;
      return next[0]?.slug ?? null;
    });
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const selected = useMemo(() => agents.find((agent) => agent.slug === selectedSlug) ?? null, [agents, selectedSlug]);
  const canEditSelected = !!selected && selected.source === "local" && !selected.builtin;
  const canToggleSelected = !!selected && selected.source === "local";

  const saveDraft = useCallback(async () => {
    const name = draft.name.trim();
    const description = draft.description.trim();
    const body = draft.body.trim();
    if (!name || !description || !body) {
      Alert.alert("Agent incomplete", "Name, description, and body are required.");
      return;
    }
    try {
      const saved = await saveCapabilityAgent({
        slug: draft.slug.trim() || slugify(name),
        name,
        description,
        body,
        model: "",
        tools: splitCsv(draft.toolsCsv),
        disallowedTools: splitCsv(draft.disallowedToolsCsv),
        skills: splitCsv(draft.skillsCsv),
        maxTurns: Math.max(1, Number.parseInt(draft.maxTurns, 10) || 6),
        enabled: true,
        builtin: false,
        mcpServers: { refs: [], inline: [] },
        memory: "",
        permissionMode: "",
        hooks: "",
        background: false,
        effort: "",
        isolation: "",
        color: "",
        initialPrompt: "",
      });
      setEditing(false);
      setDraft(emptyDraft());
      await refresh();
      setSelectedSlug(saved.slug);
    } catch (error) {
      Alert.alert("Couldn't save agent", error instanceof Error ? error.message : String(error));
    }
  }, [draft, refresh]);

  const removeSelected = useCallback(() => {
    if (!selected || !canEditSelected) return;
    Alert.alert("Delete agent?", `Remove "${selected.name}" from this device?`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => {
          void deleteCapabilityAgent(selected.slug).then(refresh).catch(() => {});
        },
      },
    ]);
  }, [canEditSelected, refresh, selected]);

  return (
    <View>
      <Text style={panelStyles.sectionLabel}>AGENTS</Text>
      <View style={panelStyles.actionRow}>
        <Pressable
          onPress={() => {
            setEditing(true);
            setDraft(emptyDraft());
          }}
        >
          <Text style={panelStyles.actionLink}>+ NEW LOCAL AGENT</Text>
        </Pressable>
      </View>

      {editing ? (
        <Card title={draft.slug ? "Edit agent" : "New agent"}>
          <View style={panelStyles.editorField}>
            <Text style={panelStyles.editorLabel}>Name</Text>
            <TextInput style={panelStyles.input} value={draft.name} onChangeText={(value) => setDraft((current) => ({ ...current, name: value }))} placeholder="Grace" placeholderTextColor={C.faint} />
          </View>
          <View style={panelStyles.editorField}>
            <Text style={panelStyles.editorLabel}>Description</Text>
            <TextInput style={panelStyles.input} value={draft.description} onChangeText={(value) => setDraft((current) => ({ ...current, description: value }))} placeholder="Coding specialist" placeholderTextColor={C.faint} />
          </View>
          <View style={panelStyles.editorField}>
            <Text style={panelStyles.editorLabel}>Allowed tools</Text>
            <TextInput style={panelStyles.input} value={draft.toolsCsv} onChangeText={(value) => setDraft((current) => ({ ...current, toolsCsv: value }))} placeholder="search_notes, list_tasks" placeholderTextColor={C.faint} />
          </View>
          <View style={panelStyles.editorField}>
            <Text style={panelStyles.editorLabel}>Disallowed tools</Text>
            <TextInput style={panelStyles.input} value={draft.disallowedToolsCsv} onChangeText={(value) => setDraft((current) => ({ ...current, disallowedToolsCsv: value }))} placeholder="news_search" placeholderTextColor={C.faint} />
          </View>
          <View style={panelStyles.editorField}>
            <Text style={panelStyles.editorLabel}>Preferred skills</Text>
            <TextInput style={panelStyles.input} value={draft.skillsCsv} onChangeText={(value) => setDraft((current) => ({ ...current, skillsCsv: value }))} placeholder="task-manager" placeholderTextColor={C.faint} />
          </View>
          <View style={panelStyles.editorField}>
            <Text style={panelStyles.editorLabel}>Max turns</Text>
            <TextInput style={panelStyles.input} value={draft.maxTurns} onChangeText={(value) => setDraft((current) => ({ ...current, maxTurns: value }))} keyboardType="number-pad" placeholder="6" placeholderTextColor={C.faint} />
          </View>
          <View style={panelStyles.editorField}>
            <Text style={panelStyles.editorLabel}>Body</Text>
            <TextInput style={panelStyles.textarea} multiline value={draft.body} onChangeText={(value) => setDraft((current) => ({ ...current, body: value }))} placeholder="Write the specialist instructions here…" placeholderTextColor={C.faint} />
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

      <Card title="Delegation roster">
        {agents.length === 0 ? (
          <Text style={panelStyles.empty}>No agents are installed yet.</Text>
        ) : (
          agents.map((agent) => (
            <View key={agent.slug} style={panelStyles.row}>
              <Pressable style={panelStyles.rowText} onPress={() => setSelectedSlug(agent.slug)}>
                <Text style={panelStyles.rowTitle}>
                  {agent.name}
                  {selectedSlug === agent.slug ? "  ·  open" : ""}
                </Text>
                <Text style={panelStyles.rowMeta}>
                  {sourceLabel(agent)} · max {agent.maxTurns} turns · {agent.enabled ? "enabled" : "disabled"}
                </Text>
                <Text style={panelStyles.rowSub}>{agent.description || "No description."}</Text>
              </Pressable>
              <View style={panelStyles.rowActions}>
                {agent.source === "local" ? (
                  <Pressable onPress={() => void setCapabilityAgentEnabled(agent.slug, !agent.enabled).then(refresh)}>
                    <Text style={panelStyles.actionLink}>{agent.enabled ? "DISABLE" : "ENABLE"}</Text>
                  </Pressable>
                ) : (
                  <Text style={[panelStyles.actionLink, panelStyles.mutedLink]}>PLUGIN</Text>
                )}
              </View>
            </View>
          ))
        )}
      </Card>

      {selected ? (
        <Card title="Selected agent">
          <View style={panelStyles.detail}>
            <View style={panelStyles.detailHead}>
              <Text style={panelStyles.detailTitle}>{selected.name}</Text>
              <View style={[panelStyles.chip, selected.enabled ? panelStyles.chipOn : panelStyles.chipOff]}>
                <Text style={panelStyles.chipText}>{selected.enabled ? "enabled" : "disabled"}</Text>
              </View>
              <View style={panelStyles.chip}>
                <Text style={panelStyles.chipText}>{sourceLabel(selected)}</Text>
              </View>
            </View>
            <Text style={panelStyles.detailBody}>{selected.description || "No description."}</Text>
            {selected.tools.length ? (
              <View style={panelStyles.editorField}>
                <Text style={panelStyles.detailLabel}>Allowed tools</Text>
                <View style={panelStyles.chipRow}>
                  {selected.tools.map((tool) => (
                    <View key={tool} style={panelStyles.chip}>
                      <Text style={panelStyles.chipText}>{tool}</Text>
                    </View>
                  ))}
                </View>
              </View>
            ) : null}
            {selected.disallowedTools.length ? (
              <View style={panelStyles.editorField}>
                <Text style={panelStyles.detailLabel}>Blocked tools</Text>
                <View style={panelStyles.chipRow}>
                  {selected.disallowedTools.map((tool) => (
                    <View key={tool} style={panelStyles.chip}>
                      <Text style={panelStyles.chipText}>{tool}</Text>
                    </View>
                  ))}
                </View>
              </View>
            ) : null}
            {selected.skills.length ? (
              <View style={panelStyles.editorField}>
                <Text style={panelStyles.detailLabel}>Preferred skills</Text>
                <View style={panelStyles.chipRow}>
                  {selected.skills.map((skill) => (
                    <View key={skill} style={panelStyles.chip}>
                      <Text style={panelStyles.chipText}>{skill}</Text>
                    </View>
                  ))}
                </View>
              </View>
            ) : null}
            <View style={panelStyles.editorField}>
              <Text style={panelStyles.detailLabel}>Delegation config</Text>
              <Text style={panelStyles.code}>
                maxTurns={selected.maxTurns}
                {selected.mcpServers.refs.length ? `\nmcpRefs=${selected.mcpServers.refs.join(", ")}` : ""}
                {selected.mcpServers.inline.length ? `\ninlineMcp=${selected.mcpServers.inline.map((server) => server.name).join(", ")}` : ""}
              </Text>
            </View>
            <View style={panelStyles.editorField}>
              <Text style={panelStyles.detailLabel}>Body</Text>
              <Text style={panelStyles.detailBody}>{selected.body}</Text>
            </View>
            <View style={panelStyles.actionRow}>
              {canToggleSelected ? (
                <Pressable onPress={() => void setCapabilityAgentEnabled(selected.slug, !selected.enabled).then(refresh)}>
                  <Text style={panelStyles.actionLink}>{selected.enabled ? "DISABLE" : "ENABLE"}</Text>
                </Pressable>
              ) : null}
              {canEditSelected ? (
                <Pressable
                  onPress={() => {
                    setDraft(toDraft(selected));
                    setEditing(true);
                  }}
                >
                  <Text style={panelStyles.actionLink}>EDIT</Text>
                </Pressable>
              ) : null}
              {canEditSelected ? (
                <Pressable onPress={removeSelected}>
                  <Text style={[panelStyles.actionLink, panelStyles.dangerLink]}>DELETE</Text>
                </Pressable>
              ) : null}
            </View>
          </View>
        </Card>
      ) : null}
    </View>
  );
}
