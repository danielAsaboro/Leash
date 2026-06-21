import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Pressable, Text, TextInput, View } from "react-native";

import type { CapabilitySkill } from "../../../packages/capability-runtime/src/index";
import { Card } from "../Card";
import {
  deleteCapabilitySkill,
  listCapabilityPlugins,
  listCapabilitySkills,
  saveCapabilitySkill,
  setCapabilitySkillEnabled,
  syncCapabilitySkillsFromMesh,
} from "../lib/capability/store";
import { C } from "../theme";
import { joinCsv, panelStyles, splitCsv } from "./capabilityShared";

type SkillDraft = {
  slug: string;
  name: string;
  description: string;
  whenToUse: string;
  toolsCsv: string;
  body: string;
};

function emptyDraft(): SkillDraft {
  return { slug: "", name: "", description: "", whenToUse: "", toolsCsv: "", body: "" };
}

function toDraft(skill: CapabilitySkill): SkillDraft {
  return {
    slug: skill.slug,
    name: skill.name,
    description: skill.description,
    whenToUse: skill.whenToUse,
    toolsCsv: joinCsv(skill.tools),
    body: skill.body,
  };
}

function sourceLabel(skill: CapabilitySkill): string {
  if (skill.source === "plugin") return `plugin · ${skill.pluginId}`;
  if (skill.builtin) return "built-in";
  return "local";
}

