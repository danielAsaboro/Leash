import React, { useCallback, useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { C, F, TRACKING_LABEL } from "../theme";
import { DesktopNote } from "../DesktopNote";
import { Brain, Plus, Trash } from "../icons";
import { ago } from "../chats";
import {
  addMemory,
  deleteMemory,
  listMemories,
  toggleType,
  updateMemory,
  type Memory,
  type MemoryType,
} from "../memories";
import {
  deleteNote,
  listNotes,
  loadNote,
  newNoteId,
  saveNote,
  type NoteSummary,
} from "../notes";

/**
 * Brain → Memory. Atomic memories (preference ↔ fact toggle, CRUD) PLUS a local notes notebook,
 * both fully on-device. Enabled memories are composed into the chat system prompt (onChanged tells
 * App to recompose), so an edit here genuinely changes how Leash answers. Desktop's "Screen activity"
 * is the watcher daemon — no on-device backing, so it's an honest DesktopNote at the foot.
 */
export function MemoryPanel({ onChanged, onPair }: { onChanged: () => void; onPair: () => void }) {
  const [memories, setMemories] = useState<Memory[]>([]);
  const [memText, setMemText] = useState("");
  const [memType, setMemType] = useState<MemoryType>("preference");
  const [editId, setEditId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");

  const [notes, setNotes] = useState<NoteSummary[]>([]);
  const [noteId, setNoteId] = useState<string | null>(null);
  const [noteTitle, setNoteTitle] = useState("");
  const [noteBody, setNoteBody] = useState("");
  const [noteOpen, setNoteOpen] = useState(false);

  const refreshMem = useCallback(() => void listMemories().then(setMemories), []);
  const refreshNotes = useCallback(() => void listNotes().then(setNotes), []);
  useEffect(() => {
    refreshMem();
    refreshNotes();
  }, [refreshMem, refreshNotes]);

  const apply = useCallback(
    (p: Promise<unknown>) => {
      void p.then(() => {
        refreshMem();
        onChanged();
      });
    },
    [refreshMem, onChanged],
  );

  const add = () => {
    const t = memText.trim();
    if (!t) return;
    setMemText("");
    apply(addMemory(memType, t));
  };

  const saveEdit = (id: string) => {
    const t = editDraft.trim();
    setEditId(null);
    if (t) apply(updateMemory(id, { text: t }));
  };

  // Notes editor
  const openNew = () => {
    setNoteId(newNoteId());
    setNoteTitle("");
    setNoteBody("");
    setNoteOpen(true);
  };
  const openNote = async (id: string) => {
    const n = await loadNote(id);
    if (!n) return;
    setNoteId(n.id);
    setNoteTitle(n.title);
    setNoteBody(n.body);
    setNoteOpen(true);
  };
  const saveCurrentNote = () => {
    if (!noteId || (!noteTitle.trim() && !noteBody.trim())) {
      setNoteOpen(false);
      return;
    }
    void saveNote({ id: noteId, title: noteTitle, body: noteBody }).then(() => {
      setNoteOpen(false);
      refreshNotes();
    });
  };
  const removeNote = (id: string) => void deleteNote(id).then(refreshNotes);

  return (
    <View>
      {/* ── Memories ─────────────────────────────────────────────── */}
      <Text style={styles.sectionLabel}>MEMORIES</Text>
      <View style={styles.composer}>
        <TextInput
          style={styles.input}
          value={memText}
          onChangeText={setMemText}
          placeholder="Something Leash should remember…"
          placeholderTextColor={C.faint}
          multiline
        />
        <View style={styles.composerRow}>
          <View style={styles.typePicker}>
            {(["preference", "fact"] as MemoryType[]).map((t) => (
              <Pressable key={t} onPress={() => setMemType(t)} style={[styles.typeChip, memType === t && styles.typeChipOn]}>
                <Text style={[styles.typeChipText, memType === t && { color: C.cream }]}>{t.toUpperCase()}</Text>
              </Pressable>
            ))}
          </View>
          <View style={{ flex: 1 }} />
          <Pressable onPress={add} disabled={!memText.trim()} style={({ pressed }) => [styles.addBtn, (!memText.trim() || pressed) && styles.dim]}>
            <Plus size={15} color={C.cream} strokeWidth={2.4} />
            <Text style={styles.addBtnText}>ADD</Text>
          </Pressable>
        </View>
      </View>

      {memories.length === 0 ? (
        <Text style={styles.empty}>No memories yet. What Leash remembers is composed into every chat.</Text>
      ) : (
        memories.map((m) => (
          <View key={m.id} style={styles.memRow}>
            <Pressable onPress={() => apply(toggleType(m.id))} hitSlop={6}>
              <Text style={[styles.typeBadge, { color: m.type === "preference" ? C.sageDeep : C.muted }]}>
                {m.type.toUpperCase()}
              </Text>
            </Pressable>
            <View style={{ flex: 1 }}>
              {editId === m.id ? (
                <TextInput
                  style={styles.memEdit}
                  value={editDraft}
                  onChangeText={setEditDraft}
                  multiline
                  autoFocus
                  onBlur={() => saveEdit(m.id)}
                />
              ) : (
                <Pressable onPress={() => { setEditId(m.id); setEditDraft(m.text); }}>
                  <Text style={styles.memText}>{m.text}</Text>
                </Pressable>
              )}
              <Text style={styles.memAge}>{ago(m.updatedAt)}</Text>
            </View>
            <Pressable onPress={() => apply(deleteMemory(m.id))} hitSlop={8} style={{ paddingTop: 2 }}>
              <Trash size={15} color={C.faint} strokeWidth={1.8} />
            </Pressable>
          </View>
        ))
      )}

      {/* ── Notes ────────────────────────────────────────────────── */}
      <View style={styles.notesHead}>
        <Text style={styles.sectionLabel}>NOTES</Text>
        <View style={{ flex: 1 }} />
        <Pressable onPress={openNew} hitSlop={8}>
          <Text style={styles.newNote}>+ NEW NOTE</Text>
        </Pressable>
      </View>

      {noteOpen ? (
        <View style={styles.noteEditor}>
          <TextInput style={styles.noteTitleInput} value={noteTitle} onChangeText={setNoteTitle} placeholder="Title" placeholderTextColor={C.faint} />
          <TextInput
            style={styles.noteBodyInput}
            value={noteBody}
            onChangeText={setNoteBody}
            placeholder="Write a note… (markdown ok)"
            placeholderTextColor={C.faint}
            multiline
          />
          <View style={styles.noteBtnRow}>
            <Pressable onPress={() => setNoteOpen(false)} style={styles.ghostBtn}>
              <Text style={styles.ghostText}>CANCEL</Text>
            </Pressable>
            <Pressable onPress={saveCurrentNote} style={styles.saveBtn}>
              <Text style={styles.saveText}>SAVE</Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      {notes.length === 0 && !noteOpen ? (
        <Text style={styles.empty}>No notes yet.</Text>
      ) : (
        notes.map((n) => (
          <Pressable key={n.id} onPress={() => void openNote(n.id)} style={styles.noteRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.noteTitle} numberOfLines={1}>{n.title}</Text>
              <Text style={styles.noteMeta}>{n.chars} chars · {ago(n.updatedAt)}</Text>
            </View>
            <Pressable onPress={() => removeNote(n.id)} hitSlop={8}>
              <Trash size={15} color={C.faint} strokeWidth={1.8} />
            </Pressable>
          </Pressable>
        ))
      )}

      {/* ── Screen activity (watcher) — desktop-only ─────────────── */}
      <View style={{ marginTop: 22 }}>
        <DesktopNote
          Icon={Brain}
          title="Screen activity"
          line="The screen watcher that turns what you read into memories is a desktop daemon. Pair a device to feed it into this Brain."
          onPair={onPair}
          compact
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  sectionLabel: { fontFamily: F.monoMed, fontSize: 10, color: C.muted, letterSpacing: TRACKING_LABEL, marginBottom: 10, marginTop: 4 },
  composer: { backgroundColor: C.paper, borderWidth: StyleSheet.hairlineWidth, borderColor: C.rule, borderRadius: 12, padding: 12, marginBottom: 14 },
  input: { fontFamily: F.body, fontSize: 16, color: C.ink, paddingVertical: 4, minHeight: 26 },
  composerRow: { flexDirection: "row", alignItems: "center", marginTop: 8 },
  typePicker: { flexDirection: "row", gap: 6 },
  typeChip: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6, borderWidth: StyleSheet.hairlineWidth, borderColor: C.rule },
  typeChipOn: { backgroundColor: C.sageDeep, borderColor: C.sageDeep },
  typeChipText: { fontFamily: F.monoMed, fontSize: 9, color: C.muted, letterSpacing: 0.8 },
  addBtn: { flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: C.sageDeep, borderRadius: 8, paddingHorizontal: 14, paddingVertical: 9 },
  addBtnText: { fontFamily: F.monoSemi, fontSize: 11, color: C.cream, letterSpacing: 1 },
  dim: { opacity: 0.45 },
  empty: { fontFamily: F.body, fontSize: 15, color: C.muted, marginBottom: 8, lineHeight: 22 },
  memRow: { flexDirection: "row", alignItems: "flex-start", gap: 12, paddingVertical: 13, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.rule },
  typeBadge: { fontFamily: F.monoSemi, fontSize: 9, letterSpacing: 0.8, paddingTop: 3, width: 76 },
  memText: { fontFamily: F.body, fontSize: 16, color: C.ink, lineHeight: 23 },
  memEdit: { fontFamily: F.body, fontSize: 16, color: C.ink, lineHeight: 23, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.sageDeep },
  memAge: { fontFamily: F.mono, fontSize: 9.5, color: C.faint, marginTop: 4 },
  notesHead: { flexDirection: "row", alignItems: "center", marginTop: 26 },
  newNote: { fontFamily: F.monoMed, fontSize: 10, color: C.sageDeep, letterSpacing: 1 },
  noteEditor: { backgroundColor: C.paper, borderWidth: StyleSheet.hairlineWidth, borderColor: C.ruleStrong, borderRadius: 12, padding: 12, marginBottom: 12 },
  noteTitleInput: { fontFamily: F.bodySemi, fontSize: 17, color: C.ink, paddingVertical: 4 },
  noteBodyInput: { fontFamily: F.body, fontSize: 15, color: C.inkSoft, paddingVertical: 6, minHeight: 90, lineHeight: 22, textAlignVertical: "top" },
  noteBtnRow: { flexDirection: "row", justifyContent: "flex-end", gap: 10, marginTop: 8 },
  ghostBtn: { borderWidth: StyleSheet.hairlineWidth, borderColor: C.ruleStrong, borderRadius: 6, paddingHorizontal: 14, paddingVertical: 8 },
  ghostText: { fontFamily: F.monoSemi, fontSize: 10.5, color: C.inkSoft, letterSpacing: 1 },
  saveBtn: { backgroundColor: C.sageDeep, borderRadius: 6, paddingHorizontal: 16, paddingVertical: 8 },
  saveText: { fontFamily: F.monoSemi, fontSize: 10.5, color: C.cream, letterSpacing: 1 },
  noteRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 13, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.rule },
  noteTitle: { fontFamily: F.bodyMed, fontSize: 16, color: C.ink },
  noteMeta: { fontFamily: F.mono, fontSize: 9.5, color: C.faint, marginTop: 3 },
});
