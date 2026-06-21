import type { FilesV4, FilesV4UploadFileCallOptions } from "@ai-sdk/provider";

export interface QvacFilesOptions {
  baseURL: string;
  headers: Record<string, string>;
  fetch?: typeof fetch;
}

function bytesFor(data: FilesV4UploadFileCallOptions["data"]): Uint8Array {
  if (data.type === "text") return new TextEncoder().encode(data.text);
  return typeof data.data === "string" ? Uint8Array.from(Buffer.from(data.data, "base64")) : data.data;
}

export function createQvacFiles(options: QvacFilesOptions): FilesV4 {
  const request = options.fetch ?? globalThis.fetch;
  return {
    specificationVersion: "v4",
    provider: "qvac",
    async uploadFile({ data, mediaType, filename, providerOptions }) {
      const form = new FormData();
      const body = bytesFor(data).slice().buffer as ArrayBuffer;
      form.append("file", new Blob([body], { type: mediaType }), filename ?? "upload.bin");
      const purpose = providerOptions?.["qvac"]?.["purpose"];
      if (typeof purpose === "string" && purpose.length > 0) form.append("purpose", purpose);
      const response = await request(`${options.baseURL.replace(/\/+$/, "")}/files`, {
        method: "POST",
        headers: options.headers,
        body: form,
      });
      if (!response.ok) throw new Error(`QVAC file upload failed (${response.status}): ${(await response.text()).slice(0, 500)}`);
      const result = (await response.json()) as { id?: string; filename?: string };
      if (!result.id) throw new Error("QVAC file upload returned no file id");
      const resolvedFilename = result.filename ?? filename;
      return {
        providerReference: { qvac: result.id },
        mediaType,
        ...(resolvedFilename !== undefined && { filename: resolvedFilename }),
        providerMetadata: { qvac: { ephemeral: true } },
        warnings: [],
      };
    },
  };
}
