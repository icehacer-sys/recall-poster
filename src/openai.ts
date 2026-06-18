// gpt-image-2 slide generation. POSTs to the OpenAI images API and decodes the
// base64 PNG it returns into a Buffer the renderer post-processes and writes to disk.

import { config, requireEnv } from "./config.js";

/**
 * Generate one slide image for the given prompt and return it as a PNG Buffer.
 * Throws a clear Error on a non-200 / error response.
 */
export async function generateSlideImage(prompt: string, size = config.imageSize): Promise<Buffer> {
  const res = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${requireEnv("OPENAI_API_KEY")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.imageModel,
      prompt,
      size,
      quality: config.imageQuality,
      n: 1,
    }),
  });

  const text = await res.text();
  let json: any;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`OpenAI images API returned non-JSON (${res.status}): ${text.slice(0, 200)}`);
  }
  if (!res.ok || json?.error) {
    throw new Error(`OpenAI images API failed (${res.status}): ${json?.error?.message ?? text.slice(0, 200)}`);
  }
  const b64 = json?.data?.[0]?.b64_json;
  if (!b64) {
    throw new Error(`OpenAI images API returned no image data: ${text.slice(0, 200)}`);
  }
  return Buffer.from(b64, "base64");
}
