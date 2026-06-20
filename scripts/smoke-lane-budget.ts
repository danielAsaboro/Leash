import assert from "node:assert/strict";
import { deriveLaneBudget, COMPUTER_STEPS, FILES_STEPS, PLAN_STEPS, SKILL_TOOL_STEPS } from "../apps/web/lib/leash/lane-budget.ts";

const quick = { steps: 2, maxOutputTokens: 150 };
const standard = { steps: 3, maxOutputTokens: 900 };
const deep = { steps: 6, maxOutputTokens: 2500 };

assert.deepEqual(
  deriveLaneBudget({ imageTurn: false, planMode: false, filesTurn: false, computerTurn: false, declaredSkillTools: [], cfg: quick }),
  { steps: 2, maxOutputTokens: 150, leanTools: true },
  "quick plain chat uses lean tool exposure",
);

assert.deepEqual(
  deriveLaneBudget({ imageTurn: false, planMode: false, filesTurn: true, computerTurn: false, declaredSkillTools: [], cfg: standard }),
  { steps: FILES_STEPS, maxOutputTokens: 900 },
  "files lane uses files step budget",
);

assert.deepEqual(
  deriveLaneBudget({ imageTurn: false, planMode: false, filesTurn: false, computerTurn: true, declaredSkillTools: [], cfg: standard }),
  { steps: COMPUTER_STEPS, maxOutputTokens: 900 },
  "computer lane uses computer step budget",
);

assert.deepEqual(
  deriveLaneBudget({ imageTurn: false, planMode: false, filesTurn: false, computerTurn: false, declaredSkillTools: ["bash"], cfg: standard }),
  { steps: SKILL_TOOL_STEPS, maxOutputTokens: 900 },
  "active skill tools use skill step budget",
);

assert.deepEqual(
  deriveLaneBudget({ imageTurn: false, planMode: true, filesTurn: false, computerTurn: false, declaredSkillTools: [], cfg: standard }),
  { steps: PLAN_STEPS, maxOutputTokens: 900 },
  "plan mode uses plan step budget",
);

assert.deepEqual(
  deriveLaneBudget({ imageTurn: false, planMode: false, filesTurn: false, computerTurn: false, declaredSkillTools: [], cfg: deep }),
  { steps: 6, maxOutputTokens: 2500 },
  "deep plain chat does not use lean tools",
);

assert.deepEqual(
  deriveLaneBudget({ imageTurn: true, planMode: false, filesTurn: false, computerTurn: false, declaredSkillTools: [], cfg: null }),
  { steps: null, maxOutputTokens: null },
  "vision/image turns stay single-shot with no token cap",
);

console.log("smoke:lane-budget PASS");
