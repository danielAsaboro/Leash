/**
 * `GET /api/leash/secrets` — status of every known secret (names + where it resolves;
 * NEVER the value). `PUT { name, value }` — set/clear one. `DELETE ?name=` — remove.
 */
import { listSecretStatus, setSecret, deleteSecret, KNOWN_SECRETS } from "../../../../lib/leash/vault.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const known = (name?: string): boolean => !!name && KNOWN_SECRETS.some((k) => k.name === name);

export async function GET(): Promise<Response> {
  return Response.json({ secrets: listSecretStatus() });
}

export async function PUT(req: Request): Promise<Response> {
  const { name, value } = (await req.json()) as { name?: string; value?: string };
  if (!known(name)) return Response.json({ error: "unknown secret name" }, { status: 400 });
  setSecret(name as string, value ?? "");
  return Response.json({ secrets: listSecretStatus() });
}

export async function DELETE(req: Request): Promise<Response> {
  const name = new URL(req.url).searchParams.get("name") ?? undefined;
  if (!known(name)) return Response.json({ error: "unknown secret name" }, { status: 400 });
  deleteSecret(name as string);
  return Response.json({ secrets: listSecretStatus() });
}
