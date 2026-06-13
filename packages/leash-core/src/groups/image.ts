/**
 * Image tool group — on-device diffusion image generation (`generate_image`). Writes the
 * PNG into `apps/web/public/leash-gen` so Next serves it at `/leash-gen/*`; the result
 * carries the small URL (not base64) as a structured extra the ImageCard renders.
 */
import { z } from "zod";
import { experimental_generateImage as generateImage } from "ai";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { imageModel, IMAGE_MODEL } from "../provider-core.ts";
import { GEN_DIR } from "../paths.ts";
import type { LeashSource } from "../sources.ts";
import { defineTool, type ToolGroup } from "./types.ts";

const NO_SOURCES: LeashSource[] = [];

export const imageGroup: ToolGroup = {
  id: "image",
  label: "Image",
  description: "Generate images from text, fully on-device (diffusion).",
  tools: [
    defineTool({
      name: "generate_image",
      description:
        "Generate an image from a text description, fully on-device. Use when the user asks to draw, create, generate, paint, or visualize a picture/image. Write a vivid, detailed prompt.",
      inputSchema: {
        prompt: z.string().describe("A detailed visual description of the image to generate."),
      },
      handler: async ({ prompt }) => {
        try {
          const { image } = await generateImage({ model: imageModel(), prompt, size: "512x512" });
          await mkdir(GEN_DIR, { recursive: true });
          const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`;
          await writeFile(join(GEN_DIR, name), Buffer.from(image.uint8Array));
          return { url: `/leash-gen/${name}`, prompt, text: `Generated an image for: ${prompt}`, sources: NO_SOURCES };
        } catch (err) {
          const raw = err instanceof Error ? err.message : String(err);
          const offline = /fetch failed|ECONNREFUSED|failed to fetch|connect/i.test(raw);
          const missing = /model_not_found|not available|not loaded/i.test(raw);
          const text = offline
            ? "I couldn't generate the image — the on-device model service is offline. Start it with `npm run qvac`."
            : missing
              ? `I couldn't generate the image — the image model "${IMAGE_MODEL}" isn't loaded. Add it to qvac.config.base.json → serve.models and restart \`npm run qvac\`.`
              : `I couldn't generate the image: ${raw}`;
          return { error: text, prompt, text, sources: NO_SOURCES };
        }
      },
    }),
  ],
};
