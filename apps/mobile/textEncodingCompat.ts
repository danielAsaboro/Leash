type EncodeIntoResult = { read: number; written: number };

export function encodeIntoCompat(
  encoder: { encode(input?: string): Uint8Array },
  source: string,
  destination: Uint8Array,
): EncodeIntoResult {
  let read = 0;
  let written = 0;

  while (read < source.length) {
    const first = source.charCodeAt(read);
    const width = first >= 0xd800 && first <= 0xdbff && read + 1 < source.length
      && source.charCodeAt(read + 1) >= 0xdc00 && source.charCodeAt(read + 1) <= 0xdfff
      ? 2
      : 1;
    const bytes = encoder.encode(source.slice(read, read + width));
    if (written + bytes.length > destination.length) break;
    destination.set(bytes, written);
    written += bytes.length;
    read += width;
  }

  return { read, written };
}

export function installTextEncoderEncodeInto(): void {
  const Encoder = globalThis.TextEncoder;
  if (!Encoder || typeof Encoder.prototype.encodeInto === "function") return;
  Object.defineProperty(Encoder.prototype, "encodeInto", {
    configurable: true,
    value(this: TextEncoder, source: string, destination: Uint8Array) {
      return encodeIntoCompat(this, String(source), destination);
    },
    writable: true,
  });
}
