// Minimal multipart/form-data parser for the hypha shim (a raw node:http server, so no Fastify
// multipart). STT (/v1/audio/transcriptions) is the one OpenAI endpoint that uploads a file; the shim
// parses the audio file + model field out of the multipart body, then forwards them (audio as base64)
// over the P2P forward transport. Buffer-based (the file is binary). Pure — unit-tested by
// scripts/smoke-multipart.ts.

export interface MultipartPart {
  name: string;
  filename?: string;
  contentType?: string;
  data: Buffer;
}

/** Extract the boundary token from a `multipart/form-data; boundary=...` content-type, or null. */
export function boundaryOf(contentType: string): string | null {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  if (!m) return null;
  const b = (m[1] ?? m[2] ?? "").trim();
  return b.length > 0 ? b : null;
}

/** Parse a multipart/form-data body into its parts. Tolerant of CRLF framing; binary-safe. */
export function parseMultipart(body: Buffer, boundary: string): MultipartPart[] {
  const parts: MultipartPart[] = [];
  const delim = Buffer.from(`--${boundary}`);
  const headerSep = Buffer.from("\r\n\r\n");

  const positions: number[] = [];
  for (let i = body.indexOf(delim, 0); i >= 0; i = body.indexOf(delim, i + delim.length)) positions.push(i);

  for (let p = 0; p < positions.length - 1; p++) {
    let start = positions[p]! + delim.length;
    const end = positions[p + 1]!;
    if (body[start] === 0x2d && body[start + 1] === 0x2d) continue; // closing "--boundary--"
    if (body[start] === 0x0d && body[start + 1] === 0x0a) start += 2; // skip CRLF after the delimiter
    let dataEnd = end;
    if (body[dataEnd - 2] === 0x0d && body[dataEnd - 1] === 0x0a) dataEnd -= 2; // drop trailing CRLF
    const segment = body.subarray(start, dataEnd);

    const hdrEnd = segment.indexOf(headerSep);
    if (hdrEnd < 0) continue;
    const headers = segment.subarray(0, hdrEnd).toString("utf8");
    const data = segment.subarray(hdrEnd + headerSep.length);

    const name = /name="([^"]*)"/.exec(headers)?.[1];
    if (name === undefined) continue;
    const filename = /filename="([^"]*)"/.exec(headers)?.[1];
    const contentType = /content-type:\s*([^\r\n]+)/i.exec(headers)?.[1]?.trim();
    parts.push({
      name,
      ...(filename !== undefined ? { filename } : {}),
      ...(contentType !== undefined ? { contentType } : {}),
      data,
    });
  }
  return parts;
}
