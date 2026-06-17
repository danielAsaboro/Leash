/**
 * The agent roster shown in Brain → Agents — the SAME built-in agents as the desktop
 * (apps/web/builtin-agents): Leash, the main orchestrator that runs on THIS device, plus the
 * specialists it delegates to. On the phone this list is informational: the specialists do their
 * work with tools (web, files, code) that live on a paired desktop, so there's no run/edit surface
 * here. Not a fabricated catalog (Rule 4) — these are the real agent definitions, name + domain.
 */
export type AgentEntry = { name: string; role: string; description: string; main?: boolean };

export const AGENTS: AgentEntry[] = [
  {
    name: "Leash",
    role: "Main orchestrator",
    description:
      "Your default on-device assistant. It answers directly, and on a paired desktop it delegates to the specialists below when a request is outside its strength.",
    main: true,
  },
  { name: "Joy", role: "Health", description: "Medical, health, symptom, medication, and mental-health or wellbeing questions." },
  { name: "Sage", role: "Researcher", description: "In-depth, multi-source web research with citations on a topic." },
  { name: "Bree", role: "Summarizer", description: "Condense long documents, notes, or threads into concise summaries." },
  { name: "Grace", role: "Coder", description: "Write, debug, or explain code and scripts." },
];
