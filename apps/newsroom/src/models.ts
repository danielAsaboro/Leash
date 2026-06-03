/**
 * Typed model-constant shim (mirrors packages/senses/src/models.ts).
 *
 * `SD_V2_1_1B_Q8_0` is a real runtime export of `@qvac/sdk` but — like the LLM /
 * embedding constants — it's absent from the package's root `.d.ts`, so importing it
 * as a value fails type-check. We import it behind a one-line `@ts-ignore` and
 * re-export it typed as a `modelSrc`, keeping every consumer strict.
 */
import type { LoadModelOptions } from "@qvac/sdk";
// @ts-ignore — present at runtime; absent from @qvac/sdk's root .d.ts.
import { SD_V2_1_1B_Q8_0 as _SD_V2_1_1B_Q8_0 } from "@qvac/sdk";

export type ModelSrc = LoadModelOptions["modelSrc"];

/** Stable Diffusion 2.1 (1B, Q8) — single all-in-one GGUF, on-device hero images. */
export const SD_V2_1_1B_Q8_0: ModelSrc = _SD_V2_1_1B_Q8_0;
