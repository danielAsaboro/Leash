export type MeshInvitePayload = {
  invite: string;
  sid?: string;
  mesh?: string;
};

const INVITE_HEX_RE = /^[0-9a-f]+$/i;

function cleanString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function serializeMeshInvitePayload(payload: MeshInvitePayload): string {
  const qs = new URLSearchParams({ invite: payload.invite });
  if (payload.sid) qs.set("sid", payload.sid);
  if (payload.mesh) qs.set("mesh", payload.mesh);
  return `leash://join?${qs.toString()}`;
}

export function parseMeshInvitePayload(data: string): MeshInvitePayload | null {
  const raw = (data ?? "").trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();
  if (INVITE_HEX_RE.test(lower) && lower.length >= 96 && lower.length % 2 === 0) return { invite: lower };

  try {
    const url = new URL(raw);
    if (url.protocol === "leash:" && url.hostname === "join") {
      const invite = cleanString(url.searchParams.get("invite"))?.toLowerCase();
      if (!invite || !INVITE_HEX_RE.test(invite) || invite.length < 96 || invite.length % 2 !== 0) return null;
      const sid = cleanString(url.searchParams.get("sid"));
      const mesh = cleanString(url.searchParams.get("mesh"));
      return { invite, ...(sid ? { sid } : {}), ...(mesh ? { mesh } : {}) };
    }
  } catch {
    /* not a URI */
  }

  try {
    const json = JSON.parse(raw) as { invite?: unknown; sid?: unknown; mesh?: unknown };
    const invite = cleanString(json.invite)?.toLowerCase();
    if (!invite || !INVITE_HEX_RE.test(invite) || invite.length < 96 || invite.length % 2 !== 0) return null;
    const sid = cleanString(json.sid);
    const mesh = cleanString(json.mesh);
    return { invite, ...(sid ? { sid } : {}), ...(mesh ? { mesh } : {}) };
  } catch {
    return null;
  }
}
