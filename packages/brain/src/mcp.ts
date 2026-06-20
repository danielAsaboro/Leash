export interface BrainMcpToolGroup {
  id: string;
  name: string;
  description: string;
}

export const BRAIN_MCP_TOOL_GROUPS: BrainMcpToolGroup[] = [
  { id: "home-assistant", name: "Home Assistant", description: "Control smart-home devices (lights, switches, fans, covers, scenes) over Home Assistant's LAN API." },
  { id: "feed", name: "Feed", description: "Search the user's auto-written on-device daily paper (The Understory)." },
  { id: "memory", name: "Memory", description: "Save and recall typed memories about the user (preferences, facts, goals, people, routines)." },
  { id: "tasks", name: "TODOs", description: "Create, list, and update TODOs on the user's TODO list." },
  { id: "context", name: "Context", description: "Search the user's private context graph (Apple Notes, files, memories, past chats) and read their live screen activity." },
  { id: "photos", name: "Photos", description: "List the user's images and their on-device auto-tags." },
  { id: "image", name: "Image", description: "Generate images from text, fully on-device." },
  { id: "research", name: "Research", description: "Run a deep, multi-source WEB research run in the background (needs network)." },
  { id: "skills", name: "Skills", description: "Load the user's skills on demand and run their bundled scripts (read_skill, read_skill_file, run_skill_script)." },
  { id: "files", name: "Files", description: "Sandboxed read-only file retrieval (grep/find/cat/jq) over a snapshot of the user's files." },
  { id: "mcp-admin", name: "MCP", description: "Install and register OTHER MCP servers from a URL or by hand (install_mcp_repo, upsert_mcp_server)." },
  { id: "scheduler", name: "Scheduler", description: "Let the assistant schedule its own future actions — recurring reminders and allowlisted maintenance jobs (no arbitrary commands, no cloud AI tasks)." },
];

export const BRAIN_ALWAYS_ON_TOOL_GROUPS = ["context", "files", "memory", "tasks", "feed"] as const;
