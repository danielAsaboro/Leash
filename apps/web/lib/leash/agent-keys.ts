/** The AI-SDK-safe tool key for an agent (its `<plugin>:<name>` slug can't contain `:`). */
export function agentToolKey(slug: string): string {
  return `agent__${slug.replace(/:/g, "__")}`;
}