export function SkillsPanel(): React.JSX.Element {
  const [skills, setSkills] = useState<CapabilitySkill[]>([]);
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<SkillDraft>(emptyDraft);

  const refresh = useCallback(async () => {
    const [localSkills, plugins] = await Promise.all([listCapabilitySkills(), listCapabilityPlugins()]);
    const pluginSkills = plugins.flatMap((plugin) =>
      plugin.skills.map((skill) => ({
        ...skill,
        source: "plugin" as const,
        pluginId: plugin.id,
        enabled: plugin.enabled && skill.enabled,
      })),
    );
    const next = [...localSkills, ...pluginSkills].sort((a, b) => a.name.localeCompare(b.name));
    setSkills(next);
    setSelectedSlug((current) => {
      if (current && next.some((skill) => skill.slug === current)) return current;
      return next[0]?.slug ?? null;
    });
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const selected = useMemo(() => skills.find((skill) => skill.slug === selectedSlug) ?? null, [skills, selectedSlug]);
  const canEditSelected = !!selected && selected.source === "local" && !selected.builtin;
  const canToggleSelected = !!selected && selected.source === "local";

  const saveDraft = useCallback(async () => {
    const name = draft.name.trim();
    const description = draft.description.trim();
    const body = draft.body.trim();
    if (!name || !description || !body) {
      Alert.alert("Skill incomplete", "Name, description, and body are required.");
      return;
    }
    try {
      const saved = await saveCapabilitySkill({
        slug: draft.slug.trim() || undefined,
        name,
        description,
        body,
        whenToUse: draft.whenToUse.trim(),
        tools: splitCsv(draft.toolsCsv),
      });
      setEditing(false);
      setDraft(emptyDraft());
      await refresh();
      setSelectedSlug(saved.slug);
    } catch (error) {
      Alert.alert("Couldn't save skill", error instanceof Error ? error.message : String(error));
    }
  }, [draft, refresh]);

  const removeSelected = useCallback(() => {
    if (!selected || !canEditSelected) return;
    Alert.alert("Delete skill?", `Remove "${selected.name}" from this device?`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => {
          void deleteCapabilitySkill(selected.slug).then(refresh).catch(() => {});
        },
      },
    ]);
  }, [canEditSelected, refresh, selected]);

  const syncMesh = useCallback(() => {
    void syncCapabilitySkillsFromMesh()
      .then((count) => {
        void refresh();
        Alert.alert("Mesh sync complete", count > 0 ? `Imported or refreshed ${count} mesh skill${count === 1 ? "" : "s"}.` : "No mesh-published skills were available.");
      })
      .catch((error) => Alert.alert("Mesh sync failed", error instanceof Error ? error.message : String(error)));
  }, [refresh]);

  return (
    <View>
      <Text style={panelStyles.sectionLabel}>SKILLS</Text>
      <View style={panelStyles.actionRow}>
        <Pressable
          onPress={() => {
            setEditing(true);
            setDraft(emptyDraft());
          }}
        >
          <Text style={panelStyles.actionLink}>+ NEW LOCAL SKILL</Text>
        </Pressable>
        <Pressable onPress={syncMesh}>
          <Text style={panelStyles.actionLink}>SYNC MESH</Text>
        </Pressable>
      </View>

      {editing ? (
        <Card title={draft.slug ? "Edit skill" : "New skill"}>
          <View style={panelStyles.editorField}>
            <Text style={panelStyles.editorLabel}>Name</Text>
            <TextInput style={panelStyles.input} value={draft.name} onChangeText={(value) => setDraft((current) => ({ ...current, name: value }))} placeholder="task-manager" placeholderTextColor={C.faint} />
          </View>
          <View style={panelStyles.editorField}>
            <Text style={panelStyles.editorLabel}>Description</Text>
            <TextInput style={panelStyles.input} value={draft.description} onChangeText={(value) => setDraft((current) => ({ ...current, description: value }))} placeholder="What this skill does" placeholderTextColor={C.faint} />
          </View>
          <View style={panelStyles.editorField}>
            <Text style={panelStyles.editorLabel}>When to use</Text>
            <TextInput style={panelStyles.input} value={draft.whenToUse} onChangeText={(value) => setDraft((current) => ({ ...current, whenToUse: value }))} placeholder="tasks, todos, reminders" placeholderTextColor={C.faint} />
          </View>
          <View style={panelStyles.editorField}>
            <Text style={panelStyles.editorLabel}>Allowed tools</Text>
            <TextInput style={panelStyles.input} value={draft.toolsCsv} onChangeText={(value) => setDraft((current) => ({ ...current, toolsCsv: value }))} placeholder="list_tasks, add_task" placeholderTextColor={C.faint} />
          </View>
          <View style={panelStyles.editorField}>
            <Text style={panelStyles.editorLabel}>Body</Text>
            <TextInput style={panelStyles.textarea} multiline value={draft.body} onChangeText={(value) => setDraft((current) => ({ ...current, body: value }))} placeholder="Write the skill instructions here…" placeholderTextColor={C.faint} />
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

      <Card title="Runtime roster">
        {skills.length === 0 ? (
          <Text style={panelStyles.empty}>No skills are installed yet.</Text>
        ) : (
          skills.map((skill) => (
            <View key={skill.slug} style={panelStyles.row}>
              <Pressable style={panelStyles.rowText} onPress={() => setSelectedSlug(skill.slug)}>
                <Text style={panelStyles.rowTitle}>
                  {skill.name}
                  {selectedSlug === skill.slug ? "  ·  open" : ""}
                </Text>
                <Text style={panelStyles.rowMeta}>
                  {sourceLabel(skill)} · {skill.enabled ? "enabled" : "disabled"}
                </Text>
                <Text style={panelStyles.rowSub}>{skill.description}</Text>
              </Pressable>
              <View style={panelStyles.rowActions}>
                {skill.source === "local" ? (
                  <Pressable onPress={() => void setCapabilitySkillEnabled(skill.slug, !skill.enabled).then(refresh)}>
                    <Text style={panelStyles.actionLink}>{skill.enabled ? "DISABLE" : "ENABLE"}</Text>
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
        <Card title="Selected skill">
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
            <Text style={panelStyles.detailBody}>{selected.description}</Text>
            {selected.whenToUse ? (
              <View style={panelStyles.editorField}>
                <Text style={panelStyles.detailLabel}>When to use</Text>
                <Text style={panelStyles.detailBody}>{selected.whenToUse}</Text>
              </View>
            ) : null}
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
            <View style={panelStyles.editorField}>
              <Text style={panelStyles.detailLabel}>Body</Text>
              <Text style={panelStyles.detailBody}>{selected.body}</Text>
            </View>
            {selected.examples.length ? (
              <View style={panelStyles.editorField}>
                <Text style={panelStyles.detailLabel}>Examples</Text>
                <View style={panelStyles.chipRow}>
                  {selected.examples.map((example) => (
                    <View key={example} style={panelStyles.chip}>
                      <Text style={panelStyles.chipText}>{example}</Text>
                    </View>
                  ))}
                </View>
              </View>
            ) : null}
            <View style={panelStyles.actionRow}>
              {canToggleSelected ? (
                <Pressable onPress={() => void setCapabilitySkillEnabled(selected.slug, !selected.enabled).then(refresh)}>
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
