import React, { useCallback, useEffect, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { C, F, TRACKING_LABEL } from "./theme";
import { ScreenHeader } from "./ScreenHeader";
import { TabBar } from "./TabBar";
import { DesktopNote } from "./DesktopNote";
import { Newspaper, Plus, Trash } from "./icons";
import {
  createTask,
  deleteTask,
  listTasks,
  updateTask,
  type Task,
  type TaskPriority,
  type TaskStatus,
} from "./tasks";
import { meshStatus, onTasksChanged, type MeshStatus } from "./meshClient";

/**
 * TASKS — 1:1 with the desktop /tasks tabs: Mine · Newsroom · Runs. "Mine" is a real on-device task
 * list (full CRUD, status + priority, status filter chips) mirroring the web TasksPanel. Newsroom
 * (the newsroom daemon + Prisma pipeline) and Runs (daemon run history) have no on-device backing,
 * so they show the honest DesktopNote rather than fake rows (Rule 4).
 */
type Tab = "mine" | "newsroom" | "runs";
const TABS: { key: Tab; label: string }[] = [
  { key: "mine", label: "Mine" },
  { key: "newsroom", label: "Newsroom" },
  { key: "runs", label: "Runs" },
];

type Filter = TaskStatus | "all";
const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "open", label: "Open" },
  { key: "in_progress", label: "In progress" },
  { key: "done", label: "Done" },
  { key: "dropped", label: "Dropped" },
];

const STATUS_META: Record<TaskStatus, { label: string; color: string }> = {
  open: { label: "OPEN", color: C.muted },
  in_progress: { label: "IN PROGRESS", color: C.sageDeep },
  done: { label: "DONE", color: C.sage },
  dropped: { label: "DROPPED", color: C.faint },
};
const STATUS_CYCLE: TaskStatus[] = ["open", "in_progress", "done", "dropped"];

const PRIO_META: Record<TaskPriority, { label: string; color: string }> = {
  low: { label: "LOW", color: C.faint },
  normal: { label: "NORMAL", color: C.muted },
  high: { label: "HIGH", color: C.brick },
};
const PRIO_CYCLE: TaskPriority[] = ["low", "normal", "high"];

