export interface LaneEffortConfig {
  steps: number;
  maxOutputTokens: number;
}

export interface LaneBudgetInput {
  imageTurn: boolean;
  planMode: boolean;
  filesTurn: boolean;
  computerTurn: boolean;
  declaredSkillTools: string[];
  cfg: LaneEffortConfig | null;
}

export interface LaneBudget {
  steps: number | null;
  maxOutputTokens: number | null;
  leanTools?: boolean;
}

/** Step budget for computer-use turns — a GUI loop is app state → act → app state → verify. */
export const COMPUTER_STEPS = 10;
/** Step budget for files turns — a retrieval loop is grep → read → grep → answer. */
export const FILES_STEPS = 8;
/** Step budget for a turn an ACTIVE skill drives with its own toolset. */
export const SKILL_TOOL_STEPS = 12;
/** Plan-mode agent budget: submit_plan call (pauses for approval) → execute → present result. */
export const PLAN_STEPS = 4;

export function deriveLaneBudget(input: LaneBudgetInput): LaneBudget {
  if (input.imageTurn || !input.cfg) return { steps: null, maxOutputTokens: null };

  const steps = input.planMode
    ? PLAN_STEPS
    : input.declaredSkillTools.length
      ? SKILL_TOOL_STEPS
      : input.filesTurn
        ? FILES_STEPS
        : input.computerTurn
          ? COMPUTER_STEPS
          : input.cfg.steps;

  return {
    steps,
    maxOutputTokens: input.cfg.maxOutputTokens,
    ...(input.cfg.steps <= 2 && !input.planMode && !input.filesTurn && !input.computerTurn && input.declaredSkillTools.length === 0 ? { leanTools: true } : {}),
  };
}
