export const DEVICE_TOOL_GROUPS = {
  time: ["get_current_time"],
  tasks: ["list_tasks", "add_task", "complete_task", "delete_task"],
  notes: ["search_notes", "create_note"],
  memory: ["remember", "list_memories"],
} as const;

/** Select only tool groups relevant to the current phone turn; ordinary chat remains tool-free. */
export function deviceToolNamesForPrompt(prompt: string): string[] {
  const text = prompt.toLowerCase();
  const names = new Set<string>();
  const add = (group: readonly string[]) => group.forEach((name) => names.add(name));

  if (/\b(?:time|date|day|today|tonight|tomorrow)\b/.test(text)) add(DEVICE_TOOL_GROUPS.time);
  if (/\b(?:task|tasks|todo|to-do|remind|reminder)\b/.test(text)) add(DEVICE_TOOL_GROUPS.tasks);
  if (/\b(?:note|notes|noted|write down|jot down)\b/.test(text)) add(DEVICE_TOOL_GROUPS.notes);
  if (/\b(?:remember|memory|memories|preference|preferences|know about me)\b/.test(text)) add(DEVICE_TOOL_GROUPS.memory);

  return [...names];
}
