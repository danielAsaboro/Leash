/**
 * Enum-like values for the newsroom schema.
 *
 * SQLite has no native enums, so these columns are TEXT in Prisma. We centralize
 * the allowed values here as `const` objects + string-literal unions so the daemon
 * and the web app stay type-safe without a DB-level enum.
 */

export const Section = {
  AI: "AI",
  COMPUTE: "COMPUTE",
  SOLANA: "SOLANA",
  BRIEF: "BRIEF",
} as const;
export type Section = (typeof Section)[keyof typeof Section];

export const Origin = {
  EXTERNAL: "EXTERNAL",
  PERSONAL: "PERSONAL",
} as const;
export type Origin = (typeof Origin)[keyof typeof Origin];

/** The newsroom pipeline, in order. Drives the Mission Control board + status pill. */
export const Stage = {
  QUEUED: "QUEUED",
  RESEARCHING: "RESEARCHING",
  RESEARCH_READY: "RESEARCH_READY",
  DRAFTING: "DRAFTING",
  REVIEW: "REVIEW",
  PUBLISHED: "PUBLISHED",
} as const;
export type Stage = (typeof Stage)[keyof typeof Stage];

/** Ordered stages for the StageTracker (RESEARCH → DRAFT → REVIEW → PUBLISH). */
export const STAGE_TRACK: Stage[] = [
  Stage.RESEARCHING,
  Stage.DRAFTING,
  Stage.REVIEW,
  Stage.PUBLISHED,
];

export const ClaimStatus = {
  UNVERIFIED: "UNVERIFIED",
  VERIFIED: "VERIFIED",
  CONFLICTED: "CONFLICTED",
} as const;
export type ClaimStatus = (typeof ClaimStatus)[keyof typeof ClaimStatus];

export const RunKind = {
  discovery: "discovery",
  research: "research",
  draft: "draft",
  review: "review",
  image: "image",
  audio: "audio",
  publish: "publish",
} as const;
export type RunKind = (typeof RunKind)[keyof typeof RunKind];

export const DaemonStatus = {
  RUNNING: "RUNNING",
  IDLE: "IDLE",
  STOPPED: "STOPPED",
} as const;
export type DaemonStatus = (typeof DaemonStatus)[keyof typeof DaemonStatus];
