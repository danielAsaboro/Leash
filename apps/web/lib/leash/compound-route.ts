const MEMORY_TASK_RE =
  /\b(?:remember|recall|memory|memor(?:y|ies)|todo|todos|to-do|task|tasks|create\s+(?:a\s+)?todo|list\s+(?:my\s+)?open\s+todos?)\b/i;

export function needsChatBrokerLane(text: string): boolean {
  return MEMORY_TASK_RE.test(text);
}
