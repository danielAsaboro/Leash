/**
 * Web-platform globals the Vercel AI SDK relies on, polyfilled for React Native / JSC — set up the
 * OFFICIAL Expo way (per ai-sdk.dev's Expo quickstart "Polyfills" section), via RN's `polyfillGlobal`
 * rather than direct `globalThis` assignment (which doesn't reliably install onto RN's global).
 *
 * MUST be imported first in `index.ts`, before any module that pulls in `ai`/`@ai-sdk/*`.
 *
 * Note: the on-device chat path drives `@qvac/sdk` `completion()` directly (JSC-safe) and needs none
 * of this. These polyfills exist for the AI-SDK-backed paths (e.g. tool-aware mesh borrow): the
 * stream text-encoders come from `@stardazed/streams-text-encoding`; `ReadableStream`/`TransformStream`
 * from `web-streams-polyfill` (JSC ships neither). Each install is guarded so we never clobber a
 * global the runtime already provides.
 */
import { Platform } from "react-native";
// @ts-expect-error — @ungap/structured-clone ships no type declarations; default export is the fn.
import structuredCloneImpl from "@ungap/structured-clone";

if (Platform.OS !== "web") {
  const setup = async (): Promise<void> => {
    // @ts-expect-error — RN internal module ships no type declarations.
    const { polyfillGlobal } = await import("react-native/Libraries/Utilities/PolyfillFunctions");

    if (!("structuredClone" in global)) {
      polyfillGlobal("structuredClone", () => structuredCloneImpl);
    }

    try {
      const streams = await import("web-streams-polyfill");
      if (!("ReadableStream" in global)) polyfillGlobal("ReadableStream", () => streams.ReadableStream);
      if (!("WritableStream" in global)) polyfillGlobal("WritableStream", () => streams.WritableStream);
      if (!("TransformStream" in global)) polyfillGlobal("TransformStream", () => streams.TransformStream);
    } catch (e) {
      console.warn("[polyfills] web-streams unavailable:", (e as Error)?.message ?? String(e));
    }

    try {
      const { TextEncoderStream, TextDecoderStream } = await import("@stardazed/streams-text-encoding");
      polyfillGlobal("TextEncoderStream", () => TextEncoderStream);
      polyfillGlobal("TextDecoderStream", () => TextDecoderStream);
    } catch (e) {
      console.warn("[polyfills] TextEncoderStream/TextDecoderStream unavailable:", (e as Error)?.message ?? String(e));
    }
  };
  void setup();
}

export {};
