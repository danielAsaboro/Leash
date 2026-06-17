/**
 * @mycelium/mind — Layer 3 (Mind): the router + tool-calling council that reasons
 * over the context graph. Built on the proven `@qvac/sdk` `completion({tools})`
 * surface (de-risked by the Days 1–3 spike + the step-2 tool-call gate).
 *
 * - tools.ts   — the `search_graph` tool the proposer is given.
 * - council.ts — the proposer's call/observe/continue loop + verifier.
 * - critic.ts  — claim verification against retrieved sources.
 * - router.ts  — trivial/hard classification + the small-local trivial path.
 */
export { SEARCH_GRAPH_TOOL } from "./tools.ts";
export { runCouncil } from "./council.ts";
export type { CouncilDeps, CouncilResult, CouncilTraceStep } from "./council.ts";
export { verifyClaims } from "./critic.ts";
export type { Verdict, VerifyClaimsParams } from "./critic.ts";
export { classify, answerTrivial } from "./router.ts";
export type { Classification, AnswerTrivialParams } from "./router.ts";
export { runMedPsyConsult, MEDPSY_PROPOSER_SYSTEM, NON_DIAGNOSTIC_DISCLAIMER, EMERGENCY_BANNER } from "./medpsy.ts";
export type { MedPsyDeps, MedPsyResult } from "./medpsy.ts";
