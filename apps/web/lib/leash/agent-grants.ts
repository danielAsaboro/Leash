// No 'server-only' guard: pure logic imported by scripts/agent-mcp-refs.test.ts (tsx, outside Next.js).
/** Which referenced-server tool names to ADD to a delegate's allow-set (in registry, not already chosen, not denied). */
export function grantedNames(serverToolNames: string[], registryKeys: Set<string>, chosen: Set<string>, denied: Set<string>): string[] {
  const out: string[] = [];
  for (const n of serverToolNames) {
    if (registryKeys.has(n) && !chosen.has(n) && !denied.has(n) && !out.includes(n)) out.push(n);
  }
  return out;
}
