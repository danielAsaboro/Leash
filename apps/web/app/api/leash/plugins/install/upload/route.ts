/** `POST /api/leash/plugins/install/upload` — install a plugin from an uploaded `.zip`.
 *  Body: multipart/form-data with a `file` field. Lands DISABLED (quarantine). */
import { stageFromUploadZip } from "../../../../../../lib/leash/plugin-sources/upload.ts";
import { stageAndInstall } from "../../../../../../lib/leash/plugin-sources/install.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return Response.json({ error: "expected a multipart/form-data upload with a `file` field" }, { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof File)) return Response.json({ error: "no `file` in the upload" }, { status: 400 });
  const bytes = new Uint8Array(await file.arrayBuffer());
  return stageAndInstall({ kind: "upload", ref: file.name || "upload.zip" }, () => stageFromUploadZip(bytes));
}
