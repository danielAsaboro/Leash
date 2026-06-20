/**
 * The agent roster shown in Brain → Agents — the same shared Brain agents as desktop. The phone is
 * a first-class runtime: it executes what it can locally and delegates roles/tools that are
 * unavailable or too heavy to a paired mesh device.
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
  { name: "Joy", role: "Health", description: "Health, medication, symptoms, lab results, urgent symptoms, and mental-health or wellbeing questions." },
  { name: "Ruth", role: "Researcher", description: "In-depth, multi-source web research with citations on a topic." },
  { name: "Bree", role: "Summarizer", description: "Condense long documents, notes, or threads into concise summaries." },
  { name: "Grace", role: "Coder", description: "Write, debug, or explain code and scripts." },
];
