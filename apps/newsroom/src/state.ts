/** DaemonState helpers (the Mission Control telemetry singleton, id = 1). */
import { prisma, DaemonStatus, type DaemonState, type Prisma } from "@mycelium/db";
import { DEFAULT_MASTHEAD, DEFAULT_CADENCE_MIN } from "./config.ts";

/** Create the singleton if absent (idempotent). */
export async function ensureState(): Promise<DaemonState> {
  return prisma.daemonState.upsert({
    where: { id: 1 },
    create: { id: 1, masthead: DEFAULT_MASTHEAD, cadenceMin: DEFAULT_CADENCE_MIN, status: DaemonStatus.IDLE },
    update: {},
  });
}

export async function patchState(data: Prisma.DaemonStateUpdateInput): Promise<DaemonState> {
  return prisma.daemonState.update({ where: { id: 1 }, data });
}
