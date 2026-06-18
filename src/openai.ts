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

/**
 * Generate a slide that matches a brand reference via the image-edit endpoint. gpt-image-2
 * keeps the reference's logo, grid, colours and layout and applies the prompt's new text.
 * `ref` must be a PNG buffer.
 */
export async function generateSlideImageRef(prompt: string, refPng: Buffer, size = config.imageSize): Promise<Buffer> {
  const form = new FormData();
  form.append("model", config.imageModel);
  form.append("prompt", prompt);
  form.append("size", size);
  form.append("n", "1");
  form.append("image", new Blob([new Uint8Array(refPng)], { type: "image/png" }), "ref.png");

  const res = await fetch("https://api.openai.com/v1/images/edits", {
    method: "POST",
    headers: { Authorization: `Bearer ${requireEnv("OPENAI_API_KEY")}` },
    body: form,
  });
  const text = await res.text();
  let json: any;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`OpenAI image edit returned non-JSON (${res.status}): ${text.slice(0, 200)}`);
  }
  if (!res.ok || json?.error) {
    throw new Error(`OpenAI image edit failed (${res.status}): ${json?.error?.message ?? text.slice(0, 200)}`);
  }
  const b64 = json?.data?.[0]?.b64_json;
  if (!b64) {
    throw new Error(`OpenAI image edit returned no image data: ${text.slice(0, 200)}`);
  }
  return Buffer.from(b64, "base64");
}
