/**
 * `GET  /api/leash/constitution` → { constitution: { soul, goals, heartbeat } }
 * `PUT  /api/leash/constitution` { field: "soul"|"goals"|"heartbeat", content } → overwrite one file
 * The three editable markdown files that steer the proactive assistant (see constitution.ts).
 */
import { getConstitution, setConstitutionField, type ConstitutionField } from "../../../../lib/leash/constitution.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FIELDS: ConstitutionField[] = ["soul", "goals", "heartbeat"];

export async function GET(): Promise<Response> {
  return Response.json({ constitution: await getConstitution() });
}

export async function PUT(req: Request): Promise<Response> {
  let body: { field?: string; content?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (!FIELDS.includes(body.field as ConstitutionField)) {
    return Response.json({ error: "field must be soul | goals | heartbeat" }, { status: 400 });
  }
  await setConstitutionField(body.field as ConstitutionField, body.content ?? "");
  return Response.json({ constitution: await getConstitution() });
}
