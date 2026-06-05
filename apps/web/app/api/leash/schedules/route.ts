/** `GET /api/leash/schedules` (definitions + cron state + recent runs) · `POST` (create). */
import { listSchedules, createSchedule, cronState, cronRuns, type ScheduleEntry } from "../../../../lib/leash/schedules-store.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const [schedules, state, runs] = await Promise.all([listSchedules(), cronState(), cronRuns()]);
  return Response.json({ schedules, state, runs });
}

export async function POST(req: Request): Promise<Response> {
  const body = (await req.json()) as Omit<ScheduleEntry, "id" | "createdAt" | "updatedAt">;
  const entry = await createSchedule(body);
  if (!entry) return Response.json({ error: "invalid schedule (check kind, schedule shape, job allowlist / task title)" }, { status: 400 });
  return Response.json({ schedule: entry }, { status: 201 });
}