export function TasksScreen({ onMenu, onPair }: { onMenu: () => void; onPair: () => void }) {
  const [tab, setTab] = useState<Tab>("mine");
  const [filter, setFilter] = useState<Filter>("all");
  const [tasks, setTasks] = useState<Task[]>([]);
  const [title, setTitle] = useState("");
  const [detail, setDetail] = useState("");
  const [prio, setPrio] = useState<TaskPriority>("normal");

  const [mesh, setMesh] = useState<MeshStatus | null>(null);
  const refresh = useCallback(() => void listTasks().then(setTasks), []);
  useEffect(() => {
    refresh();
  }, [refresh]);

  // Mesh status chip + live sync: poll status for the chip, and re-list the instant a peer's edit
  // replicates into the worklet (onTasksChanged). Both are best-effort — a mesh-less phone just
  // shows "On this device" and the local list keeps working.
  useEffect(() => {
    let alive = true;
    const tick = () => void meshStatus().then((s) => alive && setMesh(s)).catch(() => {});
    tick();
    const id = setInterval(tick, 5000);
    const off = onTasksChanged(() => { refresh(); tick(); });
    return () => { alive = false; clearInterval(id); off(); };
  }, [refresh]);

  const meshChip = mesh?.joined
    ? `MESH ✓ · ${mesh.peers} peer${mesh.peers === 1 ? "" : "s"}${mesh.leader ? (mesh.leader === mesh.deviceId ? " · leader: you" : " · leader: peer") : ""}${mesh.writable ? "" : " · syncing…"}`
    : "ON THIS DEVICE · not in a mesh";

  const add = useCallback(() => {
    const t = title.trim();
    if (!t) return;
    void createTask({ title: t, detail: detail.trim() || undefined, priority: prio }).then(() => {
      setTitle("");
      setDetail("");
      setPrio("normal");
      refresh();
    });
  }, [title, detail, prio, refresh]);

  const cycleStatus = (task: Task) => {
    const next = STATUS_CYCLE[(STATUS_CYCLE.indexOf(task.status) + 1) % STATUS_CYCLE.length]!;
    void updateTask(task.id, { status: next }).then(refresh);
  };
  const cyclePrio = (task: Task) => {
    const next = PRIO_CYCLE[(PRIO_CYCLE.indexOf(task.priority) + 1) % PRIO_CYCLE.length]!;
    void updateTask(task.id, { priority: next }).then(refresh);
  };
  const toggleDone = (task: Task) => {
    void updateTask(task.id, { status: task.status === "done" ? "open" : "done" }).then(refresh);
  };
  const remove = (task: Task) => {
    Alert.alert("Delete task", `Delete “${task.title}”?`, [
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: () => void deleteTask(task.id).then(refresh) },
    ]);
  };

  const shown = filter === "all" ? tasks : tasks.filter((t) => t.status === filter);

  return (
    <View style={{ flex: 1, backgroundColor: C.cream }}>
      <ScreenHeader kicker="On this device" title="Tasks" onMenu={onMenu} />
      <TabBar tabs={TABS} active={tab} onChange={setTab} />

      {tab === "mine" ? (
        <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
          {/* Mesh status — joined ✓ / peers / leader, or "not in a mesh" (set it up on the Mesh tab) */}
          <Pressable onPress={onPair} style={styles.meshChip}>
            <View style={[styles.meshDot, { backgroundColor: mesh?.joined ? C.sage : C.faint }]} />
            <Text style={[styles.meshChipText, { color: mesh?.joined ? C.sageDeep : C.muted }]}>{meshChip}</Text>
          </Pressable>

          {/* Create */}
          <View style={styles.composer}>
            <TextInput
              style={styles.titleInput}
              value={title}
              onChangeText={setTitle}
              placeholder="New task…"
              placeholderTextColor={C.faint}
              returnKeyType="done"
              onSubmitEditing={add}
            />
            <TextInput
              style={styles.detailInput}
              value={detail}
              onChangeText={setDetail}
              placeholder="Detail (optional)"
              placeholderTextColor={C.faint}
              multiline
            />
            <View style={styles.composerRow}>
              <View style={styles.prioPicker}>
                {PRIO_CYCLE.map((p) => (
                  <Pressable key={p} onPress={() => setPrio(p)} style={[styles.prioChip, prio === p && styles.prioChipOn]}>
                    <Text style={[styles.prioChipText, prio === p && { color: C.cream }]}>{PRIO_META[p].label}</Text>
                  </Pressable>
                ))}
              </View>
              <View style={{ flex: 1 }} />
              <Pressable
                onPress={add}
                disabled={!title.trim()}
                style={({ pressed }) => [styles.addBtn, (!title.trim() || pressed) && styles.dim]}
              >
                <Plus size={16} color={C.cream} strokeWidth={2.4} />
                <Text style={styles.addBtnText}>ADD</Text>
              </Pressable>
            </View>
          </View>

          {/* Filters */}
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filterRow}>
            {FILTERS.map((f) => {
              const n = f.key === "all" ? tasks.length : tasks.filter((t) => t.status === f.key).length;
              const on = filter === f.key;
              return (
                <Pressable key={f.key} onPress={() => setFilter(f.key)} style={[styles.filterChip, on && styles.filterChipOn]}>
                  <Text style={[styles.filterChipText, on && { color: C.sageDeep }]}>
                    {f.label} {n}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>

          {/* List */}
          {shown.length === 0 ? (
            <Text style={styles.empty}>
              {tasks.length === 0 ? "No tasks yet. Add one above." : "Nothing in this filter."}
            </Text>
          ) : (
            shown.map((task) => (
              <View key={task.id} style={styles.taskRow}>
                <Pressable onPress={() => toggleDone(task)} hitSlop={6} style={styles.checkbox}>
                  <View style={[styles.checkboxBox, task.status === "done" && styles.checkboxOn]}>
                    {task.status === "done" ? <Text style={styles.checkMark}>✓</Text> : null}
                  </View>
                </Pressable>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.taskTitle, task.status === "done" && styles.taskTitleDone]}>{task.title}</Text>
                  {task.detail ? <Text style={styles.taskDetail}>{task.detail}</Text> : null}
                  <View style={styles.taskMeta}>
                    <Pressable onPress={() => cycleStatus(task)} hitSlop={6}>
                      <Text style={[styles.metaBadge, { color: STATUS_META[task.status].color }]}>
                        {STATUS_META[task.status].label}
                      </Text>
                    </Pressable>
                    <Pressable onPress={() => cyclePrio(task)} hitSlop={6}>
                      <Text style={[styles.metaBadge, { color: PRIO_META[task.priority].color }]}>
                        ◆ {PRIO_META[task.priority].label}
                      </Text>
                    </Pressable>
                  </View>
                </View>
                <Pressable onPress={() => remove(task)} hitSlop={8} style={styles.trashBtn}>
                  <Trash size={16} color={C.faint} strokeWidth={1.8} />
                </Pressable>
              </View>
            ))
          )}
        </ScrollView>
      ) : (
        <ScrollView contentContainerStyle={styles.noteBody}>
          {tab === "newsroom" ? (
            <DesktopNote
              Icon={Newspaper}
              title="Newsroom runs on your desktop."
              line="The newsroom daemon and its Prisma pipeline — sources, drafts, and sections — run on your desktop Leash. Pair a device to track the pipeline here."
              onPair={onPair}
            />
          ) : (
            <DesktopNote
              Icon={Newspaper}
              title="Runs live on your desktop."
              line="Daemon run history (newsroom and cron producers, with outcomes) is recorded by your desktop Leash. Pair a device to review runs here."
              onPair={onPair}
            />
          )}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: 20, paddingTop: 14, paddingBottom: 40 },
  meshChip: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 8, paddingHorizontal: 10, marginBottom: 12, borderRadius: 8, backgroundColor: C.paper, borderWidth: StyleSheet.hairlineWidth, borderColor: C.rule },
  meshDot: { width: 7, height: 7, borderRadius: 4 },
  meshChipText: { fontFamily: F.monoMed, fontSize: 10, letterSpacing: 0.6 },
  noteBody: { paddingHorizontal: 28, paddingTop: 36, paddingBottom: 40 },
  composer: {
    backgroundColor: C.paper,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: C.rule,
    borderRadius: 12,
    padding: 12,
    marginBottom: 14,
  },
  titleInput: { fontFamily: F.bodyMed, fontSize: 17, color: C.ink, paddingVertical: 4 },
  detailInput: { fontFamily: F.body, fontSize: 14.5, color: C.inkSoft, paddingVertical: 4, minHeight: 22 },
  composerRow: { flexDirection: "row", alignItems: "center", marginTop: 8 },
  prioPicker: { flexDirection: "row", gap: 6 },
  prioChip: {
    paddingHorizontal: 9,
    paddingVertical: 6,
    borderRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: C.rule,
  },
  prioChipOn: { backgroundColor: C.sageDeep, borderColor: C.sageDeep },
  prioChipText: { fontFamily: F.monoMed, fontSize: 9, color: C.muted, letterSpacing: 0.8 },
  addBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: C.sageDeep,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  addBtnText: { fontFamily: F.monoSemi, fontSize: 11, color: C.cream, letterSpacing: 1 },
  dim: { opacity: 0.45 },
  filterRow: { flexDirection: "row", gap: 6, paddingBottom: 14 },
  filterChip: { paddingHorizontal: 11, paddingVertical: 7, borderRadius: 16, backgroundColor: C.paper, borderWidth: StyleSheet.hairlineWidth, borderColor: C.rule },
  filterChipOn: { backgroundColor: "rgba(63,125,78,0.16)", borderColor: "transparent" },
  filterChipText: { fontFamily: F.monoMed, fontSize: 10, color: C.muted, letterSpacing: 0.6 },
  empty: { fontFamily: F.body, fontSize: 16, color: C.muted, marginTop: 18, lineHeight: 24 },
  taskRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 12,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: C.rule,
  },
  checkbox: { paddingTop: 2 },
  checkboxBox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 1.5,
    borderColor: C.ruleStrong,
    alignItems: "center",
    justifyContent: "center",
  },
  checkboxOn: { backgroundColor: C.sageDeep, borderColor: C.sageDeep },
  checkMark: { color: C.cream, fontSize: 13, fontWeight: "700" },
  taskTitle: { fontFamily: F.bodyMed, fontSize: 16.5, color: C.ink, lineHeight: 22 },
  taskTitleDone: { color: C.faint, textDecorationLine: "line-through" },
  taskDetail: { fontFamily: F.body, fontSize: 14, color: C.muted, marginTop: 3, lineHeight: 20 },
  taskMeta: { flexDirection: "row", gap: 14, marginTop: 8 },
  metaBadge: { fontFamily: F.monoMed, fontSize: 9.5, letterSpacing: 1 },
  trashBtn: { paddingTop: 2, paddingLeft: 4 },
});
